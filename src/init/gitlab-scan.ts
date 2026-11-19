/**
 * Reads a project's GitLab CI configuration for init: `.gitlab-ci.yml` and the local files it
 * includes, their jobs (with their YAML nodes, so retiring machinery can make minimal edits),
 * what starts each job (tag pipelines, branch pushes), and the Docker builds in their scripts.
 * Read-only.
 */

import {
  type Document,
  isMap,
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
import { GITLAB_CUSTOM_TAGS, GitLabReference } from "../templates/gitlab-yaml.ts";
import { absolute, globRel, joinRel, normalizeRel, readTextOrNull } from "./fs.ts";
import {
  pairOf,
  parseDockerCommands,
  type RunCommand,
  resolveExpressions,
  runCommands,
  type ScalarRef,
  splitImageRef,
  tagTemplate,
} from "./workflow-scan.ts";

export const GITLAB_CI_FILE = ".gitlab-ci.yml";

/** Top-level `.gitlab-ci.yml` keys that aren't jobs. */
export const GITLAB_RESERVED = new Set([
  "default",
  "include",
  "stages",
  "variables",
  "workflow",
  "image",
  "services",
  "cache",
  "before_script",
  "after_script",
  "types",
  "spec",
]);

/** One string of a job's `script` (or the whole value of `script: <string>`). */
export interface GitLabScriptItem {
  ref: ScalarRef;
  /** The shell commands in it (a block scalar can hold several). */
  commands: RunCommand[];
}

export interface GitLabScript {
  key: "before_script" | "script" | "after_script";
  pair: Pair;
  /** The sequence, unless the value is a single string. */
  seq?: YAMLSeq;
  /** Written in flow style (`[a, b]`): no line-based edits. */
  flow: boolean;
  items: GitLabScriptItem[];
  /** Entries that aren't plain strings (`!reference`, aliases, nested lists). */
  others: number;
}

export interface GitLabJob {
  name: string;
  /** The file that defines it. */
  path: string;
  pair: Pair;
  map: YAMLMap;
  line: number;
  /** A hidden job (`.name`): a template that only runs through `extends` or `!reference`. */
  hidden: boolean;
  /** The job as plain data, with merge keys and aliases resolved. */
  data: Record<string, unknown>;
  scripts: GitLabScript[];
  /** The job's map has an anchor, so other places may alias it. */
  anchored: boolean;
}

export interface GitLabInclude {
  /** Repo-relative path of the included file. */
  path: string;
  /** The include entry: a sequence item, or the whole `include` value. */
  node: Node;
  /** The sequence holding the entry, if any. */
  seq?: YAMLSeq;
  /** The `include` pair of the including file. */
  pair: Pair;
  line: number;
}

export interface GitLabFile {
  path: string;
  text: string;
  doc: Document;
  root: YAMLMap;
  /** The whole file as plain data (merge keys and aliases resolved). */
  data: Record<string, unknown>;
  jobs: GitLabJob[];
  /** Local includes this file has (files that exist). */
  includes: GitLabInclude[];
  /** The file and entry that include this one; undefined for `.gitlab-ci.yml`. */
  includedBy?: { path: string; include: GitLabInclude };
}

export interface GitLabCi {
  /** `.gitlab-ci.yml` first, then the included files in the order they're found. */
  files: GitLabFile[];
  /** Every job by name (the first definition found wins). */
  jobs: Map<string, GitLabJob>;
  notes: { path: string; line?: number; message: string }[];
}

const MAX_INCLUDE_DEPTH = 5;

function scalarRefOf(text: string, node: Scalar): ScalarRef | undefined {
  if (typeof node.value !== "string" || !node.range) return undefined;
  return { value: node.value, node, line: lineOf(text, node.range[0]) };
}

function parseScripts(text: string, map: YAMLMap): GitLabScript[] {
  const scripts: GitLabScript[] = [];
  for (const key of ["before_script", "script", "after_script"] as const) {
    const pair = pairOf(map, key);
    if (!pair) continue;
    const value = pair.value;
    const script: GitLabScript = { key, pair, flow: false, items: [], others: 0 };
    const add = (node: unknown) => {
      const ref = isScalar(node) ? scalarRefOf(text, node) : undefined;
      if (ref) script.items.push({ ref, commands: runCommands(ref, text) });
      else script.others++;
    };
    if (isSeq(value)) {
      script.seq = value as YAMLSeq;
      script.flow = Boolean((value as YAMLSeq).flow);
      for (const item of (value as YAMLSeq).items) add(item);
    } else {
      add(value);
    }
    scripts.push(script);
  }
  return scripts;
}

/** The local files an `include` value names (raw paths, as written), with their entries. */
function localIncludes(pair: Pair): { raw: string; node: Node; seq?: YAMLSeq; skipped?: string }[] {
  const value = pair.value;
  const seq = isSeq(value) ? (value as YAMLSeq) : undefined;
  const items = seq ? seq.items : [value];
  const out: { raw: string; node: Node; seq?: YAMLSeq; skipped?: string }[] = [];
  for (const item of items) {
    let raw: string | undefined;
    if (isScalar(item) && typeof item.value === "string") {
      // A plain string is a local file, or a remote one when it's a URL.
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(item.value)) continue;
      raw = item.value;
    } else if (isMap(item)) {
      const local = (item as YAMLMap).get("local");
      if (typeof local === "string") raw = local;
    }
    // project, remote, template and component includes aren't in this repo.
    if (raw === undefined) continue;
    const entry = { raw, node: item as Node, ...(seq ? { seq } : {}) };
    if (raw.includes("$")) out.push({ ...entry, skipped: "it uses a variable" });
    else if (!/\.ya?ml$/i.test(raw) && !raw.includes("*")) {
      out.push({ ...entry, skipped: "it isn't a .yml file" });
    } else out.push(entry);
  }
  return out;
}

/** Parse one GitLab CI file; undefined (with a note) when it isn't valid YAML or a map. */
export function parseGitLabFile(
  path: string,
  text: string,
  notes: GitLabCi["notes"] = [],
): GitLabFile | undefined {
  const doc = parseDocument(text, { merge: true, customTags: GITLAB_CUSTOM_TAGS });
  if (doc.errors.length > 0) {
    notes.push({
      path,
      message: `can't parse the GitLab CI file: ${doc.errors[0]?.message.split("\n")[0] ?? "invalid YAML"}`,
    });
    return undefined;
  }
  if (!isMap(doc.contents)) return undefined;
  const rootMap = doc.contents as YAMLMap;
  let data: Record<string, unknown> = {};
  try {
    const js = doc.toJS({ maxAliasCount: -1 }) as unknown;
    if (js && typeof js === "object") data = js as Record<string, unknown>;
  } catch {
    // An unresolvable alias: jobs keep their own keys only.
  }
  const jobs: GitLabJob[] = [];
  for (const item of rootMap.items) {
    if (!isScalar(item.key) || !isMap(item.value)) continue;
    const name = String(item.key.value);
    if (GITLAB_RESERVED.has(name) || name === "<<") continue;
    const map = item.value as YAMLMap;
    const own = data[name];
    jobs.push({
      name,
      path,
      pair: item as Pair,
      map,
      line: lineOf(text, item.key.range?.[0] ?? 0),
      hidden: name.startsWith("."),
      data: own && typeof own === "object" ? (own as Record<string, unknown>) : {},
      scripts: parseScripts(text, map),
      anchored: Boolean(map.anchor),
    });
  }
  return { path, text, doc, root: rootMap, data, jobs, includes: [] };
}

/**
 * A configuration of already-read files (the first is `.gitlab-ci.yml`); literal local includes
 * between them are linked, nothing else is read.
 */
export function gitlabCiOf(files: readonly { path: string; text: string }[]): GitLabCi {
  const notes: GitLabCi["notes"] = [];
  const parsed = files
    .map((f) => parseGitLabFile(f.path, f.text, notes))
    .filter((f): f is GitLabFile => f !== undefined);
  for (const file of parsed) {
    const pair = pairOf(file.root, "include");
    if (!pair) continue;
    for (const entry of localIncludes(pair)) {
      const path = normalizeRel(entry.raw.replace(/^\/+/, ""));
      const included = parsed.find((f) => f.path === path && f !== file);
      if (entry.skipped || !included || included.includedBy) continue;
      const include: GitLabInclude = {
        path,
        node: entry.node,
        ...(entry.seq ? { seq: entry.seq } : {}),
        pair,
        line: lineOf(file.text, (entry.node as { range?: number[] }).range?.[0] ?? 0),
      };
      included.includedBy = { path: file.path, include };
      file.includes.push(include);
    }
  }
  return { files: parsed, jobs: jobsOf(parsed), notes };
}

function jobsOf(files: readonly GitLabFile[]): Map<string, GitLabJob> {
  const jobs = new Map<string, GitLabJob>();
  for (const f of files) for (const j of f.jobs) if (!jobs.has(j.name)) jobs.set(j.name, j);
  return jobs;
}

async function readFile(
  root: string,
  path: string,
  notes: GitLabCi["notes"],
): Promise<GitLabFile | undefined> {
  const text = await readTextOrNull(absolute(root, path));
  return text === null ? undefined : parseGitLabFile(path, text, notes);
}

/**
 * `.gitlab-ci.yml` and the local files it includes (`include: local`, plain paths, recursively),
 * or `null` without a `.gitlab-ci.yml`. Remote, project, template and component includes are
 * left out; so are files that don't parse (with a note).
 */
export async function readGitLabCi(root: string): Promise<GitLabCi | null> {
  const notes: GitLabCi["notes"] = [];
  const first = await readFile(root, GITLAB_CI_FILE, notes);
  if (!first) {
    if ((await readTextOrNull(absolute(root, GITLAB_CI_FILE))) === null) return null;
    return { files: [], jobs: new Map(), notes };
  }
  const files: GitLabFile[] = [first];
  const seen = new Set([GITLAB_CI_FILE]);
  const queue: { file: GitLabFile; depth: number }[] = [{ file: first, depth: 0 }];
  while (queue.length > 0) {
    const { file, depth } = queue.shift() as { file: GitLabFile; depth: number };
    const pair = pairOf(file.root, "include");
    if (!pair) continue;
    for (const entry of localIncludes(pair)) {
      const line = lineOf(file.text, (entry.node as { range?: number[] }).range?.[0] ?? 0);
      if (entry.skipped) {
        notes.push({
          path: file.path,
          line,
          message: `include ${entry.raw} isn't scanned: ${entry.skipped}`,
        });
        continue;
      }
      const rel = normalizeRel(entry.raw.replace(/^\/+/, ""));
      const paths = rel.includes("*") ? await globRel(root, [rel]) : [rel];
      for (const path of paths) {
        if (seen.has(path) || depth + 1 > MAX_INCLUDE_DEPTH) continue;
        seen.add(path);
        const include: GitLabInclude = {
          path,
          node: entry.node,
          ...(entry.seq ? { seq: entry.seq } : {}),
          pair,
          line,
        };
        const included = await readFile(root, path, notes);
        if (!included) {
          if ((await readTextOrNull(absolute(root, path))) === null) {
            notes.push({
              path: file.path,
              line,
              message: `the included file ${path} doesn't exist`,
            });
          }
          continue;
        }
        // Only a literal path can be deleted together with its include entry.
        if (!rel.includes("*")) included.includedBy = { path: file.path, include };
        file.includes.push(include);
        files.push(included);
        queue.push({ file: included, depth: depth + 1 });
      }
    }
  }
  return { files, jobs: jobsOf(files), notes };
}

// ---------------------------------------------------------------------------
// What starts a job

function names(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

/** `key` of a job, following `extends` (later templates win, the job's own value wins). */
export function effective(
  ci: GitLabCi,
  job: GitLabJob,
  key: string,
  seen = new Set<GitLabJob>(),
): unknown {
  if (seen.has(job)) return undefined;
  seen.add(job);
  if (job.data[key] !== undefined) return job.data[key];
  for (const name of [...names(job.data.extends)].reverse()) {
    const parent = ci.jobs.get(name);
    const value = parent ? effective(ci, parent, key, seen) : undefined;
    if (value !== undefined) return value;
  }
  return undefined;
}

const TAG_CONDITION = /(?<![!])\$\{?CI_COMMIT_TAG\}?(?!\s*==\s*null)(?!\s*==\s*"")/;
const BRANCH_CONDITION =
  /\$\{?(?:CI_COMMIT_BRANCH|CI_DEFAULT_BRANCH|CI_COMMIT_REF_NAME|CI_COMMIT_REF_SLUG|CI_COMMIT_REF_PROTECTED)\b|\$CI_PIPELINE_SOURCE\s*==\s*["']push["']/;
/** `only` / `except` refs that aren't branches. */
const NOT_BRANCH_REFS = new Set([
  "tags",
  "merge_requests",
  "schedules",
  "triggers",
  "pipelines",
  "api",
  "web",
  "external",
  "external_pull_requests",
  "chat",
]);

function rulesOf(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((r): r is Record<string, unknown> => r !== null && typeof r === "object");
}

function onlyRefs(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" || Array.isArray(value)) return names(value);
  if (typeof value === "object") {
    const refs = (value as Record<string, unknown>).refs;
    return refs === undefined ? [] : names(refs);
  }
  return undefined;
}

/** True when the job runs in tag pipelines (`only: tags`, a `$CI_COMMIT_TAG` rule). */
export function runsOnTags(ci: GitLabCi, job: GitLabJob): boolean {
  const only = onlyRefs(effective(ci, job, "only"));
  if (only?.includes("tags")) return true;
  const rules = rulesOf(effective(ci, job, "rules"));
  return (rules ?? []).some(
    (r) => typeof r.if === "string" && TAG_CONDITION.test(r.if) && r.when !== "never",
  );
}

/** True when a branch push can start the job (no rules, a branch rule or `only` ref). */
export function runsOnBranchPush(ci: GitLabCi, job: GitLabJob): boolean {
  const rules = rulesOf(effective(ci, job, "rules"));
  if (rules) {
    return rules.some((r) => {
      if (r.when === "never") return false;
      if (typeof r.if !== "string") return true;
      return BRANCH_CONDITION.test(r.if) && !/^\s*\$\{?CI_COMMIT_TAG\}?\s*$/.test(r.if);
    });
  }
  const except = onlyRefs(effective(ci, job, "except"));
  if (except?.includes("branches")) return false;
  const only = onlyRefs(effective(ci, job, "only"));
  if (only === undefined) return true;
  if (only.length === 0) return true;
  return only.some((ref) => !NOT_BRANCH_REFS.has(ref));
}

function extendsClosure(ci: GitLabCi, job: GitLabJob, seen = new Set<string>()): Set<string> {
  for (const name of names(job.data.extends)) {
    if (seen.has(name)) continue;
    seen.add(name);
    const parent = ci.jobs.get(name);
    if (parent) extendsClosure(ci, parent, seen);
  }
  return seen;
}

/** `!reference [job, …]` targets anywhere inside a value. */
function referencedJobs(value: unknown, out = new Set<string>()): Set<string> {
  if (value instanceof GitLabReference) {
    const [name] = value.path;
    if (typeof name === "string") out.add(name);
  } else if (Array.isArray(value)) {
    for (const v of value) referencedJobs(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) referencedJobs(v, out);
  }
  return out;
}

/** The visible jobs that run `job`'s keys: itself, and the jobs extending or referencing it. */
export function usersOf(ci: GitLabCi, job: GitLabJob): GitLabJob[] {
  const users: GitLabJob[] = [];
  for (const file of ci.files) {
    for (const other of file.jobs) {
      if (other.hidden || ci.jobs.get(other.name) !== other) continue;
      if (
        other === job ||
        extendsClosure(ci, other).has(job.name) ||
        referencedJobs(other.data).has(job.name)
      ) {
        users.push(other);
      }
    }
  }
  return users;
}

/** Why `job` can't simply be deleted: jobs that extend, need or reference it. */
export function referencesTo(ci: GitLabCi, job: GitLabJob): string[] {
  const out: string[] = [];
  for (const file of ci.files) {
    for (const other of file.jobs) {
      if (other === job) continue;
      if (names(other.data.extends).includes(job.name)) out.push(`job "${other.name}" extends it`);
      const needs = Array.isArray(other.data.needs) ? other.data.needs : [];
      const needed = needs.some(
        (n) =>
          n === job.name ||
          (n !== null &&
            typeof n === "object" &&
            (n as Record<string, unknown>).job === job.name &&
            (n as Record<string, unknown>).pipeline === undefined &&
            (n as Record<string, unknown>).project === undefined),
      );
      if (needed) out.push(`job "${other.name}" needs it`);
      if (names(other.data.dependencies).includes(job.name)) {
        out.push(`job "${other.name}" depends on its artifacts`);
      }
      if (referencedJobs(other.data).has(job.name)) {
        out.push(`job "${other.name}" uses !reference [${job.name}, …]`);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Docker builds

/** Where a `latest` tag is pushed, and how it can be taken out. */
export interface GitLabLatestRef {
  item: GitLabScriptItem;
  command: RunCommand;
  /** The image ref as written. */
  entry: string;
  line: number;
  /**
   * `command`: the command only moves latest (`docker push x:latest`, `docker tag … x:latest`);
   * `flag`: a `-t x:latest` of a build with other tags, spliced out; none: no minimal edit.
   */
  removal?: "command" | "flag";
}

export interface GitLabDockerBuild {
  /** The job whose script holds the commands (a template for jobs that extend it). */
  job: GitLabJob;
  path: string;
  line: number;
  /** `job "name"`. */
  label: string;
  /** Dockerfile path relative to the repo root. */
  file: string;
  context: string;
  images: string[];
  unresolved: string[];
  tags: string[];
  platforms?: string;
  pushes: boolean;
  latest: GitLabLatestRef[];
  /** A job that runs it runs in tag pipelines: its tags define the release tags. */
  release: boolean;
  /** A branch push runs it. */
  onBranch: boolean;
}

function variablesOf(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === "string" || typeof v === "number") out[key] = String(v);
    else if (v && typeof v === "object" && "value" in v) {
      const inner = (v as { value?: unknown }).value;
      if (typeof inner === "string" || typeof inner === "number") out[key] = String(inner);
    }
  }
  return out;
}

const hasVariable = (value: string) => /\$\{?[A-Za-z_]/.test(value);

/** GitLab's predefined variables launchset can know before a pipeline runs. */
export function predefinedVariables(project?: { path: string; gitlabCom: boolean }) {
  const env: Record<string, string> = { CI_PROJECT_DIR: "." };
  if (!project) return env;
  const segments = project.path.split("/");
  env.CI_PROJECT_PATH = project.path;
  env.CI_PROJECT_NAME = segments.at(-1) ?? project.path;
  env.CI_PROJECT_NAMESPACE = segments.slice(0, -1).join("/");
  if (project.gitlabCom) {
    // Self-managed instances name their registry; only gitlab.com's is known.
    env.CI_REGISTRY = "registry.gitlab.com";
    env.CI_REGISTRY_IMAGE = `registry.gitlab.com/${project.path.toLowerCase()}`;
  }
  return env;
}

const ASSIGNMENT = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S*)$/;

/** Every Docker build or push in the jobs' scripts, one per job. */
export function gitlabDockerBuilds(
  ci: GitLabCi,
  options: { project?: { path: string; gitlabCom: boolean }; gitTagPrefix: string },
): GitLabDockerBuild[] {
  const builds: GitLabDockerBuild[] = [];
  const global: Record<string, string> = {};
  for (const f of [...ci.files].reverse()) {
    Object.assign(global, variablesOf(f.data.variables));
  }
  for (const file of ci.files) {
    for (const job of file.jobs) {
      if (ci.jobs.get(job.name) !== job || job.scripts.length === 0) continue;
      const users = usersOf(ci, job);
      if (users.length === 0) continue;
      const release = users.some((u) => runsOnTags(ci, u));
      const onBranch = users.some((u) => runsOnBranchPush(ci, u));
      const tagPrefix = release ? options.gitTagPrefix : null;
      const env: Record<string, string> = {
        ...predefinedVariables(options.project),
        ...global,
        ...variablesOf(effective(ci, job, "variables")),
      };
      const images: string[] = [];
      const unresolved: string[] = [];
      const tags: string[] = [];
      const latest: GitLabLatestRef[] = [];
      let buildCommand: { file?: string; context: string } | undefined;
      let platforms: string | undefined;
      let pushes = false;
      let line: number | undefined;
      for (const script of job.scripts) {
        if (script.key === "after_script") continue;
        for (const item of script.items) {
          for (const command of item.commands) {
            const assignment = ASSIGNMENT.exec(command.command.trim());
            if (assignment) {
              env[assignment[1] as string] = resolveExpressions(
                (assignment[2] as string).replace(/^["']|["']$/g, ""),
                { env },
              );
              continue;
            }
            if (!/\bdocker\b/.test(command.command)) continue;
            const parsed = parseDockerCommands(command.command);
            const pushRefs = parsed.push ?? [];
            const buildPushes = /--push\b/.test(command.command);
            const buildTags = parsed.build?.tags ?? [];
            const refs = [...buildTags, ...pushRefs];
            if (refs.length === 0) continue;
            line ??= command.lines[0]?.number ?? item.ref.line;
            if (parsed.build) buildCommand ??= parsed.build;
            platforms ??= /--platform[=\s]+(\S+)/.exec(command.command)?.[1];
            if (pushRefs.length > 0 || buildPushes) pushes = true;
            const single = !/&&|;|\|\|/.test(command.command);
            for (const ref of refs) {
              const { image, tag } = splitImageRef(ref);
              const resolved = resolveExpressions(image, { env }).toLowerCase();
              if (hasVariable(resolved)) {
                if (!unresolved.includes(image)) unresolved.push(image);
              } else if (!images.includes(resolved)) images.push(resolved);
              if (tag === undefined) continue;
              const template = tagTemplate(tag, tagPrefix, { env });
              if (template && !tags.includes(template)) tags.push(template);
              if (template !== "latest") continue;
              const isPushRef = pushRefs.includes(ref);
              if (!isPushRef && !buildPushes) continue;
              const physical = command.lines.find((l) => l.text.includes(ref)) ?? command.lines[0];
              const at = physical?.number ?? item.ref.line;
              const entry: GitLabLatestRef = { item, command, entry: ref, line: at };
              if (isPushRef && single) entry.removal = "command";
              else if (!isPushRef && buildTags.length > 1) entry.removal = "flag";
              latest.push(entry);
            }
          }
        }
      }
      if (line === undefined) continue;
      const context = normalizeRel(resolveExpressions(buildCommand?.context ?? ".", { env }));
      const fileArg = buildCommand?.file
        ? normalizeRel(resolveExpressions(buildCommand.file, { env }))
        : undefined;
      const build: GitLabDockerBuild = {
        job,
        path: job.path,
        line,
        label: `job "${job.name}"`,
        file: fileArg ? joinRel(".", fileArg) : joinRel(context, "Dockerfile"),
        context,
        images,
        unresolved,
        tags,
        pushes,
        latest,
        release,
        onBranch,
      };
      if (platforms) build.platforms = platforms.replace(/^["']|["']$/g, "");
      builds.push(build);
    }
  }
  return builds;
}

// ---------------------------------------------------------------------------
// Pipeline-level settings

/** The project's `stages:` (from `.gitlab-ci.yml`, else the last included file that has one). */
export function gitlabStages(
  ci: GitLabCi,
): { stages: string[]; path: string; line: number } | undefined {
  const [root, ...included] = ci.files;
  for (const file of [root, ...included.reverse()]) {
    if (!file) continue;
    const pair = pairOf(file.root, "stages");
    if (!pair || !isSeq(pair.value)) continue;
    const stages = (pair.value as YAMLSeq).items
      .map((i) => (isScalar(i) ? String(i.value) : undefined))
      .filter((s): s is string => s !== undefined);
    return {
      stages,
      path: file.path,
      line: lineOf(file.text, (pair.key as Scalar).range?.[0] ?? 0),
    };
  }
  return undefined;
}

/** True when a file of the configuration has a top-level `workflow:` with `rules`. */
export function hasWorkflowRules(ci: GitLabCi): boolean {
  return ci.files.some((f) => {
    const workflow = f.data.workflow;
    return Boolean(workflow && typeof workflow === "object" && "rules" in workflow);
  });
}
