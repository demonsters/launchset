/**
 * `command: check` (spec 9.2) and `launchset check --push` (spec 11): the PR check with its
 * sticky comment, and the pre-push warning for repos that push straight to the base branch.
 */

import {
  CHECK_COMMENT_ID,
  type CheckResult,
  evaluateCheck,
  evaluatePushCheck,
  type PushCheckResult,
} from "../core/check.ts";
import { LaunchsetError } from "../core/errors.ts";
import { GitHubError } from "../github/index.ts";
import { checkConsistency, readRootVersion } from "../platforms/index.ts";
import type { FlowContext, FlowResult } from "./context.ts";
import {
  changedFilesBetween,
  changesetDir,
  commitsSince,
  hasRemote,
  lastReleaseTagOf,
  reachableReleaseVersions,
  readChangesetFiles,
  readTagSnapshot,
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

interface PayloadRepo {
  full_name?: string;
}

interface PayloadPr {
  number?: number;
  user?: { login?: string };
  head?: { ref?: string; sha?: string; repo?: PayloadRepo | null };
  base?: { ref?: string; sha?: string; repo?: PayloadRepo | null };
}

/** A fork PR: the head repo differs from the base repo, or is gone (deleted fork). */
function isForkPr(pr: PayloadPr): boolean {
  const head = pr.head?.repo;
  if (!head) return true;
  return head.full_name !== pr.base?.repo?.full_name;
}

function payloadPr(context: FlowContext): PayloadPr | undefined {
  const pr = context.event?.payload.pull_request;
  return pr && typeof pr === "object" ? (pr as PayloadPr) : undefined;
}

/** `refs/heads/main`, `origin/main` → `main`. */
function shortBranch(ref: string): string {
  return ref
    .replace(/^refs\/heads\//, "")
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
 * fetched from `refs/pull/<n>/head`.
 */
async function resolveHead(context: FlowContext, ref: string, prNumber: number): Promise<string> {
  const { git } = context;
  const local = await tryCommit(context, ref);
  if (local) return local;
  if (prNumber > 0 && (await hasRemote(git))) {
    const tracking = `refs/remotes/${git.remote}/pr/${prNumber}`;
    const fetched = await git.exec(
      ["fetch", "--quiet", "--no-tags", git.remote, `+refs/pull/${prNumber}/head:${tracking}`],
      { auth: true },
    );
    if (fetched.code === 0) {
      const sha = (await tryCommit(context, ref)) ?? (await tryCommit(context, tracking));
      if (sha) return sha;
    }
  }
  throw new LaunchsetError("commit-not-found", `the PR head commit ${ref} isn't in this checkout`, {
    hint: "Check out with fetch-depth: 0 (actions/checkout) so the PR head is available.",
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
  if (await hasRemote(git)) {
    const tracking = `refs/remotes/${git.remote}/${baseBranch}`;
    const fetched = await git.exec(
      ["fetch", "--quiet", "--no-tags", git.remote, `+refs/heads/${baseBranch}:${tracking}`],
      { auth: true },
    );
    if (fetched.code === 0) return git.revParse(tracking);
  }
  const found =
    (payloadSha ? await tryCommit(context, payloadSha) : undefined) ??
    (await tryCommit(context, `refs/remotes/${git.remote}/${baseBranch}`)) ??
    (await tryCommit(context, `refs/heads/${baseBranch}`));
  if (found) return found;
  throw new LaunchsetError("unknown-base", `the base branch ${baseBranch} isn't available`, {
    hint: "Check out with fetch-depth: 0 so the base branch is present, or pass --base <ref>.",
  });
}

/** The merge base of `base` and `head`: the PR's changes are `mergeBase..head`. */
async function mergeBase(context: FlowContext, base: string, head: string): Promise<string> {
  const result = await context.git.exec(["merge-base", base, head]);
  const sha = result.stdout.trim();
  if (result.code === 0 && sha) return sha;
  throw new LaunchsetError(
    "no-merge-base",
    `the PR head ${head.slice(0, 7)} and the base ${base.slice(0, 7)} have no common commit in this checkout`,
    { hint: "Check out with fetch-depth: 0 (a shallow clone cuts the history the check needs)." },
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
  const payload = payloadPr(context);
  const baseBranch =
    options.pr?.baseBranch ??
    payload?.base?.ref ??
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
  const headSha = await resolveHead(
    context,
    options.head ?? payload?.head?.sha ?? "HEAD",
    prNumber,
  );
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
    tip = await baseTip(context, baseBranch, payload?.base?.sha);
  }
  const base = await mergeBase(context, tip, headSha);
  const pr = {
    number: prNumber,
    author: options.pr?.author ?? payload?.user?.login ?? "",
    headBranch:
      options.pr?.headBranch ?? payload?.head?.ref ?? (await tryResolveBranch(context)) ?? "",
    baseBranch,
    fork: options.pr?.fork ?? (payload ? isForkPr(payload) : false),
  };
  const changedFiles = await changedFilesBetween(context, base, headSha);
  const changesets = await readChangesetFiles(context, { ref: headSha });
  const result = evaluateCheck({
    config,
    pr,
    changedFiles,
    changesets,
    mismatches: await checkConsistency(config, context.cwd),
    version: await readRootVersion(config, context.cwd),
    tags: await readTagSnapshot(context),
    changesetDir: await changesetDir(context),
    ...(options.docsUrl ? { docsUrl: options.docsUrl } : {}),
  });

  const data: CheckData = { result };
  let summary = result.summary;
  if ((options.comment ?? true) && context.github && pr.number > 0) {
    try {
      data.comment = await context.github.upsertStickyComment(
        pr.number,
        CHECK_COMMENT_ID,
        result.comment,
      );
    } catch (error) {
      if (error instanceof GitHubError && error.status === 403 && pr.fork) {
        data.commentWarning = `Couldn't post the check comment on #${pr.number}: the token is read-only here (PRs from forks get a read-only GITHUB_TOKEN). The check result above still counts.`;
        summary = appendAlerts(summary, "WARNING", [data.commentWarning]);
      } else if (error instanceof GitHubError && error.status === 403) {
        throw new LaunchsetError(
          "comment-forbidden",
          `the token may not comment on PR #${pr.number}: ${error.message.split("\n")[0]}`,
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

/** `check --push` (spec 11): warns, never fails. */
async function pushCheck(
  context: FlowContext,
  options: CheckOptions,
): Promise<FlowResult<PushCheckData>> {
  await syncTags(context, options.fetch ?? false);
  const reachableReleases = await reachableReleaseVersions(context);
  const result = evaluatePushCheck({
    config: context.config,
    changesets: await readChangesetFiles(context),
    commitsSinceRelease: await commitsSince(context, lastReleaseTagOf(context, reachableReleases)),
    reachableReleases,
  });
  const summary =
    result.warnings.length > 0
      ? appendAlerts("## launchset check --push\n", "WARNING", result.warnings)
      : "## launchset check --push\n\nNothing to warn about.\n";
  return {
    ok: true,
    outputs: {},
    summary,
    lines: result.message.split("\n"),
    data: { result },
  };
}
