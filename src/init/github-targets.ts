/**
 * Custom targets from existing GitHub workflows: a job in a workflow that release tags (or
 * GitHub Releases) start, and that uploads an artifact, publishes or deploys, becomes a custom
 * target. init removes that tag trigger (it would fire again on launchset's tags), so without a
 * target the build would quietly stop running for releases. Its steps are copied, commented
 * out, into the target's place in launchset-release.yml. Read-only: init writes the results.
 */

import { isScalar, type YAMLMap } from "yaml";
import { matchesFilter } from "./github-filter.ts";
import { targetNameForJob } from "./gitlab-targets.ts";
import { PUBLISH_COMMAND } from "./machinery.ts";
import { itemLines } from "./text-edit.ts";
import type { DetectedGitHubJob, DetectedTarget } from "./types.ts";
import { pairOf, type Workflow, type WorkflowJob, type WorkflowStep } from "./workflow-scan.ts";

/** Actions that upload or publish what a job built. */
const OUTPUT_ACTION =
  /^(?:actions\/upload-artifact|softprops\/action-gh-release|ncipollo\/release-action|actions\/upload-release-asset|svenstaro\/upload-release-action)$|deploy|publish|gh-pages|upload-google-play|upload-testflight|vercel|netlify|wrangler|firebase/i;

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

/** What a step outputs, for the target's reason: `uploads an artifact`, `publishes`. */
function outputOf(step: WorkflowStep): string | undefined {
  const uses = step.uses?.replace(/@.*/, "");
  if (uses && OUTPUT_ACTION.test(uses)) {
    return uses === "actions/upload-artifact" ? "uploads an artifact" : `uses ${uses}`;
  }
  if (step.run && PUBLISH_COMMAND.test(step.run.value)) return "publishes or deploys";
  return undefined;
}

const isCheckout = (step: WorkflowStep) => step.uses?.replace(/@.*/, "") === "actions/checkout";

/** The `runs-on` of a job, when it is a plain string. */
function runsOnOf(job: WorkflowJob): string | undefined {
  const value = pairOf(job.node as YAMLMap, "runs-on")?.value;
  return isScalar(value) && typeof value.value === "string" ? value.value : undefined;
}

/**
 * A job's steps as YAML (from the workflow's own text, dedented), without `actions/checkout`
 * (launchset's build job checks out the release commit), each with `if: @@if@@` in front so
 * the caller can fill in the target's condition.
 */
function stepsText(workflow: Workflow, job: WorkflowJob): string {
  const out: string[] = [];
  for (const step of job.steps) {
    if (isCheckout(step)) continue;
    const [start, end] = itemLines(workflow.text, step.node);
    const lines = workflow.text.slice(start, end).replace(/\n+$/, "").split("\n");
    const indent = Math.min(
      ...lines.filter((l) => l.trim() !== "").map((l) => /^ */.exec(l)?.[0].length ?? 0),
    );
    const dedented = lines.map((l) => l.slice(indent));
    const first = dedented[0] ?? "";
    if (!first.startsWith("- ")) continue;
    // `- if: …` first, then the step's own first key, so a `run: |` block stays intact.
    const own = step.node.items.some((p) => isScalar(p.key) && p.key.value === "if");
    out.push(own ? first : `- if: @@if@@\n  ${first.slice(2)}`, ...dedented.slice(1));
  }
  return out.join("\n");
}

/**
 * Custom targets for jobs that releases start and that output something. Workflows in
 * `skipPaths` (they build a detected Docker or native target) are left out.
 */
export function githubJobTargets(
  workflows: readonly Workflow[],
  options: {
    releaseTags: string[];
    skipPaths: ReadonlySet<string>;
    name: (base: string) => string;
  },
): DetectedTarget[] {
  const targets: DetectedTarget[] = [];
  for (const workflow of workflows) {
    if (options.skipPaths.has(workflow.path)) continue;
    if (!runsOnReleases(workflow, options.releaseTags)) continue;
    const jobs = workflow.jobs.flatMap((job) => {
      const outputs = [...new Set(job.steps.flatMap((s) => outputOf(s) ?? []))];
      return outputs.length > 0 ? [{ job, outputs }] : [];
    });
    const file = (workflow.path.split("/").pop() ?? workflow.path).replace(/\.ya?ml$/, "");
    for (const { job, outputs } of jobs) {
      const base = jobs.length === 1 ? file : `${file}-${targetNameForJob(job.id)}`;
      const checkout = job.steps.find(isCheckout);
      const runsOn = runsOnOf(job);
      const github: DetectedGitHubJob = {
        job: job.id,
        path: workflow.path,
        line: job.line,
        steps: stepsText(workflow, job),
        ...(runsOn !== undefined ? { runsOn } : {}),
        ...(checkout && checkout.with.size > 0
          ? {
              checkoutWith: [...checkout.with].map(([k, v]) => `${k}: ${v.value}`),
            }
          : {}),
      };
      targets.push({
        name: options.name(base),
        type: "custom",
        dir: ".",
        files: [],
        builtBy: [
          {
            path: workflow.path,
            line: job.line,
            note: `job "${job.id}" runs on release tags and ${outputs.join(", ")}`,
          },
        ],
        proposed: "auto",
        ask: true,
        reason: `job "${job.id}" in ${workflow.path} runs on release tags and ${outputs.join(", ")}; its tag trigger has to go, so the release workflow builds it now (its steps are copied there, commented out)`,
        github,
      });
    }
  }
  return targets;
}
