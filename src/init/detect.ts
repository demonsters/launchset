/**
 * `launchset init` steps 1–3 (spec 11.1): find versions, platforms, Dockerfiles, existing
 * workflows, conflicting release machinery, image pins and build numbers. Read-only.
 */

import { findNodeAtLocation, type Node as JsonNode, parseTree } from "jsonc-parser";
import semver from "semver";
import { parse as parseYaml } from "yaml";
import { CONFIG_FILE_NAMES } from "../config/load.ts";
import { computeBuildNumber } from "../core/build-number.ts";
import { type BuildNumberConfig, DEFAULT_DOCKER_TAGS } from "../core/config/schema.ts";
import { FORGE_HOSTS, type ForgeHost } from "../core/forge-links.ts";
import { lineOf } from "../core/text.ts";
import { remoteHost, serverUrlFromRemote } from "../flow/ci/index.ts";
import { Git, parseRepoFromRemote } from "../git/index.ts";
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
import { electronBuilderUse, stepPackageDirs } from "./electron.ts";
import {
  detectFlutterApp,
  externalCiNotes,
  findFlutterApps,
  flutterBuildFlagNotes,
} from "./flutter.ts";
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
import { githubJobTargets } from "./github-targets.ts";
import {
  DEFAULT_RELEASE_TAGS,
  GITLAB_CI_FILE,
  type GitLabCi,
  type GitLabDockerBuild,
  gitlabDockerBuilds,
  readGitLabCi,
  unruledJobs,
  workflowTagRules,
} from "./gitlab-scan.ts";
import { dockerTargetJobs, gitlabJobTargets } from "./gitlab-targets.ts";
import { detectHooks } from "./hooks.ts";
import {
  detectMachinery,
  type MachineryFinding,
  type PackageScripts,
  referencedScriptFiles,
  sampleTags,
} from "./machinery.ts";
import { simpleCommands } from "./shell.ts";
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
  type WorkflowJob,
} from "./workflow-scan.ts";

/** Everything detection found, including what writing needs but JSON doesn't show. */
export interface DetectContext {
  detection: Detection;
  workflows: Workflow[];
  dockerBuilds: DockerBuild[];
  /** `.gitlab-ci.yml` with its local includes (`null` without one). */
  gitlab: GitLabCi | null;
  /** Docker builds in the GitLab jobs. */
  gitlabBuilds: GitLabDockerBuild[];
  /** Which code host the repo is on (the `host` decision). */
  host: HostGuess;
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
  ".gitlab/launchset.yml",
  ".gitlab/launchset-targets.yml",
];

/** The code host the repo is on, as far as detection can tell (the `host` decision). */
export interface HostGuess {
  host: ForgeHost;
  evidence: Evidence[];
  /** The signals disagree: ask the human. */
  ask: boolean;
  /** Anything points at GitLab: the `host` decision is shown. */
  gitlabSignals: boolean;
  /** The origin remote's host name. */
  remoteHost?: string;
  /** The GitLab project path from the origin remote (`group/sub/project`). */
  gitlabProject?: string;
}

/**
 * The code host: `LAUNCHSET_HOST`, else `GITLAB_CI=true`, else the origin remote's host (one
 * containing `gitlab` is GitLab, github.com is GitHub), else `.gitlab-ci.yml` without GitHub
 * workflows, else GitHub.
 */
export function guessHost(input: {
  env: Record<string, string | undefined>;
  remoteUrl?: string;
  gitlabCi: boolean;
  githubWorkflows: boolean;
}): HostGuess {
  const evidence: Evidence[] = [];
  const host = input.remoteUrl ? remoteHost(input.remoteUrl) : undefined;
  const remoteGitlab = host?.includes("gitlab") === true;
  const explicit = input.env.LAUNCHSET_HOST?.trim().toLowerCase();
  const fromEnv =
    explicit && (FORGE_HOSTS as readonly string[]).includes(explicit)
      ? (explicit as ForgeHost)
      : undefined;
  const ci = input.env.GITLAB_CI === "true";
  if (fromEnv) evidence.push({ path: "LAUNCHSET_HOST", note: `LAUNCHSET_HOST=${fromEnv}` });
  if (ci) evidence.push({ path: "GITLAB_CI", note: "GITLAB_CI=true: init runs in GitLab CI" });
  if (host) evidence.push({ path: "origin", note: `the origin remote is on ${host}` });
  if (input.gitlabCi) evidence.push({ path: GITLAB_CI_FILE, note: "GitLab CI configuration" });
  if (input.githubWorkflows) {
    evidence.push({ path: ".github/workflows", note: "GitHub Actions workflows" });
  }
  let guess: ForgeHost;
  let ask = false;
  if (fromEnv) guess = fromEnv;
  else if (ci) guess = "gitlab";
  else if (remoteGitlab) {
    guess = "gitlab";
    ask = input.githubWorkflows && !input.gitlabCi;
  } else if (host === "github.com") {
    guess = "github";
    ask = input.gitlabCi && !input.githubWorkflows;
  } else if (input.gitlabCi && !input.githubWorkflows) guess = "gitlab";
  else {
    guess = "github";
    ask = input.gitlabCi;
  }
  const result: HostGuess = {
    host: guess,
    evidence,
    ask,
    gitlabSignals: fromEnv === "gitlab" || ci || remoteGitlab || input.gitlabCi,
  };
  if (host) result.remoteHost = host;
  if (input.remoteUrl && (remoteGitlab || guess === "gitlab")) {
    const project = parseRepoFromRemote(
      input.remoteUrl,
      serverUrlFromRemote(input.remoteUrl),
      "gitlab",
    );
    if (project) result.gitlabProject = project;
  }
  return result;
}

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

async function detectNative(
  root: string,
  dir: string,
  notes: Note[],
  flutterApps: ReadonlySet<string>,
): Promise<NativeFound> {
  if (flutterApps.has(dir)) return { targets: await detectFlutterApp(root, dir, notes) };
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

// ---------------------------------------------------------------------------
// detect(): one section per part of the Detection, in this order (notes are collected in it)

export async function detect(
  root: string,
  options: { now?: Date; env?: Record<string, string | undefined> } = {},
): Promise<DetectContext> {
  const now = options.now ?? new Date();
  const notes: Note[] = [];

  const { gitInfo, tagNames, remoteUrl } = await detectGit(root, notes);
  const existingConfig = await findExistingConfig(root);
  const { pkg, packageJson } = await readRootPackage(root);
  const workspaces = await workspaceDirs(root, pkg?.tree, notes);
  const { tags, gitTagPrefix } = classifyTags(tagNames);
  const { workflows, builds } = await readWorkflows(root, gitInfo, gitTagPrefix, notes);
  const gitlab = await readGitLabCi(root);
  if (gitlab) {
    gitlab.releaseTags = [
      ...new Set([gitTagPrefix, "v"].flatMap((p) => [`${p}1.2.3`, `${p}1.2.3-alpha.0`])),
      ...DEFAULT_RELEASE_TAGS.filter((t) => t.startsWith("launchset/")),
    ];
  }
  for (const n of gitlab?.notes ?? []) {
    notes.push({
      level: "warning",
      path: n.path,
      ...(n.line ? { line: n.line } : {}),
      message: n.message,
    });
  }
  if (gitlab) notes.push(...tagPipelineNotes(gitlab));
  const host = guessHost({
    env: options.env ?? process.env,
    ...(remoteUrl !== undefined ? { remoteUrl } : {}),
    gitlabCi: gitlab !== null,
    githubWorkflows: (await globRel(root, [".github/workflows/*.{yml,yaml}"])).length > 0,
  });
  if (host.gitlabProject) gitInfo.gitlab = host.gitlabProject;
  const gitlabBuilds = gitlab
    ? gitlabDockerBuilds(gitlab, {
        gitTagPrefix,
        ...(host.gitlabProject
          ? {
              project: { path: host.gitlabProject, gitlabCom: host.remoteHost === "gitlab.com" },
            }
          : {}),
      })
    : [];
  const sources = [...builds.map(githubBuildSource), ...gitlabBuilds.map(gitlabBuildSource)];

  /** Target names taken so far (Docker first, then native, then web). */
  const used = new Set<string>();
  const targets = await detectDockerTargets(root, sources, used, notes);
  const flutterApps = await findFlutterApps(root);
  const searchDirs = [...new Set([".", ...workspaces, ...flutterApps])];
  const packages = await readPackageScripts(root, searchDirs);
  const native = await detectNativeTargets(
    root,
    searchDirs,
    new Set(flutterApps),
    workflows,
    gitlab,
    used,
    notes,
  );
  targets.push(...native.targets);
  notes.push(...flutterBuildFlagNotes(native.ciFiles), ...(await externalCiNotes(root)));
  if (host.host === "github") {
    // Jobs that build a target found above aren't custom targets of their own (the other jobs
    // of their workflow still can be).
    const skipJobs = new Set<WorkflowJob>();
    for (const e of targets.filter((t) => t.proposed !== "none").flatMap((t) => t.builtBy)) {
      const workflow = workflows.find((w) => w.path === e.path);
      if (!workflow) continue;
      const job = workflow.jobs.filter((j) => j.line <= (e.line ?? 0)).at(-1);
      for (const j of job ? [job] : workflow.jobs) skipJobs.add(j);
    }
    // Steps may run scripts of a package outside the workspaces (`working-directory: desktop`).
    const stepDirs = stepPackageDirs(workflows.flatMap((w) => w.jobs.flatMap((j) => j.steps)));
    const electronPackages = [
      ...packages,
      ...(await readPackageScripts(
        root,
        stepDirs.filter((d) => !searchDirs.includes(d)),
      )),
    ];
    const fromJobs = githubJobTargets(workflows, {
      releaseTags: [...new Set([gitTagPrefix, "v"])].flatMap((p) => [
        `${p}1.2.3`,
        `${p}1.2.3-alpha.0`,
      ]),
      skipJobs,
      name: (base) => uniqueName(slug(base), used),
      electronBuilder: (steps, env) => electronBuilderUse(steps, electronPackages, env),
    });
    targets.push(...fromJobs.targets);
    notes.push(...fromJobs.notes);
  }
  if (gitlab) {
    const dockerfiles = new Set(
      targets.flatMap((t) => (t.docker && t.proposed !== "none" ? [t.docker.dockerfile] : [])),
    );
    targets.push(
      ...gitlabJobTargets(gitlab, {
        skipJobs: dockerTargetJobs(gitlab, gitlabBuilds, dockerfiles),
        name: (base) => uniqueName(slug(base), used),
      }),
    );
  }
  const npm = npmTarget(pkg, workflows, gitlab, targets, used);
  if (npm) targets.push(npm);
  // A Flutter-only repo has no package.json, but still gets the web target as the auto target
  // of last resort (a config needs one) or for its Flutter web build.
  if (pkg || flutterApps.length > 0) targets.push(webTarget(targets, used));

  const versions = await collectVersions(root, packageJson, targets, tags);
  const canonical = pickCanonical(versions);
  const buildNumbers = buildNumberInfo(targets, now);
  notes.push(...nearLimitNotes(buildNumbers));
  const imagePins = await detectImagePins(
    root,
    targets,
    (gitlab?.files ?? []).map((f) => f.path),
    notes,
  );
  const machinery = await detectProjectMachinery(root, {
    searchDirs,
    packages,
    workflows,
    builds,
    gitlab,
    gitlabBuilds,
    tags,
    targets,
  });
  await releaseToolNotes(root, pkg, notes);

  const detection: Detection = {
    root,
    git: gitInfo,
    workspaces,
    flutterApps,
    versions,
    tags,
    canonical,
    targets,
    workflows: workflowSummaries(native.ciFiles, native.signals, sources),
    machinery: machinery.map((m) => m.item),
    imagePins,
    buildNumbers,
    existingFiles: await existingGeneratedFiles(root),
    changesets: await findChangesets(root),
    hooks: await detectHooks(root),
    notes,
  };
  if (existingConfig) detection.existingConfig = existingConfig;
  if (packageJson) detection.packageJson = packageJson;
  return {
    detection,
    workflows,
    dockerBuilds: builds,
    gitlab,
    gitlabBuilds,
    host,
    machinery,
    packageJsonText: pkg?.text ?? null,
    tagNames,
  };
}

/**
 * A note per `workflow: rules` entry that starts tag pipelines: which of launchset's tags would
 * start one, and what to change. init never edits `workflow:` (it decides every pipeline).
 */
export function tagPipelineNotes(ci: GitLabCi): Note[] {
  const jobs = unruledJobs(ci).map((j) => j.name);
  const shown = jobs.length > 6 ? [...jobs.slice(0, 5), `${jobs.length - 5} more`] : jobs;
  const everyJob =
    jobs.length > 0
      ? `every job without rules (${shown.join(", ")})`
      : "every job whose rules allow tags";
  return workflowTagRules(ci).map((rule) => ({
    level: "info",
    manual: true,
    path: rule.path,
    line: rule.line,
    message: `workflow: rules start a pipeline for every tag push (- if: ${rule.condition}), which runs ${everyJob}. On GitLab launchset pushes all its tags (the markers launchset/<target>@<version>, partial tags, v<version> and prerelease tags) with git push -o ci.skip, so they start none (gitlab.tagPipelines: true in launchset.config lets the release and prerelease tags start one). Other tag pushes still do, e.g. a tag pushed by hand. If the rule was only there for the release jobs launchset replaces, remove it; init doesn't edit workflow:.`,
  }));
}

/** The repo: HEAD, branch, GitHub repository and tag names. */
async function detectGit(
  root: string,
  notes: Note[],
): Promise<{ gitInfo: Detection["git"]; tagNames: string[]; remoteUrl?: string }> {
  const git = new Git({ cwd: root });
  let remoteUrl: string | undefined;
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
    if (await git.hasRemote()) remoteUrl = await git.remoteUrl();
  } else {
    notes.push({
      level: "warning",
      message: "not a git repository: tags can't be read and no baseline can be set",
    });
  }
  return { gitInfo, tagNames, ...(remoteUrl !== undefined ? { remoteUrl } : {}) };
}

/** The launchset config file already in `root`, if any. */
async function findExistingConfig(root: string): Promise<string | undefined> {
  for (const name of CONFIG_FILE_NAMES) {
    if (await isFile(absolute(root, name))) return name;
  }
  return undefined;
}

/** The root package.json: its text and tree, and name, version and version line. */
async function readRootPackage(root: string): Promise<{
  pkg: { text: string; tree?: JsonNode } | null;
  packageJson: Detection["packageJson"];
}> {
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
  return { pkg, packageJson };
}

/** The repo's version tags, and the tag prefix most of them use (`v` unless bare wins). */
function classifyTags(tagNames: readonly string[]): { tags: FoundTag[]; gitTagPrefix: string } {
  const tags = tagNames.map(classifyTag).filter((t): t is FoundTag => t !== null);
  const vTags = tags.filter((t) => t.format === "v{version}").length;
  const bareTags = tags.filter((t) => t.format === "{version}").length;
  return { tags, gitTagPrefix: bareTags > vTags ? "" : "v" };
}

/** The GitHub workflows (launchset's own left out) and the Docker builds in them. */
async function readWorkflows(
  root: string,
  gitInfo: Detection["git"],
  gitTagPrefix: string,
  notes: Note[],
): Promise<{ workflows: Workflow[]; builds: DockerBuild[] }> {
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
  return { workflows, builds };
}

/** A Docker build in a GitHub workflow or a GitLab job, as Docker target detection reads it. */
interface BuildSource {
  path: string;
  line: number;
  /** `step "Build"`, `job "build"`. */
  label: string;
  file: string;
  context: string;
  images: string[];
  unresolved: string[];
  tags: string[];
  platforms?: string;
  /** Tags start it: its tags are the release tags. */
  release: boolean;
  gitlab: boolean;
}

function githubBuildSource(b: DockerBuild): BuildSource {
  const s: BuildSource = {
    path: b.workflow.path,
    line: b.line,
    label: b.step.label,
    file: b.file,
    context: b.context,
    images: b.images,
    unresolved: b.unresolved,
    tags: b.tags,
    release: b.workflow.triggers.tagPatterns.length > 0,
    gitlab: false,
  };
  if (b.platforms) s.platforms = b.platforms;
  return s;
}

function gitlabBuildSource(b: GitLabDockerBuild): BuildSource {
  const s: BuildSource = {
    path: b.path,
    line: b.line,
    label: b.label,
    file: b.file,
    context: b.context,
    images: b.images,
    unresolved: b.unresolved,
    tags: b.tags,
    release: b.release,
    gitlab: true,
  };
  if (b.platforms) s.platforms = b.platforms;
  return s;
}

/** A Docker target per Dockerfile, with what the workflows' builds say about it. */
async function detectDockerTargets(
  root: string,
  builds: readonly BuildSource[],
  used: Set<string>,
  notes: Note[],
): Promise<DetectedTarget[]> {
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
  const targets: DetectedTarget[] = [];
  const matchedBuilds = new Set<BuildSource>();
  const buildsFor = new Map<string, BuildSource[]>();
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
    const releaseBuilds = all.filter((b) => b.release);
    const list = releaseBuilds.length > 0 ? releaseBuilds : all;
    const evidence: Evidence[] = [...list, ...all.filter((b) => !list.includes(b))].map((b) => ({
      path: b.path,
      line: b.line,
      note: `${b.label} builds ${dockerfile}${b.images.length ? ` as ${b.images.join(", ")}` : ""}`,
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
        path: list[0]?.path,
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
      reason = all.every((b) => b.gitlab)
        ? "an existing GitLab CI job builds this image"
        : "an existing workflow builds and pushes this image";
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
  return targets;
}

/**
 * Android and iOS targets in the search dirs, proposed `auto` when a CI file builds the
 * platform. Also returns the CI files (GitHub workflows, `.gitlab-ci.yml`) and their signals.
 */
async function detectNativeTargets(
  root: string,
  searchDirs: readonly string[],
  flutterApps: ReadonlySet<string>,
  workflows: readonly Workflow[],
  gitlab: GitLabCi | null,
  used: Set<string>,
  notes: Note[],
): Promise<{
  targets: DetectedTarget[];
  ciFiles: { path: string; text: string }[];
  signals: Map<string, ReturnType<typeof platformBuildSignals>>;
}> {
  const native: NativeFound["targets"] = [];
  for (const dir of searchDirs) {
    native.push(...(await detectNative(root, dir, notes, flutterApps)).targets);
  }
  const signals = new Map<string, ReturnType<typeof platformBuildSignals>>();
  const ciFiles = [...workflows.map((w) => ({ path: w.path, text: w.text }))];
  if (gitlab && gitlab.files.length > 0) {
    ciFiles.push(...gitlab.files.map((f) => ({ path: f.path, text: f.text })));
  } else if (gitlab) {
    // A .gitlab-ci.yml that doesn't parse: its lines still show what it builds.
    const text = await readTextOrNull(absolute(root, GITLAB_CI_FILE));
    if (text !== null) ciFiles.push({ path: GITLAB_CI_FILE, text });
  }
  for (const f of ciFiles) signals.set(f.path, platformBuildSignals(f.text));
  const count = (type: string) => native.filter((t) => t.type === type).length;
  const targets: DetectedTarget[] = [];
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
  return { targets, ciFiles, signals };
}

/** A command that publishes an npm package, or runs a tool that does (Changesets, semantic-release). */
const NPM_PUBLISH =
  /^(?:(?:npm|pnpm|bun)\s+(?:-\S+\s+)*publish\b|yarn\s+(?:npm\s+)?publish\b|changeset\s+publish\b|semantic-release\b|release-it\b)/;
/** Only the release tools among {@link NPM_PUBLISH} (init retires them wherever they run). */
const NPM_PUBLISH_TOOL = /^(?:changeset\s+publish\b|semantic-release\b|release-it\b)/;

/**
 * The commands of `script` that publish the root package to npm, following `npm run <x>` /
 * `pnpm <x>` into the root package.json scripts (once).
 */
function publishesToNpm(
  script: string,
  scripts: Record<string, string>,
  pattern = NPM_PUBLISH,
  depth = 0,
): boolean {
  return simpleCommands(script).some(({ text }) => {
    if (pattern.test(text) && !/\s(?:--dry-run|--help|-h)\b/.test(text)) return true;
    if (depth > 0) return false;
    const run = /^(?:npm\s+run|pnpm(?:\s+run)?|yarn(?:\s+run)?|bun\s+run)\s+([\w:.-]+)/.exec(text);
    const name = run?.[1];
    return (
      name !== undefined &&
      scripts[name] !== undefined &&
      publishesToNpm(scripts[name], scripts, pattern, 1)
    );
  });
}

/**
 * An `npm` target when the root package is published to npm today by release machinery init
 * retires (`changesets/action`'s `publish`, `changeset publish`, semantic-release, a plain
 * `npm publish` outside the jobs that became targets). Without it, retiring that machinery would
 * quietly stop publishing the package. Private packages have nothing to publish.
 */
function npmTarget(
  pkg: { text: string; tree?: JsonNode } | null,
  workflows: readonly Workflow[],
  gitlab: GitLabCi | null,
  targets: readonly DetectedTarget[],
  used: Set<string>,
): DetectedTarget | undefined {
  if (!pkg?.tree) return undefined;
  if (findNodeAtLocation(pkg.tree, ["private"])?.value === true) return undefined;
  const name = jsonString(pkg.tree, ["name"]);
  if (!name) return undefined;
  const scriptsNode = findNodeAtLocation(pkg.tree, ["scripts"]);
  const scripts: Record<string, string> = {};
  for (const prop of scriptsNode?.type === "object" ? (scriptsNode.children ?? []) : []) {
    const [key, value] = prop.children ?? [];
    if (typeof key?.value === "string" && typeof value?.value === "string") {
      scripts[key.value] = value.value;
    }
  }
  const covered = new Set(
    targets.flatMap((t) =>
      t.github
        ? [`${t.github.path}#${t.github.job}`]
        : t.gitlab
          ? [`${t.gitlab.path}#${t.gitlab.job}`]
          : [],
    ),
  );
  const evidence: Evidence[] = [];
  for (const w of workflows) {
    // A plain `npm publish` only goes when init retires the workflow's trigger (tags, releases,
    // every push); the release tools go wherever they run.
    const t = w.triggers;
    const retired = t.tagEvents || t.unfilteredPush || t.release !== undefined;
    for (const job of w.jobs) {
      if (covered.has(`${w.path}#${job.id}`)) continue;
      for (const step of job.steps) {
        const uses = step.uses?.replace(/@.*/, "");
        const publishInput = uses === "changesets/action" ? step.with.get("publish") : undefined;
        if (publishInput && publishesToNpm(publishInput.value, scripts)) {
          evidence.push({
            path: w.path,
            line: step.line,
            note: `changesets/action publishes (${publishInput.value})`,
          });
        } else if (uses && /^js-devtools\/npm-publish$/i.test(uses)) {
          evidence.push({ path: w.path, line: step.line, note: `uses ${uses}` });
        } else if (
          step.run &&
          publishesToNpm(step.run.value, scripts, retired ? NPM_PUBLISH : NPM_PUBLISH_TOOL)
        ) {
          evidence.push({ path: w.path, line: step.line, note: `${step.label} publishes to npm` });
        }
      }
    }
  }
  for (const job of gitlab?.jobs.values() ?? []) {
    if (job.hidden || covered.has(`${job.path}#${job.name}`)) continue;
    const script = job.data.script;
    const lines = (Array.isArray(script) ? script : [script]).filter(
      (l): l is string => typeof l === "string",
    );
    if (lines.some((l) => publishesToNpm(l, scripts))) {
      evidence.push({
        path: job.path,
        line: job.line,
        note: `GitLab job "${job.name}" publishes to npm`,
      });
    }
  }
  if (evidence.length === 0) return undefined;
  return {
    name: uniqueName("npm", used),
    type: "custom",
    dir: ".",
    files: [],
    builtBy: evidence,
    proposed: "auto",
    ask: true,
    reason: `${evidence[0]?.note} (${evidence[0]?.path}:${evidence[0]?.line}); init retires that release machinery, so launchset publishes ${name} to npm when a release ships`,
    npm: { package: "package.json", name },
  };
}

/** The web target of a repo with a package.json: `auto` unless another target ships it. */
function webTarget(targets: readonly DetectedTarget[], used: Set<string>): DetectedTarget {
  const otherAuto = targets.some((t) => t.proposed === "auto");
  return {
    name: uniqueName("web", used),
    type: "web",
    dir: ".",
    files: [],
    builtBy: [],
    proposed: otherAuto ? "none" : "auto",
    reason: otherAuto
      ? "other targets already ship this repo"
      : "no other target is released automatically; a web target runs your own build steps for every release",
  };
}

/**
 * Every version found: the root package.json, Docker targets' package.json files, native
 * marketing versions (each place once), then the tags. Tags of other packages are marked
 * `counted: false` (on `tags` too).
 */
async function collectVersions(
  root: string,
  packageJson: Detection["packageJson"],
  targets: readonly DetectedTarget[],
  tags: FoundTag[],
): Promise<FoundVersion[]> {
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
    unique.push(v);
  }
  return unique;
}

/** The canonical version: the highest plain version found (a prerelease file counts as its release). */
function pickCanonical(versions: readonly FoundVersion[]): Detection["canonical"] {
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
  return winner
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
}

/**
 * The `buildNumber` settings init writes: only `offset` is ever set, so the strategy is
 * `timestamp` with the default epoch and unit (seconds).
 */
const INIT_BUILD_NUMBER: BuildNumberConfig = {
  strategy: "timestamp",
  epoch: DEFAULT_EPOCH,
  offset: 0,
};

/**
 * The `offset` that keeps the build numbers of `settings` (a `timestamp` strategy, any unit)
 * above `highest` from `now` on: 0 when they already are, else the minimum rounded up to two
 * significant digits.
 */
export function offsetAbove(highest: number, settings: BuildNumberConfig, now: Date): number {
  const strategyNow = computeBuildNumber({ ...settings, offset: 0 }, { now }) as number;
  return highest >= strategyNow ? roundUpOffset(highest - strategyNow + 1) : 0;
}

/** The timestamp strategy's number now, the highest committed build number and the offset. */
function buildNumberInfo(targets: readonly DetectedTarget[], now: Date): Detection["buildNumbers"] {
  const strategyNow = computeBuildNumber(INIT_BUILD_NUMBER, { now }) as number;
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
  const offset = highest ? offsetAbove(highest.value, INIT_BUILD_NUMBER, now) : 0;
  const buildNumbers: Detection["buildNumbers"] = { strategyNow, offset };
  if (highest) buildNumbers.highest = highest;
  return buildNumbers;
}

/** Google Play's limit for `versionCode` (spec 6.3). */
const PLAY_LIMIT = 2_100_000_000;

/**
 * A warning when the build numbers in the files are so high (date-based numbers like
 * `2024112701`) that the offset leaves little room below Google Play's limit.
 */
function nearLimitNotes(b: Detection["buildNumbers"]): Note[] {
  const h = b.highest;
  if (!h || h.value < PLAY_LIMIT * 0.9) return [];
  const room = PLAY_LIMIT - h.value;
  const years = room / (365.25 * 24 * 3600);
  return [
    {
      level: "warning",
      path: h.path,
      line: h.line,
      message: `build number ${h.value} (${h.key}) is close to Google Play's limit of 2,100,000,000. New numbers must stay above it, so with the timestamp strategy in seconds there is room for about ${years < 1 ? "less than a year" : `${Math.floor(years)} year(s)`}; unit "minute" lasts about 60 times longer. A number that was never uploaded to a store doesn't need the offset: set it to 0.`,
    },
  ];
}

/** The scripts of the package.json in each of `dirs` (the root and the workspaces). */
async function readPackageScripts(
  root: string,
  dirs: readonly string[],
): Promise<PackageScripts[]> {
  const packages: PackageScripts[] = [];
  for (const dir of dirs) {
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
  return packages;
}

/** Release machinery: package scripts, script files, workflows, GitLab CI, Fastfiles, docs. */
async function detectProjectMachinery(
  root: string,
  input: {
    searchDirs: readonly string[];
    packages: PackageScripts[];
    workflows: Workflow[];
    builds: DockerBuild[];
    gitlab: GitLabCi | null;
    gitlabBuilds: GitLabDockerBuild[];
    tags: readonly FoundTag[];
    targets: readonly DetectedTarget[];
  },
): Promise<MachineryFinding[]> {
  const packages = input.packages;
  const scriptCandidates = new Set(referencedScriptFiles(packages, input.workflows));
  for (const dir of input.searchDirs) {
    for (const p of await globRel(
      root,
      ["{scripts,bin,tools,tool}/**/*.{js,mjs,cjs,ts,mts,cts,sh,bash,rb,py,dart}"],
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
  const { gitlab, tags } = input;
  return detectMachinery({
    workflows: input.workflows,
    dockerBuilds: input.builds,
    packages,
    scriptFiles,
    ...(gitlab ? { gitlabCi: gitlab, gitlabBuilds: input.gitlabBuilds } : {}),
    fastfiles,
    docs,
    samples: sampleTags(
      [...new Set(tags.filter((t) => t.counted && !t.prerelease).map((t) => t.format))],
      input.targets.map((t) => t.name),
    ),
  });
}

/** Notes for release tool configuration (the invocations are machinery items). */
async function releaseToolNotes(
  root: string,
  pkg: { text: string; tree?: JsonNode } | null,
  notes: Note[],
): Promise<void> {
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
}

/** Files init generates that already exist. */
async function existingGeneratedFiles(root: string): Promise<string[]> {
  const existing: string[] = [];
  for (const path of GENERATED_FILES) {
    if (await isFile(absolute(root, path))) existing.push(path);
  }
  return existing;
}

/** Per CI file: the platform builds and Docker builds found in it. */
function workflowSummaries(
  ciFiles: readonly { path: string; text: string }[],
  signals: ReadonlyMap<string, ReturnType<typeof platformBuildSignals>>,
  builds: readonly BuildSource[],
): Detection["workflows"] {
  return ciFiles.map((f) => ({
    path: f.path,
    builds: [
      ...(signals.get(f.path) ?? []),
      ...builds
        .filter((b) => b.path === f.path)
        .map((b) => ({
          platform: "docker" as const,
          line: b.line,
          note: `builds ${b.file}${b.images.length ? ` as ${b.images.join(", ")}` : ""}`,
        })),
    ],
  }));
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
  ciFiles: readonly string[],
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
      ".gitlab/**",
      ...ciFiles,
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
