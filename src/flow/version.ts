/**
 * `launchset version` (spec 11): apply the pending changesets locally, exactly like the release
 * PR commit (same code path), without a branch, commit or push. `--dry-run` prints the diff.
 */

import { isMaintenanceBranch } from "../core/branches.ts";
import { planRelease } from "../core/release.ts";
import {
  type PlannedChange,
  planReleaseChanges,
  unifiedDiff,
  writePlannedChanges,
} from "./apply.ts";
import type { FlowContext, FlowResult } from "./context.ts";
import {
  changesetWarnings,
  gatherReleaseState,
  invalidChangesetsError,
  invalidChangesetWarnings,
  releaseInputFor,
} from "./gather.ts";
import { releasePrContent } from "./release.ts";
import { noteLines, plain } from "./result.ts";

export interface VersionOptions {
  /** Print the diff instead of writing. */
  dryRun?: boolean;
  /** `git fetch --tags` first (when a remote exists). Default true. */
  fetch?: boolean;
  /** Include merged bot PRs (needs a GitHub client). Default: when a client exists. */
  botPrs?: boolean;
}

export interface VersionData {
  /** `null` when nothing is pending. */
  version: string | null;
  changed: { path: string; status: "added" | "modified" | "deleted" }[];
  dryRun: boolean;
  /** Unified diff (`--dry-run`), else empty. */
  diff: string;
}

function statusOf(change: PlannedChange): VersionData["changed"][number]["status"] {
  if (change.before === null) return "added";
  if (change.after === null) return "deleted";
  return "modified";
}

/** `launchset version` (spec 11). */
export async function version(
  context: FlowContext,
  options: VersionOptions = {},
): Promise<FlowResult<VersionData>> {
  const current = await context.git.currentBranch();
  // Maintenance rules follow a maintenance branch; anything else is treated like the base branch.
  const branch =
    current && isMaintenanceBranch(context.config, current) ? current : context.config.baseBranch;
  const state = await gatherReleaseState(context, {
    branch,
    worktree: true,
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.botPrs !== undefined ? { botPrs: options.botPrs } : {}),
  });
  state.headIsReleaseCommit = false;
  const decision = planRelease(releaseInputFor(context, state, { kind: "push" }));
  const dryRun = options.dryRun ?? false;
  const warnings = [
    ...decision.warnings,
    ...changesetWarnings(state.changesetFiles),
    ...invalidChangesetWarnings(state.invalidChangesets),
  ];
  if (decision.plan.mode !== "release-pr") {
    return {
      ok: true,
      outputs: {},
      summary: decision.summary,
      lines: [
        "Nothing to version: no pending changesets.",
        ...noteLines(warnings, decision.notices),
      ],
      data: { version: null, changed: [], dryRun, diff: "" },
    };
  }
  const invalid = invalidChangesetsError(state.invalidChangesets);
  if (invalid) throw invalid;
  const content = await releasePrContent(context, state, decision);
  const changes = (await planReleaseChanges(context, content)).filter((c) => c.before !== c.after);
  const changed = changes.map((c) => ({ path: c.path, status: statusOf(c) }));
  let diff = "";
  if (dryRun) diff = await unifiedDiff(changes);
  else await writePlannedChanges(changes);
  const lines = dryRun
    ? [
        `Would set the version to ${content.version} (dry run, nothing written):`,
        "",
        ...diff.replace(/\n$/, "").split("\n"),
      ]
    : [
        `Version set to ${content.version}:`,
        ...changed.map((c) => `  ${c.status.padEnd(8)} ${c.path}`),
      ];
  lines.push(...noteLines(warnings, decision.notices));
  return {
    ok: true,
    outputs: { version: content.version },
    summary: `## launchset: version\n\n${dryRun ? "Would set" : "Set"} the version to **${content.version}**.\n\n${changed.map((c) => `- ${c.status} \`${c.path}\``).join("\n")}\n`,
    lines: lines.map((l) => (l.startsWith("warning:") || l.startsWith("note:") ? plain(l) : l)),
    data: { version: content.version, changed, dryRun, diff },
  };
}
