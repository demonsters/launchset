/**
 * `launchset status` (spec 11): pending changesets, next version, consistency, last release,
 * unfinished releases, manual targets, the no-changeset warning. With `requireChangeset`, it
 * fails unless a changeset was added or changed compared with `since`.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LaunchsetError } from "../core/errors.ts";
import { renderSummary } from "../core/plan-common.ts";
import { computeStatus, renderStatus, type StatusData } from "../core/status.ts";
import { checkConsistency } from "../platforms/index.ts";
import type { FlowContext, FlowResult } from "./context.ts";
import {
  baseBranchRef,
  botPrsSince,
  findReleaseCommitFor,
  gatherRepoState,
  tryResolveBranch,
} from "./gather.ts";

export interface StatusOptions {
  /** Default: git's current branch (or the Actions ref). */
  branch?: string;
  /** `git fetch --tags` first (when a remote exists). Default true. */
  fetch?: boolean;
  /** Look up bot PRs without a changeset (needs a GitHub client). Default: when a client exists. */
  botPrs?: boolean;
  /** `--require-changeset`: fail unless a changeset is added or changed compared with `since`. */
  requireChangeset?: boolean;
  /** `--since <ref>`; default `origin/<baseBranch>` (or `<baseBranch>` without a remote). */
  since?: string;
}

export interface StatusResultData extends StatusData {
  /** Set with `requireChangeset`. */
  requireChangeset?: { since: string; ok: boolean; changesets: string[] };
}

/**
 * Changeset files (working tree) that are new or different compared with `since`. Paths are
 * repo-relative.
 */
async function changesetsSince(
  context: FlowContext,
  since: string,
  files: StatusData["pending"],
  invalid: StatusData["invalid"],
): Promise<string[]> {
  const sinceSha = await context.git.tryRevParse(since);
  if (!sinceSha) {
    throw new LaunchsetError("unknown-ref", `--since ${since} isn't a known commit or branch`, {
      hint: "Pass a branch, tag or commit, e.g. --since origin/main (fetch it first).",
    });
  }
  const top = await context.git.topLevel();
  const changed: string[] = [];
  for (const path of [...files.map((f) => f.path), ...invalid.map((f) => f.path)]) {
    const before = await context.git.showFile(sinceSha, path);
    const now = await readFile(join(top, path), "utf8");
    if (before !== now) changed.push(path);
  }
  return changed.sort();
}

/** `launchset status` (spec 11). */
export async function status(
  context: FlowContext,
  options: StatusOptions = {},
): Promise<FlowResult<StatusResultData>> {
  const { config } = context;
  // A detached HEAD (e.g. `git checkout v1.5.0` before `launchset ship`) uses the base
  // branch's rules: status only reads, so that's always safe.
  const branch = options.branch ?? (await tryResolveBranch(context)) ?? config.baseBranch;
  const repo = await gatherRepoState(context, {
    worktree: true,
    branch,
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });
  const wantBots = options.botPrs ?? context.forge !== undefined;
  let botPrs: StatusData["botPrs"] = [];
  if (wantBots) {
    const releaseCommit = await findReleaseCommitFor(context, repo.tags, repo.version);
    botPrs = await botPrsSince(
      context,
      repo.branch,
      releaseCommit ?? repo.lastReleaseTag ?? undefined,
    );
  }
  const data: StatusResultData = computeStatus({
    config,
    branch: repo.branch,
    version: repo.version,
    changesets: repo.changesetFiles,
    mismatches: await checkConsistency(config, context.cwd),
    tags: repo.tags,
    reachableReleases: repo.reachableReleases,
    commitsSinceRelease: repo.commitsSinceRelease,
    botPrs,
  });
  let ok = true;
  const extra: string[] = [];
  if (options.requireChangeset) {
    const since = options.since ?? (await baseBranchRef(context));
    const changesets = await changesetsSince(context, since, data.pending, data.invalid);
    ok = changesets.length > 0;
    data.requireChangeset = { since, ok, changesets };
    extra.push(
      ok
        ? `Changesets compared with ${since}: ${changesets.join(", ")}`
        : `Error: no changeset added or changed compared with ${since}. Add one with: launchset add`,
    );
  }
  const text = renderStatus(data, context.host);
  const lines = [
    ...text.replace(/\n$/, "").split("\n"),
    ...(extra.length > 0 ? ["", ...extra] : []),
  ];
  return {
    ok,
    outputs: {},
    summary: renderSummary({
      title: "launchset status",
      paragraphs: [`\`\`\`\n${text}\`\`\``, ...extra],
    }),
    lines,
    data,
  };
}
