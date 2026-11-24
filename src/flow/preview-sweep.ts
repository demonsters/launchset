/**
 * `launchset preview-sweep` (GitLab only): start a merge request pipeline for open MRs that
 * just got the preview label, so their preview builds without a push or a click.
 *
 * GitLab starts no pipeline when a label is added. A labeled MR's preview job runs
 * automatically in its MR pipelines, so all a newly labeled MR needs is one new MR pipeline.
 * The templates run this command in a scheduled pipeline (`LAUNCHSET_PREVIEW_SWEEP=true`).
 *
 * The rule: with the label last added at time T, an MR needs a pipeline unless one of its MR
 * pipelines for the current head commit was created at or after T. A pipeline for the head
 * from before T ran the preview as a manual job (the MR had no label then), so it doesn't
 * count; pushes after T start pipelines that build by themselves. The pipeline this command
 * starts counts from then on, so an MR gets at most one.
 *
 * Reads and writes nothing in the checkout: only the config and the API (`GIT_DEPTH: 1` is
 * enough).
 */

import { errorMessage, LaunchsetError, messageWithHint } from "../core/errors.ts";
import { forgeWords } from "../core/forge-links.ts";
import { ciProfile, hostProfile } from "../core/hosts.ts";
import { renderSummary } from "../core/plan-common.ts";
import { isReleasePrBranch } from "../core/release-pr.ts";
import {
  type GitLabForge,
  isGitLabForge,
  type LabeledMergeRequest,
  type MergeRequestPipeline,
} from "../forge/gitlab/index.ts";
import { ciSystemOf, type FlowContext, type FlowResult } from "./context.ts";

/** Pipelines one run starts at most, by default. */
export const DEFAULT_SWEEP_MAX = 10;

export interface PreviewSweepOptions {
  /** Report what would be started, start nothing. */
  dryRun?: boolean;
  /** Pipelines to start at most (default {@link DEFAULT_SWEEP_MAX}); the rest wait for the next run. */
  max?: number;
}

export type SweepOutcome = "created" | "would-create" | "skipped" | "failed";

export type SweepSkipCode =
  | "fork"
  | "release-mr"
  | "no-commits"
  | "no-label-time"
  | "has-pipeline"
  | "max";

/** What happened to one labeled MR. */
export interface SweepEntry {
  number: number;
  url: string;
  branch: string;
  headSha: string;
  /** When the label was added (T); the MR's creation time when no label event says so. */
  labelAddedAt?: string;
  outcome: SweepOutcome;
  skip?: { code: SweepSkipCode; reason: string };
  /** `created`: the new pipeline. `has-pipeline` skips: the pipeline that already counts. */
  pipeline?: { id: number; url: string };
  /** `failed`: why (with the hint). */
  error?: string;
}

export interface PreviewSweepData {
  /** False when previews are disabled in the config (nothing was read). */
  enabled: boolean;
  label: string;
  dryRun: boolean;
  max: number;
  mergeRequests: SweepEntry[];
  /** Pipelines started (dry run: that would be started). */
  created: number;
  failed: number;
}

/** `refs/merge-requests/<iid>/head|merge|train`: an MR pipeline, not a branch pipeline. */
const MR_REF = /^refs\/merge-requests\/\d+\/(head|merge|train)$/;

/**
 * A pipeline created at or after `time` (ms). One without a creation time counts, so a missing
 * field can never make the sweep start a pipeline on every run.
 */
function since(pipeline: MergeRequestPipeline, time: number): boolean {
  const created = Date.parse(pipeline.createdAt);
  return Number.isNaN(created) || created >= time;
}

/**
 * The MR pipeline that already covers the label (for the head commit, created at or after
 * `time`), or undefined. Merged results and merge train pipelines run a merge commit, so their
 * `sha` isn't the head: for those GitLab's head pipeline of the MR says which one is the head's.
 */
async function coveringPipeline(
  forge: GitLabForge,
  mr: LabeledMergeRequest,
  time: number,
): Promise<MergeRequestPipeline | undefined> {
  const recent = (await forge.mergeRequestPipelines(mr.number)).filter(
    (p) => MR_REF.test(p.ref) && since(p, time),
  );
  const forHead = recent.find((p) => p.sha === mr.headSha);
  if (forHead) return forHead;
  if (!recent.some((p) => !p.ref.endsWith("/head"))) return undefined;
  const head = await forge.headPipeline(mr.number);
  return head && MR_REF.test(head.ref) && since(head, time) ? head : undefined;
}

function gitlabForge(context: FlowContext): GitLabForge {
  const words = forgeWords("gitlab");
  const { name } = hostProfile(context.host);
  if (ciProfile(ciSystemOf(context)).labelEvents) {
    throw new LaunchsetError(
      "gitlab-only",
      `preview-sweep is for GitLab only: on ${name}, adding the preview label starts the preview workflow by itself (the pull_request \`labeled\` event).`,
      { hint: `Nothing to set up on ${name}. On GitLab, run it in a pipeline schedule.` },
    );
  }
  if (!context.token || !isGitLabForge(context.forge)) {
    throw new LaunchsetError(
      "no-gitlab-token",
      `preview-sweep starts ${words.prName} pipelines, which needs LAUNCHSET_TOKEN: CI_JOB_TOKEN can't list ${words.prName} pipelines or start them.`,
      {
        hint: "Set the CI/CD variable LAUNCHSET_TOKEN (a project or group access token with the api scope; not Protected, or the schedule's branch must be protected), or pass --token.",
      },
    );
  }
  return context.forge;
}

/**
 * `launchset preview-sweep`: for each open MR with the preview label, start an MR pipeline
 * when it has none since the label was added (oldest label first, at most `max`). Reports
 * every MR; a failed start doesn't stop the others, and makes the result fail.
 */
export async function previewSweep(
  context: FlowContext,
  options: PreviewSweepOptions = {},
): Promise<FlowResult<PreviewSweepData>> {
  const { preview } = context.config;
  const max = options.max ?? DEFAULT_SWEEP_MAX;
  const dryRun = Boolean(options.dryRun);
  if (!Number.isSafeInteger(max) || max < 1) {
    throw new LaunchsetError("invalid-max", `--max must be a positive integer, not ${max}`);
  }
  if (!ciProfile(ciSystemOf(context)).labelEvents && !preview.enabled) {
    const line = "Previews are disabled in the config (preview: false): nothing to sweep.";
    return {
      ok: true,
      outputs: {},
      summary: renderSummary({
        title: "launchset preview sweep: nothing to do",
        notices: [line],
        host: "gitlab",
      }),
      lines: [line],
      data: {
        enabled: false,
        label: preview.label,
        dryRun,
        max,
        mergeRequests: [],
        created: 0,
        failed: 0,
      },
    };
  }
  if (!ciProfile(ciSystemOf(context)).labelEvents && !preview.rebuildOnPush) {
    throw new LaunchsetError(
      "preview-sweep-manual-previews",
      "preview.rebuildOnPush is false, so on GitLab every MR's preview is a manual job, also with the label: a pipeline the sweep started wouldn't build the preview. GitLab gives such a pipeline no variable or source of its own that the preview job could tell apart from a push.",
      {
        hint: "Set preview.rebuildOnPush to true (previews then build on every pipeline of a labeled MR), or remove the preview sweep schedule and start the manual preview job instead.",
      },
    );
  }
  const forge = gitlabForge(context);
  const words = forgeWords("gitlab");
  const { label } = preview;
  const name = (n: number) => `${words.prName} ${words.prText(n)}`;

  const mrs = (await forge.openMergeRequestsWithLabel(label)).sort((a, b) => a.number - b.number);
  const entries: SweepEntry[] = [];
  const waiting: { entry: SweepEntry; time: number }[] = [];
  for (const mr of mrs) {
    const entry: SweepEntry = {
      number: mr.number,
      url: mr.url,
      branch: mr.head,
      headSha: mr.headSha,
      outcome: "skipped",
    };
    entries.push(entry);
    const skip = (code: SweepSkipCode, reason: string) => {
      entry.skip = { code, reason };
    };
    if (mr.fork) {
      skip("fork", "it comes from a fork: fork MRs never get a preview.");
      continue;
    }
    if (isReleasePrBranch(mr.head)) {
      skip("release-mr", "it is the release MR.");
      continue;
    }
    if (!mr.headSha) {
      skip("no-commits", "it has no commits yet.");
      continue;
    }
    try {
      // Labels given when the MR was created may have no label event: its first pipeline
      // then had the label already.
      const addedAt = (await forge.labelAddedAt(mr.number, label)) ?? (mr.createdAt || null);
      const time = addedAt === null ? Number.NaN : Date.parse(addedAt);
      if (Number.isNaN(time)) {
        skip("no-label-time", "GitLab doesn't say when the label was added: nothing is started.");
        continue;
      }
      entry.labelAddedAt = addedAt as string;
      const covered = await coveringPipeline(forge, mr, time);
      if (covered) {
        entry.pipeline = { id: covered.id, url: covered.url };
        skip(
          "has-pipeline",
          `pipeline ${covered.id} for its head commit started after the label was added.`,
        );
        continue;
      }
      waiting.push({ entry, time });
    } catch (error) {
      entry.outcome = "failed";
      entry.error = messageWithHint(error);
    }
  }

  // Oldest label first: an MR left out by --max is the first one next run.
  waiting.sort((a, b) => a.time - b.time || a.entry.number - b.entry.number);
  for (const [index, { entry }] of waiting.entries()) {
    if (index >= max) {
      entry.skip = {
        code: "max",
        reason: `this run starts at most ${max} pipeline(s) (--max): the next run starts it.`,
      };
      continue;
    }
    if (dryRun) {
      entry.outcome = "would-create";
      continue;
    }
    try {
      const pipeline = await forge.createMergeRequestPipeline(entry.number);
      entry.outcome = "created";
      entry.pipeline = { id: pipeline.id, url: pipeline.url };
    } catch (error) {
      entry.outcome = "failed";
      entry.error = messageWithHint(error);
      context.log.warn(`${name(entry.number)}: ${errorMessage(error)}`);
    }
  }

  const created = entries.filter((e) => e.outcome === "created" || e.outcome === "would-create");
  const failed = entries.filter((e) => e.outcome === "failed");
  const describe = (e: SweepEntry): string => {
    switch (e.outcome) {
      case "created":
        return `${name(e.number)}: started pipeline ${e.pipeline?.id}: ${e.pipeline?.url}`;
      case "would-create":
        return `${name(e.number)}: would start a pipeline (dry run)`;
      case "failed":
        return `${name(e.number)}: failed: ${e.error}`;
      default:
        return `${name(e.number)}: skipped: ${e.skip?.reason}`;
    }
  };
  const header = `Preview sweep${dryRun ? " (dry run)" : ""}: ${mrs.length} open ${words.prName}(s) with the ${label} label, ${created.length} pipeline(s) ${dryRun ? "to start" : "started"}${failed.length > 0 ? `, ${failed.length} failed` : ""}.`;
  const lines = [header, ...entries.map(describe)];
  const summary = renderSummary({
    title: `launchset preview sweep${dryRun ? " (dry run)" : ""}`,
    paragraphs: [
      header,
      entries
        .filter((e) => e.outcome !== "failed")
        .map((e) => `- ${describe(e)}`)
        .join("\n"),
    ],
    failures: failed.map(describe),
    host: "gitlab",
  });
  return {
    ok: failed.length === 0,
    outputs: {},
    summary,
    lines,
    data: {
      enabled: true,
      label,
      dryRun,
      max,
      mergeRequests: entries,
      created: created.length,
      failed: failed.length,
    },
  };
}
