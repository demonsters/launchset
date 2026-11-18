/**
 * `command: finalize` (spec 9.3, 9.5, 9.6, 9.8): after the build jobs, create the release tag
 * and GitHub Release when every auto target shipped, supersede older unfinished versions,
 * open the changelog backport PR for maintenance releases, or record a shipped manual target.
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { insertSectionSorted } from "../core/changelog.ts";
import {
  type ExistingRelease,
  type FinalizeAction,
  type FinalizeResult,
  finalizeCandidates,
  planFinalize,
  type UnfinishedVersion,
} from "../core/finalize.ts";
import { partialTag, releaseTag } from "../core/tags.ts";
import type { Plan } from "../core/types.ts";
import { mapLimit } from "../github/concurrency.ts";
import type { GitHub } from "../github/index.ts";
import { type FlowContext, type FlowResult, requireGitHub } from "./context.ts";
import {
  changelogFilePath,
  readTagSnapshot,
  syncTags,
  unfinishedVersionsBefore,
} from "./gather.ts";
import {
  branchHead,
  currentCheckout,
  ensureTag,
  remoteBranchHead,
  requireCleanWorktree,
  restoreCheckout,
  sameCommitContent,
  type UpsertPrResult,
  upsertPr,
} from "./git-ops.ts";
import { noteLines, plain, requireReleasePlan, resolvePlan } from "./result.ts";

export interface FinalizeOptions {
  plan: string | Plan;
  /** `git fetch --tags` first (when a remote exists). Default true. */
  fetch?: boolean;
}

/** What one executed action did. */
export interface ExecutedAction {
  action: FinalizeAction;
  /** `created`/`exists` for tags; the Release or PR URL otherwise. */
  result: string;
}

export interface FinalizeData {
  result: FinalizeResult;
  executed: ExecutedAction[];
  /** The backport PR, when one was opened or updated. */
  backportPr?: { number: number; url: string; action: "created" | "updated" | "unchanged" };
}

/** Existing GitHub Releases for `tags` (missing ones left out). */
export async function existingReleases(
  github: GitHub,
  tags: Iterable<string>,
): Promise<Map<string, ExistingRelease>> {
  const unique = [...new Set(tags)];
  const found = await mapLimit(unique, 4, (tag) => github.getReleaseByTag(tag));
  const releases = new Map<string, ExistingRelease>();
  unique.forEach((tag, index) => {
    const release = found[index];
    if (release) {
      releases.set(tag, {
        id: release.id,
        name: release.name,
        body: release.body,
        prerelease: release.prerelease,
      });
    }
  });
  return releases;
}

/** Run finalize actions in order (tags, releases, backport). */
export async function executeFinalizeActions(
  context: FlowContext,
  github: GitHub,
  actions: readonly FinalizeAction[],
): Promise<{ executed: ExecutedAction[]; backportPr?: FinalizeData["backportPr"] }> {
  const executed: ExecutedAction[] = [];
  let backportPr: FinalizeData["backportPr"];
  for (const action of actions) {
    switch (action.kind) {
      case "create-tag":
        executed.push({ action, result: await ensureTag(context, action.tag, action.sha) });
        break;
      case "create-release": {
        const created = await github.createRelease({
          tag: action.tag,
          name: action.name,
          body: action.body,
          prerelease: action.prerelease,
          makeLatest: action.makeLatest,
        });
        executed.push({ action, result: created.url });
        break;
      }
      case "update-release": {
        const updated = await github.updateRelease(action.id, {
          name: action.name,
          body: action.body,
          prerelease: action.prerelease,
          ...(action.makeLatest !== undefined ? { makeLatest: action.makeLatest } : {}),
        });
        executed.push({ action, result: updated.url });
        break;
      }
      case "backport-changelog": {
        const pr = await backport(context, github, action);
        if (pr) {
          backportPr = { number: pr.pr.number, url: pr.pr.url, action: pr.action };
          executed.push({ action, result: pr.pr.url });
        } else {
          executed.push({ action, result: "already on the base branch" });
        }
        break;
      }
    }
  }
  return backportPr ? { executed, backportPr } : { executed };
}

/**
 * The changelog backport (spec 9.5): a branch rebuilt from the base branch's current head
 * with only the section inserted (`insertSectionSorted`, so several open backports never
 * conflict), force-pushed, and a PR `Changelog: v1.4.1`. Null when the base branch already
 * has the section. The original checkout is restored.
 */
async function backport(
  context: FlowContext,
  github: GitHub,
  action: Extract<FinalizeAction, { kind: "backport-changelog" }>,
): Promise<UpsertPrResult | null> {
  const { git } = context;
  const base = await branchHead(context, action.base);
  const repoPath = await git.toRepoPath(action.file);
  const current = (await git.showFile(base, repoPath)) ?? null;
  const updated = insertSectionSorted(current, action.section, action.version);
  if (current !== null && updated === current) return null;
  await requireCleanWorktree(git, "The changelog backport");
  const original = await currentCheckout(git);
  try {
    await git.checkoutNewBranch(action.branch, base);
    await writeFile(resolve(context.cwd, action.file), updated);
    const commit = await git.commitAll(action.commitMessage, [repoPath]);
    // A re-run rebuilds the same commit content: don't force-push (and re-trigger CI) for nothing.
    const remote = await remoteBranchHead(context, action.branch);
    if (remote === undefined || !(await sameCommitContent(context, remote, commit))) {
      await git.pushBranch(action.branch, { force: true });
    }
  } finally {
    await restoreCheckout(git, original);
  }
  return upsertPr(github, {
    head: action.branch,
    base: action.base,
    title: action.title,
    body: action.body,
  });
}

/** `command: finalize` (spec 9.3). Fails (ok: false) when auto targets are missing. */
export async function finalize(
  context: FlowContext,
  options: FinalizeOptions,
): Promise<FlowResult<FinalizeData>> {
  const plan = requireReleasePlan(resolvePlan(options.plan), "finalize");
  const github = requireGitHub(context, "finalize");
  const { git, config } = context;
  await syncTags(context, options.fetch ?? true);
  const tags = await readTagSnapshot(context);

  // Candidates whose partial tag already has its pre-release are done; the others (no partial
  // tag yet, or a pre-release that failed to be created) are superseded or completed.
  let unfinished: UnfinishedVersion[] = [];
  /** Releases looked up so far (tag → release, `undefined`: there is none). */
  const known = new Map<string, ExistingRelease | undefined>();
  if (plan.mode === "publish") {
    const partials = finalizeCandidates(config, tags, plan.version).flatMap((c) =>
      tags.index.partials.has(c.version) ? [partialTag(config.tags, c.version)] : [],
    );
    const partialReleases = await existingReleases(github, partials);
    for (const tag of partials) known.set(tag, partialReleases.get(tag));
    const withRelease = new Set(partialReleases.keys());
    unfinished = await unfinishedVersionsBefore(
      context,
      tags,
      plan.releaseSha,
      plan.version,
      withRelease,
    );
  }
  const changelogPath = await changelogFilePath(context);
  const changelog = (await git.showFile(plan.releaseSha, changelogPath)) ?? null;
  let baseChangelog: string | null | undefined;
  if (plan.mode === "publish" && plan.maintenance) {
    const baseSha = await branchHead(context, config.baseBranch);
    baseChangelog = (await git.showFile(baseSha, changelogPath)) ?? null;
  }
  const lookup = [releaseTag(config.tags, plan.version)];
  for (const u of unfinished) {
    lookup.push(partialTag(config.tags, u.version), releaseTag(config.tags, u.version));
  }
  const fetched = await existingReleases(
    github,
    lookup.filter((tag) => !known.has(tag)),
  );
  const releases = new Map<string, ExistingRelease>();
  for (const tag of new Set(lookup)) {
    const release = known.has(tag) ? known.get(tag) : fetched.get(tag);
    if (release) releases.set(tag, release);
  }

  const result = planFinalize({
    config,
    plan,
    tags,
    unfinished,
    changelog,
    ...(baseChangelog !== undefined ? { baseChangelog } : {}),
    releases,
    now: context.now,
  });
  const { executed, backportPr } = await executeFinalizeActions(context, github, result.actions);

  const outputs: Record<string, string> = {
    version: plan.version,
    "release-sha": plan.releaseSha,
    tag: result.tag,
  };
  if (backportPr) outputs["pr-number"] = String(backportPr.number);
  const lines = [
    result.status === "superseded"
      ? `${result.version} was superseded by a newer release: it never gets ${result.tag}`
      : `${result.tag}: ${result.status}${result.missing.length > 0 ? ` (missing: ${result.missing.join(", ")})` : ""}`,
    ...executed.map((e) => `  ${describe(e)}`),
    ...result.failures.map((f) => `error: ${plain(f.split("\n")[0] ?? f)}`),
    ...noteLines(result.warnings, result.notices),
  ];
  const data: FinalizeData = { result, executed };
  if (backportPr) data.backportPr = backportPr;
  return { ok: result.ok, outputs, summary: result.summary, lines, data };
}

function describe(executed: ExecutedAction): string {
  const { action, result } = executed;
  switch (action.kind) {
    case "create-tag":
      return `tag ${action.tag} at ${action.sha.slice(0, 7)}: ${result}`;
    case "create-release":
      return `created ${action.prerelease ? "pre-release" : "release"} ${action.name}: ${result}`;
    case "update-release":
      return `updated release ${action.name}: ${result}`;
    case "backport-changelog":
      return `changelog backport PR ${action.title}: ${result}`;
  }
}
