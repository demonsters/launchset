/**
 * Bot-PR detection for the release PR (spec 9.4): merged bot PRs since the last release
 * that didn't add a changeset get a generated `patch` changeset.
 */

import type { Git } from "../git/index.ts";
import { mapLimit } from "./concurrency.ts";
import type { GitHub } from "./index.ts";

export interface BotPr {
  number: number;
  /** PR title, used as the generated changeset's summary. */
  title: string;
  /** Bot login, e.g. `dependabot[bot]`. */
  author: string;
}

export interface FindBotPrsOptions {
  git: Git;
  github: GitHub;
  /**
   * Start of the range (exclusive): any ref or sha, typically the current version's release
   * commit (bot PRs before it were consumed by that release). Undefined = the whole history.
   */
  since?: string;
  /** Commit or ref the release PR is built from (usually HEAD). */
  head: string;
  /** Branch the PRs must have been merged into (the base or maintenance branch). */
  branch: string;
  /** Bot logins (`check.bots`), compared case-insensitively. */
  bots: readonly string[];
  /** True for repo-relative paths of changeset files (e.g. `.launchset/*.md` but not the README). */
  isChangesetPath: (path: string) => boolean;
  /** Parallel API calls; default 4. */
  concurrency?: number;
}

/** Slack for clock skew between the committer's machine and GitHub. */
export const UPDATED_SINCE_MARGIN_MS = 24 * 60 * 60 * 1000;

/**
 * Merged PRs into `branch` whose result is in `since..head`, authored by one of `bots`, that
 * didn't add or change a changeset. Sorted by PR number.
 *
 * Lists the branch's closed PRs (newest update first, stopping before the range start), so
 * it works on maintenance branches too and costs a few calls instead of one per commit. A PR
 * is in the range when its merge commit (merge, squash, or the last rebased commit) or its
 * head commit is one of the range's commits.
 */
export async function findBotPrsWithoutChangeset(options: FindBotPrsOptions): Promise<BotPr[]> {
  const { git, github, since, head, branch, isChangesetPath } = options;
  const concurrency = options.concurrency ?? 4;
  const bots = new Set(options.bots.map((b) => b.toLowerCase()));
  if (bots.size === 0) return [];

  const inRange = new Set(await git.revList(since ? `${since}..${head}` : head));
  if (inRange.size === 0) return [];

  const updatedSince = since
    ? new Date(Date.parse(await git.commitDate(since)) - UPDATED_SINCE_MARGIN_MS).toISOString()
    : undefined;
  const prs = await github.closedPrsInto(branch, updatedSince ? { updatedSince } : {});

  const candidates = prs
    .filter(
      (pr) =>
        pr.mergedAt &&
        pr.base === branch &&
        bots.has(pr.author.toLowerCase()) &&
        ((pr.mergeCommitSha !== null && inRange.has(pr.mergeCommitSha)) || inRange.has(pr.headSha)),
    )
    .sort((a, b) => a.number - b.number);

  const withChangeset = await mapLimit(candidates, concurrency, async (pr) => {
    const files = await github.prFiles(pr.number);
    return files.some((f) => f.status !== "removed" && isChangesetPath(f.path));
  });

  return candidates
    .filter((_, i) => !withChangeset[i])
    .map((pr) => ({ number: pr.number, title: pr.title, author: pr.author }));
}
