/**
 * Git and GitHub operations the flow commands share: idempotent tag creation, rebuilding a
 * branch and restoring the original checkout, fetching a remote branch, and creating or
 * updating a PR by its head branch.
 */

import { errorMessage, LaunchsetError } from "../core/errors.ts";
import type { Forge, PullRequest } from "../forge/types.ts";
import {
  type Git,
  LeaseError,
  type PushResult,
  TagCleanupError,
  TagExistsError,
} from "../git/index.ts";
import type { FlowContext } from "./context.ts";

export type TagResult = "created" | "exists";

/**
 * Create tag `name` at `sha` and push it (when a remote exists). Idempotent: a tag that
 * already points to `sha` (locally or on the remote) is fine; one that points elsewhere is a
 * `tag-conflict` error.
 */
export async function ensureTag(
  context: FlowContext,
  name: string,
  sha: string,
): Promise<TagResult> {
  const { git } = context;
  const existing = await git.tryRevParse(`refs/tags/${name}`);
  if (existing !== undefined && existing !== sha) throw tagConflict(name, existing, sha);
  if (!(await git.hasRemote())) {
    if (existing !== undefined) return "exists";
    await git.createTag(name, sha);
    return "created";
  }
  let pushed: PushResult;
  try {
    // A tag that only exists locally must not linger: a later ship, mark or finalize would
    // take it for shipped. createAndPushTag removes it again when the push fails.
    pushed =
      existing === undefined ? await git.createAndPushTag(name, sha) : await git.pushTag(name);
  } catch (error) {
    if (error instanceof TagCleanupError) {
      throw new LaunchsetError(
        "tag-push-failed",
        `pushing tag ${name} failed, and removing the local tag failed too (run \`git tag -d ${name}\`): ${errorMessage(error.cleanupError)}\n${errorMessage(error.pushError)}`,
        { cause: error.pushError },
      );
    }
    if (error instanceof TagExistsError) {
      throw new LaunchsetError(
        "tag-conflict",
        `tag ${name} already exists on the remote at another commit (launchset wanted ${sha.slice(0, 7)})`,
        {
          hint: "Someone created it by hand or another run made it. Check which commit is right; delete the wrong tag only if you're sure.",
          cause: error,
        },
      );
    }
    throw error;
  }
  return existing === undefined && pushed !== "up-to-date" ? "created" : "exists";
}

function tagConflict(name: string, existing: string, wanted: string): LaunchsetError {
  return new LaunchsetError(
    "tag-conflict",
    `tag ${name} already exists at ${existing.slice(0, 7)}, not at ${wanted.slice(0, 7)}`,
    {
      hint: "launchset never moves tags. Check which commit is right; delete the wrong tag only if you're sure.",
    },
  );
}

/** What is checked out now, to go back to it. */
export interface Checkout {
  branch?: string;
  sha: string;
}

export async function currentCheckout(git: Git): Promise<Checkout> {
  const sha = await git.headSha();
  const branch = await git.currentBranch();
  return branch ? { branch, sha } : { sha };
}

/** Check out `checkout` again (discarding launchset's own uncommitted edits). */
export async function restoreCheckout(git: Git, checkout: Checkout): Promise<void> {
  if (checkout.branch) await git.checkout(checkout.branch, { force: true });
  else await git.checkout(checkout.sha, { force: true, detach: true });
}

/** Throws `dirty-worktree` when the working tree has changes. */
export async function requireCleanWorktree(git: Git, what: string): Promise<void> {
  if (await git.isClean()) return;
  throw new LaunchsetError(
    "dirty-worktree",
    `${what} needs a clean working tree, but there are uncommitted changes`,
    { hint: "Commit or stash the changes (git status shows them), or run it in a fresh checkout." },
  );
}

export interface RebuildResult {
  commit: string;
  /** The branch was pushed (false when the remote already had the same content). */
  pushed: boolean;
  /** Another run pushed the branch while this one was building it: leave it to that run. */
  superseded: boolean;
}

export interface RebuildBranchOptions {
  /** The branch to (re)build, e.g. `launchset/release/main`. */
  branch: string;
  /** Commit it starts from. */
  from: string;
  /** Commit message of the one commit on top of `from`. */
  message: string;
  /** Edits the working tree; returns the repo-relative paths to commit. */
  write: () => Promise<string[]>;
  /** What needs the clean working tree, for the error (`Building the release PR`). */
  what: string;
}

/**
 * Rebuild `branch` as one commit on top of `from` and force-push it: needs a clean working
 * tree, and restores the original checkout afterwards. A rebuild with the same content as the
 * remote branch isn't pushed (no CI re-run for nothing): `pushed: false`.
 */
export async function rebuildBranch(
  context: FlowContext,
  options: RebuildBranchOptions,
): Promise<RebuildResult> {
  const { git } = context;
  await requireCleanWorktree(git, options.what);
  const original = await currentCheckout(git);
  try {
    await git.checkoutNewBranch(options.branch, options.from);
    const paths = await options.write();
    const commit = await git.commitAll(options.message, paths);
    const remote = await remoteBranchHead(context, options.branch);
    if (remote !== undefined && (await sameCommitContent(context, remote, commit))) {
      return { commit, pushed: false, superseded: false };
    }
    if (!(await git.hasRemote())) {
      await git.pushBranch(options.branch, { force: true });
      return { commit, pushed: true, superseded: false };
    }
    // Overwrite only the commit read above: when another run pushed the branch meanwhile,
    // that run is newer, and its version wins.
    try {
      await git.pushBranch(options.branch, { expect: remote ?? null });
    } catch (error) {
      if (error instanceof LeaseError) return { commit, pushed: false, superseded: true };
      throw error;
    }
    return { commit, pushed: true, superseded: false };
  } finally {
    await restoreCheckout(git, original);
  }
}

/**
 * The commit of `branch` on the remote (fetched into `refs/remotes/<remote>/<branch>`), or
 * the local branch when there is no remote. Throws when the branch doesn't exist.
 */
export async function branchHead(context: FlowContext, branch: string): Promise<string> {
  const { git } = context;
  if (await git.hasRemote()) {
    const tracking = `refs/remotes/${git.remote}/${branch}`;
    await git.fetchRef(`refs/heads/${branch}`, tracking, { required: true });
    return git.revParse(tracking);
  }
  return git.revParse(`refs/heads/${branch}`);
}

/**
 * The remote's commit of `branch`, fetched, or undefined when the remote has no such branch
 * (or there is no remote).
 */
export async function remoteBranchHead(
  context: FlowContext,
  branch: string,
): Promise<string | undefined> {
  const { git } = context;
  if (!(await git.hasRemote())) return undefined;
  if (!(await git.remoteBranchExists(branch))) return undefined;
  return branchHead(context, branch);
}

export interface UpsertPrResult {
  pr: PullRequest;
  action: "created" | "updated" | "unchanged";
}

/** Create the PR for `head`, or update the open one (title and body). */
export async function upsertPr(
  forge: Forge,
  input: { head: string; base: string; title: string; body: string },
): Promise<UpsertPrResult> {
  const existing = await forge.findOpenPrByHead(input.head);
  if (!existing) return { pr: await forge.createPr(input), action: "created" };
  if (existing.title === input.title && existing.body === input.body) {
    return { pr: existing, action: "unchanged" };
  }
  const pr = await forge.updatePr(existing.number, { title: input.title, body: input.body });
  return { pr, action: "updated" };
}

/** True when both commits have the same tree and the same parents (a rebuild changed nothing). */
export async function sameCommitContent(
  context: FlowContext,
  a: string,
  b: string,
): Promise<boolean> {
  const [left, right] = await Promise.all([
    context.git.treeAndParents(a),
    context.git.treeAndParents(b),
  ]);
  return left.tree === right.tree && left.parents.join(" ") === right.parents.join(" ");
}

const CHECKOUT_HINT =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template.
  "Check out the plan's commit in this job: actions/checkout with ref: ${{ needs.launchset.outputs.release-sha }} (and fetch-depth: 0).";

/** True when running in CI (GitHub Actions). */
export function inActions(context: FlowContext): boolean {
  return context.ci.inCi;
}

/**
 * The build steps (`stamp`, `verify`, `mark`) must run on the plan's `release-sha` (spec
 * 9.3: build jobs check out exactly that commit). In GitHub Actions a different HEAD is an
 * error; locally it's a warning (returned).
 */
export async function checkHeadAtPlan(
  context: FlowContext,
  plan: { releaseSha: string; version: string },
  command: string,
): Promise<string | undefined> {
  if (!plan.releaseSha) return undefined;
  const head = await context.git.headSha();
  if (head === plan.releaseSha) return undefined;
  const message = `${command} runs at ${head.slice(0, 7)}, but the plan builds ${plan.version} from ${plan.releaseSha.slice(0, 7)} (release-sha)`;
  if (inActions(context)) {
    throw new LaunchsetError("wrong-checkout", message, { hint: CHECKOUT_HINT });
  }
  return `${message}. In CI this is an error: build jobs must check out release-sha.`;
}
