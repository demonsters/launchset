/**
 * Renders the three GitHub workflow files (spec 3, 9.2, 9.3, 9.7) from the template files in
 * `templates/workflows/` and a resolved config. Pure apart from reading the template files.
 *
 * Template syntax: `@@name@@`. A line that holds only a token is replaced by the (possibly
 * multi-line) value, indented like the token; an empty value removes the line. A token inside
 * a line is replaced by the (single-line) value. A token without a value is an error, and so
 * is a rendered file that no longer parses as YAML.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type {
  ResolvedAndroidTarget,
  ResolvedConfig,
  ResolvedCustomTarget,
  ResolvedDockerTarget,
  ResolvedIosTarget,
  ResolvedTarget,
} from "../core/config/schema.ts";
import { ConfigError, hostConfigIssues } from "../core/config/schema.ts";
import { LaunchsetError } from "../core/errors.ts";

export interface WorkflowTemplateInput {
  config: ResolvedConfig;
  /** Action reference, default "demonsters/launchset-action@v1" ("./action" for launchset itself). */
  actionRef?: string;
  /** Extra info init found per target, e.g. Dockerfile path and build context. */
  hints?: Record<string, WorkflowHint>;
  /**
   * Put every target's build steps (and "build steps missing" placeholder) into the preview
   * workflow, not only those of `preview.targets`. init narrows `preview.targets` to the targets
   * that have build steps; one added back later must still find its placeholder there, or its
   * preview would pass without building anything.
   */
  allPreviewSteps?: boolean;
}

/** What init found out about how a target was built before (see {@link WorkflowTemplateInput}). */
export interface WorkflowHint {
  dockerfile?: string;
  context?: string;
  platforms?: string;
  /** A custom target's job in an existing workflow: its steps go in, commented out. */
  moved?: {
    path: string;
    job: string;
    /** Its steps as YAML, each starting with `if: @@if@@`. */
    steps: string;
    runsOn?: string;
    /** `with:` lines of its `actions/checkout` step. */
    checkoutWith?: string[];
    /** More things to check (env, defaults, matrix, needs), one sentence each. */
    notes?: string[];
  };
}

export interface RenderedFile {
  /** Repo-relative POSIX path, e.g. `.github/workflows/launchset-check.yml`. */
  path: string;
  content: string;
}

export const DEFAULT_ACTION_REF = "demonsters/launchset-action@v1";

// ---------------------------------------------------------------------------
// Locating the template files

let cachedTemplatesDir: string | undefined;

/**
 * The package's `templates/` directory (it holds `workflows/`).
 *
 * The files sit at the package root, next to `src/` in the repo and next to `dist/` in the
 * published npm package (`package.json` `files` lists `templates`). This module runs from
 * `src/templates/workflows.ts` in tests and development, and ends up inside a bundled
 * `dist/*.js` (one level below the package root, maybe deeper for shared chunks) in the
 * published package. A fixed relative URL would be right for only one of them, so this walks up
 * from this module until it finds a directory with `templates/workflows`.
 */
export function templatesDir(): string {
  if (cachedTemplatesDir) return cachedTemplatesDir;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth++) {
    const candidate = join(dir, "templates");
    if (existsSync(join(candidate, "workflows"))) {
      cachedTemplatesDir = candidate;
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new LaunchsetError(
    "templates-not-found",
    "Could not find the launchset workflow templates (templates/workflows).",
    { hint: "This is a packaging bug: the templates folder must ship next to dist/." },
  );
}

/** A template file below `templates/<folder>/`, with CRLF and trailing newlines removed. */
export function readTemplateFile(folder: string, name: string): string {
  const text = readFileSync(join(templatesDir(), folder, name), "utf8");
  return text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

function readTemplate(name: string): string {
  return readTemplateFile("workflows", name);
}

// ---------------------------------------------------------------------------
// Template engine

const TOKEN = /@@([a-z_]+)@@/g;

/** Fills `@@name@@` tokens (see the file comment). Exported for tests. */
export function fillTemplate(template: string, values: Record<string, string>, label = "template") {
  const lookup = (name: string): string => {
    const value = values[name];
    if (value === undefined) {
      throw new LaunchsetError("template-token", `Unknown token @@${name}@@ in ${label}.`);
    }
    return value;
  };
  const out: string[] = [];
  for (const line of template.split("\n")) {
    const whole = /^(\s*)@@([a-z_]+)@@\s*$/.exec(line);
    if (whole) {
      const value = lookup(whole[2] as string);
      if (value === "") continue;
      const indent = whole[1] as string;
      for (const valueLine of value.split("\n")) {
        out.push(valueLine === "" ? "" : indent + valueLine);
      }
      continue;
    }
    out.push(line.replace(TOKEN, (_match, name: string) => lookup(name)));
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Small helpers

/** A YAML double-quoted scalar (JSON strings are valid YAML). */
const quote = (value: string) => JSON.stringify(value);

/** A GitHub expression: `${{ inner }}`. */
const gh = (inner: string) => `\${{ ${inner} }}`;

/** A single-quoted GitHub expression string literal. */
const exprString = (value: string) => `'${value.replaceAll("'", "''")}'`;

const yamlList = (items: string[]) => items.map((item) => `- ${quote(item)}`).join("\n");

export const unique = <T>(items: T[]): T[] => [...new Set(items)];

/** A plain YAML scalar when that is safe, otherwise a quoted one. */
function scalar(value: string): string {
  return /^[A-Za-z0-9_./,][A-Za-z0-9_./,-]*$/.test(value) ? value : quote(value);
}

// ---------------------------------------------------------------------------
// Which targets each workflow builds

/** Every target: auto targets are built by releases, manual ones by `ship` runs. */
function releaseTargets(config: ResolvedConfig): ResolvedTarget[] {
  return Object.values(config.targets);
}

/** `preview.targets` plus the per-branch overrides, in config order. */
function previewTargets(config: ResolvedConfig): ResolvedTarget[] {
  const wanted = new Set<string>();
  const sets = [config.preview.targets, ...config.preview.branches.map((b) => b.targets)];
  let all = false;
  for (const set of sets) {
    if (set === undefined) continue;
    if (set === "all") all = true;
    else for (const name of set) wanted.add(name);
  }
  return Object.values(config.targets).filter((t) => all || wanted.has(t.name));
}

// ---------------------------------------------------------------------------
// Per-target snippet data

type Mode = "release" | "preview";

/** `matrix.target == 'x'`, or `contains(fromJSON('["x","y"]'), matrix.target)`. */
function targetCondition(names: string[]): string {
  const [only] = names;
  if (names.length === 1 && only !== undefined) return `matrix.target == ${exprString(only)}`;
  return `contains(fromJSON(${exprString(JSON.stringify(names))}), matrix.target)`;
}

/** The `if` of a build step: this target, and, for a release, not yet published. */
function stepCondition(target: ResolvedTarget, mode: Mode): string {
  let condition = targetCondition([target.name]);
  if (mode === "release") condition += " && steps.verify.outputs.already-published != 'true'";
  // PR and branch previews don't go to npm: only real prereleases do.
  if (mode === "preview" && isNpmTarget(target)) {
    condition += " && steps.stamp.outputs.channel == 'prerelease'";
  }
  return condition;
}

export function isNpmTarget(target: ResolvedTarget): target is ResolvedCustomTarget {
  return target.type === "custom" && (target.verify.includes("npm") || target.npm !== undefined);
}

const GITHUB_REGISTRY = "ghcr.io";
const DOCKER_HUB_HOSTS = new Set(["docker.io", "index.docker.io", "registry-1.docker.io"]);

/** Registry host of an image name; `docker.io` for Docker Hub names without a host. */
export function registryOf(image: string): string {
  const first = image.split("/")[0] as string;
  const hasHost =
    image.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost");
  if (!hasHost || DOCKER_HUB_HOSTS.has(first)) return "docker.io";
  return first;
}

function dockerRegistries(target: ResolvedDockerTarget): string[] {
  return unique(target.image.map(registryOf));
}

export function androidDir(target: ResolvedAndroidTarget): string {
  const source = target.source;
  switch (source.kind) {
    case "gradle": {
      const dir = posix.dirname(posix.normalize(source.file));
      return posix.basename(dir) === "app" ? posix.dirname(dir) : dir;
    }
    case "gradle-properties":
      return posix.dirname(posix.normalize(source.file));
    case "capacitor":
      return posix.join(source.dir, "android");
    case "expo":
      return "android";
    case "flutter":
      return posix.join(source.dir, "android");
  }
}

/** The Flutter project folder of a target with `source: { kind: "flutter" }`, else undefined. */
export function flutterDir(target: ResolvedTarget): string | undefined {
  if (target.type !== "android" && target.type !== "ios") return undefined;
  return target.source.kind === "flutter" ? posix.normalize(target.source.dir) : undefined;
}

export function iosProject(target: ResolvedIosTarget): string {
  const source = target.source;
  switch (source.kind) {
    case "xcodeproj":
      return posix.normalize(source.file);
    case "capacitor":
      return posix.join(source.dir, "ios/App/App.xcodeproj");
    case "flutter":
      return posix.join(source.dir, "ios/Runner.xcodeproj");
    default:
      return "<path to App.xcodeproj>";
  }
}

export function iosScheme(project: string): string {
  const base = posix.basename(project);
  return base.endsWith(".xcodeproj") ? base.slice(0, -".xcodeproj".length) : "App";
}

/** Credentials the `verify` step needs for the configured checks (names only). */
function verifyEnv(targets: ResolvedTarget[]): string {
  const keys: string[] = [];
  for (const target of targets) {
    if (target.type === "android" && target.verify.includes("store")) {
      keys.push("LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON");
    }
    if (target.type === "ios" && target.verify.includes("store")) {
      keys.push("LAUNCHSET_ASC_KEY_ID", "LAUNCHSET_ASC_ISSUER_ID", "LAUNCHSET_ASC_PRIVATE_KEY");
    }
  }
  const lines = unique(keys).map((key) => `  ${key}: ${gh(`secrets.${key}`)}`);
  if (targets.some((t) => t.type === "custom" && t.verify.includes("npm"))) {
    lines.push(`  NODE_AUTH_TOKEN: ${gh("secrets.NPM_TOKEN")}`);
  }
  if (lines.length === 0) return "";
  return [
    "env:",
    "  # Credentials for the store and npm checks (secrets, referenced by name only).",
    ...lines,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Build job parts

interface BuildParts {
  runsOn: string;
  permissions: string;
  loginSteps: string;
  buildSteps: string;
  verifyEnv: string;
}

function buildSnippet(
  target: ResolvedTarget,
  mode: Mode,
  hints: NonNullable<WorkflowTemplateInput["hints"]>,
): string {
  const common = { target: target.name, if: stepCondition(target, mode) };
  const flutter = flutterDir(target);
  if (flutter !== undefined && (target.type === "android" || target.type === "ios")) {
    const file = `snippets/flutter-${target.type}.yml`;
    return fillTemplate(
      readTemplate(file),
      {
        ...common,
        flutter_dir: scalar(flutter),
        pubspec: posix.join(flutter, "pubspec.yaml"),
        package_name:
          (target.type === "android" ? target.store?.packageName : undefined) ??
          "<your.package.name>",
      },
      file,
    );
  }
  switch (target.type) {
    case "docker": {
      const hint = hints[target.name] ?? {};
      return fillTemplate(
        readTemplate("snippets/docker.yml"),
        {
          ...common,
          context: scalar(hint.context ?? "."),
          file_line: hint.dockerfile ? `file: ${scalar(hint.dockerfile)}` : "",
          platforms_line: hint.platforms ? `platforms: ${scalar(hint.platforms)}` : "",
        },
        "snippets/docker.yml",
      );
    }
    case "android":
      return fillTemplate(
        readTemplate("snippets/android.yml"),
        {
          ...common,
          android_dir: scalar(androidDir(target)),
          package_name: target.store?.packageName ?? "<your.package.name>",
        },
        "snippets/android.yml",
      );
    case "ios": {
      const project = iosProject(target);
      return fillTemplate(
        readTemplate("snippets/ios.yml"),
        { ...common, xcodeproj: project, scheme: iosScheme(project) },
        "snippets/ios.yml",
      );
    }
    case "web":
      return fillTemplate(readTemplate("snippets/web.yml"), common, "snippets/web.yml");
    case "custom": {
      if (isNpmTarget(target)) {
        return fillTemplate(
          readTemplate("snippets/custom-npm.yml"),
          common,
          "snippets/custom-npm.yml",
        );
      }
      const moved = hints[common.target]?.moved;
      const example = moved
        ? movedSteps(moved, common.if)
        : fillTemplate(
            readTemplate("snippets/custom-example.yml"),
            common,
            "snippets/custom-example.yml",
          );
      return fillTemplate(
        readTemplate("snippets/custom.yml"),
        { ...common, example },
        "snippets/custom.yml",
      );
    }
  }
}

/** The steps of the job a custom target comes from, commented out, with notes. */
function movedSteps(moved: NonNullable<WorkflowHint["moved"]>, condition: string): string {
  const notes = [
    `The steps of job "${moved.job}" in ${moved.path}, which ran on release tags. Check them,`,
    "uncomment them and remove the step above. `stamp` already wrote the version into this",
    "target's files, and the checkout above is the release commit.",
  ];
  if (moved.checkoutWith && moved.checkoutWith.length > 0) {
    notes.push(
      `That job checked out with ${moved.checkoutWith.map((w) => `\`${w}\``).join(", ")}: add what it needs to the checkout step of this job.`,
    );
  }
  if (moved.runsOn && moved.runsOn !== "ubuntu-latest") {
    notes.push(
      `That job ran on \`${moved.runsOn}\`: change runs-on of this job if it needs that runner.`,
    );
  }
  notes.push(...(moved.notes ?? []));
  const steps = moved.steps.replaceAll("@@if@@", condition);
  return [...notes, "", ...steps.split("\n")]
    .map((line) => (line === "" ? "#" : `# ${line}`))
    .join("\n");
}

function renderBuildParts(
  input: WorkflowTemplateInput,
  targets: ResolvedTarget[],
  mode: Mode,
): BuildParts {
  const hints = input.hints ?? {};

  // Runner: iOS builds need macOS.
  const iosNames = targets.filter((t) => t.type === "ios").map((t) => t.name);
  const runsOn =
    iosNames.length === 0
      ? "ubuntu-latest"
      : `\${{ ${targetCondition(iosNames)} && 'macos-latest' || 'ubuntu-latest' }}`;

  // Permissions: pushing to GHCR needs packages: write.
  const dockerTargets = targets.filter((t): t is ResolvedDockerTarget => t.type === "docker");
  const permissions = ["contents: read"];
  if (dockerTargets.some((t) => dockerRegistries(t).includes(GITHUB_REGISTRY))) {
    permissions.push("packages: write");
  }
  if (targets.some(isNpmTarget)) {
    permissions.push("# id-token: write # for npm trusted publishing instead of an NPM_TOKEN");
  }

  // Registry logins, one step per registry, before `verify`.
  const loginTemplate = readTemplate("snippets/docker-login.yml");
  const byRegistry = new Map<string, string[]>();
  for (const target of dockerTargets) {
    for (const registry of dockerRegistries(target)) {
      byRegistry.set(registry, [...(byRegistry.get(registry) ?? []), target.name]);
    }
  }
  const loginSteps = [...byRegistry].map(([registry, names]) => {
    const github = registry === GITHUB_REGISTRY;
    const hub = registry === "docker.io";
    return fillTemplate(
      loginTemplate,
      {
        registry_name: github ? "GitHub Container Registry" : hub ? "Docker Hub" : registry,
        if: targetCondition(names),
        registry_line: hub ? "" : `registry: ${registry}`,
        username: github
          ? gh("github.actor")
          : hub
            ? gh("secrets.DOCKERHUB_USERNAME")
            : gh("secrets.REGISTRY_USERNAME"),
        password: github
          ? gh("secrets.GITHUB_TOKEN")
          : hub
            ? gh("secrets.DOCKERHUB_TOKEN")
            : gh("secrets.REGISTRY_PASSWORD"),
      },
      "snippets/docker-login.yml",
    );
  });

  // The team's build steps, per target in config order.
  const buildSteps = targets.map((target) => buildSnippet(target, mode, hints));

  return {
    runsOn,
    permissions: permissions.join("\n"),
    loginSteps: loginSteps.join("\n"),
    buildSteps: buildSteps.join("\n\n"),
    verifyEnv: mode === "release" ? verifyEnv(targets) : "",
  };
}

// ---------------------------------------------------------------------------
// Preview triggers and expressions

/**
 * A GitHub expression that is true for a branch matching the glob, as far as the expression
 * language can tell. Always a superset of the glob: the caller uses it where a false positive
 * is the safe side. `next/*` becomes `startsWith(github.ref_name, 'next/')`, `*-beta` becomes
 * `endsWith(github.ref_name, '-beta')`, a glob without wildcards an equality check, and a
 * glob that starts with a wildcard in the middle of a pattern matches by its literal prefix
 * (or everything, when there is none).
 */
export function branchGlobExpression(glob: string): string {
  const ref = "github.ref_name";
  const wildcard = glob.search(/[*?[\]{}()!+@]/);
  if (wildcard === -1) return `${ref} == ${exprString(glob)}`;
  const prefix = glob.slice(0, wildcard);
  const rest = glob.slice(wildcard);
  if (prefix === "" && /^\*+[^*?[\]{}()!+@/]+$/.test(rest)) {
    return `endsWith(${ref}, ${exprString(rest.replace(/^\*+/, ""))})`;
  }
  if (prefix === "") return "true";
  return `startsWith(${ref}, ${exprString(prefix)})`;
}

function cancelInProgress(config: ResolvedConfig): string {
  const globs = unique(config.preview.branches.filter((b) => b.prerelease).map((b) => b.branch));
  if (globs.length === 0) return "true";
  const expressions = unique(globs.map(branchGlobExpression));
  if (expressions.includes("true")) return "false";
  // A pull_request run has a ref_name like `12/merge`, so it is excluded explicitly.
  return `\${{ !(github.event_name != 'pull_request' && (${expressions.join(" || ")})) }}`;
}

function previewPushTrigger(config: ResolvedConfig): string {
  const globs = unique(config.preview.branches.map((b) => b.branch));
  if (globs.length === 0) return "";
  return [
    "  push:",
    "    branches:",
    ...globs.map((glob) => `      - ${quote(glob)}`),
    "      # Maintenance branches never auto-preview, even when a pattern above matches them.",
    `      - ${quote(`!${config.maintenanceBranches}`)}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Rendering

function checkParsable(file: RenderedFile): void {
  try {
    parseYaml(file.content, { strict: true });
  } catch (error) {
    throw new LaunchsetError(
      "template-invalid-yaml",
      `The generated ${file.path} is not valid YAML: ${(error as Error).message}`,
      {
        hint: "A value from launchset.config (a branch pattern, label or target name) may contain characters YAML can't take in this position.",
        cause: error,
      },
    );
  }
}

export function renderWorkflows(input: WorkflowTemplateInput): RenderedFile[] {
  const { config } = input;
  const hostIssues = hostConfigIssues(config, "github");
  if (hostIssues.length > 0) throw new ConfigError(hostIssues);
  const action = input.actionRef ?? DEFAULT_ACTION_REF;
  const files: RenderedFile[] = [];

  // Check (9.2): base branch, maintenance branches and prerelease branches.
  const prereleaseGlobs = config.preview.branches.filter((b) => b.prerelease).map((b) => b.branch);
  files.push({
    path: ".github/workflows/launchset-check.yml",
    content: fillTemplate(
      readTemplate("launchset-check.yml"),
      {
        action,
        branches: yamlList(
          unique([config.baseBranch, config.maintenanceBranches, ...prereleaseGlobs]),
        ),
      },
      "launchset-check.yml",
    ),
  });

  // Release (9.3).
  const release = renderBuildParts(input, releaseTargets(config), "release");
  files.push({
    path: ".github/workflows/launchset-release.yml",
    content: fillTemplate(
      readTemplate("launchset-release.yml"),
      {
        action,
        branches: yamlList(unique([config.baseBranch, config.maintenanceBranches])),
        runs_on: release.runsOn,
        build_permissions: release.permissions,
        login_steps: release.loginSteps,
        verify_env: release.verifyEnv,
        build_steps: release.buildSteps,
      },
      "launchset-release.yml",
    ),
  });

  // Preview (9.7, 9.9), unless previews are switched off.
  if (config.preview.enabled) {
    const label = exprString(config.preview.label);
    const prLabel = `(contains(github.event.pull_request.labels.*.name, ${label}) && (github.event.action != 'labeled' || github.event.label.name == ${label}))`;
    const preview = renderBuildParts(
      input,
      input.allPreviewSteps ? releaseTargets(config) : previewTargets(config),
      "preview",
    );
    files.push({
      path: ".github/workflows/launchset-preview.yml",
      content: fillTemplate(
        readTemplate("launchset-preview.yml"),
        {
          action,
          pr_types: config.preview.rebuildOnPush ? "[labeled, synchronize, reopened]" : "[labeled]",
          push_trigger: previewPushTrigger(config),
          pr_label: prLabel,
          pr_relevant: `(github.event.pull_request.head.repo.full_name == github.repository && ${prLabel})`,
          cancel_in_progress: cancelInProgress(config),
          runs_on: preview.runsOn,
          build_permissions: preview.permissions,
          login_steps: preview.loginSteps,
          build_steps: preview.buildSteps,
        },
        "launchset-preview.yml",
      ),
    });
  }

  for (const file of files) {
    file.content = `${file.content.replace(/\n+$/, "")}\n`;
    checkParsable(file);
  }
  return files;
}
