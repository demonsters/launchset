/**
 * Preview flow (spec 9.7, 9.9): `preview-plan` decides the version and targets of a preview
 * (and, unless `dryRun`, reserves the tag on prerelease branches), `preview-comment` reports the per-target
 * results (sticky PR comment, GitHub pre-release for prerelease branches, job summary).
 *
 * Which commit is built: the PR's **head** commit, not the merge commit `actions/checkout`
 * checks out for `pull_request` events. The preview workflow's build jobs check out
 * `needs.plan.outputs.release-sha`, so `release-sha` is exactly what gets built, and it
 * doesn't change when the base branch moves. The plan and comment jobs read the root version
 * and the changesets from that commit's git objects (it's a parent of the merge commit, so it
 * is there with `fetch-depth: 0`), never from the working tree.
 *
 * Re-running failed jobs reuses the plan job's outputs, so `preview-plan` doesn't run again
 * and a prerelease keeps its reserved tag. "Re-run all jobs" runs `preview-plan` again and
 * reserves a new tag (the old one exists, so the next number is picked).
 */

import { isChangesetPath } from "../core/changesets.ts";
import { errorMessage, LaunchsetError } from "../core/errors.ts";
import { forgeHints } from "../core/forge-hints.ts";
import { type ForgeHost, forgeWords } from "../core/forge-links.ts";
import { DEFAULT_HOST, hostProfile } from "../core/hosts.ts";
import { actionOutputs, parsePlan } from "../core/outputs.ts";
import {
  alert,
  type ChangesetFile,
  code,
  invalidChangesetFiles,
  renderSummary,
  snapshotTags,
  validChangesets,
} from "../core/plan-common.ts";
import {
  nextPrereleaseCandidate,
  PREVIEW_COMMENT_ID,
  type PreviewDecision,
  type PreviewInput,
  type PreviewKind,
  type PreviewSkipCode,
  type PreviewTrigger,
  planPreview,
  prereleaseRelease,
  renderPreviewComment,
  type TargetResult,
  type TargetResultStatus,
} from "../core/preview.ts";
import { escapeRegExp } from "../core/regex.ts";
import type { Plan } from "../core/types.ts";
import type { Forge, Job } from "../forge/types.ts";
import { GitError, type PushResult, TagCleanupError, TagExistsError } from "../git/index.ts";
import { branchFromRef, type FlowContext, type FlowResult, requireForge } from "./context.ts";
import {
  baseBranchRef,
  changesetDir,
  readChangesetFiles,
  readTagSnapshot,
  rootVersionReader,
  syncTags,
} from "./gather.ts";
import { tagPushOptionsFor } from "./git-ops.ts";

/** Attempts to reserve a prerelease tag before giving up (spec 9.9: bounded retries). */
export const MAX_RESERVATION_ATTEMPTS = 10;

// ---------------------------------------------------------------------------
// Reading the event

function invalidEvent(context: FlowContext, message: string): LaunchsetError {
  return new LaunchsetError("invalid-event", message, {
    hint: forgeHints(context.host).previewEvents,
  });
}

/** Split `targets` values: each may be a comma-separated list (or `all`). */
function splitTargets(values: readonly string[]): string[] {
  return values
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

/** Branch of a `refs/heads/<branch>` ref; throws for tags and other refs. */
function branchOfRef(ref: string): string {
  const branch = branchFromRef(ref);
  if (branch !== undefined) return branch;
  throw new LaunchsetError(
    "unsupported-ref",
    `a preview can only be built from a branch, but the event ref is ${ref}`,
    { hint: "Start the preview workflow on a branch (not a tag), or open a PR." },
  );
}

interface Source {
  trigger: PreviewTrigger;
  branch: string;
  headSha: string;
}

async function currentBranch(context: FlowContext): Promise<string> {
  const ref = context.ci.event?.ref ?? context.ci.ref;
  if (ref?.startsWith("refs/")) return branchOfRef(ref);
  const name = context.ci.refName;
  if (name) return name;
  const branch = await context.git.currentBranch();
  if (branch) return branch;
  throw new LaunchsetError("no-branch", "can't tell which branch the preview is for", {
    hint: forgeHints(context.host).previewNoBranch,
  });
}

async function deriveSource(
  context: FlowContext,
  targets: readonly string[] | undefined,
): Promise<Source> {
  const event = context.ci.event;

  if (event?.kind === "pr") {
    const { pr } = event;
    const number = pr?.number;
    const branch = pr?.headRef;
    const headSha = pr?.headSha;
    if (!pr || number === undefined || !Number.isSafeInteger(number) || !branch || !headSha) {
      throw invalidEvent(context, forgeHints(context.host).previewPrIncomplete);
    }
    const trigger: PreviewTrigger = { kind: "pr", number, labels: pr.labels, fork: pr.fork };
    if (pr.manual) trigger.manual = true;
    if (pr.action !== undefined) trigger.action = pr.action;
    if (pr.action === "labeled" && pr.label !== undefined) trigger.label = pr.label;
    return { trigger, branch, headSha };
  }

  if (event && event.kind !== "push" && event.kind !== "dispatch") {
    throw invalidEvent(context, `can't build a preview for the ${event.name} event`);
  }
  const branch = await currentBranch(context);
  const headSha = context.ci.sha || event?.sha || (await context.git.headSha());
  if (event?.kind === "push") {
    return { trigger: { kind: "push" }, branch, headSha };
  }
  // workflow_dispatch, or no event at all (the CLI): any branch, the targets input.
  const inputs = event?.inputs ?? {};
  const input = targets ?? splitTargets([inputs.targets ?? inputs.target ?? ""]);
  const trigger: PreviewTrigger = { kind: "dispatch" };
  if (input.length > 0) trigger.targets = input;
  return { trigger, branch, headSha };
}

// ---------------------------------------------------------------------------
// Reading the repo at a commit

/** Root version at `sha`. */
async function rootVersion(context: FlowContext, sha: string): Promise<string> {
  const version = await (await rootVersionReader(context))(sha);
  if (!version) {
    throw new LaunchsetError(
      "no-root-version",
      `${context.config.version.file} has no "version" at commit ${sha.slice(0, 7)}`,
      { hint: 'Add a "version" field, e.g. "version": "0.1.0".' },
    );
  }
  return version;
}

async function requireCommit(context: FlowContext, sha: string): Promise<void> {
  if (await context.git.tryRevParse(sha)) return;
  throw new LaunchsetError("commit-not-found", `commit ${sha} isn't in this checkout`, {
    hint: forgeHints(context.host).previewCommitMissing,
  });
}

// ---------------------------------------------------------------------------
// preview-plan

export interface PreviewPlanOptions {
  /**
   * Targets to build, as given (CLI `--target`, the action's `target` input): each value may
   * be a comma-separated list; `all` builds every target. Only used for manual runs; PR and
   * push previews ignore it.
   */
  targets?: readonly string[];
  /** `git fetch --tags` first (when a remote exists). Default true. */
  fetch?: boolean;
  /**
   * Plan only: on a prerelease branch don't reserve (push) the tag. The tag in the plan is the
   * next free candidate from the fetched tags and may be taken by the time a build starts.
   */
  dryRun?: boolean;
}

export interface PreviewPlanData {
  outcome: "plan" | "skip";
  /** Set when `outcome` is `skip`. */
  skip?: { code: PreviewSkipCode; reason: string };
  plan?: Plan;
  preview?: PreviewKind;
  /** Prerelease only: how many tag reservations were tried (1 = no conflict). */
  reservationAttempts?: number;
  /** Changeset files at the built commit that didn't parse (ignored for the version). */
  invalidChangesets: { path: string; error: string }[];
}

function skipResult(
  skip: { code: PreviewSkipCode; reason: string },
  summary: string,
): FlowResult<PreviewPlanData> {
  return {
    ok: true,
    outputs: {
      matrix: "[]",
      plan: "",
      version: "",
      "build-number": "",
      channel: "",
      "release-sha": "",
      tag: "",
      "dist-tag": "",
      skipped: skip.code,
      "skip-reason": skip.reason,
    },
    summary,
    lines: [`Preview skipped: ${skip.reason.replaceAll("`", "")}`],
    data: { outcome: "skip", skip, invalidChangesets: [] },
  };
}

/** Outcome of one tag reservation attempt. */
type Reservation = "reserved" | "taken";

function reservationFailure(context: FlowContext, tag: string, error: unknown): LaunchsetError {
  const detail = errorMessage(error);
  if (error instanceof GitError && (error.reason === "auth" || error.reason === "forbidden")) {
    return new LaunchsetError(
      "tag-push-denied",
      `Couldn't push the prerelease tag ${tag}: the token isn't allowed to push tags.\n${detail}`,
      {
        cause: error,
        hint: forgeHints(context.host).tagPushDenied,
      },
    );
  }
  return new LaunchsetError(
    "tag-push-failed",
    `Couldn't push the prerelease tag ${tag}.\n${detail}`,
    {
      cause: error,
      hint: "Check the git error above. The tag is only reserved once the push succeeds.",
    },
  );
}

/** Create the tag at `sha` and push it. `taken`: the tag exists on the remote (another run won). */
async function tryReserve(context: FlowContext, tag: string, sha: string): Promise<Reservation> {
  let pushed: PushResult;
  try {
    // A failed push removes the local tag again: it must not linger and count as taken.
    pushed = await context.git.createAndPushTag(tag, sha, tagPushOptionsFor(context, tag));
  } catch (error) {
    if (error instanceof TagCleanupError) {
      // A failing cleanup must not hide the push error.
      const failure = reservationFailure(context, tag, error.pushError);
      throw new LaunchsetError(
        failure.code,
        `${failure.message}\nRemoving the local tag failed too (run \`git tag -d ${tag}\`): ${errorMessage(error.cleanupError)}`,
        { cause: error.pushError, ...(failure.hint ? { hint: failure.hint } : {}) },
      );
    }
    if (error instanceof TagExistsError) return "taken";
    if (!(error instanceof GitError && error.command.startsWith("git push"))) {
      throw new LaunchsetError(
        "tag-create-failed",
        `Couldn't create the local tag ${tag} at ${sha.slice(0, 7)}.\n${errorMessage(error)}`,
        { cause: error },
      );
    }
    throw reservationFailure(context, tag, error);
  }
  // `up-to-date`: the remote already had this tag at this very commit, so a concurrent run on
  // the same commit reserved it first. It isn't ours; take the next number.
  return pushed === "up-to-date" ? "taken" : "reserved";
}

/**
 * Reserve the prerelease tag of `first` (spec 9.9): push it before the builds start; when
 * it's taken, refresh the tags and plan again with the next number.
 */
async function reservePrereleaseTag(
  context: FlowContext,
  input: PreviewInput,
  first: Extract<PreviewDecision, { kind: "plan" }>,
): Promise<{ decision: Extract<PreviewDecision, { kind: "plan" }>; attempts: number }> {
  let decision = first;
  let current = input;
  const tried: string[] = [];
  for (let attempt = 1; attempt <= MAX_RESERVATION_ATTEMPTS; attempt++) {
    const tag = decision.plan.tag;
    if (!tag) throw new LaunchsetError("invalid-plan", "a prerelease plan has no tag to reserve");
    if ((await tryReserve(context, tag, input.headSha)) === "reserved") {
      context.log.info(
        `Reserved prerelease tag ${tag}${attempt > 1 ? ` (attempt ${attempt})` : ""}`,
      );
      return { decision, attempts: attempt };
    }
    tried.push(tag);
    context.log.info(`Prerelease tag ${tag} is taken by another run, trying the next number`);
    await context.git.fetchTags();
    current = { ...current, tags: await readTagSnapshot(context) };
    const next = nextPrereleaseCandidate(current, decision.plan);
    if (next.kind !== "plan") {
      throw new LaunchsetError("invalid-plan", "the prerelease retry didn't produce a plan");
    }
    decision = next;
  }
  throw new LaunchsetError(
    "tag-reservation-failed",
    `Couldn't reserve a prerelease tag after ${MAX_RESERVATION_ATTEMPTS} attempts (tried ${tried.join(", ")}): every one of them was taken by another run.`,
    {
      hint: "Many runs are pushing to this branch at once. Re-run the workflow once they have finished.",
    },
  );
}

/**
 * `launchset preview-plan`: decide whether and what to preview (`planPreview`) for the
 * current event. On a prerelease branch the tag is created and pushed here, before any
 * build starts. Outputs are the plan's `actionOutputs` plus `skipped` / `skip-reason`
 * (empty unless the preview is skipped; then `matrix` is `[]` and `plan` is empty).
 */
export async function previewPlan(
  context: FlowContext,
  options: PreviewPlanOptions = {},
): Promise<FlowResult<PreviewPlanData>> {
  const { config } = context;
  const targets = options.targets === undefined ? undefined : splitTargets(options.targets);

  const { trigger, branch, headSha } = await deriveSource(context, targets);
  if (targets !== undefined && trigger.kind !== "dispatch") {
    context.log.warn("The targets input only applies to manual runs: ignored for this event.");
  }

  // Skips that depend only on the event and the config (fork, labels, previews disabled,
  // branches) are decided before anything is read from the repo: a fork PR's checkout may
  // not even have the head commit.
  const early = planPreview({
    config,
    trigger,
    branch,
    headSha,
    // Not read by the skip rules; a 1.x placeholder keeps every tag template renderable.
    version: "1.0.0",
    changesets: [],
    tags: snapshotTags([], config),
    now: context.now,
    ...(context.run ? { run: context.run } : {}),
    host: context.host,
  });
  if (early.kind === "skip") {
    return skipResult({ code: early.code, reason: early.reason }, early.summary);
  }

  await requireCommit(context, headSha);
  await syncTags(context, options.fetch ?? true);
  const version = await rootVersion(context, headSha);
  const files = await readChangesetFiles(context, { ref: headSha });
  const tags = await readTagSnapshot(context);
  const input: PreviewInput = {
    config,
    trigger,
    branch,
    headSha,
    version,
    changesets: validChangesets(files),
    tags,
    now: context.now,
    host: context.host,
  };
  if (context.run) input.run = context.run;
  if (context.repository) input.repository = context.repository;

  let decision = planPreview(input);
  if (decision.kind === "skip") {
    return skipResult({ code: decision.code, reason: decision.reason }, decision.summary);
  }
  const invalidChangesets = invalidChangesetFiles(files);
  let attempts: number | undefined;
  const extra: string[] = [];
  if (decision.preview === "prerelease" && options.dryRun) {
    extra.push(
      `Tag ${code(decision.plan.tag as string)} is the next free prerelease tag at ${code(headSha.slice(0, 7))}. It is **not reserved** (dry run), so a concurrent run may take it.`,
    );
  } else if (decision.preview === "prerelease") {
    const reserved = await reservePrereleaseTag(context, input, decision);
    decision = reserved.decision;
    attempts = reserved.attempts;
    const { tag } = decision.plan;
    extra.push(
      `Reserved tag ${code(tag as string)} at ${code(headSha.slice(0, 7))}${attempts > 1 ? ` (the tags before it were taken by concurrent runs: ${attempts} attempts)` : ""}. The ${forgeWords(context.host).prereleaseName} is created once the builds are done.`,
    );
  }
  for (const bad of invalidChangesets) {
    extra.push(
      alert(
        "WARNING",
        `Ignored the changeset ${bad.path} (it doesn't parse): ${bad.error}`,
        context.host,
      ),
    );
  }

  const { plan } = decision;
  const data: PreviewPlanData = {
    outcome: "plan",
    plan,
    preview: decision.preview,
    invalidChangesets,
  };
  if (attempts !== undefined) data.reservationAttempts = attempts;
  const lines = [
    `Preview ${plan.version} (${plan.channel}) of ${plan.branch} at ${headSha.slice(0, 7)}`,
    `Targets: ${plan.matrix.length > 0 ? plan.matrix.join(", ") : "none"}`,
  ];
  if (plan.tag) {
    lines.push(
      `Tag: ${plan.tag}${options.dryRun && decision.preview === "prerelease" ? " (not reserved: dry run)" : ""}`,
    );
  }
  return {
    ok: true,
    outputs: { ...actionOutputs(plan), skipped: "", "skip-reason": "" },
    summary: `${[decision.summary.trimEnd(), ...extra].join("\n\n")}\n`,
    lines,
    data,
  };
}

// ---------------------------------------------------------------------------
// preview-comment

export interface PreviewCommentOptions {
  /** The `plan` output of `preview-plan`. Empty when the plan was skipped. */
  plan: string;
}

export interface PreviewCommentData {
  /** `none`: no plan to report (the preview was skipped, or the plan job failed). */
  kind: "pr" | "prerelease" | "branch" | "none";
  plan?: Plan;
  results: Record<string, TargetResult>;
  /** Targets without a matching job in the run. */
  unmatched: string[];
  commentUrl?: string;
  releaseUrl?: string;
}

/** Job conclusion → target result status. `null`: queued or running. */
export function jobStatus(job: Job): TargetResultStatus {
  switch (job.conclusion) {
    case "success":
      return "success";
    case "failure":
    case "timed_out":
    case "startup_failure":
    case "action_required":
      return "failure";
    case "cancelled":
      return "cancelled";
    case "skipped":
    case "neutral":
    case "stale":
      return "skipped";
    default:
      return "pending";
  }
}

/**
 * The build job of `target`: named `Preview <target>` (the template's `Preview ${{ matrix.target }}`),
 * also found as `Build <target>` or the bare target name, with or without a caller-workflow
 * prefix (`ci / Preview android`). On GitLab the generated child pipeline names them
 * `preview-<target>` (release builds `build-<target>`), also found as the bare target name.
 * The last match wins.
 */
export function findTargetJob(
  jobs: readonly Job[],
  target: string,
  host: ForgeHost = DEFAULT_HOST,
): Job | undefined {
  const pattern =
    hostProfile(host).ci === "gitlab-ci"
      ? new RegExp(`^(?:preview-|build-)?${escapeRegExp(target)}$`, "i")
      : new RegExp(`^(?:.* / )?(?:Preview |Build )?${escapeRegExp(target)}$`, "i");
  return jobs.filter((job) => pattern.test(job.name.trim())).at(-1);
}

function unknownResults(targets: readonly string[]): Record<string, TargetResult> {
  return Object.fromEntries(targets.map((name) => [name, { status: "unknown" as const }]));
}

/** Per-target results of the run's jobs; targets without a job are `unknown`. */
export function targetResults(
  plan: Plan,
  jobs: readonly Job[],
  host: ForgeHost = DEFAULT_HOST,
): Record<string, TargetResult> {
  const results: Record<string, TargetResult> = {};
  for (const name of plan.matrix) {
    const job = findTargetJob(jobs, name, host);
    results[name] = job
      ? { status: jobStatus(job), ...(job.url ? { jobUrl: job.url } : {}) }
      : { status: "unknown" };
  }
  return results;
}

/**
 * The jobs of the current run. The App token first, then the workflow's own `GITHUB_TOKEN`.
 * On GitLab only LAUNCHSET_TOKEN can list pipeline jobs: the fallback (CI_JOB_TOKEN) can't,
 * so there's no retry.
 */
async function listRunJobs(context: FlowContext, forge: Forge, runId: number): Promise<Job[]> {
  try {
    return await forge.listJobs(runId);
  } catch (error) {
    if (!context.fallbackForge || !hostProfile(context.host).fallbackListsJobs) throw error;
    context.log.warn(
      `Couldn't list the jobs with the App token (${errorMessage(error)}); trying GITHUB_TOKEN`,
    );
    return context.fallbackForge.listJobs(runId);
  }
}

/** Changesets the branch has that the base branch doesn't (paths, root-relative). */
async function branchOnlyChangesets(
  context: FlowContext,
  sha: string,
  files: readonly ChangesetFile[],
): Promise<{ baseChangesetPaths?: string[]; note?: string }> {
  const { git } = context;
  const dir = await changesetDir(context);
  const baseRef = await baseBranchRef(context);
  if (!(await git.tryRevParse(baseRef))) {
    return {
      note: `_Couldn't compare with ${code(baseRef)} (not in this checkout), so every pending changeset is listed. ${forgeHints(context.host).previewCompareNote}_`,
    };
  }
  const added = new Set<string>();
  for (const file of await git.changedFiles(baseRef, sha)) {
    if (file.status === "D") continue;
    if (isChangesetPath(file.path, dir)) added.add(file.path);
  }
  return { baseChangesetPaths: files.map((f) => f.path).filter((p) => !added.has(p)) };
}

/**
 * `launchset preview-comment`: the final job of the preview workflow. Reads each target's
 * job result from the run, then
 * - PR previews: creates or updates the sticky preview comment,
 * - prerelease branches: creates or updates the GitHub pre-release for the tag (pre-release,
 *   never "latest"),
 * - branch previews: the job summary only.
 *
 * An empty `plan` (preview skipped, or the plan job failed) reports that and does nothing.
 */
export async function previewComment(
  context: FlowContext,
  options: PreviewCommentOptions,
): Promise<FlowResult<PreviewCommentData>> {
  if (options.plan.trim() === "") {
    const reason =
      "No preview plan was passed: the preview was skipped, or the plan job failed (see its log).";
    return {
      ok: true,
      outputs: {},
      summary: renderSummary({ title: "launchset preview: nothing to report", notices: [reason] }),
      lines: [reason],
      data: { kind: "none", results: {}, unmatched: [] },
    };
  }
  const plan = parsePlan(options.plan);
  if (plan.mode !== "preview") {
    throw new LaunchsetError(
      "invalid-plan",
      `the plan is a ${plan.mode} plan, not a preview plan`,
      { hint: "Pass the output of `preview-plan` as `plan` in the preview comment job." },
    );
  }
  const forge = requireForge(context, "The preview comment");
  const words = forgeWords(context.host);
  const hints = forgeHints(context.host);

  // Per-target job results.
  const notes: string[] = [];
  const runId = context.run?.id ?? plan.run?.id;
  let results = unknownResults(plan.matrix);
  let listed = false;
  if (runId === undefined) {
    notes.push(`The ${hints.runName} id is unknown, so the per-target results can't be read.`);
  } else {
    try {
      results = targetResults(plan, await listRunJobs(context, forge, runId), context.host);
      listed = true;
    } catch (error) {
      // The comment is still worth posting; the failure is reported in it and in the summary.
      context.log.warn(`Couldn't list the jobs of run ${runId}: ${errorMessage(error)}`);
      notes.push(
        `Couldn't read the job results of this run (${errorMessage(error)}). ${hints.listJobsFailed}`,
      );
    }
  }
  const unmatched = plan.matrix.filter((name) => results[name]?.status === "unknown");
  if (listed && unmatched.length > 0) {
    notes.push(
      `No build job found for ${unmatched.map(code).join(", ")}: the jobs are expected to be named ${code(hints.previewJobName)}.`,
    );
  }
  const noteBlock = notes.length > 0 ? `\n${notes.map((n) => `> ${n}`).join("\n")}\n` : "";
  const data: PreviewCommentData = { kind: "branch", plan, results, unmatched };
  const outputs: Record<string, string> = {};
  const lines: string[] = [];
  const comment = () =>
    `${renderPreviewComment({ plan, results, host: context.host })}${noteBlock}`;

  if (plan.prNumber !== undefined) {
    data.kind = "pr";
    const body = comment();
    const posted = await forge.upsertStickyComment(plan.prNumber, PREVIEW_COMMENT_ID, body);
    data.commentUrl = posted.url;
    outputs["comment-url"] = posted.url;
    lines.push(
      `Preview comment ${posted.action} on ${words.prName} ${words.prText(plan.prNumber)}: ${posted.url}`,
    );
    return { ok: true, outputs, summary: body, lines, data };
  }

  if (plan.channel === "prerelease") {
    data.kind = "prerelease";
    const files = await readChangesetFiles(context, { ref: plan.releaseSha });
    const compared = await branchOnlyChangesets(context, plan.releaseSha, files);
    const release = prereleaseRelease({
      plan,
      results,
      host: context.host,
      changesets: validChangesets(files),
      ...(compared.baseChangesetPaths ? { baseChangesetPaths: compared.baseChangesetPaths } : {}),
    });
    const body = `${release.body}${compared.note ? `\n${compared.note}\n` : ""}`;
    const fields = { name: release.name, body, prerelease: true, makeLatest: false };
    const existing = await forge.getReleaseByTag(release.tag);
    const published = existing
      ? await forge.updateRelease(existing, fields)
      : await forge.createRelease({ tag: release.tag, ...fields });
    data.releaseUrl = published.url;
    outputs["release-url"] = published.url;
    lines.push(
      `${words.prereleaseName} ${existing ? "updated" : "created"} for ${release.tag}: ${published.url}`,
    );
    return { ok: true, outputs, summary: `${body}${noteBlock}`, lines, data };
  }

  const body = comment();
  lines.push(
    `Preview ${plan.version}: ${plan.matrix.length} target(s), no ${words.prName} to comment on`,
  );
  return { ok: true, outputs, summary: body, lines, data };
}
