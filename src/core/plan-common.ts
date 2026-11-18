/**
 * Building blocks shared by the release, preview, finalize, check and status logic: input
 * snapshots (tags with shas, commits, bot PRs, changeset files), per-target plans, and small
 * markdown helpers. Pure.
 */

import { type BuildNumberContext, computeBuildNumber, targetBuildNumber } from "./build-number.ts";
import { ChangesetError, parseChangeset } from "./changesets.ts";
import type { ResolvedConfig, ResolvedTarget } from "./config/schema.ts";
import { dockerPlan } from "./docker-tags.ts";
import { LaunchsetError } from "./errors.ts";
import { indexTags, markerTag, releasesAfter, type TagIndex } from "./tags.ts";
import type { Changeset, Channel, Plan, RunInfo, TargetPlan } from "./types.ts";
import { highestVersion, isPlainVersion, marketingVersion } from "./versions.ts";

// ---------------------------------------------------------------------------
// Input snapshots

/** A git tag and the commit it points to (annotated tags peeled), like `git.TagRef`. */
export interface TagRefInput {
  name: string;
  sha: string;
}

/** The repo's tags: classified (`indexTags`) plus each tag's commit. */
export interface TagSnapshot {
  index: TagIndex;
  /** Tag name → commit sha. */
  shas: ReadonlyMap<string, string>;
}

/** Index tag refs (from `git.listTags()` or similar) with the configured templates. */
export function snapshotTags(
  refs: Iterable<TagRefInput>,
  config: Pick<ResolvedConfig, "tags" | "targets">,
): TagSnapshot {
  const list = [...refs];
  return {
    index: indexTags(
      list.map((r) => r.name),
      config,
    ),
    shas: new Map(list.map((r) => [r.name, r.sha])),
  };
}

/** A commit, e.g. from `git log`. */
export interface CommitInfo {
  sha: string;
  subject: string;
}

/** A merged bot PR without a changeset (spec 9.4), like `github/bot-prs.BotPr`. */
export interface BotPrInfo {
  number: number;
  title: string;
  author: string;
}

/** A changeset file at some commit, parsed or not. */
export type ChangesetFile =
  | { path: string; ok: true; changeset: Changeset; warnings: string[] }
  | {
      path: string;
      ok: false;
      /** Full message, `file:line: reason`. */
      error: string;
      /** 1-based line, when known. */
      line?: number;
      hint?: string;
    };

/** Parse a changeset file into a `ChangesetFile` (parse errors become `ok: false`). */
export function readChangesetFile(text: string, path: string): ChangesetFile {
  try {
    const { changeset, warnings } = parseChangeset(text, path);
    return { path, ok: true, changeset, warnings };
  } catch (error) {
    if (error instanceof ChangesetError) {
      const result: ChangesetFile = { path, ok: false, error: error.message, line: error.line };
      if (error.hint !== undefined) result.hint = error.hint;
      return result;
    }
    throw error;
  }
}

/** The valid changesets of a list of files. */
export function validChangesets(files: readonly ChangesetFile[]): Changeset[] {
  return files.flatMap((f) => (f.ok ? [f.changeset] : []));
}

/** The files that couldn't be parsed, as `{ path, error }`. */
export function invalidChangesetFiles(
  files: readonly ChangesetFile[],
): { path: string; error: string }[] {
  return files.flatMap((f) => (f.ok ? [] : [{ path: f.path, error: f.error }]));
}

/**
 * A committed marketing version that differs from the root version (spec 6.7). Matches
 * `platforms.Mismatch` structurally.
 */
export interface VersionMismatch {
  /** Target name, or `null` for the version file's npm lockfile. */
  target: string | null;
  path: string;
  found: { key: string; value: string; line?: number }[];
  expected: string;
}

/** One line per mismatch: `apps/android/app/build.gradle (android): versionName = 1.3.0, expected 1.4.0`. */
export function describeMismatch(mismatch: VersionMismatch): string {
  const who = mismatch.target ? ` (${mismatch.target})` : "";
  const found =
    mismatch.found.length > 0
      ? mismatch.found
          .map((f) => `${f.key} = ${f.value}${f.line !== undefined ? ` (line ${f.line})` : ""}`)
          .join(", ")
      : "no value found";
  return `${mismatch.path}${who}: ${found}, expected ${mismatch.expected}`;
}

// ---------------------------------------------------------------------------
// Versions

export { highestVersion } from "./versions.ts";

/**
 * Normalize a user-given version (`workflow_dispatch` input, `--version`): trims, drops a
 * leading `v`. Throws when the result isn't a plain `X.Y.Z`.
 */
export function normalizeVersionInput(input: string, what = "version"): string {
  const version = input.trim().replace(/^[vV](?=\d)/, "");
  if (!isPlainVersion(version)) {
    throw new LaunchsetError(
      "invalid-version",
      `${what} "${input}" is not a released version like 1.4.0`,
      { hint: "Pass a plain X.Y.Z version (a leading v is fine)." },
    );
  }
  return version;
}

/** UTC day (`2026-11-18`) of a time. */
export function isoDay(now: Date | number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function isoTime(now: Date | number): string {
  return new Date(now).toISOString();
}

// ---------------------------------------------------------------------------
// Target plans

export interface TargetPlanContext {
  channel: Channel;
  /** The run's version (release, preview or prerelease version). */
  version: string;
  /** Plain `X.Y.Z` part of `version`. */
  baseVersion: string;
  /** Drop moving Docker tags (`latest`, `{major}`) as on a maintenance branch (spec 6.1). */
  maintenance: boolean;
  now: Date | number;
  run?: RunInfo;
  /** The built commit. */
  sha: string;
  /** ISO time of the plan (OCI `created` label). */
  createdAt: string;
  prNumber?: number;
  branchSlug?: string;
  preid?: string;
  /** Marker tag template; set on the release channel only. */
  markerTemplate?: { tags: ResolvedConfig["tags"] };
  /** The build number of a build that already happened (`mark --version`): not computed. */
  buildNumber?: number | null;
}

/** The build number inputs of a run: time, version and the CI run number and attempt. */
export function buildNumberContext(
  now: Date | number,
  version: string,
  run: RunInfo | undefined,
): BuildNumberContext {
  const context: BuildNumberContext = { now, version };
  if (run?.number !== undefined) context.runNumber = run.number;
  if (run?.attempt !== undefined) context.runAttempt = run.attempt;
  return context;
}

/**
 * The plan for one target: build number with the target's strategy (checked against its
 * limits, spec 6.3), marketing version (plain for iOS), marker (release channel) and Docker
 * data.
 */
export function buildTargetPlan(target: ResolvedTarget, ctx: TargetPlanContext): TargetPlan {
  const buildNumber =
    ctx.buildNumber !== undefined
      ? ctx.buildNumber
      : targetBuildNumber(target, buildNumberContext(ctx.now, ctx.baseVersion, ctx.run));
  const plan: TargetPlan = {
    name: target.name,
    type: target.type,
    release: target.release,
    marketingVersion: marketingVersion(target.type, ctx.version),
    buildNumber,
  };
  if (ctx.markerTemplate)
    plan.marker = markerTag(ctx.markerTemplate.tags, target.name, ctx.version);
  if (target.type === "docker") {
    const dockerCtx: Parameters<typeof dockerPlan>[1] = {
      channel: ctx.channel,
      version: ctx.version,
      maintenance: ctx.maintenance,
      sha: ctx.sha,
      buildNumber,
      createdAt: ctx.createdAt,
    };
    if (ctx.prNumber !== undefined) dockerCtx.prNumber = ctx.prNumber;
    if (ctx.branchSlug !== undefined) dockerCtx.branchSlug = ctx.branchSlug;
    if (ctx.preid !== undefined) dockerCtx.preid = ctx.preid;
    plan.docker = dockerPlan(target, dockerCtx);
  }
  return plan;
}

/** Plans for `names` (in the given order), keyed by name. */
export function buildTargetPlans(
  config: ResolvedConfig,
  names: readonly string[],
  ctx: TargetPlanContext,
): Record<string, TargetPlan> {
  const plans: Record<string, TargetPlan> = {};
  for (const name of names) {
    const target = config.targets[name];
    if (!target) throw unknownTarget(config, name);
    plans[name] = buildTargetPlan(target, ctx);
  }
  return plans;
}

/**
 * `plan.buildNumber`: the root strategy's number (spec 7.1), computed after `plan.targets`.
 * When the root strategy can't run here (`run-number` outside CI) but the targets override
 * it, the first target's number.
 */
export function planBuildNumber(
  config: Pick<ResolvedConfig, "buildNumber">,
  plan: Pick<Plan, "matrix" | "targets">,
  ctx: { now: Date | number; version: string; run?: RunInfo },
): number | null {
  try {
    return computeBuildNumber(
      config.buildNumber,
      buildNumberContext(ctx.now, ctx.version, ctx.run),
    );
  } catch (error) {
    const first = plan.matrix[0];
    if (error instanceof LaunchsetError && error.code === "no-run-number" && first) {
      return plan.targets[first]?.buildNumber ?? null;
    }
    throw error;
  }
}

export function unknownTarget(config: Pick<ResolvedConfig, "targets">, name: string) {
  return new LaunchsetError("unknown-target", `there is no target "${name}" in the config`, {
    hint: `Configured targets: ${Object.keys(config.targets).join(", ")}.`,
  });
}

/** Manual target names (spec 9.8), in config order. */
export function manualTargets(config: Pick<ResolvedConfig, "targets">): string[] {
  return Object.entries(config.targets)
    .filter(([, t]) => t.release === "manual")
    .map(([name]) => name);
}

/** How far a manual target lags behind (spec 9.8 visibility). */
export interface ManualTargetStatus {
  target: string;
  /** Highest version with a marker for this target, or `null` when it never shipped. */
  lastShipped: string | null;
  /** Releases newer than `lastShipped` (all releases when it never shipped). */
  releasesBehind: number;
}

/** Status of every manual target, in config order. */
export function manualTargetStatuses(
  config: Pick<ResolvedConfig, "targets">,
  index: TagIndex,
): ManualTargetStatus[] {
  return manualTargets(config).map((target) => {
    const lastShipped = highestVersion(
      [...index.markers.entries()]
        .filter(([version, targets]) => targets.has(target) && isPlainVersion(version))
        .map(([version]) => version),
    );
    const releasesBehind =
      lastShipped === null ? index.releases.size : releasesAfter(index, lastShipped);
    return { target, lastShipped, releasesBehind };
  });
}

/** `ios: 1.3.0 (9 releases behind)`, `ios: never shipped (3 releases)`. */
export function describeManualTarget(status: ManualTargetStatus): string {
  if (status.lastShipped === null) {
    return `${code(status.target)}: never shipped${status.releasesBehind > 0 ? ` (${plural(status.releasesBehind, "release")} so far)` : ""}`;
  }
  const behind =
    status.releasesBehind === 0
      ? "up to date"
      : `${plural(status.releasesBehind, "release")} behind`;
  return `${code(status.target)}: ${status.lastShipped} (${behind})`;
}

// ---------------------------------------------------------------------------
// Markdown

/** `a`, `a and b`, `a, b and c`. */
export function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** Inline code. */
export const code = (text: string): string => `\`${text.replace(/`/g, "'")}\``;

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** First line of a (multi-line) summary. */
export function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0]?.trim() ?? "";
}

/** A GitHub markdown alert block: `> [!KIND]` then the text quoted line by line. */
export function alert(kind: "NOTE" | "TIP" | "WARNING" | "CAUTION", text: string): string {
  return `> [!${kind}]\n${text
    .trimEnd()
    .split("\n")
    .map((l) => (l === "" ? ">" : `> ${l}`))
    .join("\n")}`;
}

/** A job summary: a heading, paragraphs, then `> [!WARNING]` / `> [!NOTE]` blocks. */
export function renderSummary(input: {
  title: string;
  paragraphs?: readonly string[];
  failures?: readonly string[];
  warnings?: readonly string[];
  notices?: readonly string[];
}): string {
  const blocks = [`## ${input.title}`];
  for (const p of input.paragraphs ?? []) if (p.trim() !== "") blocks.push(p.trimEnd());
  for (const f of input.failures ?? []) blocks.push(alert("CAUTION", f));
  for (const w of input.warnings ?? []) blocks.push(alert("WARNING", w));
  for (const n of input.notices ?? []) blocks.push(alert("NOTE", n));
  return `${blocks.join("\n\n")}\n`;
}
