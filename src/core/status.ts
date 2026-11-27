/**
 * `launchset status` (spec 11): pending changesets, bump, next version, consistency, last
 * release, unfinished releases, manual targets and the no-changeset warning. Pure: the CLI
 * gathers the inputs and prints `renderStatus` or the data as JSON.
 */

import { baselineAction } from "./baseline.ts";
import { isMaintenanceBranch } from "./branches.ts";
import type { ResolvedConfig } from "./config/schema.ts";
import { type ForgeHost, forgeWords } from "./forge-links.ts";
import {
  type BotPrInfo,
  type ChangesetFile,
  type CommitInfo,
  describeManualTarget,
  describeMismatch,
  firstLine,
  highestVersion,
  invalidChangesetFiles,
  type ManualTargetStatus,
  manualTargetStatuses,
  plural,
  type TagSnapshot,
  type VersionMismatch,
  validChangesets,
} from "./plan-common.ts";
import { commitsWithoutChangesetWarning } from "./release.ts";
import { autoTargets, hasMarker, releaseTag, takenVersions, unfinishedReleases } from "./tags.ts";
import type { Bump } from "./types.ts";
import { parseMaintenanceBranch, releaseBump, releaseVersion } from "./versions.ts";

export interface StatusInput {
  config: ResolvedConfig;
  branch: string;
  /** Root version at HEAD. */
  version: string;
  /** Every changeset file at HEAD. */
  changesets: readonly ChangesetFile[];
  /** Consistency check result (spec 6.7). */
  mismatches: readonly VersionMismatch[];
  tags: TagSnapshot;
  /** Plain versions whose release tag is reachable from HEAD; default: every release. */
  reachableReleases?: readonly string[];
  /** Commits since the last release (newest first). */
  commitsSinceRelease: readonly CommitInfo[];
  /** Bot PRs without changeset, when known (needs a token). */
  botPrs?: readonly BotPrInfo[];
}

export interface StatusData {
  branch: string;
  maintenance: boolean;
  version: string;
  pending: { path: string; bump: Bump; summary: string; source?: "bot" }[];
  invalid: { path: string; error: string }[];
  /** Bump of the pending changesets; `null` when nothing would be released. */
  bump: Exclude<Bump, "none"> | null;
  nextVersion: string | null;
  /** Why `nextVersion` can't be computed (e.g. minor on a maintenance branch). */
  nextVersionError?: string;
  botPrs: BotPrInfo[];
  consistency: { ok: boolean; mismatches: VersionMismatch[] };
  lastRelease: { version: string; tag: string } | null;
  /**
   * `baseline` in the config is the current version and its release tag doesn't exist yet: the
   * release workflow on the base branch creates `tag` (spec 11.1 step 5). Absent otherwise.
   */
  baseline?: { version: string; tag: string };
  unfinished: { version: string; shipped: string[]; missing: string[] }[];
  manualTargets: ManualTargetStatus[];
  /** Commits that no pending changeset covers (none pending at all). */
  commitsWithoutChangeset: { since: string | null; commits: CommitInfo[] } | null;
  warnings: string[];
}

export function computeStatus(input: StatusInput): StatusData {
  const { config } = input;
  const index = input.tags.index;
  const valid = validChangesets(input.changesets);
  const invalid = invalidChangesetFiles(input.changesets);
  const botPrs = [...(input.botPrs ?? [])];
  const maintenance = isMaintenanceBranch(config, input.branch);
  const warnings = input.changesets.flatMap((f) => (f.ok ? f.warnings : []));

  let bump = releaseBump(valid);
  if (bump === null && botPrs.length > 0) bump = "patch";
  let nextVersion: string | null = null;
  let nextVersionError: string | undefined;
  if (bump !== null) {
    const line = parseMaintenanceBranch(input.branch, config.maintenanceBranches);
    try {
      nextVersion = releaseVersion({
        current: input.version,
        bump,
        taken: takenVersions(index),
        ...(line
          ? { maintenance: { line, branch: input.branch, baseBranch: config.baseBranch } }
          : {}),
      });
    } catch (error) {
      nextVersionError = (error as Error).message;
    }
  }

  const reachable = input.reachableReleases ?? [...index.releases.keys()];
  const last = highestVersion(reachable);
  const lastRelease = last === null ? null : { version: last, tag: releaseTag(config.tags, last) };

  const auto = autoTargets(config);
  const unfinished = unfinishedReleases(index).map((version) => ({
    version,
    shipped: auto.filter((t) => hasMarker(index, t, version)),
    missing: auto.filter((t) => !hasMarker(index, t, version)),
  }));

  // Not the branch: on the migration branch the baseline is still the base branch's to create.
  const baseline = maintenance
    ? undefined
    : baselineAction(config, { branch: config.baseBranch, version: input.version, index });
  if (baseline?.kind === "skip") warnings.push(baseline.warning);
  const pendingBaseline = baseline?.kind === "create" ? baseline : undefined;

  // With a pending baseline the commits so far are part of that release, not unreleased work.
  const commitsWithoutChangeset =
    pendingBaseline === undefined &&
    input.changesets.length === 0 &&
    botPrs.length === 0 &&
    input.commitsSinceRelease.length > 0
      ? { since: lastRelease?.tag ?? null, commits: [...input.commitsSinceRelease] }
      : null;

  const data: StatusData = {
    branch: input.branch,
    maintenance,
    version: input.version,
    pending: valid.map((c) => ({
      path: c.path,
      bump: c.bump,
      summary: c.summary,
      ...(c.source ? { source: c.source } : {}),
    })),
    invalid,
    bump,
    nextVersion,
    botPrs,
    consistency: { ok: input.mismatches.length === 0, mismatches: [...input.mismatches] },
    lastRelease,
    unfinished,
    manualTargets: manualTargetStatuses(config, index),
    commitsWithoutChangeset,
    warnings,
  };
  if (nextVersionError !== undefined) data.nextVersionError = nextVersionError;
  if (pendingBaseline)
    data.baseline = { version: pendingBaseline.version, tag: pendingBaseline.tag };
  return data;
}

/** Plain-text status for the terminal (no colors). */
/** The status as text; `host` writes bot PRs as GitLab MRs (`!12`); default GitHub. */
export function renderStatus(data: StatusData, host?: ForgeHost): string {
  const words = forgeWords(host);
  const lines: string[] = [];
  lines.push(
    `Branch:        ${data.branch}${data.maintenance ? " (maintenance)" : ""}`,
    `Version:       ${data.version}`,
    `Last release:  ${data.lastRelease ? data.lastRelease.tag : "none yet"}`,
  );
  if (data.baseline) {
    lines.push(
      `Baseline:      ${data.baseline.tag}, not created yet: the first release workflow run on the base branch creates it, so ${data.baseline.version} counts as released (don't push it by hand)`,
    );
  }
  if (data.bump !== null) {
    lines.push(
      `Next version:  ${data.nextVersion ?? `can't be computed: ${data.nextVersionError ?? "unknown"}`} (${data.bump})`,
    );
  } else {
    lines.push("Next version:  nothing to release");
  }
  lines.push("");
  if (data.pending.length === 0) {
    lines.push("Pending changesets: none");
  } else {
    lines.push(`Pending changesets (${data.pending.length}):`);
    for (const c of data.pending) {
      lines.push(
        `  ${c.bump.padEnd(5)}  ${c.bump === "none" ? "(no release)" : firstLine(c.summary)}  ${c.path}`,
      );
    }
  }
  if (data.botPrs.length > 0) {
    lines.push(`Bot ${words.prName}s without changeset (${data.botPrs.length}):`);
    for (const pr of data.botPrs) lines.push(`  ${words.prText(pr.number)}  ${pr.title}`);
  }
  if (data.invalid.length > 0) {
    lines.push("", `Invalid changesets (${data.invalid.length}):`);
    for (const f of data.invalid) lines.push(`  ${f.error}`);
  }
  lines.push("");
  if (data.consistency.ok) {
    lines.push("Version files: consistent");
  } else {
    lines.push(
      `Version files: ${plural(data.consistency.mismatches.length, "mismatch", "mismatches")}`,
    );
    for (const m of data.consistency.mismatches) lines.push(`  ${describeMismatch(m)}`);
  }
  if (data.unfinished.length > 0) {
    lines.push("", "Unfinished releases:");
    for (const u of data.unfinished) {
      lines.push(
        `  ${u.version}: shipped ${u.shipped.join(", ") || "nothing"}; missing ${u.missing.join(", ") || "nothing"}`,
      );
    }
  }
  if (data.manualTargets.length > 0) {
    lines.push("", "Manual targets:");
    for (const m of data.manualTargets)
      lines.push(`  ${describeManualTarget(m).replace(/`/g, "")}`);
  }
  if (data.commitsWithoutChangeset) {
    lines.push(
      "",
      `Warning: ${commitsWithoutChangesetWarning(data.commitsWithoutChangeset.commits, data.commitsWithoutChangeset.since)}`,
    );
  }
  if (data.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const w of data.warnings) lines.push(`  ${w}`);
  }
  return `${lines.join("\n")}\n`;
}
