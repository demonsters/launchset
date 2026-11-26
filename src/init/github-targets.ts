/**
 * Custom targets from existing GitHub workflows: a job that release tags (or GitHub Releases)
 * start becomes a custom target. init retires that tag trigger (it would fire again on
 * launchset's tags), so without a target the job would quietly stop running for releases. Its
 * steps are copied, commented out, into the target's place in launchset-release.yml.
 *
 * Release tags start a job when:
 * - its workflow runs on them (`on.push.tags`, `on.release`), unless the job's `if:` only lets
 *   branch pushes through;
 * - its workflow runs on every push (`on: push`) and the job, or one of its output steps, checks
 *   for a tag (`if: startsWith(github.ref, 'refs/tags/')`);
 * - its workflow runs after one of the above (`on.workflow_run`).
 *
 * Such a job becomes a target when it outputs something (uploads an artifact, publishes,
 * deploys, has an `environment`, calls a reusable workflow) or, failing that, when no other job
 * needs it and it runs commands of its own (it's the end of the release chain). Every other
 * such job gets a warning: it stops running for releases. Read-only: init writes the results.
 */

import { isMap, isScalar, isSeq, type Pair, type YAMLMap } from "yaml";
import { matchesFilter } from "./github-filter.ts";
import { targetNameForJob } from "./gitlab-targets.ts";
import { publishCommand } from "./machinery.ts";
import { itemLines, pairLines } from "./text-edit.ts";
import type { DetectedGitHubJob, DetectedTarget, Note } from "./types.ts";
import {
  pairOf,
  TAG_REF,
  type Workflow,
  type WorkflowJob,
  type WorkflowStep,
} from "./workflow-scan.ts";

/** Actions that upload or publish what a job built. */
const OUTPUT_ACTION =
  /^(?:actions\/upload-artifact|softprops\/action-gh-release|ncipollo\/release-action|actions\/upload-release-asset|svenstaro\/upload-release-action)$|deploy|publish|gh-pages|upload-google-play|upload-testflight|vercel|netlify|wrangler|firebase|docker\/build-push-action|goreleaser|ssh-action|scp-action|rsync/i;

/** An `if:` that only matches branch refs or pull requests (not tags). */
const BRANCH_REF =
  /github\.ref\s*==\s*['"]refs\/heads\/|github\.ref_type\s*==\s*['"]branch['"]|github\.event_name\s*==\s*['"](?:pull_request|pull_request_target|schedule|merge_group)['"]|refs\/heads\//;

/** True when release tags (`v1.2.3`, `v1.2.3-alpha.0`) or GitHub Releases start the workflow. */
export function runsOnReleases(workflow: Workflow, releaseTags: string[]): boolean {
  const t = workflow.triggers;
  if (t.release) return true;
  if (t.tagsPair) {
    const patterns = t.tagPatterns.map((p) => p.value);
    return releaseTags.some((tag) => matchesFilter(patterns, tag));
  }
  if (t.tagsIgnorePair) {
    const ignored = t.tagsIgnore.map((p) => p.value);
    return releaseTags.some((tag) => !matchesFilter(ignored, tag));
  }
  return false;
}

/** How release tags start a workflow's jobs (see the module comment). */
type ReleaseMode = { kind: "tags" } | { kind: "push" } | { kind: "after"; upstream: string };

function releaseModes(workflows: readonly Workflow[], releaseTags: string[]) {
  const modes = new Map<Workflow, ReleaseMode>();
  for (const w of workflows) {
    if (runsOnReleases(w, releaseTags)) modes.set(w, { kind: "tags" });
    else if (w.triggers.unfilteredPush) modes.set(w, { kind: "push" });
  }
  // Workflows that run after one of those (`workflow_run`), to a fixed point.
  for (let changed = true; changed; ) {
    changed = false;
    for (const w of workflows) {
      if (modes.has(w) || w.triggers.workflowRun.length === 0) continue;
      // An upstream that runs on every push (and checks for tags inside) doesn't count: this
      // one would run after branch pushes too.
      const upstream = workflows.find((u) => {
        const kind = modes.get(u)?.kind;
        if (kind !== "tags" && kind !== "after") return false;
        const names = [u.name ?? u.path, u.path, u.path.replace(/^.*\//, "")];
        return names.some((n) => w.triggers.workflowRun.includes(n));
      });
      if (upstream) {
        modes.set(w, { kind: "after", upstream: upstream.name ?? upstream.path });
        changed = true;
      }
    }
  }
  return modes;
}

/** Events that don't start a workflow by themselves (or only start it by hand). */
const RELEASE_ONLY_EVENTS = new Set([
  "push",
  "release",
  "workflow_dispatch",
  "workflow_run",
  "workflow_call",
]);

/**
 * True when only release events start the workflow: no branch push, pull request, schedule.
 * Once its release trigger goes it doesn't run at all.
 */
function startedOnlyByReleases(workflow: Workflow): boolean {
  const t = workflow.triggers;
  if (t.onBranchPush) return false;
  const value = t.pair?.value;
  const events = isMap(value)
    ? (value as YAMLMap).items.map((p) => (isScalar(p.key) ? String(p.key.value) : ""))
    : isSeq(value)
      ? value.items.map((i) => (isScalar(i) ? String(i.value) : ""))
      : isScalar(value)
        ? [String(value.value)]
        : [];
  return events.every((e) => RELEASE_ONLY_EVENTS.has(e));
}

/** What a step outputs, for the target's reason: `uploads an artifact`, `publishes`. */
function outputOf(step: WorkflowStep): string | undefined {
  const uses = step.uses?.replace(/@.*/, "");
  if (uses && OUTPUT_ACTION.test(uses)) {
    return uses === "actions/upload-artifact" ? "uploads an artifact" : `uses ${uses}`;
  }
  const command = step.run ? publishCommand(step.run.value) : undefined;
  if (command !== undefined) {
    return `publishes or deploys (\`${command.length > 60 ? `${command.slice(0, 59)}…` : command}\`)`;
  }
  return undefined;
}

const isCheckout = (step: WorkflowStep) => step.uses?.replace(/@.*/, "") === "actions/checkout";
/** Steps that only prepare the job: they don't make it release work of its own. */
const isSetup = (step: WorkflowStep) =>
  !step.run &&
  /^(?:actions\/(?:checkout|cache|setup-[\w-]+|download-artifact)|pnpm\/action-setup|oven-sh\/setup-bun|[\w-]+\/setup-[\w-]+)$/.test(
    step.uses?.replace(/@.*/, "") ?? "",
  );

/** The `runs-on` of a job, when it is a plain string. */
function runsOnOf(job: WorkflowJob): string | undefined {
  const value = pairOf(job.node as YAMLMap, "runs-on")?.value;
  return isScalar(value) && typeof value.value === "string" ? value.value : undefined;
}

/** `${{ x }}` → `x`. */
const bare = (condition: string) => condition.trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, "$1");

/**
 * A job's steps as YAML (from the workflow's own text, dedented), without `actions/checkout`
 * (launchset's build job checks out the release commit), each with `if: @@if@@` in front so
 * the caller can fill in the target's condition. A step's own `if:` is kept, and-ed with it.
 */
function stepsText(workflow: Workflow, job: WorkflowJob): string {
  const out: string[] = [];
  for (const step of job.steps) {
    if (isCheckout(step)) continue;
    const [start, end] = itemLines(workflow.text, step.node);
    let body = workflow.text.slice(start, end);
    const ifPair = step.node.items.find((p) => isScalar(p.key) && p.key.value === "if") as
      | Pair
      | undefined;
    let condition = "@@if@@";
    if (ifPair) {
      const own = isScalar(ifPair.value) ? String(ifPair.value.value) : "";
      condition = `@@if@@ && (${bare(own)})`;
      const [s, e] = pairLines(workflow.text, ifPair);
      const first = step.node.items[0] === ifPair;
      body = workflow.text.slice(start, s) + workflow.text.slice(e, end);
      if (first) {
        // The `- ` was on the `if:` line: the next key takes it.
        body = body.replace(
          /^([ \t]*)([^\s])/,
          (_m, indent: string, c: string) =>
            `${indent.slice(0, Math.max(0, indent.length - 2))}- ${c}`,
        );
      }
    }
    const lines = body.replace(/\n+$/, "").split("\n");
    const indent = Math.min(
      ...lines.filter((l) => l.trim() !== "").map((l) => /^ */.exec(l)?.[0].length ?? 0),
    );
    const dedented = lines.map((l) => l.slice(indent));
    const first = dedented[0] ?? "";
    if (!first.startsWith("- ")) continue;
    out.push(`- if: ${condition}`, `  ${first.slice(2)}`, ...dedented.slice(1));
  }
  return out.join("\n");
}

/** What launchset's build job lacks of a job: its env, defaults, matrix, needs (notes). */
function contextNotes(job: WorkflowJob, jobs: readonly WorkflowJob[]): string[] {
  const notes: string[] = [];
  const node = job.node as YAMLMap;
  const env = Object.keys(job.env);
  if (env.length > 0) {
    notes.push(
      `That job set env ${env.map((k) => `\`${k}\``).join(", ")}: add what the steps need to their env.`,
    );
  }
  const defaults = pairOf(node, "defaults")?.value;
  const run = isMap(defaults) ? pairOf(defaults as YAMLMap, "run")?.value : undefined;
  const wd = isMap(run) ? pairOf(run as YAMLMap, "working-directory")?.value : undefined;
  if (isScalar(wd)) {
    notes.push(
      `That job ran its commands in \`${String(wd.value)}\` (defaults.run.working-directory): add working-directory to its run steps.`,
    );
  }
  const strategy = pairOf(node, "strategy")?.value;
  const matrix = isMap(strategy) ? pairOf(strategy as YAMLMap, "matrix")?.value : undefined;
  if (isMap(matrix)) {
    const keys = (matrix as YAMLMap).items
      .map((p) => (isScalar(p.key) ? String(p.key.value) : ""))
      .filter((k) => k !== "" && k !== "include" && k !== "exclude");
    notes.push(
      `That job ran a matrix (${keys.map((k) => `matrix.${k}`).join(", ") || "include/exclude"}); this job's matrix is one entry per target, so matrix.${keys[0] ?? "<key>"} isn't set here: one target per matrix entry, or a loop in the steps.`,
    );
  }
  const needed = job.needs.map((n) => n.value).filter((n) => jobs.some((j) => j.id === n));
  if (needed.length > 0) {
    notes.push(
      `That job needed ${needed.map((n) => `"${n}"`).join(", ")} (artifacts, outputs): add what it used from them.`,
    );
  }
  return notes;
}

/** A label for a job's trigger, for reasons. */
function startedBy(mode: ReleaseMode): string {
  switch (mode.kind) {
    case "tags":
      return "runs on release tags";
    case "push":
      return "runs on release tags (its if: checks for a tag)";
    case "after":
      return `runs after ${mode.upstream}, which runs on release tags`;
  }
}

/**
 * Custom targets for jobs that releases start (see the module comment), and warnings for the
 * ones that don't become targets. Jobs in `skipJobs` (they build a detected Docker or native
 * target) are left out.
 */
export function githubJobTargets(
  workflows: readonly Workflow[],
  options: {
    releaseTags: string[];
    skipJobs: ReadonlySet<WorkflowJob>;
    name: (base: string) => string;
  },
): { targets: DetectedTarget[]; notes: Note[] } {
  const targets: DetectedTarget[] = [];
  const notes: Note[] = [];
  const modes = releaseModes(workflows, options.releaseTags);
  const byPath = new Map(workflows.map((w) => [w.path.replace(/^\.\//, ""), w]));
  for (const workflow of workflows) {
    const mode = modes.get(workflow);
    if (!mode) continue;
    const started = workflow.jobs.filter((job) => {
      if (options.skipJobs.has(job)) return false;
      const condition = job.if ?? "";
      if (mode.kind === "push") {
        return (
          TAG_REF.test(condition) ||
          job.steps.some((s) => {
            const own = pairOf(s.node, "if")?.value;
            return isScalar(own) && TAG_REF.test(String(own.value)) && outputOf(s) !== undefined;
          })
        );
      }
      return !(BRANCH_REF.test(condition) && !TAG_REF.test(condition));
    });
    if (started.length === 0) continue;
    const neededBy = (job: WorkflowJob) =>
      workflow.jobs.some((j) => j !== job && j.needs.some((n) => n.value === job.id));
    const jobs = started.flatMap((job) => {
      const outputs = [...new Set(job.steps.flatMap((s) => outputOf(s) ?? []))];
      if (job.environment) outputs.push(`deploys to the ${job.environment} environment`);
      if (job.uses) outputs.push(`calls the reusable workflow ${job.uses}`);
      // Jobs that keep running on other events (CI on branch pushes) lose nothing: only
      // release-only jobs fall back to "it's release work" or get the warning.
      const releaseOnly = mode.kind === "push" || startedOnlyByReleases(workflow);
      if (
        outputs.length === 0 &&
        releaseOnly &&
        !neededBy(job) &&
        job.steps.some((s) => !isSetup(s) && s.run)
      ) {
        outputs.push("runs commands of its own (no other job needs it)");
      }
      if (outputs.length > 0) return [{ job, outputs }];
      if (!releaseOnly) return [];
      notes.push({
        level: "warning",
        path: workflow.path,
        line: job.line,
        message: `Job "${job.id}" ${startedBy(mode)}, but isn't a target (it doesn't output anything): once init retires that trigger it no longer runs for releases. Move what it does into launchset-release.yml if a release needs it.`,
      });
      return [];
    });
    const file = (workflow.path.split("/").pop() ?? workflow.path).replace(/\.ya?ml$/, "");
    for (const { job, outputs } of jobs) {
      const base = jobs.length === 1 ? file : `${file}-${targetNameForJob(job.id)}`;
      const checkout = job.steps.find(isCheckout);
      const runsOn = runsOnOf(job);
      const extra = contextNotes(job, workflow.jobs);
      let steps = stepsText(workflow, job);
      if (job.uses) {
        const local = job.uses.startsWith("./") ? byPath.get(job.uses.slice(2)) : undefined;
        extra.push(
          local
            ? `That job called the reusable workflow ${job.uses}: below are the steps of its jobs (with:/secrets: inputs become plain values or secrets here).`
            : `That job called the reusable workflow ${job.uses}: a step can't call a workflow, so copy its steps here.`,
        );
        if (local) steps = local.jobs.map((j) => stepsText(local, j)).join("\n");
      }
      const github: DetectedGitHubJob = {
        job: job.id,
        path: workflow.path,
        line: job.line,
        steps,
        ...(runsOn !== undefined ? { runsOn } : {}),
        ...(checkout && checkout.with.size > 0
          ? {
              checkoutWith: [...checkout.with].map(([k, v]) => `${k}: ${v.value}`),
            }
          : {}),
        ...(extra.length > 0 ? { notes: extra } : {}),
      };
      const what = `${startedBy(mode)} and ${outputs.join(", ")}`;
      targets.push({
        name: options.name(base),
        type: "custom",
        dir: ".",
        files: [],
        builtBy: [{ path: workflow.path, line: job.line, note: `job "${job.id}" ${what}` }],
        proposed: "auto",
        ask: true,
        reason: `job "${job.id}" in ${workflow.path} ${what}; ${mode.kind === "after" ? "its upstream's tag trigger has to go" : "its tag trigger has to go"}, so the release workflow builds it now (its steps are copied there, commented out)`,
        github,
      });
    }
  }
  return { targets, notes };
}
