/**
 * `launchset init` steps 1–3 (spec 11.1): find versions, platforms, Dockerfiles, existing
 * workflows, conflicting release machinery, image pins and build numbers. Read-only.
 */

import { findNodeAtLocation, type Node as JsonNode, parseTree } from "jsonc-parser";
import semver from "semver";
import { parse as parseYaml } from "yaml";
import { CONFIG_FILE_NAMES } from "../config/load.ts";
import { computeBuildNumber } from "../core/build-number.ts";
import { DEFAULT_DOCKER_TAGS } from "../core/config/schema.ts";
import { lineOf } from "../core/text.ts";
import { Git } from "../git/index.ts";
import { expoAndroid, expoIos } from "../platforms/expo.ts";
import { gradle } from "../platforms/gradle.ts";
import { gradleProperties } from "../platforms/gradle-properties.ts";
import { hasImageRef, imageRefs } from "../platforms/image.ts";
import { isBuildSettingReference } from "../platforms/ios-version.ts";
import { listNativeTargets, pbxproj } from "../platforms/pbxproj.ts";
import { plist } from "../platforms/plist.ts";
import type { FoundValue } from "../platforms/types.ts";
import { xcconfig } from "../platforms/xcconfig.ts";
import { findChangesets } from "./convert.ts";
import {
  absolute,
  baseName,
  dirOf,
  globRel,
  isDirectory,
  isFile,
  joinRel,
  MAX_SCAN_BYTES,
  readTextOrNull,
  statOrNull,
} from "./fs.ts";
import { detectHooks } from "./hooks.ts";
import {
  detectMachinery,
  type MachineryFinding,
  type PackageScripts,
  referencedScriptFiles,
  sampleTags,
} from "./machinery.ts";
import type {
  DetectedDocker,
  DetectedFile,
  DetectedTarget,
  Detection,
  Evidence,
  FoundTag,
  FoundVersion,
  ImagePin,
  Note,
} from "./types.ts";
import {
  type DockerBuild,
  dockerBuilds,
  parseWorkflow,
  platformBuildSignals,
  type Workflow,
} from "./workflow-scan.ts";

/** Everything detection found, including what writing needs but JSON doesn't show. */
export interface DetectContext {
  detection: Detection;
  workflows: Workflow[];
  dockerBuilds: DockerBuild[];
  machinery: MachineryFinding[];
  /** Root package.json text (`null` when there is none). */
  packageJsonText: string | null;
  /** Every git tag name. */
  tagNames: string[];
}

const DEFAULT_EPOCH = "2020-01-01T00:00:00Z";

/** Files init writes that a re-run would overwrite (asked about when they exist). */
export const GENERATED_FILES = [
  ".launchset/README.md",
  ".github/workflows/launchset-check.yml",
  ".github/workflows/launchset-release.yml",
  ".github/workflows/launchset-preview.yml",
];

const RELEASE_TOOL_CONFIGS = [
  ".releaserc",
  ".releaserc.{json,yml,yaml,js,cjs,mjs}",
  "release.config.{js,cjs,mjs,ts}",
  ".release-it.{json,js,cjs,mjs,ts,yml,yaml,toml}",
  ".versionrc",
  ".versionrc.{json,js,cjs}",
  "release-please-config.json",
  ".release-please-manifest.json",
];

function releaseToolOf(path: string): string {
  if (/releaserc|release\.config/.test(path)) return "semantic-release";
  if (/release-it/.test(path)) return "release-it";
  if (/versionrc/.test(path)) return "standard-version";
  return "release-please";
}

/** Round up to two significant digits (same rule as the store-ahead suggestion). */
export function roundUpOffset(minimum: number): number {
  if (minimum < 100) return minimum;
  const step = 10 ** (String(minimum).length - 2);
  return Math.ceil(minimum / step) * step;
}

function jsonNode(text: string): JsonNode | undefined {
  return parseTree(text, [], { allowTrailingComma: true }) ?? undefined;
}

function jsonString(tree: JsonNode | undefined, path: (string | number)[]): string | undefined {
  const node = tree ? findNodeAtLocation(tree, path) : undefined;
  return node && typeof node.value === "string" ? node.value : undefined;
}

/** `1.0` → `1.0.0`; `null` for anything that isn't a plain version. */
export function plainVersion(value: string): string | null {
  const v = value.trim().replace(/^v/, "");
  if (/^\d+\.\d+\.\d+$/.test(v)) return semver.valid(v);
  if (/^\d+\.\d+$/.test(v)) return semver.valid(`${v}.0`);
  if (/^\d+$/.test(v)) return semver.valid(`${v}.0.0`);
  return null;
}

/** Classify a tag name: `v1.2.3`, `1.2.3`, `name@1.2.3` (prereleases too). */
export function classifyTag(tag: string): FoundTag | null {
  if (tag.startsWith("launchset/")) return null;
  const v = "(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)";
  const plain = new RegExp(`^(v?)${v}$`).exec(tag);
  if (plain && semver.valid(plain[2] as string)) {
    const version = plain[2] as string;
    return {
      tag,
      version,
      format: `${plain[1]}{version}`,
      prerelease: semver.prerelease(version) !== null,
      counted: true,
    };
  }
  const named = new RegExp(`^(.+)@(v?)${v}$`).exec(tag);
  if (named && semver.valid(named[3] as string)) {
    const version = named[3] as string;
    return {
      tag,
      version,
      format: `${named[1]}@${named[2]}{version}`,
      prerelease: semver.prerelease(version) !== null,
      package: named[1] as string,
      counted: true,
    };
  }
  return null;
}

/** A target name from a free string: lowercase letters, digits and dashes. */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueName(base: string, taken: Set<string>): string {
  let name = base || "app";
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  taken.add(name);
  return name;
}

async function readJson(
  root: string,
  path: string,
): Promise<{ text: string; tree?: JsonNode } | null> {
  const text = await readTextOrNull(absolute(root, path));
  if (text === null) return null;
  const tree = jsonNode(text);
  return tree ? { text, tree } : { text };
}

// ---------------------------------------------------------------------------
// Workspaces and search scope

async function workspaceDirs(
  root: string,
  pkgTree: JsonNode | undefined,
  notes: Note[],
): Promise<string[]> {
  const patterns: string[] = [];
  const ws = pkgTree ? findNodeAtLocation(pkgTree, ["workspaces"]) : undefined;
  const list =
    ws?.type === "array"
      ? ws
      : ws?.type === "object"
        ? findNodeAtLocation(ws, ["packages"])
        : undefined;
  for (const child of list?.children ?? [])
    if (typeof child.value === "string") patterns.push(child.value);
  const pnpm = await readTextOrNull(absolute(root, "pnpm-workspace.yaml"));
  if (pnpm !== null) {
    try {
      const parsed = parseYaml(pnpm) as { packages?: unknown } | null;
      if (Array.isArray(parsed?.packages)) {
        for (const p of parsed.packages) if (typeof p === "string") patterns.push(p);
      }
    } catch (error) {
      notes.push({
        level: "warning",
        path: "pnpm-workspace.yaml",
        message: `can't read it: ${(error as Error).message}`,
      });
    }
  }
  const include = patterns.filter((p) => !p.startsWith("!")).map((p) => p.replace(/\/+$/, ""));
  const exclude = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
  if (include.length === 0) return [];
  const dirs = await globRel(root, include, { directories: true, ignore: exclude });
  const out: string[] = [];
  for (const dir of dirs)
    if (await isFile(absolute(root, joinRel(dir, "package.json")))) out.push(dir);
  return out;
}

// ---------------------------------------------------------------------------
// Native projects

interface NativeFound {
  targets: Omit<DetectedTarget, "name" | "builtBy" | "proposed" | "reason">[];
}

function safeRead(
  read: () => FoundValue[],
  path: string,
  notes: Note[],
  what: string,
): FoundValue[] | null {
  try {
    return read();
  } catch (error) {
    notes.push({
      level: "warning",
      path,
      message: `${what}: ${(error as Error).message.replace(`${path}: `, "")}`,
    });
    return null;
  }
}

function summarize(files: DetectedFile[]): { marketingVersion?: string; buildNumber?: number } {
  const marketing = files.flatMap((f) =>
    f.values.filter((v) => v.field === "marketing").map((v) => v.value),
  );
  const builds = files
    .flatMap((f) => f.values.filter((v) => v.field === "build").map((v) => v.value))
    .filter((v) => /^\d+$/.test(v))
    .map(Number);
  const out: { marketingVersion?: string; buildNumber?: number } = {};
  const best = marketing
    .filter((m) => plainVersion(m) !== null)
    .sort((a, b) => semver.rcompare(plainVersion(a) as string, plainVersion(b) as string))[0];
  if (best !== undefined) out.marketingVersion = best;
  else if (marketing[0] !== undefined) out.marketingVersion = marketing[0];
  if (builds.length > 0) out.buildNumber = Math.max(...builds);
  return out;
}

const GRADLE_NAME_KEY = /^(?:[A-Z_]*VERSION_?NAME|[a-z]*[vV]ersionName)$/;
const GRADLE_CODE_KEY = /^(?:[A-Z_]*VERSION_?CODE|[a-z]*[vV]ersionCode)$/;

async function detectAndroid(root: string, dir: string, capacitor: boolean, notes: Note[]) {
  const groovy = joinRel(dir, "android/app/build.gradle");
  const kts = joinRel(dir, "android/app/build.gradle.kts");
  const [g, k] = [await isFile(absolute(root, groovy)), await isFile(absolute(root, kts))];
  if (!g && !k) return undefined;
  if (g && k) {
    notes.push({
      level: "warning",
      path: groovy,
      message:
        'both build.gradle and build.gradle.kts exist; not offered as a target (pick one and set source { kind: "gradle", file } by hand)',
    });
    return undefined;
  }
  const file = g ? groovy : kts;
  const text = (await readTextOrNull(absolute(root, file))) ?? "";
  let readError: string | undefined;
  let values: FoundValue[] | null = null;
  try {
    values = gradle.read(text, file, undefined);
  } catch (error) {
    readError = (error as Error).message.replace(`${file}: `, "");
  }
  if (values) {
    return {
      type: "android" as const,
      dir,
      source: capacitor ? { kind: "capacitor", dir } : { kind: "gradle", file },
      files: [{ path: file, values }],
    };
  }
  const propsPath = joinRel(dir, "android/gradle.properties");
  const props = await readTextOrNull(absolute(root, propsPath));
  if (props !== null) {
    const keys = [...props.matchAll(/^[ \t]*([A-Za-z0-9_.]+)[ \t]*[=:]/gm)].map(
      (m) => m[1] as string,
    );
    const nameKey = keys.find((key) => GRADLE_NAME_KEY.test(key));
    const codeKey = keys.find((key) => GRADLE_CODE_KEY.test(key));
    if (nameKey && codeKey) {
      const found = safeRead(
        () =>
          gradleProperties.read(props, propsPath, {
            versionNameKey: nameKey,
            versionCodeKey: codeKey,
          }),
        propsPath,
        notes,
        "can't read the version keys",
      );
      if (found) {
        const source: Record<string, unknown> = { kind: "gradle-properties", file: propsPath };
        if (nameKey !== "VERSION_NAME") source.versionNameKey = nameKey;
        if (codeKey !== "VERSION_CODE") source.versionCodeKey = codeKey;
        return {
          type: "android" as const,
          dir,
          source,
          files: [{ path: propsPath, values: found }],
        };
      }
    }
  }
  notes.push({
    level: "warning",
    path: file,
    message: `Android project not offered as a target: ${readError}`,
  });
  return undefined;
}

async function detectIos(root: string, dir: string, capacitor: boolean, notes: Note[]) {
  const iosDir = joinRel(dir, "ios");
  const hasIosDir = await isDirectory(absolute(root, iosDir));
  const base = hasIosDir ? iosDir : dir;
  const projects = (
    await globRel(root, [hasIosDir ? "**/*.xcodeproj" : "*.xcodeproj"], {
      base,
      directories: true,
      deep: 3,
    })
  ).filter((p) => !/(^|\/)Pods\.xcodeproj$/.test(p));
  if (projects.length === 0) return undefined;
  const plists = await globRel(root, ["**/Info.plist"], {
    base,
    deep: 4,
    ignore: ["**/*.xcodeproj/**", "**/*Tests/**", "**/*UITests/**"],
  });
  const xcconfigs = await globRel(root, ["**/*.xcconfig"], { base, deep: 4 });

  // Info.plist with literal versions wins: that's what the app uses.
  const literal: DetectedFile[] = [];
  for (const path of plists) {
    const text = await readTextOrNull(absolute(root, path));
    if (text === null || !text.includes("CFBundleShortVersionString")) continue;
    const values = safeRead(
      () => plist.read(text, path, undefined),
      path,
      notes,
      "can't read the versions",
    );
    if (!values) continue;
    const marketing = values.find((v) => v.field === "marketing");
    if (marketing && !isBuildSettingReference(marketing.value)) literal.push({ path, values });
  }
  if (literal.length > 0) {
    return {
      type: "ios" as const,
      dir,
      source:
        literal.length === 1
          ? { kind: "plist", file: literal[0]?.path }
          : { kind: "plist", files: literal.map((f) => f.path) },
      files: literal,
    };
  }

  for (const project of projects) {
    const path = `${project}/project.pbxproj`;
    const text = await readTextOrNull(absolute(root, path));
    if (text === null) continue;
    let targets: ReturnType<typeof listNativeTargets>;
    try {
      targets = listNativeTargets(text, path);
    } catch (error) {
      notes.push({
        level: "warning",
        path,
        message: `can't read the Xcode project: ${(error as Error).message}`,
      });
      continue;
    }
    if (!targets.some((t) => t.hasVersionSettings)) continue;
    const literalValues = targets.every((t) =>
      t.marketingVersions.every((v) => !isBuildSettingReference(v)),
    );
    if (!literalValues) continue;
    const values = safeRead(
      () => pbxproj.read(text, path, {}),
      path,
      notes,
      "can't read the versions",
    );
    if (!values) continue;
    const isCapacitorProject = capacitor && project === joinRel(dir, "ios/App/App.xcodeproj");
    return {
      type: "ios" as const,
      dir,
      source: isCapacitorProject
        ? { kind: "capacitor", dir }
        : { kind: "xcodeproj", file: project },
      files: [{ path, values }],
    };
  }

  for (const path of xcconfigs) {
    const text = await readTextOrNull(absolute(root, path));
    if (text === null || !/\b(MARKETING_VERSION|CURRENT_PROJECT_VERSION)\b/.test(text)) continue;
    const values = safeRead(
      () => xcconfig.read(text, path, undefined),
      path,
      notes,
      "can't read the versions",
    );
    if (values)
      return {
        type: "ios" as const,
        dir,
        source: { kind: "xcconfig", file: path },
        files: [{ path, values }],
      };
  }
  notes.push({
    level: "warning",
    path: projects[0],
    message:
      "iOS project not offered as a target: no native target sets a literal MARKETING_VERSION, and no Info.plist or .xcconfig holds the version",
  });
  return undefined;
}

const EXPO_CONFIG_ADVICE =
  "app.config.js/ts is code, so launchset doesn't edit it. Read the version from package.json and the build number from process.env.LAUNCHSET_BUILD_NUMBER in it (launchset sets LAUNCHSET_VERSION, LAUNCHSET_BUILD_NUMBER and LAUNCHSET_CHANNEL as job outputs).";

async function detectNative(root: string, dir: string, notes: Note[]): Promise<NativeFound> {
  const targets: NativeFound["targets"] = [];
  const appJsonPath = joinRel(dir, "app.json");
  const appJson = await readJson(root, appJsonPath);
  const appConfig = (
    await globRel(root, ["app.config.{js,ts,mjs,cjs}"], { base: dir, deep: 1 })
  )[0];
  if (appConfig) {
    notes.push({ level: "info", path: appConfig, message: EXPO_CONFIG_ADVICE, manual: true });
  }
  if (appJson?.tree && findNodeAtLocation(appJson.tree, ["expo"])?.type === "object") {
    const text = appJson.text;
    const a = safeRead(
      () => expoAndroid.read(text, appJsonPath, undefined),
      appJsonPath,
      notes,
      "can't read expo.version",
    );
    const i = safeRead(
      () => expoIos.read(text, appJsonPath, undefined),
      appJsonPath,
      notes,
      "can't read expo.version",
    );
    if (a)
      targets.push({
        type: "android",
        dir,
        source: { kind: "expo", file: appJsonPath },
        files: [{ path: appJsonPath, values: a }],
      });
    if (i)
      targets.push({
        type: "ios",
        dir,
        source: { kind: "expo", file: appJsonPath },
        files: [{ path: appJsonPath, values: i }],
      });
    if (await isDirectory(absolute(root, joinRel(dir, "android")))) {
      notes.push({
        level: "info",
        path: joinRel(dir, "android"),
        message: "Expo app: the native folders are ignored; launchset stamps app.json.",
      });
    }
    return { targets };
  }
  const capacitor =
    (await globRel(root, ["capacitor.config.{ts,js,json}"], { base: dir, deep: 1 })).length > 0;
  const android = await detectAndroid(root, dir, capacitor, notes);
  if (android) targets.push(android);
  const ios = await detectIos(root, dir, capacitor, notes);
  if (ios) targets.push(ios);
  return { targets };
}

// ---------------------------------------------------------------------------
// Docker

const DEV_DOCKERFILE = /\.(dev|development|local|test|ci|debug)$/i;
/** Dockerfiles that aren't release images: dev containers, tests, fixtures, examples, docs. */
const STRAY_DOCKERFILE =
  /(?:^|\/)(?:\.devcontainer|test|tests|__tests__|fixtures|examples|example|samples|docs)\//;

function orderTags(tags: string[]): string[] {
  const withVersion = tags.filter((t) => t.includes("{version}"));
  return [...withVersion, ...tags.filter((t) => !t.includes("{version}"))];
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function dockerName(dockerfile: string): string {
  const dir = dirOf(dockerfile);
  const file = baseName(dockerfile);
  const variant =
    file === "Dockerfile"
      ? ""
      : slug(file.replace(/^Dockerfile[.-]?/, "").replace(/\.Dockerfile$/, ""));
  const dirPart = dir === "." ? "" : slug(baseName(dir));
  const name = [dirPart, variant].filter(Boolean).join("-") || "docker";
  // Platform names stay free for the native and web targets.
  return ["android", "ios", "web"].includes(name) ? `docker-${name}` : name;
}

// ---------------------------------------------------------------------------

export async function detect(root: string, options: { now?: Date } = {}): Promise<DetectContext> {
  const now = options.now ?? new Date();
  const notes: Note[] = [];

  // Git
  const git = new Git({ cwd: root });
  const inside = await git.exec(["rev-parse", "--is-inside-work-tree"]);
  const gitInfo: Detection["git"] = { repo: inside.code === 0 && inside.stdout.trim() === "true" };
  let tagNames: string[] = [];
  if (gitInfo.repo) {
    const head = await git.tryRevParse("HEAD");
    if (head) gitInfo.head = head;
    const branch = await git.currentBranch();
    if (branch) gitInfo.branch = branch;
    const github = await git.repoFromRemote();
    if (github) gitInfo.github = github;
    tagNames = (await git.tags()).map((t) => t.name);
    const top = await git.topLevel();
    if (absolute(top, ".") !== absolute(root, ".") && (await statOrNull(top))) {
      notes.push({
        level: "warning",
        message: `${root} is not the root of the git repository (${top}); GitHub only reads workflows from .github/workflows at the repository root.`,
      });
    }
  } else {
    notes.push({
      level: "warning",
      message: "not a git repository: tags can't be read and no baseline tag can be created",
    });
  }

  let existingConfig: string | undefined;
  for (const name of CONFIG_FILE_NAMES) {
    if (await isFile(absolute(root, name))) {
      existingConfig = name;
      break;
    }
  }

  // Root package.json
  const pkg = await readJson(root, "package.json");
  const packageJson: Detection["packageJson"] = pkg ? { path: "package.json" } : undefined;
  if (pkg && packageJson) {
    const name = jsonString(pkg.tree, ["name"]);
    if (name) packageJson.name = name;
    const versionNode = pkg.tree ? findNodeAtLocation(pkg.tree, ["version"]) : undefined;
    if (typeof versionNode?.value === "string") {
      packageJson.version = versionNode.value;
      packageJson.line = lineOf(pkg.text, versionNode.offset);
    }
  }
  const workspaces = await workspaceDirs(root, pkg?.tree, notes);

  // Tags
  const tags = tagNames.map(classifyTag).filter((t): t is FoundTag => t !== null);
  const vTags = tags.filter((t) => t.format === "v{version}").length;
  const bareTags = tags.filter((t) => t.format === "{version}").length;
  const gitTagPrefix = bareTags > vTags ? "" : "v";

  // Workflows
  const workflowFiles = (
    await globRel(root, [".github/workflows/*.yml", ".github/workflows/*.yaml"])
  ).filter((p) => !/^launchset-/.test(baseName(p)));
  const workflows: Workflow[] = [];
  for (const path of workflowFiles) {
    const text = (await readTextOrNull(absolute(root, path))) ?? "";
    const parsed = parseWorkflow(path, text);
    if ("error" in parsed) {
      notes.push({ level: "warning", path, message: `can't parse the workflow: ${parsed.error}` });
      continue;
    }
    workflows.push(parsed);
  }
  const builds: DockerBuild[] = [];
  for (const workflow of workflows) {
    // `github.ref_name` is a tag only when tags start the workflow.
    const patterns = workflow.triggers.tagPatterns.map((p) => p.value);
    const tagPrefix = !workflow.triggers.tagEvents
      ? null
      : patterns.length > 0
        ? patterns.every((p) => p.startsWith("v"))
          ? "v"
          : ""
        : gitTagPrefix;
    builds.push(
      ...dockerBuilds(workflow, {
        ...(gitInfo.github ? { github: gitInfo.github } : {}),
        tagPrefix,
      }),
    );
  }

  // Dockerfiles
  const allDockerfiles = (await globRel(root, ["**/Dockerfile*", "**/*.Dockerfile"])).filter(
    (p) => !p.endsWith(".dockerignore") && !p.startsWith(".github/"),
  );
  const dockerfiles = allDockerfiles.filter((p) => !STRAY_DOCKERFILE.test(p));
  const stray = allDockerfiles.filter((p) => STRAY_DOCKERFILE.test(p));
  if (stray.length > 0) {
    notes.push({
      level: "info",
      message: `skipped Dockerfiles in dev container, test, example and docs folders: ${stray.join(", ")}`,
    });
  }
  const used = new Set<string>();
  const targets: DetectedTarget[] = [];
  const matchedBuilds = new Set<DockerBuild>();
  const buildsFor = new Map<string, DockerBuild[]>();
  for (const dockerfile of dockerfiles) {
    const list = builds.filter((b) => b.file === dockerfile);
    for (const b of list) matchedBuilds.add(b);
    buildsFor.set(dockerfile, list);
  }
  if (dockerfiles.length === 1) {
    const only = dockerfiles[0] as string;
    const rest = builds.filter(
      (b) => !matchedBuilds.has(b) && b.images.length + b.unresolved.length > 0,
    );
    buildsFor.set(only, [...(buildsFor.get(only) ?? []), ...rest]);
  }
  const anyBuilt = [...buildsFor.values()].some((l) => l.length > 0);
  // Nothing builds any Dockerfile: only the root one (or the only one) is a likely target.
  const releasable = dockerfiles.filter((p) => !DEV_DOCKERFILE.test(p));
  const likely =
    releasable.length === 1
      ? releasable[0]
      : releasable.includes("Dockerfile")
        ? "Dockerfile"
        : undefined;
  for (const dockerfile of dockerfiles) {
    const all = buildsFor.get(dockerfile) ?? [];
    // Builds in tag-triggered workflows are the release builds: they define the tags.
    const releaseBuilds = all.filter((b) => b.workflow.triggers.tagPatterns.length > 0);
    const list = releaseBuilds.length > 0 ? releaseBuilds : all;
    const evidence: Evidence[] = [...list, ...all.filter((b) => !list.includes(b))].map((b) => ({
      path: b.workflow.path,
      line: b.line,
      note: `${b.step.label} builds ${dockerfile}${b.images.length ? ` as ${b.images.join(", ")}` : ""}`,
    }));
    const docker: DetectedDocker = {
      dockerfile,
      context: list[0]?.context ?? dirOf(dockerfile),
      evidence,
    };
    const images = [...new Set(list.flatMap((b) => b.images))];
    const image = images[0];
    if (image) {
      docker.image = image;
      docker.images = images;
    }
    const unresolved = list.flatMap((b) => b.unresolved)[0];
    if (!image && unresolved) {
      notes.push({
        level: "warning",
        path: list[0]?.workflow.path,
        line: list[0]?.line,
        message: `can't resolve the image name ${unresolved}`,
      });
    }
    const found = orderTags([...new Set(list.flatMap((b) => b.tags))]);
    if (
      found.some((t) => t.includes("{version}")) &&
      !sameList(found, DEFAULT_DOCKER_TAGS.release)
    ) {
      docker.tags = found;
    }
    const platforms = list.find((b) => b.platforms)?.platforms;
    if (platforms) docker.platforms = platforms;
    const dir = dirOf(dockerfile);
    if (dir !== ".") {
      const p = joinRel(dir, "package.json");
      const sub = await readJson(root, p);
      if (sub && jsonString(sub.tree, ["version"]) !== undefined) docker.packageJson = p;
    }
    const built = all.length > 0;
    const dev = DEV_DOCKERFILE.test(dockerfile);
    let proposed: DetectedTarget["proposed"];
    let reason: string;
    let ask = false;
    if (built) {
      proposed = "auto";
      reason = "an existing workflow builds and pushes this image";
    } else if (dev) {
      proposed = "none";
      reason = "looks like a development Dockerfile";
    } else if (anyBuilt) {
      proposed = "none";
      reason = "no workflow builds this Dockerfile (other Dockerfiles are built)";
    } else if (dockerfile === likely) {
      proposed = "auto";
      reason = "Dockerfile found; the release workflow builds it";
    } else {
      proposed = "none";
      reason =
        "no workflow builds any Dockerfile and there are several: decide which ones are released";
      ask = true;
    }
    targets.push({
      name: uniqueName(dockerName(dockerfile), used),
      type: "docker",
      dir,
      files: [],
      builtBy: evidence,
      proposed,
      reason,
      ...(ask ? { ask } : {}),
      docker,
    });
  }

  // Native projects
  const searchDirs = [...new Set([".", ...workspaces])];
  const native: NativeFound["targets"] = [];
  for (const dir of searchDirs) native.push(...(await detectNative(root, dir, notes)).targets);
  const signals = new Map<string, ReturnType<typeof platformBuildSignals>>();
  const ciFiles = [...workflows.map((w) => ({ path: w.path, text: w.text }))];
  const gitlabText = await readTextOrNull(absolute(root, ".gitlab-ci.yml"));
  if (gitlabText !== null) ciFiles.push({ path: ".gitlab-ci.yml", text: gitlabText });
  for (const f of ciFiles) signals.set(f.path, platformBuildSignals(f.text));
  const count = (type: string) => native.filter((t) => t.type === type).length;
  for (const t of native) {
    const builtBy: Evidence[] = [];
    for (const [path, list] of signals) {
      for (const s of list)
        if (s.platform === t.type) builtBy.push({ path, line: s.line, note: s.note });
    }
    const name =
      count(t.type) > 1 ? `${slug(baseName(t.dir === "." ? "app" : t.dir))}-${t.type}` : t.type;
    const auto = builtBy.length > 0;
    targets.push({
      ...t,
      ...summarize(t.files),
      name: uniqueName(name, used),
      builtBy,
      proposed: auto ? "auto" : "manual",
      reason: auto
        ? "an existing workflow builds it"
        : 'no workflow builds it, so it\'s shipped on demand (release: "manual")',
    });
  }
  if (pkg) {
    const otherAuto = targets.some((t) => t.proposed === "auto");
    targets.push({
      name: uniqueName("web", used),
      type: "web",
      dir: ".",
      files: [],
      builtBy: [],
      proposed: otherAuto ? "none" : "auto",
      reason: otherAuto
        ? "other targets already ship this repo"
        : "no other target is released automatically; a web target runs your own build steps for every release",
    });
  }

  // Versions
  const versions: FoundVersion[] = [];
  if (packageJson?.version !== undefined) {
    const v: FoundVersion = {
      source: "root",
      path: "package.json",
      key: "version",
      value: packageJson.version,
      plain: plainVersion(packageJson.version),
    };
    if (packageJson.line !== undefined) v.line = packageJson.line;
    versions.push(v);
  }
  for (const t of targets) {
    if (t.docker?.packageJson) {
      const sub = await readJson(root, t.docker.packageJson);
      const node = sub?.tree ? findNodeAtLocation(sub.tree, ["version"]) : undefined;
      if (sub && typeof node?.value === "string") {
        versions.push({
          source: "docker-package",
          path: t.docker.packageJson,
          line: lineOf(sub.text, node.offset),
          key: "version",
          value: node.value,
          plain: plainVersion(node.value),
        });
      }
    }
    for (const f of t.files) {
      for (const v of f.values) {
        if (v.field !== "marketing") continue;
        versions.push({
          source: "native",
          path: f.path,
          line: v.line,
          key: v.key,
          value: v.value,
          plain: plainVersion(v.value),
        });
      }
    }
  }
  const seen = new Set<string>();
  const unique = versions.filter((v) => {
    const k = `${v.path}:${v.line}:${v.key}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  versions.length = 0;
  versions.push(...unique);
  // `name@1.2.3` tags count only for this repo's own packages.
  const ownPackages = new Set<string>();
  if (packageJson?.name) ownPackages.add(packageJson.name);
  for (const t of targets) {
    const paths = [
      t.docker?.packageJson,
      t.type !== "docker" && t.dir !== "." ? joinRel(t.dir, "package.json") : undefined,
    ];
    for (const path of paths) {
      if (!path) continue;
      const name = jsonString((await readJson(root, path))?.tree, ["name"]);
      if (name) ownPackages.add(name);
    }
  }
  for (const t of tags) {
    if (t.package !== undefined && !ownPackages.has(t.package)) t.counted = false;
    const v: FoundVersion = {
      source: "tag",
      path: t.tag,
      key: t.format,
      value: t.version,
      plain: t.prerelease ? null : t.version,
    };
    if (!t.counted) v.ignored = `tag of another package (${t.package}), not this repo's version`;
    versions.push(v);
  }

  // Canonical version: the highest plain version found.
  const candidates: { version: string; from: FoundVersion }[] = [];
  for (const v of versions) {
    if (v.ignored) continue;
    if (v.plain) candidates.push({ version: v.plain, from: v });
    else if (v.source !== "tag" && semver.valid(v.value) && semver.prerelease(v.value)) {
      // A file on 2.0.0-rc.1 → 2.0.0 (the release that prerelease leads to), so it never goes down.
      const inc = semver.inc(v.value, "patch");
      if (inc) candidates.push({ version: inc, from: v });
    }
  }
  candidates.sort((a, b) => semver.rcompare(a.version, b.version));
  const winner = candidates[0];
  const canonical: Detection["canonical"] = winner
    ? {
        version: winner.version,
        reason: `highest version found (${candidates
          .filter((c) => c.version === winner.version)
          .map((c) => describeVersion(c.from))
          .join(
            ", ",
          )})${candidates.some((c) => semver.lt(c.version, winner.version)) ? "; lower versions are raised to it, never the other way round" : ""}`,
        evidence: candidates
          .filter((c) => c.version === winner.version)
          .map((c) => evidenceOf(c.from, "highest version")),
      }
    : { version: "0.1.0", reason: "no version found anywhere; starting at 0.1.0", evidence: [] };

  // Build numbers
  const strategyNow = computeBuildNumber(
    { strategy: "timestamp", epoch: DEFAULT_EPOCH, offset: 0 },
    { now },
  ) as number;
  let highest: Detection["buildNumbers"]["highest"];
  for (const t of targets) {
    for (const f of t.files) {
      for (const v of f.values) {
        if (v.field !== "build" || !/^\d+$/.test(v.value)) continue;
        const value = Number(v.value);
        if (!highest || value > highest.value)
          highest = { value, path: f.path, line: v.line, key: v.key };
      }
    }
  }
  const offset =
    highest && highest.value >= strategyNow ? roundUpOffset(highest.value - strategyNow + 1) : 0;
  const buildNumbers: Detection["buildNumbers"] = { strategyNow, offset };
  if (highest) buildNumbers.highest = highest;

  // Image pins
  const imagePins = await detectImagePins(root, targets, notes);

  // Machinery
  const packages: PackageScripts[] = [];
  for (const dir of searchDirs) {
    const path = joinRel(dir, "package.json");
    const p = await readJson(root, path);
    const scripts = p?.tree ? findNodeAtLocation(p.tree, ["scripts"]) : undefined;
    if (!p || scripts?.type !== "object") continue;
    const entry: PackageScripts = { path, dir, scripts: {}, lines: {} };
    for (const prop of scripts.children ?? []) {
      const [key, value] = prop.children ?? [];
      if (typeof key?.value === "string" && typeof value?.value === "string") {
        entry.scripts[key.value] = value.value;
        entry.lines[key.value] = lineOf(p.text, key.offset);
      }
    }
    packages.push(entry);
  }
  const scriptCandidates = new Set(referencedScriptFiles(packages, workflows));
  for (const dir of searchDirs) {
    for (const p of await globRel(
      root,
      ["{scripts,bin,tools}/**/*.{js,mjs,cjs,ts,mts,cts,sh,bash,rb,py}"],
      {
        base: dir,
        deep: 4,
      },
    )) {
      scriptCandidates.add(p);
    }
  }
  const scriptFiles: { path: string; text: string }[] = [];
  for (const path of [...scriptCandidates].sort()) {
    const info = await statOrNull(absolute(root, path));
    if (!info?.isFile() || info.size > MAX_SCAN_BYTES) continue;
    scriptFiles.push({ path, text: (await readTextOrNull(absolute(root, path))) ?? "" });
  }
  const fastfiles: { path: string; text: string }[] = [];
  for (const path of await globRel(root, ["**/fastlane/Fastfile"], { deep: 6 })) {
    fastfiles.push({ path, text: (await readTextOrNull(absolute(root, path))) ?? "" });
  }
  const docs: { path: string; text: string }[] = [];
  for (const path of await globRel(
    root,
    ["{CLAUDE,AGENTS,README,readme,Readme}{,.md}", ".claude/CLAUDE.md"],
    { deep: 2 },
  )) {
    docs.push({ path, text: (await readTextOrNull(absolute(root, path))) ?? "" });
  }
  const machinery = detectMachinery({
    workflows,
    dockerBuilds: builds,
    packages,
    scriptFiles,
    ...(gitlabText !== null ? { gitlab: { path: ".gitlab-ci.yml", text: gitlabText } } : {}),
    fastfiles,
    docs,
    samples: sampleTags(
      [...new Set(tags.filter((t) => t.counted && !t.prerelease).map((t) => t.format))],
      targets.map((t) => t.name),
    ),
  });

  // Release tool configuration (the invocations are machinery items).
  for (const path of await globRel(root, RELEASE_TOOL_CONFIGS, { deep: 1 })) {
    notes.push({
      level: "warning",
      path,
      message: `${releaseToolOf(path)} configuration: launchset replaces it; delete this file once the move is done.`,
      manual: true,
    });
  }
  for (const key of ["release", "release-it", "standard-version"]) {
    const node = pkg?.tree ? findNodeAtLocation(pkg.tree, [key]) : undefined;
    if (node && node.type === "object" && pkg) {
      const tool = key === "release" ? "semantic-release" : key;
      notes.push({
        level: "warning",
        path: "package.json",
        line: lineOf(pkg.text, node.parent?.offset ?? node.offset),
        message: `"${key}" holds ${tool} configuration: launchset replaces ${tool}; remove the key once the move is done.`,
        manual: true,
      });
    }
  }

  const existingFiles: string[] = [];
  for (const path of GENERATED_FILES) {
    if (await isFile(absolute(root, path))) existingFiles.push(path);
  }

  const workflowsOut: Detection["workflows"] = ciFiles.map((f) => ({
    path: f.path,
    builds: [
      ...(signals.get(f.path) ?? []),
      ...builds
        .filter((b) => b.workflow.path === f.path)
        .map((b) => ({
          platform: "docker" as const,
          line: b.line,
          note: `builds ${b.file}${b.images.length ? ` as ${b.images.join(", ")}` : ""}`,
        })),
    ],
  }));

  const changesets = await findChangesets(root);
  const hooks = await detectHooks(root);

  const detection: Detection = {
    root,
    git: gitInfo,
    workspaces,
    versions,
    tags,
    canonical,
    targets,
    workflows: workflowsOut,
    machinery: machinery.map((m) => m.item),
    imagePins,
    buildNumbers,
    existingFiles,
    changesets,
    hooks,
    notes,
  };
  if (existingConfig) detection.existingConfig = existingConfig;
  if (packageJson) detection.packageJson = packageJson;
  return {
    detection,
    workflows,
    dockerBuilds: builds,
    machinery,
    packageJsonText: pkg?.text ?? null,
    tagNames,
  };
}

function describeVersion(v: FoundVersion): string {
  if (v.source === "tag") return `tag ${v.path}`;
  return `${v.path}${v.line ? `:${v.line}` : ""} ${v.key} = ${v.value}`;
}

export function evidenceOf(v: FoundVersion, note: string): Evidence {
  if (v.source === "tag") return { path: v.path, note: `${note}: tag ${v.path}` };
  const e: Evidence = { path: v.path, note: `${note}: ${v.key} = ${v.value}` };
  if (v.line !== undefined) e.line = v.line;
  return e;
}

async function detectImagePins(
  root: string,
  targets: DetectedTarget[],
  notes: Note[],
): Promise<ImagePin[]> {
  const images = targets.flatMap((t) =>
    (t.docker?.images ?? []).map((image) => ({ target: t.name, image })),
  );
  if (images.length === 0) return [];
  const files = await globRel(root, ["**/*.{yml,yaml}"], {
    ignore: [
      ".github/**",
      ".gitlab-ci.yml",
      "**/pnpm-lock.yaml",
      "**/Chart.lock",
      "**/.changeset/**",
      "lefthook.yml",
      ".lefthook.yml",
    ],
  });
  const pins: ImagePin[] = [];
  for (const path of files.slice(0, 5000)) {
    const info = await statOrNull(absolute(root, path));
    if (!info || info.size > MAX_SCAN_BYTES) continue;
    const text = (await readTextOrNull(absolute(root, path))) ?? "";
    for (const { target, image } of images) {
      if (
        /(^|\/)kustomization\.ya?ml$/.test(path) &&
        text.includes(image) &&
        /\bnewTag:/.test(text)
      ) {
        notes.push({
          level: "info",
          path,
          message: `pins ${image} with images[].newTag, which launchset doesn't stamp (only <image>:<tag> references)`,
        });
      }
      if (!hasImageRef(text, [image])) continue;
      try {
        const refs = imageRefs
          .read(text, path, { images: [image] })
          .map((v) => ({ line: v.line, tag: v.value }));
        pins.push({ path, target, image, refs });
      } catch (error) {
        notes.push({
          level: "warning",
          path,
          message: `not offered for image stamping: ${(error as Error).message.replace(`${path}: `, "")}`,
        });
      }
    }
  }
  return pins;
}
