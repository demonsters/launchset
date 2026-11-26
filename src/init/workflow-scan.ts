/**
 * Reads existing CI files for init: GitHub workflow triggers, jobs and steps (with their
 * YAML nodes, so retiring machinery can make minimal edits), Docker builds and which
 * platforms a workflow builds. Read-only.
 */

import {
  type Document,
  isMap,
  isPair,
  isScalar,
  isSeq,
  type Node,
  type Pair,
  parseDocument,
  type Scalar,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";
import { lineOf } from "../core/text.ts";
import { joinRel, linesOf, normalizeRel } from "./fs.ts";
import type { DetectedPlatform } from "./types.ts";

/** An `if:` that only matches tag refs (`startsWith(github.ref, 'refs/tags/')`). */
export const TAG_REF =
  /refs\/tags\/|github\.ref_type\s*==\s*['"]tag['"]|startsWith\(\s*github\.ref_name\s*,\s*['"]v/;

/**
 * True when a job only runs for tags (its `if:` checks for a tag ref). A tag-gated step that
 * publishes already makes its workflow one that publishes.
 */
export function tagGated(job: WorkflowJob): boolean {
  return TAG_REF.test(job.if ?? "");
}

export interface ScalarRef {
  value: string;
  node: Scalar;
  line: number;
}

/**
 * The shell a `run` step runs in: `posix` (bash, sh), `powershell` (pwsh, the default on
 * Windows runners), `cmd`, `mixed` (a matrix of Windows and other runners, so bash on some and
 * pwsh on others) or `other` (python, node, a custom command).
 */
export type StepShell = "posix" | "powershell" | "cmd" | "mixed" | "other";

export interface WorkflowStep {
  index: number;
  node: YAMLMap;
  line: number;
  name?: string;
  id?: string;
  uses?: string;
  run?: ScalarRef;
  with: Map<string, ScalarRef>;
  /** `with` pairs, for edits. */
  withPairs: Map<string, Pair>;
  env: Record<string, string>;
  workingDirectory?: string;
  /** The shell its `run` runs in: `shell:`, else `defaults.run.shell`, else the runner's. */
  shell: StepShell;
  /** The `shell:` value it comes from (`python`), or the runner's default (`pwsh`, `bash`). */
  shellName: string;
  /** `step "Release"` or `step 2 (changesets/action)`. */
  label: string;
}

export interface WorkflowJob {
  id: string;
  pair: Pair;
  node: YAMLMap;
  line: number;
  env: Record<string, string>;
  steps: WorkflowStep[];
  stepsSeq?: YAMLSeq;
  /** `needs` value nodes (scalar or sequence items). */
  needs: ScalarRef[];
  needsPair?: Pair;
  /** Its `if:` condition. */
  if?: string;
  /** A reusable workflow it calls (`uses: ./.github/workflows/build.yml`) instead of steps. */
  uses?: string;
  /** Its deployment environment (`environment: production` or `environment.name`). */
  environment?: string;
}

export interface WorkflowTriggers {
  /** The top-level `on` pair. */
  pair?: Pair;
  /** Trigger pairs when `on` is a map. */
  map?: YAMLMap;
  pushPair?: Pair;
  /** `on.push.tags` pair. */
  tagsPair?: Pair;
  tagPatterns: ScalarRef[];
  /** `on.push.tags-ignore` pair (used when there's no `tags` filter). */
  tagsIgnorePair?: Pair;
  tagsIgnore: ScalarRef[];
  /**
   * `push` without any branch or tag filter (`on: push`, `[push]`, `push:` with only
   * `paths`): it runs for every pushed tag too.
   */
  unfilteredPush: boolean;
  /** `release` trigger (finalize creates GitHub Releases). */
  release?: { pair?: Pair; types: string[] | null; line: number };
  /** True when a branch push starts the workflow. */
  onBranchPush: boolean;
  /** `on.push` has a `branches` / `branches-ignore` filter. */
  hasBranchFilter: boolean;
  /** A `tags` / `tags-ignore` filter exists, so `github.ref_name` can be a tag. */
  tagEvents: boolean;
  /** `on.workflow_run.workflows`: the workflows (by name) whose runs start this one. */
  workflowRun: string[];
}

export interface Workflow {
  path: string;
  /** Its top-level `name:`. */
  name?: string;
  text: string;
  doc: Document;
  env: Record<string, string>;
  triggers: WorkflowTriggers;
  jobs: WorkflowJob[];
  jobsMap?: YAMLMap;
}

function scalarRef(text: string, node: unknown): ScalarRef | undefined {
  if (!isScalar(node) || node.range === undefined || node.range === null) return undefined;
  if (node.value === null || node.value === undefined) return undefined;
  return { value: String(node.value), node, line: lineOf(text, node.range[0]) };
}

export function pairOf(map: YAMLMap, key: string): Pair | undefined {
  for (const item of map.items) {
    if (isPair(item) && isScalar(item.key) && String(item.key.value) === key) {
      return item as Pair;
    }
  }
  return undefined;
}

function envOf(node: unknown): Record<string, string> {
  const env: Record<string, string> = {};
  if (!isMap(node)) return env;
  for (const item of node.items) {
    if (isScalar(item.key) && isScalar(item.value) && item.value.value !== null) {
      env[String(item.key.value)] = String(item.value.value);
    }
  }
  return env;
}

function scalars(text: string, node: unknown): ScalarRef[] {
  const items = isSeq(node) ? node.items : [node];
  return items.map((i) => scalarRef(text, i)).filter((r): r is ScalarRef => r !== undefined);
}

function parseTriggers(text: string, root: YAMLMap): WorkflowTriggers {
  const triggers: WorkflowTriggers = {
    tagPatterns: [],
    tagsIgnore: [],
    unfilteredPush: false,
    onBranchPush: false,
    hasBranchFilter: false,
    tagEvents: false,
    workflowRun: [],
  };
  const pair = pairOf(root, "on");
  if (!pair) return triggers;
  triggers.pair = pair;
  const value = pair.value;
  const onLine = lineOf(text, (pair.key as Scalar).range?.[0] ?? 0);
  if (isScalar(value) || isSeq(value)) {
    const names = scalars(text, value).map((r) => r.value);
    triggers.onBranchPush = names.includes("push");
    triggers.unfilteredPush = names.includes("push");
    if (names.includes("release")) triggers.release = { types: null, line: onLine };
    return triggers;
  }
  if (!isMap(value)) return triggers;
  triggers.map = value;
  const run = pairOf(value, "workflow_run")?.value;
  const runWorkflows = isMap(run) ? pairOf(run as YAMLMap, "workflows") : undefined;
  if (runWorkflows) triggers.workflowRun = scalars(text, runWorkflows.value).map((r) => r.value);
  const release = pairOf(value, "release");
  if (release) {
    const types = isMap(release.value) ? pairOf(release.value as YAMLMap, "types") : undefined;
    triggers.release = {
      pair: release,
      types: types ? scalars(text, types.value).map((r) => r.value) : null,
      line: lineOf(text, (release.key as Scalar).range?.[0] ?? 0),
    };
  }
  const push = pairOf(value, "push");
  if (!push) return triggers;
  triggers.pushPair = push;
  if (!isMap(push.value)) {
    triggers.onBranchPush = true;
    triggers.unfilteredPush = true;
    return triggers;
  }
  const pushMap = push.value as YAMLMap;
  const tags = pairOf(pushMap, "tags");
  const ignore = pairOf(pushMap, "tags-ignore");
  const branchFilter = Boolean(pairOf(pushMap, "branches") || pairOf(pushMap, "branches-ignore"));
  const tagFilter = Boolean(tags || ignore);
  triggers.hasBranchFilter = branchFilter;
  triggers.onBranchPush = branchFilter || !tagFilter;
  triggers.unfilteredPush = !branchFilter && !tagFilter;
  triggers.tagEvents = tagFilter;
  if (tags) {
    triggers.tagsPair = tags;
    triggers.tagPatterns = scalars(text, tags.value);
  } else if (ignore) {
    triggers.tagsIgnorePair = ignore;
    triggers.tagsIgnore = scalars(text, ignore.value);
  }
  return triggers;
}

function parseStep(text: string, node: YAMLMap, index: number): WorkflowStep {
  const get = (key: string) => {
    const pair = pairOf(node, key);
    return pair ? scalarRef(text, pair.value) : undefined;
  };
  const withMap = pairOf(node, "with")?.value;
  const withValues = new Map<string, ScalarRef>();
  const withPairs = new Map<string, Pair>();
  if (isMap(withMap)) {
    for (const item of withMap.items) {
      if (!isScalar(item.key)) continue;
      const key = String(item.key.value);
      withPairs.set(key, item as Pair);
      const ref = scalarRef(text, item.value);
      if (ref) withValues.set(key, ref);
    }
  }
  const name = get("name")?.value;
  const uses = get("uses")?.value;
  const run = get("run");
  const step: WorkflowStep = {
    index,
    node,
    line: lineOf(text, node.range?.[0] ?? 0),
    with: withValues,
    withPairs,
    env: envOf(pairOf(node, "env")?.value),
    shell: "posix",
    shellName: "bash",
    label: name
      ? `step "${name}"`
      : `step ${index + 1}${uses ? ` (${uses.replace(/@.*/, "")})` : ""}`,
  };
  if (name !== undefined) step.name = name;
  const id = get("id")?.value;
  if (id !== undefined) step.id = id;
  if (uses !== undefined) step.uses = uses;
  if (run) step.run = run;
  const wd = get("working-directory")?.value;
  if (wd !== undefined) step.workingDirectory = wd;
  return step;
}

/** The kind of shell a `shell:` value names (`bash -e {0}` → posix, `pwsh` → powershell). */
export function shellKind(value: string): StepShell {
  const program = (value.trim().split(/\s+/)[0] ?? "").replace(/^.*[\\/]/, "").toLowerCase();
  if (/^(?:bash|sh|zsh|dash|ksh)$/.test(program)) return "posix";
  if (program === "pwsh" || program === "powershell") return "powershell";
  if (program === "cmd") return "cmd";
  return "other";
}

/** `defaults.run.shell` of a workflow or job. */
function defaultShell(node: YAMLMap): string | undefined {
  const defaults = pairOf(node, "defaults")?.value;
  const run = isMap(defaults) ? pairOf(defaults as YAMLMap, "run")?.value : undefined;
  const shell = isMap(run) ? pairOf(run as YAMLMap, "shell")?.value : undefined;
  return isScalar(shell) && typeof shell.value === "string" ? shell.value : undefined;
}

const strings = (node: unknown): string[] => {
  if (isScalar(node))
    return node.value === null || node.value === undefined ? [] : [String(node.value)];
  if (isSeq(node)) return node.items.flatMap(strings);
  if (isMap(node)) return node.items.flatMap((i) => strings((i as Pair).value));
  return [];
};

/**
 * The default shell of a job's runner: pwsh on Windows, bash elsewhere. A `runs-on` from the
 * matrix (`${{ matrix.os }}`) with Windows and other runners is `mixed`.
 */
function runnerShell(job: YAMLMap): { shell: StepShell; name: string } {
  const labels = strings(pairOf(job, "runs-on")?.value);
  const windows = (s: string) => /windows/i.test(s);
  if (labels.some((l) => l.includes("${{"))) {
    const strategy = pairOf(job, "strategy")?.value;
    const matrix = isMap(strategy) ? strings(pairOf(strategy as YAMLMap, "matrix")?.value) : [];
    const runners = matrix.filter((s) => /windows|ubuntu|macos|linux/i.test(s));
    if (runners.some(windows)) {
      return runners.every(windows)
        ? { shell: "powershell", name: "pwsh" }
        : { shell: "mixed", name: "bash or pwsh" };
    }
  }
  return labels.some(windows)
    ? { shell: "powershell", name: "pwsh" }
    : { shell: "posix", name: "bash" };
}

function parseJobs(text: string, root: YAMLMap): { jobs: WorkflowJob[]; map?: YAMLMap } {
  const jobsPair = pairOf(root, "jobs");
  if (!jobsPair || !isMap(jobsPair.value)) return { jobs: [] };
  const jobs: WorkflowJob[] = [];
  for (const item of jobsPair.value.items) {
    if (!isScalar(item.key) || !isMap(item.value)) continue;
    const node = item.value as YAMLMap;
    const fallbackShell = defaultShell(node) ?? defaultShell(root);
    const runner = runnerShell(node);
    const stepsPair = pairOf(node, "steps");
    const steps: WorkflowStep[] = [];
    let stepsSeq: YAMLSeq | undefined;
    if (stepsPair && isSeq(stepsPair.value)) {
      stepsSeq = stepsPair.value as YAMLSeq;
      stepsSeq.items.forEach((step, index) => {
        if (!isMap(step)) return;
        const parsed = parseStep(text, step as YAMLMap, index);
        const own = pairOf(step as YAMLMap, "shell")?.value;
        const shell =
          (isScalar(own) && typeof own.value === "string" ? own.value : undefined) ?? fallbackShell;
        if (shell !== undefined) {
          parsed.shell = shellKind(shell);
          parsed.shellName = shell.trim().split(/\s+/)[0] ?? shell;
        } else {
          parsed.shell = runner.shell;
          parsed.shellName = runner.name;
        }
        steps.push(parsed);
      });
    }
    const needsPair = pairOf(node, "needs");
    const needs: ScalarRef[] = [];
    if (needsPair) {
      const items = isSeq(needsPair.value) ? needsPair.value.items : [needsPair.value];
      for (const n of items) {
        const ref = scalarRef(text, n);
        if (ref) needs.push(ref);
      }
    }
    const job: WorkflowJob = {
      id: String(item.key.value),
      pair: item as Pair,
      node,
      line: lineOf(text, (item.key as Scalar).range?.[0] ?? 0),
      env: envOf(pairOf(node, "env")?.value),
      steps,
      needs,
    };
    if (stepsSeq) job.stepsSeq = stepsSeq;
    if (needsPair) job.needsPair = needsPair;
    const plainValue = (key: string, of: YAMLMap = node) => {
      const v = pairOf(of, key)?.value;
      return isScalar(v) && v.value !== null && v.value !== undefined ? String(v.value) : undefined;
    };
    const condition = plainValue("if");
    if (condition !== undefined) job.if = condition;
    const uses = plainValue("uses");
    if (uses !== undefined) job.uses = uses;
    const environment = pairOf(node, "environment")?.value;
    const envName = isMap(environment)
      ? plainValue("name", environment as YAMLMap)
      : plainValue("environment");
    if (envName !== undefined) job.environment = envName;
    jobs.push(job);
  }
  return { jobs, map: jobsPair.value as YAMLMap };
}

/** Parse a GitHub workflow; `{ error }` when it isn't valid YAML. */
export function parseWorkflow(path: string, text: string): Workflow | { error: string } {
  const doc = parseDocument(text, { keepSourceTokens: false });
  if (doc.errors.length > 0) {
    return { error: doc.errors[0]?.message.split("\n")[0] ?? "invalid YAML" };
  }
  const root = doc.contents;
  if (!isMap(root)) return { error: "the file has no top-level map" };
  const { jobs, map } = parseJobs(text, root as YAMLMap);
  const nameNode = pairOf(root as YAMLMap, "name")?.value;
  const workflow: Workflow = {
    path,
    ...(isScalar(nameNode) && typeof nameNode.value === "string" ? { name: nameNode.value } : {}),
    text,
    doc,
    env: envOf(pairOf(root as YAMLMap, "env")?.value),
    triggers: parseTriggers(text, root as YAMLMap),
    jobs,
  };
  if (map) workflow.jobsMap = map;
  return workflow;
}

// ---------------------------------------------------------------------------
// Expressions

export interface ExpressionContext {
  env: Record<string, string>;
  /** Step outputs written to `$GITHUB_OUTPUT` by earlier steps, by `<step id>.<name>`. */
  outputs?: Record<string, string>;
  /** `owner/repo`. */
  github?: string;
}

/** Resolve `${{ env.X }}`, `${{ github.repository }}` and `$X` / `${X}` where known. */
export function resolveExpressions(value: string, ctx: ExpressionContext, depth = 0): string {
  if (depth > 4) return value;
  const [owner] = (ctx.github ?? "").split("/");
  const out = value
    .replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (match, expr: string) => {
      const env = /^env\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(expr);
      if (env) {
        const v = ctx.env[env[1] as string];
        return v === undefined ? match : resolveExpressions(v, ctx, depth + 1);
      }
      const output = /^steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)$/.exec(expr);
      if (output) {
        const v = ctx.outputs?.[`${output[1]}.${output[2]}`];
        return v === undefined ? match : resolveExpressions(v, ctx, depth + 1);
      }
      if (expr === "github.repository" && ctx.github) return ctx.github;
      if (expr === "github.repository_owner" && owner) return owner;
      return match;
    })
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, a, b) => {
      const v = ctx.env[(a ?? b) as string];
      return v === undefined ? match : resolveExpressions(v, ctx, depth + 1);
    });
  return out;
}

function hasExpression(value: string): boolean {
  return /\$\{\{|\$\{?[A-Za-z_]/.test(value);
}

// ---------------------------------------------------------------------------
// Docker builds

export interface DockerBuild {
  workflow: Workflow;
  job: WorkflowJob;
  step: WorkflowStep;
  /** Dockerfile path relative to the repo root. */
  file: string;
  context: string;
  /** Resolved image names (lowercase). */
  images: string[];
  /** Image references that couldn't be resolved, as written. */
  unresolved: string[];
  /** Release tag templates found, in order. */
  tags: string[];
  /** Where each latest tag is defined (for machinery). */
  latest: LatestRef[];
  pushes: boolean;
  platforms?: string;
  /** Line of the evidence (the tags input or the command). */
  line: number;
}

/** Where a `latest` tag is pushed: a line to remove, or a splice inside a one-line value. */
export interface LatestRef {
  step: WorkflowStep;
  line: number;
  /** The scalar holding the tag list. */
  node: Scalar;
  /** Text of the entry (a line of a block scalar, or a comma-separated entry). */
  entry: string;
  /** `flavor`: the entry is `latest=true` and is changed to `latest=false`. */
  flavor?: boolean;
  /** For `run` steps: the command, and what can be removed (none: no minimal edit). */
  run?: { command: RunCommand; removal?: "command" | "line"; lineNumber: number };
}

/** Split `image:tag` (the tag after the last `:` past the last `/`). */
export function splitImageRef(ref: string): { image: string; tag?: string } {
  const at = ref.indexOf("@");
  const clean = at === -1 ? ref : ref.slice(0, at);
  const slash = clean.lastIndexOf("/");
  const colon = clean.lastIndexOf(":");
  if (colon > slash && !clean.slice(colon).includes("${{")) {
    return { image: clean.slice(0, colon), tag: clean.slice(colon + 1) };
  }
  // `image:${{ ... }}`: the colon is inside the last segment before an expression.
  const exprColon = clean.indexOf(":${{", slash);
  if (exprColon !== -1)
    return { image: clean.slice(0, exprColon), tag: clean.slice(exprColon + 1) };
  return { image: clean };
}

/**
 * The release tag template for a tag as written in a workflow (`v${{ env.VERSION }}` →
 * `v{version}`), or `null` when it isn't a release tag (`staging`, a branch name).
 *
 * With `ctx`, variables are first replaced by what they're set to, so
 * `${{ env.RELEASE_VERSION }}` set from `${GITHUB_REF#refs/*\/}` is the pushed tag
 * (`v{version}` under `v*` tags), not a bare `{version}`.
 */
export function tagTemplate(
  raw: string,
  tagPrefix: string | null,
  ctx?: ExpressionContext,
): string | null {
  if (ctx) {
    const resolved = resolveExpressions(raw, ctx);
    if (resolved !== raw) {
      const template = tagTemplate(resolved, tagPrefix);
      if (template) return template;
    }
  }
  const t = raw.trim().replace(/^["']|["']$/g, "");
  if (t === "latest") return "latest";
  let unknown = false;
  let placeholders = 0;
  const out = t.replace(
    /\$\{\{\s*([^}]*?)\s*\}\}|\$\{([A-Za-z_][A-Za-z0-9_]*)([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, expr: string | undefined, braced: string | undefined, mods: string, bare) => {
      const name = (expr ?? braced ?? bare) as string;
      placeholders++;
      if (/sha/i.test(name) && !/version|tag/i.test(name)) {
        return /::?7|:0:7|short/i.test(`${name}${mods ?? ""}`) ? "{shortSha}" : "{sha}";
      }
      if (/ref_name|github\.ref$|GITHUB_REF|CI_COMMIT_TAG|CI_COMMIT_REF_NAME/i.test(name)) {
        // The pushed git tag; `${GITHUB_REF#refs/tags/v}` strips the prefix.
        // The pushed git tag, but only when tags start the workflow (else it's a branch name).
        if (tagPrefix === null) {
          unknown = true;
          return match;
        }
        // `${GITHUB_REF#refs/tags/v}`, `${GITHUB_REF_NAME#v}`: the `v` is stripped.
        return /^##?(?:.*\/)?v$/.test(mods ?? "") ? "{version}" : `${tagPrefix}{version}`;
      }
      if (/version|tag/i.test(name)) return "{version}";
      unknown = true;
      return match;
    },
  );
  if (unknown || placeholders === 0) return null;
  return out;
}

/** Tag templates of a `docker/metadata-action` `tags` input (spec 6.1 placeholders). */
export function metadataTagTemplates(
  input: string,
  flavor: string | undefined,
  /** `null` when no tag starts the workflow: semver and tag-event tags never render then. */
  tagPrefix: string | null,
): string[] {
  const templates: string[] = [];
  let autoLatest = false;
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const attrs = new Map<string, string>();
    for (const part of line.split(",")) {
      const eq = part.indexOf("=");
      if (eq !== -1) attrs.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
    if (attrs.get("enable") === "false") continue;
    const prefix = attrs.get("prefix") ?? "";
    const suffix = attrs.get("suffix") ?? "";
    const type = attrs.get("type");
    if (
      (type === "semver" || (type === "ref" && attrs.get("event") === "tag")) &&
      tagPrefix === null
    ) {
      continue;
    }
    if (type === "semver") {
      const pattern = attrs.get("pattern") ?? "{{version}}";
      const t = pattern
        .replace(/\{\{\s*raw\s*\}\}/g, `${tagPrefix}{version}`)
        .replace(/\{\{\s*(version|major|minor|patch)\s*\}\}/g, "{$1}");
      templates.push(`${prefix}${t}${suffix}`);
      autoLatest = true;
    } else if (type === "ref" && attrs.get("event") === "tag") {
      templates.push(`${prefix}${tagPrefix}{version}${suffix}`);
      autoLatest = true;
    } else if (type === "raw") {
      const value = attrs.get("value");
      const t = value === undefined ? null : tagTemplate(value, tagPrefix);
      if (t) templates.push(`${prefix}${t}${suffix}`);
    } else if (type === "sha") {
      const p = attrs.has("prefix") ? prefix : "sha-";
      templates.push(`${p}${attrs.get("format") === "long" ? "{sha}" : "{shortSha}"}${suffix}`);
    }
  }
  const latestFlavor = /(?:^|[\s,])latest=(true|false|auto)/.exec(flavor ?? "")?.[1] ?? "auto";
  if (latestFlavor === "true" || (latestFlavor === "auto" && autoLatest)) {
    templates.push("latest");
  }
  return templates;
}

/** One shell command of a `run` script (continuation lines joined). */
export interface RunCommand {
  command: string;
  /** Physical lines (1-based file line numbers) the command spans. */
  lines: { number: number; text: string }[];
  /**
   * How the command can be taken out without breaking the script:
   * - `delete`: a top-level command on its own lines, not chained to its neighbours;
   * - `neutralize`: a simple command inside `if`/`for`/`case` or an `&&`/`|` chain; it's
   *   replaced by the no-op `:` with a comment, so the structure stays valid;
   * - `null`: neither is safe (a compound line, a heredoc).
   */
  removal: "delete" | "neutralize" | null;
  /** `&&`, `||` or `|` ending the command's last line (kept when neutralizing). */
  trailingOp?: string;
}

/** The physical lines of a `run` value, as file lines (block scalars: without the `|` line). */
export function runLines(run: ScalarRef, text: string): { number: number; text: string }[] {
  const [start, end] = run.node.range ?? [0, 0];
  if (!isBlock(run.node)) {
    return [{ number: run.line, text: run.value }];
  }
  return linesOf(text)
    .filter((l) => l.start > start && l.start < end)
    .filter((l, i, all) => i < all.length - 1 || l.text.trim() !== "" || l.start + 1 < end)
    .map((l) => ({ number: l.number, text: l.text }));
}

/** A shell line without quoted strings and comments, for structure checks. */
function shellCode(line: string): string {
  return line
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''")
    .replace(/(^|\s)#.*$/, "$1")
    .trim();
}

const OPENERS = /(?:^|[;&|(]|\bthen|\bdo|\belse)\s*(?:if|for|while|until|case|select)\b/g;
const CLOSERS = /(?:^|[;&|]\s*)(?:fi|done|esac)\b/g;
const STRUCTURE = /\b(?:then|do|else|elif|fi|done|esac)\b|;;|^[^\s()]+\)(?:\s|$)|\{$|^\}/;

function depthDelta(code: string): number {
  let d = (code.match(OPENERS) ?? []).length - (code.match(CLOSERS) ?? []).length;
  if (code.endsWith("{")) d++;
  if (code.startsWith("}")) d--;
  return d;
}

/**
 * Shell commands of a `run` script, with the lines each spans and how it can be removed.
 * Blank lines, comments and heredoc bodies (data, not commands) are skipped.
 */
export function runCommands(run: ScalarRef, text: string): RunCommand[] {
  return shellCommands(runLines(run, text));
}

/** {@link runCommands} for any shell lines (a script file's, with 1-based line numbers). */
export function shellCommands(lines: { number: number; text: string }[]): RunCommand[] {
  const out: RunCommand[] = [];
  let current:
    | (RunCommand & { depth: number; prevContinues: boolean; heredoc: boolean })
    | undefined;
  let depth = 0;
  let heredoc: string | undefined;
  let prevContinues = false;
  for (const line of lines) {
    const trimmed = line.text.trim();
    if (heredoc !== undefined) {
      if (trimmed === heredoc) heredoc = undefined;
      continue;
    }
    if (!current && (trimmed === "" || trimmed.startsWith("#"))) continue;
    const code = shellCode(line.text);
    current ??= {
      command: "",
      lines: [],
      removal: null,
      depth,
      prevContinues,
      heredoc: false,
    };
    current.lines.push(line);
    if (/(?<!<)<<(?!<)-?\s*(?:''|[A-Za-z_])/.test(code)) {
      const here = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line.text);
      if (here) {
        heredoc = here[2];
        current.heredoc = true;
      }
    }
    depth += depthDelta(code);
    if (trimmed.endsWith("\\") && heredoc === undefined) {
      current.command += `${trimmed.slice(0, -1)} `;
      continue;
    }
    current.command += trimmed;
    const op = /(&&|\|\||\|)$/.exec(code)?.[1];
    if (op) current.trailingOp = op;
    const lineCodes = current.lines.map((l) => shellCode(l.text));
    const structural = lineCodes.some((c) => STRUCTURE.test(c) || depthDelta(c) !== 0);
    const net = lineCodes.reduce((sum, c) => sum + depthDelta(c), 0);
    if (current.heredoc) current.removal = null;
    else if (current.depth === 0 && net === 0 && !current.prevContinues && !op) {
      current.removal = "delete";
    } else if (!structural) current.removal = "neutralize";
    else current.removal = null;
    const { depth: _d, prevContinues: _p, heredoc: _h, ...command } = current;
    out.push(command);
    prevContinues = op !== undefined;
    current = undefined;
  }
  if (current) {
    const { depth: _d, prevContinues: _p, heredoc: _h, ...command } = current;
    out.push(command);
  }
  return out;
}

export function isBlock(node: Scalar): boolean {
  return node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED";
}

/**
 * Shell words of a command. A `${{ … }}` expression is part of the word it's in, even with
 * spaces inside: `--build-arg X=${{ secrets.X }} .` is three words, not five.
 */
export function tokens(command: string): string[] {
  return (command.match(/(?:"[^"]*"|'[^']*'|\$\{\{.*?\}\}|\S)+/g) ?? []).map((t) =>
    t.replace(/^["']|["']$/g, ""),
  );
}

/** The `docker build` (file, context, tags) and pushed refs (`push`, `tag` targets) of a command. */
export function parseDockerCommands(command: string): {
  build?: { tags: string[]; file?: string; context: string };
  push?: string[];
} {
  const result: { build?: { tags: string[]; file?: string; context: string }; push?: string[] } =
    {};
  for (const part of command.split(/&&|;|\|\|/)) {
    const t = tokens(part.trim());
    const d = t.indexOf("docker");
    if (d === -1) continue;
    const rest = t.slice(d + 1);
    if (rest[0] === "buildx") rest.shift();
    const verb = rest.shift();
    if (verb === "build") {
      const tags: string[] = [];
      let file: string | undefined;
      const positional: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const tok = rest[i] as string;
        if (tok === "-t" || tok === "--tag") tags.push(rest[++i] ?? "");
        else if (tok.startsWith("--tag=")) tags.push(tok.slice(6));
        else if (tok === "-f" || tok === "--file") file = rest[++i];
        else if (tok.startsWith("--file=")) file = tok.slice(7);
        else if (
          /^--(build-arg|platform|label|target|cache-from|cache-to|secret|output)$/.test(tok)
        )
          i++;
        else if (!tok.startsWith("-")) positional.push(tok);
      }
      const build: { tags: string[]; file?: string; context: string } = {
        tags,
        context: positional.at(-1) ?? ".",
      };
      if (file !== undefined) build.file = file;
      result.build = build;
    } else if (verb === "push") {
      const ref = rest.find((x) => !x.startsWith("-"));
      if (ref) result.push = [...(result.push ?? []), ref];
    } else if (verb === "tag") {
      const target = rest.filter((x) => !x.startsWith("-"))[1];
      if (target) result.push = [...(result.push ?? []), target];
    }
  }
  return result;
}

/** `echo "NAME=value" >> $GITHUB_ENV` (or `$GITHUB_OUTPUT`): the variable it sets. */
export function githubFileWrite(
  command: string,
): { file: "GITHUB_ENV" | "GITHUB_OUTPUT"; name: string; value: string } | undefined {
  const m =
    /^echo\s+(?:"([A-Za-z_][\w-]*)=([^"]*)"|'([A-Za-z_][\w-]*)=([^']*)'|([A-Za-z_][\w-]*)=(\S*))\s*>>\s*["']?\$\{?(GITHUB_ENV|GITHUB_OUTPUT)\}?["']?\s*$/.exec(
      command.trim(),
    );
  if (!m) return undefined;
  return {
    file: m[7] as "GITHUB_ENV" | "GITHUB_OUTPUT",
    name: (m[1] ?? m[3] ?? m[5]) as string,
    value: (m[2] ?? m[4] ?? m[6]) as string,
  };
}

function listEntries(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s !== "" && !s.startsWith("#"));
}

/** Every Docker build or push in a workflow. */
export function dockerBuilds(
  workflow: Workflow,
  /** `tagPrefix`: `v` or `` for the pushed tags; `null` when no tag starts the workflow. */
  options: { github?: string; tagPrefix: string | null },
): DockerBuild[] {
  const builds: DockerBuild[] = [];
  const text = workflow.text;
  for (const job of workflow.jobs) {
    // What earlier steps of the job wrote to `$GITHUB_ENV` and `$GITHUB_OUTPUT`.
    const written: Record<string, string> = {};
    const outputs: Record<string, string> = {};
    for (const step of job.steps) {
      const ctx: ExpressionContext = {
        env: { ...workflow.env, ...job.env, ...written, ...step.env },
        outputs,
        ...(options.github ? { github: options.github } : {}),
      };
      if (step.run) {
        for (const command of runCommands(step.run, text)) {
          const set = githubFileWrite(command.command);
          if (set?.file === "GITHUB_ENV") written[set.name] = set.value;
          else if (set && step.id) outputs[`${step.id}.${set.name}`] = set.value;
        }
      }
      const uses = step.uses?.replace(/@.*/, "");
      if (uses === "docker/build-push-action") {
        const tagsRef = step.with.get("tags");
        const images: string[] = [];
        const unresolved: string[] = [];
        const tags: string[] = [];
        const latest: LatestRef[] = [];
        for (const entry of listEntries(tagsRef?.value ?? "")) {
          const meta = /steps\.([A-Za-z0-9_-]+)\.outputs\.tags/.exec(entry);
          if (meta) {
            const metaStep = job.steps.find((s) => s.id === meta[1]);
            if (metaStep)
              addMetadata(metaStep, ctx, options.tagPrefix, images, unresolved, tags, latest, text);
            continue;
          }
          const { image, tag } = splitImageRef(entry);
          const resolved = resolveExpressions(image, ctx).toLowerCase();
          if (hasExpression(resolved)) unresolved.push(image);
          else if (!images.includes(resolved)) images.push(resolved);
          if (tag !== undefined) {
            const template = tagTemplate(tag, options.tagPrefix, ctx);
            if (template && !tags.includes(template)) tags.push(template);
            if (template === "latest" && tagsRef) {
              latest.push({
                step,
                line: entryLine(text, tagsRef, entry),
                node: tagsRef.node,
                entry,
              });
            }
          }
        }
        const context = normalizeRel(
          resolveExpressions(step.with.get("context")?.value ?? ".", ctx),
        );
        const fileInput = step.with.get("file")?.value;
        const file = fileInput
          ? normalizeRel(resolveExpressions(fileInput, ctx))
          : joinRel(context, "Dockerfile");
        const push = step.with.get("push")?.value;
        const build: DockerBuild = {
          workflow,
          job,
          step,
          file,
          context,
          images,
          unresolved,
          tags,
          latest,
          pushes: push !== undefined && push !== "false",
          line: tagsRef?.line ?? step.line,
        };
        const platforms = step.with.get("platforms")?.value;
        if (platforms) build.platforms = platforms;
        builds.push(build);
      } else if (step.run) {
        const build = runDockerBuild(workflow, job, step, step.run, ctx, options.tagPrefix);
        if (build) builds.push(build);
      }
    }
  }
  return builds;
}

/** The docker commands of one `run` step, as one build (file and context from `docker build`). */
function runDockerBuild(
  workflow: Workflow,
  job: WorkflowJob,
  step: WorkflowStep,
  run: ScalarRef,
  ctx: ExpressionContext,
  tagPrefix: string | null,
): DockerBuild | undefined {
  const images: string[] = [];
  const unresolved: string[] = [];
  const tags: string[] = [];
  const latest: LatestRef[] = [];
  let buildCommand: { file?: string; context: string } | undefined;
  let pushes = false;
  let line: number | undefined;
  for (const command of runCommands(run, workflow.text)) {
    if (!/\bdocker\b/.test(command.command)) continue;
    const parsed = parseDockerCommands(command.command);
    const pushRefs = parsed.push ?? [];
    const buildPushes = /--push\b/.test(command.command);
    const refs = [...(parsed.build?.tags ?? []), ...pushRefs];
    if (refs.length === 0) continue;
    line ??= command.lines[0]?.number;
    if (parsed.build) buildCommand ??= parsed.build;
    if (pushRefs.length > 0 || buildPushes) pushes = true;
    const single = !/&&|;|\|\|/.test(command.command);
    for (const ref of refs) {
      const { image, tag } = splitImageRef(ref);
      const resolved = resolveExpressions(image, ctx).toLowerCase();
      if (hasExpression(resolved)) unresolved.push(image);
      else if (!images.includes(resolved)) images.push(resolved);
      if (tag === undefined) continue;
      const template = tagTemplate(tag, tagPrefix, ctx);
      if (template && !tags.includes(template)) tags.push(template);
      if (template !== "latest") continue;
      const isPushRef = pushRefs.includes(ref);
      if (!isPushRef && !buildPushes) continue;
      const physical = command.lines.find((l) => l.text.includes(ref)) ?? command.lines[0];
      const lineNumber = physical?.number ?? command.lines[0]?.number ?? run.line;
      let removal: "command" | "line" | undefined;
      if (isPushRef && single) removal = "command";
      else if (
        !isPushRef &&
        physical &&
        command.lines.indexOf(physical) > 0 &&
        physical.text.trimEnd().endsWith("\\")
      ) {
        removal = "line";
      }
      const r: LatestRef["run"] = { command, lineNumber };
      if (removal) r.removal = removal;
      latest.push({ step, line: lineNumber, node: run.node, entry: ref, run: r });
    }
  }
  if (line === undefined) return undefined;
  const wd = step.workingDirectory ? normalizeRel(step.workingDirectory) : ".";
  const context = joinRel(wd, normalizeRel(buildCommand?.context ?? "."));
  const file = buildCommand?.file
    ? joinRel(wd, normalizeRel(buildCommand.file))
    : joinRel(context, "Dockerfile");
  return { workflow, job, step, file, context, images, unresolved, tags, latest, pushes, line };
}

function addMetadata(
  metaStep: WorkflowStep,
  ctx: ExpressionContext,
  tagPrefix: string | null,
  images: string[],
  unresolved: string[],
  tags: string[],
  latest: LatestRef[],
  text: string,
): void {
  if (metaStep.uses?.replace(/@.*/, "") !== "docker/metadata-action") return;
  for (const image of listEntries(metaStep.with.get("images")?.value ?? "")) {
    const name = image.replace(/,.*$/, "").replace(/^name=/, "");
    const resolved = resolveExpressions(name, ctx).toLowerCase();
    if (hasExpression(resolved)) unresolved.push(name);
    else if (!images.includes(resolved)) images.push(resolved);
  }
  const tagsRef = metaStep.with.get("tags");
  const flavorRef = metaStep.with.get("flavor");
  for (const t of metadataTagTemplates(tagsRef?.value ?? "", flavorRef?.value, tagPrefix)) {
    if (!tags.includes(t)) tags.push(t);
  }
  // Explicit latest tags (what a branch push would move).
  if (tagsRef) {
    for (const entry of tagsRef.value.split(/\r?\n/)) {
      if (/type=raw\b/.test(entry) && /value=latest\b/.test(entry) && !/enable=false/.test(entry)) {
        latest.push({
          step: metaStep,
          line: entryLine(text, tagsRef, entry.trim()),
          node: tagsRef.node,
          entry: entry.trim(),
        });
      }
    }
  }
  if (flavorRef && /(?:^|[\s,])latest=true\b/.test(flavorRef.value)) {
    latest.push({
      step: metaStep,
      line: flavorRef.line,
      node: flavorRef.node,
      entry: "latest=true",
      flavor: true,
    });
  }
}

/** Line of `entry` inside a scalar's source text. */
function entryLine(text: string, ref: ScalarRef, entry: string): number {
  const [start, end] = ref.node.range ?? [0, 0];
  const index = text.indexOf(entry, start);
  return index !== -1 && index < end ? lineOf(text, index) : ref.line;
}

// ---------------------------------------------------------------------------
// What a workflow builds

const BUILD_SIGNALS: { platform: DetectedPlatform; pattern: RegExp; note: string }[] = [
  {
    platform: "android",
    pattern: /gradlew[^\n]*\b(assemble|bundle)\w*/,
    note: "runs a Gradle assemble/bundle task",
  },
  { platform: "android", pattern: /\bfastlane\s+android\b/, note: "runs fastlane android" },
  { platform: "android", pattern: /upload-google-play/, note: "uploads to Google Play" },
  {
    platform: "android",
    pattern: /\beas\s+build\b(?![^\n]*--platform\s+ios)/,
    note: "runs eas build",
  },
  {
    platform: "ios",
    pattern: /\bxcodebuild\b[^\n]*\b(archive|-exportArchive)\b/,
    note: "runs xcodebuild archive",
  },
  { platform: "ios", pattern: /\bfastlane\s+ios\b/, note: "runs fastlane ios" },
  {
    platform: "ios",
    pattern: /upload-testflight|xcrun\s+altool[^\n]*--upload/,
    note: "uploads to TestFlight",
  },
  {
    platform: "ios",
    pattern: /\beas\s+build\b(?![^\n]*--platform\s+android)/,
    note: "runs eas build",
  },
];

/** Lines of a CI file that build android or iOS apps. */
export function platformBuildSignals(
  text: string,
): { platform: DetectedPlatform; line: number; note: string }[] {
  const out: { platform: DetectedPlatform; line: number; note: string }[] = [];
  for (const line of linesOf(text)) {
    if (line.text.trimStart().startsWith("#")) continue;
    for (const signal of BUILD_SIGNALS) {
      if (signal.pattern.test(line.text) && !out.some((o) => o.platform === signal.platform)) {
        out.push({ platform: signal.platform, line: line.number, note: signal.note });
      }
    }
  }
  return out;
}

export type { Node };
