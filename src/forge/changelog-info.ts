/**
 * PR and author links for changelog entries (spec 12, `changelog.links`): the commit that
 * added each changeset → its merged PR. Missing token or no match → no entry, never a failure.
 */

import { messageWithHint } from "../core/errors.ts";
import type { Git } from "../git/index.ts";
import { UPDATED_SINCE_MARGIN_MS } from "./bot-prs.ts";
import { mapLimit } from "./concurrency.ts";
import type { Forge, Logger, PullRequest } from "./types.ts";

export interface ChangelogInfo {
  pr: number;
  /** PR author login, e.g. `someone` or `dependabot[bot]`. */
  author: string;
  /** PR URL. */
  url: string;
}

export interface ChangelogInfoOptions {
  git: Git;
  /** Undefined when there is no token: every lookup is skipped. */
  forge: Forge | undefined;
  /**
   * The branch the changesets were merged into. Preferred when a commit belongs to several
   * PRs, and needed for the fallback off the default branch (where GitHub's commit → PR
   * lookup only returns open PRs).
   */
  branch?: string;
  /** Ref whose history is searched; default HEAD. */
  head?: string;
  log?: Partial<Logger>;
  /** Parallel API calls; default 4. */
  concurrency?: number;
}

/** Pick the PR that brought a commit in: into `branch` if possible, then the earliest merged. */
function pickPr(prs: PullRequest[], branch: string | undefined): PullRequest | undefined {
  const preferred = branch ? prs.filter((pr) => pr.base === branch) : [];
  const pool = preferred.length ? preferred : prs;
  return [...pool].sort((a, b) => (a.mergedAt ?? "").localeCompare(b.mergedAt ?? ""))[0];
}

/**
 * Map of changeset path (repo-relative) → PR info, for the paths whose PR was found.
 *
 * 1. `GET /commits/{sha}/pulls` for the commit that added the file.
 * 2. When that finds no merged PR and `branch` is given: the branch's closed PRs (listed once),
 *    matched by merge commit sha against the adding commit, or, when the adding commit came in
 *    through a merge, against the first-parent commit that merged it.
 *
 * Lookups that fail are logged (warning) and left out, so the changelog never blocks a release.
 */
export async function changelogInfoFor(
  changesetPaths: readonly string[],
  options: ChangelogInfoOptions,
): Promise<Map<string, ChangelogInfo>> {
  const { git, forge, branch } = options;
  const head = options.head ?? "HEAD";
  const concurrency = options.concurrency ?? 4;
  const debug = (m: string) => options.log?.debug?.(m);
  const warn = (m: string) => (options.log?.warn ?? options.log?.debug)?.(m);
  const result = new Map<string, ChangelogInfo>();
  if (!forge) {
    debug("changelog.github: no GitHub token, leaving PR links out of the changelog.");
    return result;
  }
  const toInfo = (pr: PullRequest): ChangelogInfo => ({
    pr: pr.number,
    author: pr.author,
    url: pr.url,
  });

  // Phase 1: the commit → PR lookup.
  const misses: { path: string; added: string }[] = [];
  await mapLimit(changesetPaths, concurrency, async (path) => {
    try {
      const added = (await git.commitsAddingFile(path, head)).at(-1);
      if (!added) {
        debug(`changelog.github: no commit adds ${path} (uncommitted?), no PR link.`);
        return;
      }
      const pr = pickPr(await forge.pullRequestsForCommit(added), branch);
      if (pr) result.set(path, toInfo(pr));
      else misses.push({ path, added });
    } catch (error) {
      warn(
        `changelog.github: could not look up the PR for ${path}, leaving its link out: ${messageWithHint(error)}`,
      );
    }
  });
  if (misses.length === 0) return result;

  const noPr = (path: string, added: string) =>
    debug(`changelog.github: no merged PR for ${path} (commit ${added.slice(0, 12)}), no PR link.`);
  if (!branch) {
    for (const { path, added } of misses) noPr(path, added);
    return result;
  }

  // Phase 2: one listing of the branch's closed PRs, matched by merge commit.
  try {
    const dates = await Promise.all(misses.map(({ added }) => git.commitDate(added)));
    const oldest = Math.min(...dates.map((d) => Date.parse(d)));
    const updatedSince = new Date(oldest - UPDATED_SINCE_MARGIN_MS).toISOString();
    const listing = await forge.closedPrsInto(branch, { updatedSince });
    const byMergeCommit = new Map<string, PullRequest>();
    for (const pr of listing) if (pr.mergeCommitSha) byMergeCommit.set(pr.mergeCommitSha, pr);
    const firstParentChain = await git.firstParentLog(head);
    const firstParent = new Set(firstParentChain);

    for (const { path, added } of misses) {
      let pr = byMergeCommit.get(added);
      if (!pr && !firstParent.has(added)) {
        // Came in through a merge: the oldest first-parent commit descending from it is the
        // merge commit.
        const descendants = new Set(await git.revList(`${added}..${head}`, { ancestryPath: true }));
        const merging = firstParentChain.findLast((sha) => descendants.has(sha));
        if (merging) pr = byMergeCommit.get(merging);
      }
      if (pr) result.set(path, toInfo(pr));
      else noPr(path, added);
    }
  } catch (error) {
    warn(
      `changelog.github: could not list merged PRs into ${branch}, leaving ${misses.length} link(s) out: ${messageWithHint(error)}`,
    );
  }
  return result;
}
