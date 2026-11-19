/**
 * `command: release` (spec 9.3): decide the mode and, in `release-pr` mode, rebuild the
 * release branch from the base branch, commit the release changes, force-push it and create
 * or update the release PR. Closes an open release PR when nothing is pending anymore.
 */

import { forgeWords } from "../core/forge-links.ts";
import { actionOutputs } from "../core/outputs.ts";
import type { ReleaseDecision, ReleaseEvent } from "../core/release.ts";
import { planRelease } from "../core/release.ts";
import {
  buildReleasePr,
  type ReleasePrContent,
  releasePrBranch,
  releasePrCloseComment,
} from "../core/release-pr.ts";
import type { Plan } from "../core/types.ts";
import { releaseBump } from "../core/versions.ts";
import { planReleaseChanges, writePlannedChanges } from "./apply.ts";
import { type FlowContext, type FlowResult, requireForge } from "./context.ts";
import {
  changelogOrigins,
  changesetWarnings,
  gatherReleaseState,
  invalidChangesetsError,
  invalidChangesetWarnings,
  type ReleaseState,
  releaseEventFor,
  releaseInputFor,
} from "./gather.ts";
import { rebuildBranch, remoteBranchHead, upsertPr } from "./git-ops.ts";
import { appendAlerts, appendParagraphs, noteLines, plain } from "./result.ts";

export interface ReleaseOptions {
  /** Explicit event; default from the Actions event (`push` / `workflow_dispatch`). */
  event?: ReleaseEvent;
  /** `target` input: ship a manual target (spec 9.8). */
  target?: string;
  /** `version` input (with `target`). */
  version?: string;
  /** Ship a version lower than the target's highest marker. */
  force?: boolean;
  /** Default: the Actions ref, else git's current branch. */
  branch?: string;
  /** `git fetch --tags` first (when a remote exists). Default true. */
  fetch?: boolean;
  /** Only decide and print the plan (`launchset plan`): no branch, commit, push or PR. */
  dryRun?: boolean;
}

interface ReleasePrSkipped {
  skipped: true;
  reason: string;
}

export interface ReleasePrResult {
  number: number;
  url: string;
  action: "created" | "updated" | "unchanged";
  branch: string;
  /** False when the remote branch already had the same content. */
  pushed: boolean;
  commit: string;
}

export interface ReleaseData {
  mode: Plan["mode"];
  plan: Plan;
  notices: string[];
  warnings: string[];
  releasePr?: ReleasePrResult;
  /** Why this run left the release PR alone (a newer run handles it). */
  releasePrSkipped?: string;
  /** The open release PR that was closed because nothing is pending. */
  closedPr?: { number: number; url: string };
}

/** `command: release` (spec 9.3). */
export async function release(
  context: FlowContext,
  options: ReleaseOptions = {},
): Promise<FlowResult<ReleaseData>> {
  const state = await gatherReleaseState(context, {
    ...(options.branch ? { branch: options.branch } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });
  const event = releaseEventFor(context, options);
  const decision = planRelease(releaseInputFor(context, state, event));
  const { plan } = decision;
  // The release PR would consume (delete) changesets it can't read: refuse. Publish, ship and
  // retries build what was released before, so a broken file must not block them.
  if (plan.mode === "release-pr") {
    const error = invalidChangesetsError(state.invalidChangesets);
    if (error) throw error;
  }
  const fileWarnings = [
    ...changesetWarnings(state.changesetFiles),
    ...invalidChangesetWarnings(state.invalidChangesets),
  ];
  const warnings = [...decision.warnings, ...fileWarnings];
  const data: ReleaseData = {
    mode: plan.mode,
    plan,
    notices: [...decision.notices],
    warnings,
  };
  const outputs = actionOutputs(plan);
  let summary = appendAlerts(decision.summary, "WARNING", fileWarnings);
  const words = forgeWords(context.host);
  const lines = [`mode: ${plan.mode}`];
  if (plan.mode !== "none") lines.push(`version: ${plan.version}`);
  if (plan.mode === "publish" || plan.mode === "ship") {
    lines.push(
      `release-sha: ${plan.releaseSha}`,
      `matrix: ${plan.matrix.length > 0 ? plan.matrix.join(", ") : "(nothing to build)"}`,
    );
    if (plan.buildNumber !== null) lines.push(`build-number: ${plan.buildNumber}`);
  }

  // Every push gets its own run (no run is ever cancelled), so runs for older commits can
  // still be going when the base branch has moved on: only the run for the branch's current
  // tip touches the release PR.
  const movedOn =
    !options.dryRun && (plan.mode === "release-pr" || plan.mode === "none")
      ? await baseMovedOn(context, plan.branch, state.headSha)
      : undefined;
  if (movedOn) {
    const reason = `${plan.branch} has moved on to ${movedOn.slice(0, 7)}: the run for that commit updates the release PR.`;
    if (plan.mode === "release-pr") data.releasePrSkipped = reason;
    summary = appendParagraphs(summary, [reason]);
    lines.push(`release PR left alone: ${reason}`);
  } else if (!options.dryRun && plan.mode === "release-pr") {
    const pr = await openReleasePr(context, state, decision);
    if ("skipped" in pr) {
      data.releasePrSkipped = pr.reason;
      summary = appendParagraphs(summary, [pr.reason]);
      lines.push(`release PR left alone: ${pr.reason}`);
    } else {
      data.releasePr = pr;
      outputs["pr-number"] = String(pr.number);
      summary = appendParagraphs(summary, [
        `Release ${words.prName} [${words.prText(pr.number)}](${pr.url}) ${pr.action}${pr.pushed ? "" : " (branch already up to date)"}.`,
      ]);
      lines.push(`release ${words.prName} ${words.prText(pr.number)} ${pr.action}: ${pr.url}`);
    }
  }
  const nothingPending =
    releaseBump(state.changesets) === null &&
    state.botPrs.length === 0 &&
    state.invalidChangesets.length === 0;
  if (!options.dryRun && !movedOn && plan.mode === "none" && nothingPending && context.forge) {
    const branch = releasePrBranch(plan.branch);
    const open = await context.forge.findOpenPrByHead(branch);
    if (open) {
      await context.forge.closePr(open.number, releasePrCloseComment(plan.branch));
      data.closedPr = { number: open.number, url: open.url };
      summary = appendParagraphs(summary, [
        `Closed the release ${words.prName} [${words.prText(open.number)}](${open.url}): nothing is pending anymore.`,
      ]);
      lines.push(`closed release ${words.prName} ${words.prText(open.number)}: nothing is pending`);
    }
  }
  lines.push(...noteLines(warnings, decision.notices));
  return { ok: true, outputs, summary, lines: lines.map(plain), data };
}

/**
 * The base branch's current tip on the remote when it's no longer `headSha` (a newer push
 * exists), else undefined. Without a remote there's nothing to compare: undefined.
 */
async function baseMovedOn(
  context: FlowContext,
  branch: string,
  headSha: string,
): Promise<string | undefined> {
  if (!(await context.git.hasRemote())) return undefined;
  const tip = await remoteBranchHead(context, branch);
  return tip !== undefined && tip !== headSha ? tip : undefined;
}

/**
 * Rebuild `launchset/release/<base>` from HEAD (the base branch), commit the release
 * changes as launchset, force-push it (skipped when the remote branch has the same content
 * on the same base) and create or update the PR. The original checkout is restored.
 */
async function openReleasePr(
  context: FlowContext,
  state: ReleaseState,
  decision: ReleaseDecision,
): Promise<ReleasePrResult | ReleasePrSkipped> {
  const forge = requireForge(context, "The release PR");
  const content = await releasePrContent(context, state, decision);
  const { commit, pushed, superseded } = await rebuildBranch(context, {
    branch: content.branch,
    from: state.headSha,
    message: content.commitMessage,
    what: "Building the release PR",
    write: async () => {
      const changes = await planReleaseChanges(context, content);
      await writePlannedChanges(changes);
      return changes.map((c) => c.path);
    },
  });
  if (superseded) {
    return {
      skipped: true,
      reason: `${content.branch} was pushed by another run while this one built it: that run updates the release PR.`,
    };
  }
  const { pr, action } = await upsertPr(forge, {
    head: content.branch,
    base: content.base,
    title: content.title,
    body: content.body,
  });
  return { number: pr.number, url: pr.url, action, branch: content.branch, pushed, commit };
}

/** The release PR content for a `release-pr` decision (changelog origins looked up). */
export async function releasePrContent(
  context: FlowContext,
  state: ReleaseState,
  decision: ReleaseDecision,
): Promise<ReleasePrContent> {
  const origins = await changelogOrigins(
    context,
    state.changesets.map((c) => c.path),
    state.branch,
  );
  return buildReleasePr({
    config: context.config,
    plan: decision.plan,
    changesets: state.changesets,
    botPrs: state.botPrs,
    origins,
    tags: state.tags,
    now: context.now,
    serverUrl: context.serverUrl,
    host: context.host,
  });
}
