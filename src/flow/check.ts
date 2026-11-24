/**
 * `command: check` (spec 9.2) and `launchset check --push` (spec 11): the PR check with its
 * sticky comment, and the pre-push warning for repos that push straight to the base branch.
 */

import { isChangesetPath } from "../core/changesets.ts";
import {
  CHECK_COMMENT_ID,
  type CheckResult,
  evaluateCheck,
  evaluatePushCheck,
  type PushCheckResult,
} from "../core/check.ts";
import { errorMessage, LaunchsetError } from "../core/errors.ts";
import { forgeHints } from "../core/forge-hints.ts";
import { forgeWords } from "../core/forge-links.ts";
import { DEFAULT_HOST } from "../core/hosts.ts";
import { type ChangesetFile, renderSummary } from "../core/plan-common.ts";
import { ForgeError } from "../forge/errors.ts";
import type { ChangedFile } from "../git/index.ts";
import { checkConsistency, readRootVersion } from "../platforms/index.ts";
import { branchFromRef, ciSystemOf, type FlowContext, type FlowResult } from "./context.ts";
import {
  allInOrder,
  baseBranchRef,
  changesetDir,
  commitsSince,
  lastReleaseTagOf,
  reachableReleaseVersions,
  readChangesetFiles,
  readTagSnapshot,
  rootVersionReader,
  syncTags,
  tryResolveBranch,
} from "./gather.ts";
import { appendAlerts, plain } from "./result.ts";

export interface CheckPrInfo {
  number?: number;
  author?: string;
  headBranch?: string;
  baseBranch?: string;
  /** The PR comes from a fork. Default from the payload; `false` for local runs. */
  fork?: boolean;
}

export interface CheckOptions {
  /**
   * Base ref to compare against (CLI `--base origin/main`). Default: the PR's base commit
   * from the `pull_request` event.
   */
  base?: string;
  /** Head ref; default HEAD. */
  head?: string;
  /** Override or fill in PR details (CLI use); the event payload is used otherwise. */
  pr?: CheckPrInfo;
  /** Post the sticky comment (when a client and PR number exist). Default true. */
  comment?: boolean;
  /** `check --push`: the pre-push warning; never fails. */
  push?: boolean;
  /** `git fetch --tags` first (when a remote exists). Default true. */
  fetch?: boolean;
  docsUrl?: string;
}

export interface CheckData {
  result: CheckResult;
  /** The sticky comment, when it was posted. */
  comment?: { id: number; url: string; action: "created" | "updated" | "unchanged" };
  /** Why the comment couldn't be posted (fork PR with a read-only token). */
  commentWarning?: string;
}

export interface PushCheckData {
  result: PushCheckResult;
}

/** `refs/heads/main`, `origin/main` → `main`. */
function shortBranch(ref: string): string {
  return (branchFromRef(ref) ?? ref)
    .replace(/^refs\/remotes\/[^/]+\//, "")
    .replace(/^origin\//, "");
}

/** A commit by ref or sha, or undefined. */
async function tryCommit(context: FlowContext, ref: string): Promise<string | undefined> {
  return context.git.tryRevParse(ref);
}

/**
 * The PR's head commit (`pull_request.head.sha`): `actions/checkout` checks out the merge
 * commit, whose second parent it is, so it's there with `fetch-depth: 0`. Otherwise it is
 * fetched from the host's PR head ref (`refs/pull/<n>/head`, GitLab
 * `refs/merge-requests/<n>/head`).
 */
async function resolveHead(context: FlowContext, ref: string, prNumber: number): Promise<string> {
  const { git } = context;
  const local = await tryCommit(context, ref);
  if (local) return local;
  if (prNumber > 0 && (await git.hasRemote())) {
    const tracking = `refs/remotes/${git.remote}/pr/${prNumber}`;
    if (await git.fetchRef(forgeWords(context.host).prRef(prNumber), tracking)) {
      const sha = (await tryCommit(context, ref)) ?? (await tryCommit(context, tracking));
      if (sha) return sha;
    }
  }
  throw new LaunchsetError("commit-not-found", `the PR head commit ${ref} isn't in this checkout`, {
    hint: forgeHints(context.host).prHeadMissing,
  });
}

/**
 * The tip of the base branch now: fetched from the remote (a payload's `base.sha` can be
 * stale when the base branch moved after the PR was opened), else the local branch, else
 * the payload's sha.
 */
async function baseTip(
  context: FlowContext,
  baseBranch: string,
  payloadSha: string | undefined,
): Promise<string> {
  const { git } = context;
  if (await git.hasRemote()) {
    const tracking = `refs/remotes/${git.remote}/${baseBranch}`;
    if (await git.fetchRef(`refs/heads/${baseBranch}`, tracking)) return git.revParse(tracking);
  }
  if (payloadSha) {
    const payload = await tryCommit(context, payloadSha);
    if (payload) return payload;
  }
  const found = await tryCommit(context, await baseBranchRef(context, baseBranch));
  if (found) return found;
  throw new LaunchsetError("unknown-base", `the base branch ${baseBranch} isn't available`, {
    hint: forgeHints(context.host).baseMissing,
  });
}

/** The merge base of `base` and `head`: the PR's changes are `mergeBase..head`. */
async function mergeBase(context: FlowContext, base: string, head: string): Promise<string> {
  const sha = await context.git.mergeBase(base, head);
  if (sha) return sha;
  throw new LaunchsetError(
    "no-merge-base",
    `the PR head ${head.slice(0, 7)} and the base ${base.slice(0, 7)} have no common commit in this checkout`,
    { hint: forgeHints(context.host).noMergeBase },
  );
}

/** `command: check` (spec 9.2), or `check --push` with `push: true`. */
export async function check(
  context: FlowContext,
  options: CheckOptions & { push: true },
): Promise<FlowResult<PushCheckData>>;
export async function check(
  context: FlowContext,
  options?: CheckOptions,
): Promise<FlowResult<CheckData>>;
export async function check(
  context: FlowContext,
  options: CheckOptions = {},
): Promise<FlowResult<CheckData | PushCheckData>> {
  if (options.push) return pushCheck(context, options);
  const { config } = context;
  await syncTags(context, options.fetch ?? true);
  const payload = context.ci.event?.pr;
  const baseBranch =
    options.pr?.baseBranch ??
    payload?.baseRef ??
    (options.base ? shortBranch(options.base) : config.baseBranch);
  if (!options.base && !payload) {
    throw new LaunchsetError(
      "no-base",
      "check needs a base to compare with: run it on a pull_request event, or pass --base <ref>",
      { hint: "Locally: launchset check --base origin/main." },
    );
  }
  const prNumber = options.pr?.number ?? payload?.number ?? 0;
  // The PR head, never the merge commit actions/checkout made (HEAD in a PR job).
  const headSha = await resolveHead(context, options.head ?? payload?.headSha ?? "HEAD", prNumber);
  let tip: string;
  if (options.base) {
    const local = await tryCommit(context, options.base);
    if (!local) {
      throw new LaunchsetError(
        "unknown-base",
        `--base ${options.base} isn't a known commit or branch`,
        {
          hint: "Fetch it first (git fetch origin main), or pass another ref.",
        },
      );
    }
    tip = local;
  } else {
    tip = await baseTip(context, baseBranch, payload?.baseSha);
  }
  const base = await mergeBase(context, tip, headSha);
  const pr = {
    number: prNumber,
    author: options.pr?.author ?? payload?.author ?? (await fetchAuthor(context, prNumber)),
    headBranch:
      options.pr?.headBranch ?? payload?.headRef ?? (await tryResolveBranch(context)) ?? "",
    baseBranch,
    fork: options.pr?.fork ?? payload?.fork ?? false,
  };
  // Pending changesets, the version and the consistency check all describe the checked-out
  // commit: in Actions that's the merge commit, i.e. what the base branch will contain after
  // the merge (a changeset the base already released is gone there); the same in GitLab's
  // merged results pipelines. Which changesets the PR itself adds comes from the diff.
  // A plain GitLab MR pipeline checks out the MR's head instead: see `headOnlyCheckout`.
  const headOnly =
    !options.base && !options.head && (await headOnlyCheckout(context, tip, headSha));
  const [changedFiles, headChangesets, mismatches, headVersion, tags, dir] = await allInOrder([
    context.git.changedFiles(base, headSha),
    readChangesetFiles(context, { ref: "HEAD" }),
    checkConsistency(config, context.cwd),
    readRootVersion(config, context.cwd),
    readTagSnapshot(context),
    changesetDir(context),
  ]);
  let changesets = headChangesets;
  let version = headVersion;
  if (headOnly) {
    context.log.debug(
      `HEAD is the MR head, not a merge with ${baseBranch}: reading the pending changesets and the version as merged into ${tip.slice(0, 7)}`,
    );
    changesets = await mergedChangesets(context, { tip, head: headSha, changedFiles, dir });
    version = (await (await rootVersionReader(context))(tip)) ?? headVersion;
  }
  const result = evaluateCheck({
    config,
    pr,
    changedFiles,
    changesets,
    mismatches,
    version,
    tags,
    changesetDir: dir,
    ...(options.docsUrl ? { docsUrl: options.docsUrl } : {}),
    ...(context.host !== DEFAULT_HOST ? { host: context.host } : {}),
  });

  const data: CheckData = { result };
  let summary = result.summary;
  if ((options.comment ?? true) && context.forge && pr.number > 0) {
    const words = forgeWords(context.host);
    try {
      data.comment = await context.forge.upsertStickyComment(
        pr.number,
        CHECK_COMMENT_ID,
        result.comment,
      );
    } catch (error) {
      const gitlab = gitlabCommentFailure(context, error, pr);
      if (gitlab?.warning) {
        data.commentWarning = gitlab.warning;
        summary = appendAlerts(summary, "WARNING", [data.commentWarning], context.host);
      } else if (gitlab?.error) {
        throw gitlab.error;
      } else if (error instanceof ForgeError && error.status === 403 && pr.fork) {
        data.commentWarning = `Couldn't post the check comment on ${words.prText(pr.number)}: the token is read-only here (PRs from forks get a read-only GITHUB_TOKEN). The check result above still counts.`;
        summary = appendAlerts(summary, "WARNING", [data.commentWarning]);
      } else if (error instanceof ForgeError && error.status === 403) {
        throw new LaunchsetError(
          "comment-forbidden",
          `the token may not comment on ${words.prName} ${words.prText(pr.number)}: ${error.message.split("\n")[0]}`,
          {
            hint: "Give the check workflow `permissions: pull-requests: write` (with GITHUB_TOKEN), or use the GitHub App token.",
            cause: error,
          },
        );
      } else {
        throw error;
      }
    }
  }
  const lines = [
    `launchset check: ${result.ok ? "passed" : "failed"}`,
    ...result.failures.map((f) => `  ${f.code}: ${plain(f.message)}`),
    ...result.warnings.map((w) => `  warning: ${plain(w)}`),
  ];
  if (result.nextVersion) lines.push(`  next version: ${result.nextVersion} (${result.bump})`);
  if (data.commentWarning) lines.push(`  warning: ${data.commentWarning}`);
  return { ok: result.ok, outputs: {}, summary, lines, data };
}

/**
 * GitLab's check note failures: a warning (the check still counts) when no token of ours can
 * write notes here, i.e. only `CI_JOB_TOKEN` (no `LAUNCHSET_TOKEN`), or an MR from a fork
 * (its pipelines run in the fork, without the project's variables); an error with a GitLab
 * hint for a 403 with a real token. Undefined on GitHub and for other errors.
 */
function gitlabCommentFailure(
  context: FlowContext,
  error: unknown,
  pr: { number: number; fork: boolean },
): { warning?: string; error?: LaunchsetError } | undefined {
  if (ciSystemOf(context) !== "gitlab-ci" || !(error instanceof ForgeError)) {
    return undefined;
  }
  const mr = forgeWords("gitlab").prText(pr.number);
  const denied = error.status === 401 || error.status === 403 || error.status === 404;
  if (pr.fork && (denied || !context.token)) {
    return {
      warning: `Couldn't post the check note on ${mr}: it comes from a fork, and pipelines for fork MRs run without LAUNCHSET_TOKEN (${error.message.split("\n")[0]}). The check result above still counts.`,
    };
  }
  if (!context.token && denied) {
    return {
      warning: `Couldn't post the check note on ${mr}: CI_JOB_TOKEN can't write notes; set LAUNCHSET_TOKEN (a project or group access token with the api scope) to get the note. The check result above still counts.`,
    };
  }
  if (error.status === 403) {
    return {
      error: new LaunchsetError(
        "comment-forbidden",
        `the token may not write notes on MR ${mr}: ${error.message.split("\n")[0]}`,
        {
          hint: "LAUNCHSET_TOKEN needs the api scope and at least the Developer role in the project to write MR notes.",
          cause: error,
        },
      ),
    };
  }
  return undefined;
}

/**
 * The MR author on GitLab, which isn't in the environment: one API call (a job token can read
 * MRs), so bot MRs (`check.bots`) are recognised. `""` when it can't be read (logged).
 */
async function fetchAuthor(context: FlowContext, number: number): Promise<string> {
  if (ciSystemOf(context) !== "gitlab-ci" || !context.forge || number <= 0) return "";
  try {
    return (await context.forge.getPr(number)).author;
  } catch (error) {
    context.log.debug(`Couldn't read the author of MR !${number}: ${errorMessage(error)}`);
    return "";
  }
}

/**
 * True when HEAD is the MR's head commit and not a merge with the target branch: a GitLab
 * merge request pipeline without merged results (`CI_MERGE_REQUEST_EVENT_TYPE` `detached`)
 * checks out the source branch as it is. When the target branch is already in the head, the
 * head is what a merge would give, so that counts as merged. GitHub (and GitLab merged results
 * pipelines) check out the merge commit: always false there.
 */
async function headOnlyCheckout(
  context: FlowContext,
  tip: string,
  headSha: string,
): Promise<boolean> {
  if (ciSystemOf(context) !== "gitlab-ci" || context.ci.event?.kind !== "pr") {
    return false;
  }
  if ((await context.git.headSha()) !== headSha) return false;
  return !(await context.git.isAncestor(tip, headSha));
}

/**
 * The changeset files the target branch will have after merging the MR, without a merge
 * commit: those at the target's tip, with the MR's own changes to the folder applied (its
 * added and modified files from the head, its deletions and renames). Like a merge where the
 * MR wins on conflicts. A changeset the target already released (deleted) since the MR
 * branched off is gone, one added to the target meanwhile is there.
 */
async function mergedChangesets(
  context: FlowContext,
  input: { tip: string; head: string; changedFiles: readonly ChangedFile[]; dir: string },
): Promise<ChangesetFile[]> {
  const [atTip, atHead] = await allInOrder([
    readChangesetFiles(context, { ref: input.tip }),
    readChangesetFiles(context, { ref: input.head }),
  ]);
  const fromHead = new Map(atHead.map((file) => [file.path, file]));
  const merged = new Map(atTip.map((file) => [file.path, file]));
  for (const file of input.changedFiles) {
    if (file.status === "R" && file.oldPath !== undefined) merged.delete(file.oldPath);
    if (!isChangesetPath(file.path, input.dir)) continue;
    if (file.status === "D") {
      merged.delete(file.path);
      continue;
    }
    const head = fromHead.get(file.path);
    if (head) merged.set(file.path, head);
  }
  return [...merged.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** `check --push` (spec 11): warns, never fails. */
async function pushCheck(
  context: FlowContext,
  options: CheckOptions,
): Promise<FlowResult<PushCheckData>> {
  await syncTags(context, options.fetch ?? false);
  const [reachableReleases, changesets] = await allInOrder([
    reachableReleaseVersions(context),
    readChangesetFiles(context),
  ]);
  const result = evaluatePushCheck({
    config: context.config,
    changesets,
    commitsSinceRelease: await commitsSince(context, lastReleaseTagOf(context, reachableReleases)),
    reachableReleases,
  });
  const summary = renderSummary({
    title: "launchset check --push",
    paragraphs: result.warnings.length > 0 ? [] : ["Nothing to warn about."],
    warnings: result.warnings,
  });
  return {
    ok: true,
    outputs: {},
    summary,
    lines: result.message.split("\n"),
    data: { result },
  };
}
