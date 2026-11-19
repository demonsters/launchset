/**
 * Preview and prerelease plans (spec 8.3, 9.7, 9.9), the sticky preview comment and the
 * prerelease GitHub pre-release body. Pure: the I/O layer reserves the prerelease tag
 * (retrying with `nextPrereleaseCandidate` when it already exists), posts the comment and
 * creates the pre-release.
 */

import { findPreviewBranch, isMaintenanceBranch, matchBranch } from "./branches.ts";
import type { ResolvedConfig } from "./config/schema.ts";
import { LaunchsetError } from "./errors.ts";
import { type ForgeHost, forgeWords } from "./forge-links.ts";
import {
  buildTargetPlans,
  code,
  firstLine,
  isoTime,
  joinWords,
  planBuildNumber,
  renderSummary,
  type TagSnapshot,
  unknownTarget,
} from "./plan-common.ts";
import { prereleaseVersions, releaseTag, takenVersions } from "./tags.ts";
import type { Changeset, Plan, RunInfo } from "./types.ts";
import {
  branchPreviewVersion,
  branchSlug,
  distTag,
  nextPrereleaseNumber,
  prereleaseVersion,
  previewBaseVersion,
  prPreviewVersion,
  releaseBump,
} from "./versions.ts";

export type PreviewTrigger =
  | {
      kind: "pr";
      number: number;
      /** The PR's labels now. */
      labels: readonly string[];
      /** `pull_request` activity type: `labeled`, `synchronize`, `reopened`, … */
      action?: string;
      /**
       * The label a `labeled` event added (`github.event.label.name`). A `labeled` event for
       * another label never builds.
       */
      label?: string;
      /** True for a PR from a fork (no secrets). */
      fork?: boolean;
    }
  | { kind: "push" }
  | {
      kind: "dispatch";
      /** `targets` input; empty or undefined = the branch's / config's preview targets. */
      targets?: readonly string[];
    };

export interface PreviewInput {
  config: ResolvedConfig;
  trigger: PreviewTrigger;
  /** The pushed / dispatched branch, or the PR's head branch. */
  branch: string;
  /** The commit to build. */
  headSha: string;
  /** Root version at `headSha`. */
  version: string;
  /** Pending changesets at `headSha` (the PR's or branch's), parsed. */
  changesets: readonly Changeset[];
  tags: TagSnapshot;
  now: Date | number;
  /** `run.number` is required for PR and branch previews. */
  run?: RunInfo;
  repository?: string;
  /** Prerelease only: use at least this `n` (retry after a reservation conflict). */
  minPrereleaseNumber?: number;
  /** Code host, for how PRs are written in messages (`PR #12`); default `github`. */
  host?: ForgeHost;
}

export type PreviewKind = "pr" | "branch" | "prerelease";

export type PreviewSkipCode =
  | "previews-disabled"
  | "fork"
  | "no-label"
  | "not-labeled-event"
  | "other-label"
  | "maintenance-branch"
  | "no-preview-branch";

export type PreviewDecision =
  | { kind: "plan"; preview: PreviewKind; plan: Plan; notices: string[]; summary: string }
  | { kind: "skip"; code: PreviewSkipCode; reason: string; summary: string };

function skip(code: PreviewSkipCode, reason: string): PreviewDecision {
  return {
    kind: "skip",
    code,
    reason,
    summary: renderSummary({ title: "launchset preview: skipped", notices: [reason] }),
  };
}

function resolveTargets(config: ResolvedConfig, list: "all" | readonly string[]): string[] {
  if (list === "all") return Object.keys(config.targets);
  for (const name of list) if (!config.targets[name]) throw unknownTarget(config, name);
  // Config order, like the release matrix.
  return Object.keys(config.targets).filter((name) => list.includes(name));
}

/**
 * Decide whether and what to preview (spec 9.7, 9.9):
 *
 * - `pr`: only with `preview.label`; never for forks. A `labeled` event builds only when it
 *   added the preview label (`label`). With `rebuildOnPush: false` only that event builds;
 *   with `true`, `synchronize` / `reopened` (any non-`labeled` action) build too. Version
 *   `{next}-pr.{n}.{run}`.
 * - push: the first matching `preview.branches` entry; maintenance branches never
 *   auto-preview. A `prerelease` entry makes it a prerelease `{next}-{preid}.{n}`, else a
 *   branch preview `{next}-{slug}.{run}`.
 * - dispatch: any branch (maintenance too); a matching prerelease entry makes it a prerelease.
 *
 * Targets: dispatch input > branch entry `targets` > `preview.targets`.
 */
export function planPreview(input: PreviewInput): PreviewDecision {
  const { config, trigger } = input;
  if (!config.preview.enabled) {
    return skip("previews-disabled", "Previews are disabled in the config (preview: false).");
  }
  let kind: PreviewKind;
  let targets: "all" | readonly string[] = config.preview.targets;
  let preid: string | undefined;
  const maintenance = isMaintenanceBranch(config, input.branch);
  const words = forgeWords(input.host);
  const prLabel = (n: number) => `${words.prName} ${words.prText(n)}`;

  if (trigger.kind === "pr") {
    if (trigger.fork) {
      return skip(
        "fork",
        `${prLabel(trigger.number)} comes from a fork: secrets aren't available there, so no preview is built.`,
      );
    }
    if (!trigger.labels.includes(config.preview.label)) {
      return skip(
        "no-label",
        `${prLabel(trigger.number)} doesn't have the ${code(config.preview.label)} label: add it to build a preview.`,
      );
    }
    if (
      trigger.action === "labeled" &&
      trigger.label !== undefined &&
      trigger.label !== config.preview.label
    ) {
      return skip(
        "other-label",
        `The ${code(trigger.label)} label was added to ${prLabel(trigger.number)}; only adding ${code(config.preview.label)} builds a preview.`,
      );
    }
    if (
      !config.preview.rebuildOnPush &&
      trigger.action !== undefined &&
      trigger.action !== "labeled"
    ) {
      return skip(
        "not-labeled-event",
        `preview.rebuildOnPush is false: previews of ${prLabel(trigger.number)} are built only when the label is added.`,
      );
    }
    kind = "pr";
  } else {
    const entry = findPreviewBranch(config, input.branch);
    if (trigger.kind === "push" && !entry) {
      if (maintenance && config.preview.branches.some((e) => matchBranch(input.branch, e.branch))) {
        return skip(
          "maintenance-branch",
          `${input.branch} is a maintenance branch: it never auto-previews (start the preview workflow by hand to build one).`,
        );
      }
      return skip(
        "no-preview-branch",
        `${input.branch} matches no preview.branches entry: nothing to preview.`,
      );
    }
    if (entry?.targets) targets = entry.targets;
    if (entry?.prerelease) {
      kind = "prerelease";
      preid = entry.prerelease;
    } else {
      kind = "branch";
    }
    if (trigger.kind === "dispatch" && trigger.targets && trigger.targets.length > 0) {
      targets = trigger.targets.includes("all") ? "all" : trigger.targets;
    }
  }

  const matrix = resolveTargets(config, targets);
  const next = previewBaseVersion({
    current: input.version,
    bump: releaseBump(input.changesets),
    taken: takenVersions(input.tags.index),
  });

  const runNumber = input.run?.number;
  const needRun = () => {
    if (runNumber === undefined) {
      throw new LaunchsetError(
        "no-run-number",
        "a preview version needs the workflow run number, and there is none here",
        {
          hint: "Previews are built in GitHub Actions; `launchset plan --preview` needs --run-number outside CI.",
        },
      );
    }
    return runNumber;
  };

  let version: string;
  let slug: string | undefined;
  let prNumber: number | undefined;
  let tag: string | undefined;
  switch (kind) {
    case "pr":
      prNumber = (trigger as Extract<PreviewTrigger, { kind: "pr" }>).number;
      version = prPreviewVersion(next, prNumber, needRun());
      break;
    case "branch":
      slug = branchSlug(input.branch);
      version = branchPreviewVersion(next, slug, needRun());
      break;
    case "prerelease": {
      slug = branchSlug(input.branch);
      const id = preid as string;
      const n = Math.max(
        nextPrereleaseNumber(next, id, prereleaseVersions(input.tags.index)),
        input.minPrereleaseNumber ?? 0,
      );
      version = prereleaseVersion(next, id, n);
      tag = releaseTag(config.tags, version);
      break;
    }
  }

  const channel = kind === "prerelease" ? "prerelease" : "preview";
  const createdAt = isoTime(input.now);
  const plan: Plan = {
    schemaVersion: 1,
    mode: "preview",
    channel,
    version,
    baseVersion: next,
    buildNumber: null,
    releaseSha: input.headSha,
    branch: input.branch,
    maintenance,
    distTag:
      kind === "prerelease"
        ? distTag({ channel: "prerelease", preid: preid as string })
        : distTag({
            channel: "preview",
            ...(prNumber !== undefined ? { prNumber } : {}),
            ...(slug !== undefined ? { branchSlug: slug } : {}),
          }),
    matrix,
    targets: {},
    createdAt,
  };
  if (tag !== undefined) plan.tag = tag;
  if (prNumber !== undefined) plan.prNumber = prNumber;
  if (slug !== undefined) plan.branchSlug = slug;
  if (preid !== undefined) plan.preid = preid;
  if (input.repository !== undefined) plan.repository = input.repository;
  if (input.run !== undefined) plan.run = { ...input.run };
  plan.targets = buildTargetPlans(config, matrix, {
    channel,
    version,
    baseVersion: next,
    maintenance,
    now: input.now,
    ...(input.run ? { run: input.run } : {}),
    sha: input.headSha,
    createdAt,
    ...(prNumber !== undefined ? { prNumber } : {}),
    ...(slug !== undefined ? { branchSlug: slug } : {}),
    ...(preid !== undefined ? { preid } : {}),
  });
  plan.buildNumber = planBuildNumber(config, plan, {
    now: input.now,
    version: next,
    ...(input.run ? { run: input.run } : {}),
  });

  const notices: string[] = [];
  if (maintenance && trigger.kind === "dispatch") {
    notices.push(`${input.branch} is a maintenance branch: this preview was started by hand.`);
  }
  const what =
    kind === "pr" && prNumber !== undefined
      ? prLabel(prNumber)
      : kind === "prerelease"
        ? `prerelease of ${code(input.branch)}`
        : code(input.branch);
  const summary = renderSummary({
    title: `launchset preview: ${version}`,
    paragraphs: [
      `Building ${what} at ${code(input.headSha.slice(0, 7))} as **${version}**${plan.buildNumber !== null ? ` (build number ${plan.buildNumber})` : ""}.`,
      matrix.length > 0 ? `Targets: ${joinWords(matrix.map(code))}.` : "No targets to build.",
      tag ? `Reserving tag ${code(tag)}.` : "",
    ],
    notices,
  });
  return { kind: "plan", preview: kind, plan, notices, summary };
}

/**
 * The next candidate after the prerelease tag reservation failed because the tag exists
 * (spec 9.9): the same preview with `n + 1` (or higher, when `input.tags` already knows more
 * prerelease tags). Throws when `failed` isn't a prerelease plan.
 */
export function nextPrereleaseCandidate(input: PreviewInput, failed: Plan): PreviewDecision {
  if (failed.channel !== "prerelease" || failed.preid === undefined) {
    throw new LaunchsetError("invalid-plan", "only a prerelease plan can be retried with n + 1");
  }
  const prefix = `${failed.baseVersion}-${failed.preid}.`;
  const n = failed.version.startsWith(prefix)
    ? Number(failed.version.slice(prefix.length))
    : Number.NaN;
  if (!Number.isSafeInteger(n)) {
    throw new LaunchsetError(
      "invalid-plan",
      `can't read the prerelease number of ${failed.version}`,
    );
  }
  return planPreview({
    ...input,
    minPrereleaseNumber: Math.max(n + 1, input.minPrereleaseNumber ?? 0),
  });
}

// ---------------------------------------------------------------------------
// Results: the sticky comment (9.7) and the prerelease's GitHub pre-release (9.9)

/** `unknown`: no build job found for the target (or the job list couldn't be read). */
export type TargetResultStatus =
  | "success"
  | "failure"
  | "cancelled"
  | "skipped"
  | "pending"
  | "unknown";

export interface TargetResult {
  status: TargetResultStatus;
  /** Link to the build job. */
  jobUrl?: string;
}

export interface PreviewResultsInput {
  plan: Plan;
  /** Per target in `plan.matrix`; a missing target counts as `pending`. */
  results: Readonly<Record<string, TargetResult>>;
}

/** Sticky comment id for previews (`<!-- launchset:preview -->`). */
export const PREVIEW_COMMENT_ID = "preview";

const STATUS_TEXT: Record<TargetResultStatus, string> = {
  success: "succeeded",
  failure: "**failed**",
  cancelled: "cancelled",
  skipped: "skipped",
  pending: "running",
  unknown: "unknown",
};

function resultsTable(input: PreviewResultsInput): string {
  const rows = input.plan.matrix.map((name) => {
    const target = input.plan.targets[name];
    const result = input.results[name] ?? { status: "pending" as const };
    const status = result.jobUrl
      ? `[${STATUS_TEXT[result.status]}](${result.jobUrl})`
      : STATUS_TEXT[result.status];
    const build = target?.buildNumber ?? null;
    return `| ${code(name)} | ${status} | ${target ? code(target.marketingVersion) : ""} | ${build === null ? "n/a" : build} |`;
  });
  return ["| Target | Result | Version | Build number |", "|---|---|---|---|", ...rows].join("\n");
}

function dockerList(plan: Plan): string {
  const refs = plan.matrix.flatMap((name) => plan.targets[name]?.docker?.refs ?? []);
  if (refs.length === 0) return "";
  return ["Docker images:", "", ...refs.map((r) => `- ${code(r)}`)].join("\n");
}

function runLine(plan: Plan): string {
  const sha = code(plan.releaseSha.slice(0, 7));
  return plan.run?.url ? `Commit ${sha}, [workflow run](${plan.run.url}).` : `Commit ${sha}.`;
}

/** The sticky preview comment (spec 9.7), without the hidden marker. */
export function renderPreviewComment(input: PreviewResultsInput): string {
  const { plan } = input;
  const failed = plan.matrix.filter((n) => input.results[n]?.status === "failure");
  const blocks = [
    `### launchset preview: ${code(plan.version)}`,
    `${plan.channel === "prerelease" ? "Prerelease" : "Preview"} of ${plan.prNumber !== undefined ? "this PR" : code(plan.branch)}${failed.length > 0 ? `: ${joinWords(failed.map(code))} failed` : ""}.`,
    resultsTable(input),
    dockerList(plan),
    runLine(plan),
  ].filter((b) => b !== "");
  return `${blocks.join("\n\n")}\n`;
}

export interface PrereleaseReleaseInput extends PreviewResultsInput {
  /** Changesets pending on the branch at the built commit. */
  changesets: readonly Changeset[];
  /** Paths of the changesets the base branch has too; they're left out of the body. */
  baseChangesetPaths?: readonly string[];
}

/** The GitHub pre-release for a prerelease (spec 9.9): never "latest". */
export function prereleaseRelease(input: PrereleaseReleaseInput): {
  tag: string;
  name: string;
  body: string;
  prerelease: true;
  makeLatest: false;
} {
  const { plan } = input;
  if (plan.channel !== "prerelease" || !plan.tag) {
    throw new LaunchsetError(
      "invalid-plan",
      "a GitHub pre-release needs a prerelease plan with a tag",
    );
  }
  return {
    tag: plan.tag,
    name: plan.tag,
    body: renderPrereleaseBody(input),
    prerelease: true,
    makeLatest: false,
  };
}

/** Body of a prerelease's GitHub pre-release: the branch's own changesets and the per-target result. */
export function renderPrereleaseBody(input: PrereleaseReleaseInput): string {
  const { plan } = input;
  const onBase = new Set(input.baseChangesetPaths ?? []);
  const own = input.changesets.filter((c) => !onBase.has(c.path) && c.bump !== "none");
  const changes =
    own.length > 0
      ? own.map((c) => `- \`${c.bump}\`: ${firstLine(c.summary)}`).join("\n")
      : "_No changesets on this branch that the base branch doesn't have._";
  const blocks = [
    `Prerelease **${plan.version}** from ${code(plan.branch)}. It is not a release: nothing was committed, and the changesets ship in the normal release once the branch is merged.`,
    `### Changes\n\n${changes}`,
    `### Targets\n\n${resultsTable(input)}`,
    dockerList(plan),
    runLine(plan),
  ].filter((b) => b !== "");
  return `${blocks.join("\n\n")}\n`;
}
