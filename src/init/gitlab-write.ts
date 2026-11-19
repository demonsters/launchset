/**
 * What `launchset init` writes on GitLab (design/GITLAB.md phase 5), instead of
 * `.github/workflows/*`:
 *
 * - `.gitlab/launchset.yml`: launchset's jobs (kept or overwritten like the generated workflows);
 * - `.gitlab/launchset-targets.yml`: the user's build steps; written when missing, else kept with
 *   only the jobs of targets it lacks appended;
 * - `.gitlab-ci.yml`: a fresh one when missing, else only the include of `.gitlab/launchset.yml`
 *   added (its `workflow:` stays the user's; init prints the recommended one when it has none).
 */

import type { ResolvedConfig } from "../core/config/schema.ts";
import {
  GITLAB_COM_REGISTRY,
  GITLAB_FILES,
  GITLAB_INCLUDE_SNIPPET,
  renderGitLabCi,
  renderGitLabTargetJobs,
} from "../templates/gitlab.ts";
import { registryOf } from "../templates/workflows.ts";
import type { ConfigPlan } from "./config-source.ts";
import type { DetectContext } from "./detect.ts";
import { absolute, readTextOrNull } from "./fs.ts";
import {
  addLocalInclude,
  appendBlock,
  commentAboveJob,
  missingTargetJobs,
  pickStage,
  workflowBlock,
} from "./gitlab-edit.ts";
import { gitlabStages, hasWorkflowRules } from "./gitlab-scan.ts";
import type { Change } from "./types.ts";

export interface GitLabPlan {
  /** `.gitlab/launchset.yml`. */
  jobs: { path: string; content: string; summary: string };
  /** `.gitlab/launchset-targets.yml` as a fresh file. */
  targets: { path: string; content: string; summary: string };
  /** Each target's job, for appending to an existing targets file. */
  targetJobs: Record<string, string>;
  /** A fresh `.gitlab-ci.yml`. */
  root: { path: string; content: string };
  /** The stage of launchset's jobs and why. */
  stage: { name: string; note?: string };
  /** Container registries that log in with the job's `CI_REGISTRY_*` credentials. */
  registries: string[];
  /** The existing configuration has `workflow: rules`. */
  workflowRules: boolean;
  /** Notes about the existing `workflow:` (MR pipelines, auto_cancel). */
  workflowNotes: string[];
}

/** Comments above a target's job: the existing jobs that built its Dockerfile. */
function prefillComments(ctx: DetectContext, plan: ConfigPlan): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const t of plan.targets) {
    if (t.type !== "docker" || !t.docker) continue;
    const dockerfile = t.docker.dockerfile;
    const jobs = ctx.gitlabBuilds.filter((b) => b.file === dockerfile);
    const lines = [
      ...new Set(
        jobs.map(
          (b) => `Your job ${b.job.name} in ${b.path} built this image; move its steps here.`,
        ),
      ),
    ];
    if (lines.length > 0) out[t.name] = lines;
  }
  return out;
}

function withComments(text: string, comments: Record<string, string[]>): string {
  let out = text;
  for (const [target, lines] of Object.entries(comments)) out = commentAboveJob(out, target, lines);
  return out;
}

/** Registries of the chosen images that belong to this (self-managed) GitLab, plus gitlab.com's. */
function gitlabRegistries(ctx: DetectContext, config: ResolvedConfig): string[] {
  const registries = [GITLAB_COM_REGISTRY];
  const server = ctx.host.remoteHost;
  if (!server || server === "gitlab.com") return registries;
  for (const target of Object.values(config.targets)) {
    if (target.type !== "docker") continue;
    for (const image of target.image) {
      const registry = registryOf(image);
      const own =
        registry === `registry.${server}` ||
        registry === server ||
        registry.startsWith(`${server}:`);
      if (own && !registries.includes(registry)) registries.push(registry);
    }
  }
  return registries;
}

/** Everything init writes on GitLab, rendered (throws before anything is written). */
export function planGitLab(
  ctx: DetectContext,
  resolved: ResolvedConfig,
  plan: ConfigPlan,
): GitLabPlan {
  const ci = ctx.gitlab;
  const stages = ci ? gitlabStages(ci) : undefined;
  const picked = stages ? pickStage(stages.stages) : undefined;
  const stage: GitLabPlan["stage"] = { name: picked ?? "test" };
  if (stages && picked) {
    stage.note =
      picked === "test"
        ? `in stage test, from stages: in ${stages.path}`
        : `in stage ${picked}, the last of stages: in ${stages.path}, which has no test`;
  }
  const registries = gitlabRegistries(ctx, resolved);
  const input = {
    config: resolved,
    stage: stage.name,
    hints: plan.hints,
    gitlabRegistries: registries,
  };
  const comments = prefillComments(ctx, plan);
  const [jobs, targets, root] = renderGitLabCi(input);
  if (!jobs || !targets || !root)
    throw new Error("internal: renderGitLabCi returned too few files");
  const targetJobs = renderGitLabTargetJobs(input);
  for (const name of Object.keys(targetJobs)) {
    targetJobs[name] = withComments(targetJobs[name] as string, comments);
  }
  const extra = registries.filter((r) => r !== GITLAB_COM_REGISTRY);
  const workflowNotes: string[] = [];
  const workflowRules = ci ? hasWorkflowRules(ci) : false;
  if (ci && workflowRules) {
    const workflows = ci.files.map((f) => f.data.workflow).filter(Boolean);
    const text = JSON.stringify(workflows);
    if (!text.includes("merge_request_event")) {
      workflowNotes.push(
        `launchset-check runs in merge request pipelines: make sure the workflow: rules in ${ci.files[0]?.path ?? GITLAB_FILES.root} allow them (- if: $CI_PIPELINE_SOURCE == "merge_request_event").`,
      );
    }
    if (!text.includes("auto_cancel")) {
      workflowNotes.push(
        `Consider adding auto_cancel: on_new_commit: interruptible under workflow: in ${GITLAB_FILES.root}: a new push then cancels only interruptible jobs (checks, previews), never launchset's release job while it waits for its resource group (GitLab's default "conservative" mode could cancel a release pipeline before it published).`,
      );
    }
  }
  return {
    jobs: {
      path: jobs.path,
      content: jobs.content,
      summary: `launchset's GitLab CI jobs${stage.note ? `, ${stage.note}` : ""}`,
    },
    targets: {
      path: targets.path,
      content: withComments(targets.content, comments),
      summary: `your build steps, one hidden job per target${extra.length > 0 ? `; images on ${extra.join(", ")} log in with the job's CI_REGISTRY_* credentials (the remote's GitLab)` : ""}`,
    },
    targetJobs,
    root,
    stage,
    registries,
    workflowRules,
    workflowNotes,
  };
}

export interface WriteIo {
  warn(line: string): void;
  writeText(path: string, text: string, summary: string): Promise<Change | null>;
}

/**
 * The targets file: written when missing (or answered overwrite), else kept with the jobs of
 * targets it lacks appended.
 */
export async function writeTargetsFile(
  root: string,
  gitlab: GitLabPlan,
  overwrite: boolean,
  io: WriteIo,
): Promise<{ changes: Change[]; manualSteps: string[] }> {
  const { path } = gitlab.targets;
  const current = await readTextOrNull(absolute(root, path));
  if (current === null || overwrite) {
    const c = await io.writeText(path, gitlab.targets.content, gitlab.targets.summary);
    return { changes: c ? [c] : [], manualSteps: [] };
  }
  const missing = missingTargetJobs(current, Object.keys(gitlab.targetJobs));
  if (!Array.isArray(missing)) {
    io.warn(`${path} can't be read (${missing.error}); it was kept as is.`);
    return {
      changes: [],
      manualSteps: [
        `Fix ${path} (${missing.error}) and make sure it has a hidden job .launchset-<target> with your build steps for ${Object.keys(gitlab.targetJobs).join(", ")}.`,
      ],
    };
  }
  if (missing.length === 0) return { changes: [], manualSteps: [] };
  let text = current;
  for (const target of missing) text = appendBlock(text, gitlab.targetJobs[target] as string);
  const jobs = missing.map((t) => `.launchset-${t}`).join(", ");
  const c = await io.writeText(
    path,
    text,
    `kept your jobs; added ${jobs} (${missing.length === 1 ? "a target it had no job for" : "targets it had no job for"})`,
  );
  return { changes: c ? [c] : [], manualSteps: [] };
}

function indent(block: string, by: string): string {
  return block
    .split("\n")
    .map((l) => (l === "" ? l : `${by}${l}`))
    .join("\n");
}

/** The recommended `workflow:` block, as a manual step for a configuration without one. */
export function workflowStep(gitlab: GitLabPlan): string {
  return [
    `${GITLAB_FILES.root} has no workflow: rules, so a push to a branch with an open merge request runs two pipelines (a branch pipeline and a merge request pipeline) and launchset's jobs run in both; launchset's tag pushes also start tag pipelines that run every job without rules. init doesn't change your workflow: (it decides every pipeline of the project). Add this one, or merge its rules into yours:`,
    "",
    indent(workflowBlock(gitlab.root.content), "       "),
    "",
    "     auto_cancel: on_new_commit: interruptible lets a new push cancel only interruptible jobs (checks, previews), never launchset's release job while it waits; GitLab's default (conservative) could cancel a release pipeline before it published.",
  ].join("\n");
}

/**
 * `.gitlab-ci.yml`: a fresh one when missing, else the include added with a minimal edit
 * (after retirement edited it). Returns the change and the manual steps.
 */
export async function writeGitLabRoot(
  root: string,
  gitlab: GitLabPlan,
  io: WriteIo,
): Promise<{ change: Change | null; manualSteps: string[] }> {
  const path = GITLAB_FILES.root;
  const current = await readTextOrNull(absolute(root, path));
  if (current === null) {
    const change = await io.writeText(
      path,
      gitlab.root.content,
      "GitLab CI configuration: workflow rules (no duplicate pipelines, safe auto-cancel) and the include of .gitlab/launchset.yml",
    );
    return { change, manualSteps: [] };
  }
  const manualSteps: string[] = [];
  const edit = addLocalInclude(current, GITLAB_FILES.jobs);
  let change: Change | null = null;
  if ("error" in edit) {
    io.warn(`can't add the include to ${path}: ${edit.error}.`);
    manualSteps.push(
      `Add launchset's jobs to ${path} by hand (init couldn't: ${edit.error}):\n\n${indent(GITLAB_INCLUDE_SNIPPET.trimEnd(), "       ")}`,
    );
  } else if (edit.changed) {
    change = await io.writeText(path, edit.text, edit.summary);
  }
  if (!gitlab.workflowRules) manualSteps.push(workflowStep(gitlab));
  manualSteps.push(...gitlab.workflowNotes);
  return { change, manualSteps };
}

/** The GitLab counterpart of the GitHub App steps. */
export function gitlabManualSteps(config: ResolvedConfig, targets: readonly string[]): string[] {
  return [
    "Create the CI/CD variable LAUNCHSET_TOKEN: a project access token (Settings > Access tokens) with the role Maintainer and the scopes api and write_repository, added under Settings > CI/CD > Variables as Masked. Don't make it Protected: protected variables don't reach merge request pipelines, so the check couldn't post its note. (Pushes made with CI_JOB_TOKEN never start pipelines, so launchset needs its own token.)",
    "Add the CI/CD variable NPM_TOKEN (Masked): an npm token that can read the private @demonsters/launchset package, which every launchset job installs.",
    `Let the token's bot user push to the protected branches ${config.baseBranch} and ${config.maintenanceBranches} and create the release tags (Settings > Repository > Protected branches and Protected tags). With GitLab's default rules (Maintainers may push and create tags) the Maintainer role is enough.`,
    'For manual runs (manual targets, previews of any branch, release retries with variables), allow pipeline variables: Settings > CI/CD > Variables, "Minimum role to use pipeline variables" (new projects on GitLab.com start at no_one_allowed).',
    `Add your build and upload steps for ${targets.join(", ")} to ${GITLAB_FILES.targets}.`,
  ];
}

/** The optional preview sweep schedule (previews enabled, `rebuildOnPush` true). */
export function gitlabSweepStep(config: ResolvedConfig): string {
  return `Optional: start previews when the ${config.preview.label} label is added (GitLab starts no pipeline for a label). Create a pipeline schedule (Build > Pipeline schedules > New schedule) for the branch ${config.baseBranch} with the variable LAUNCHSET_PREVIEW_SWEEP=true and the interval */10 * * * * (GitLab.com Free runs a schedule at most once an hour, paid tiers every 5 minutes; self-managed every 10 minutes by default). Its job launchset-preview-sweep starts an MR pipeline for MRs that just got the label. Jobs without rules also run in that pipeline: to keep one out, start its rules with \`- if: $LAUNCHSET_PREVIEW_SWEEP == "true"\` and \`when: never\`.`;
}
