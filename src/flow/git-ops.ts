/**
 * Git and GitHub operations the flow commands share: idempotent tag creation, rebuilding a
 * branch and restoring the original checkout, fetching a remote branch, and creating or
 * updating a PR by its head branch.
 */

import { LaunchsetError } from "../core/errors.ts";
import { type Git, type PushResult, TagExistsError } from "../git/index.ts";
import type { GitHub, PullRequest } from "../github/index.ts";
import type { FlowContext } from "./context.ts";
import { hasRemote } from "./gather.ts";

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
  if (existing === undefined) await git.createTag(name, sha);
  let pushed: PushResult | undefined;
  if (await hasRemote(git)) {
    try {
      pushed = await git.pushTag(name);
    } catch (error) {
      // A tag that only exists locally must not linger: a later ship, mark or finalize would
      // take it for shipped. Keep the push error; mention a failed cleanup.
      if (existing === undefined) {
        try {
          await git.deleteLocalTag(name);
        } catch (cleanup) {
          throw new LaunchsetError(
            "tag-push-failed",
            `pushing tag ${name} failed, and removing the local tag failed too (run \`git tag -d ${name}\`): ${(cleanup as Error).message}\n${(error as Error).message}`,
            { cause: error },
          );
        }
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
  if (checkout.branch) await git.run(["checkout", "--quiet", "--force", checkout.branch]);
  else await git.run(["checkout", "--quiet", "--force", "--detach", checkout.sha]);
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

/**
 * The commit of `branch` on the remote (fetched into `refs/remotes/<remote>/<branch>`), or
 * the local branch when there is no remote. Throws when the branch doesn't exist.
 */
export async function branchHead(context: FlowContext, branch: string): Promise<string> {
  const { git } = context;
  if (await hasRemote(git)) {
    const tracking = `refs/remotes/${git.remote}/${branch}`;
    await git.run(
      ["fetch", "--quiet", "--no-tags", git.remote, `+refs/heads/${branch}:${tracking}`],
      {
        auth: true,
      },
    );
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
  if (!(await hasRemote(git))) return undefined;
  if (!(await git.remoteBranchExists(branch))) return undefined;
  return branchHead(context, branch);
}

export interface UpsertPrResult {
  pr: PullRequest;
  action: "created" | "updated" | "unchanged";
}

/** Create the PR for `head`, or update the open one (title and body). */
export async function upsertPr(
  github: GitHub,
  input: { head: string; base: string; title: string; body: string },
): Promise<UpsertPrResult> {
  const existing = await github.findOpenPrByHead(input.head);
  if (!existing) return { pr: await github.createPr(input), action: "created" };
  if (existing.title === input.title && existing.body === input.body) {
    return { pr: existing, action: "unchanged" };
  }
  const pr = await github.updatePr(existing.number, { title: input.title, body: input.body });
  return { pr, action: "updated" };
}

/** True when both commits have the same tree and the same parents (a rebuild changed nothing). */
export async function sameCommitContent(
  context: FlowContext,
  a: string,
  b: string,
): Promise<boolean> {
  const show = (sha: string) => context.git.run(["show", "-s", "--format=%T %P", sha]);
  const [left, right] = await Promise.all([show(a), show(b)]);
  return left === right;
}

const CHECKOUT_HINT =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template.
  "Check out the plan's commit in this job: actions/checkout with ref: ${{ needs.launchset.outputs.release-sha }} (and fetch-depth: 0).";

/** True when running in GitHub Actions. */
export function inActions(context: FlowContext): boolean {
  return context.env.GITHUB_ACTIONS === "true";
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
