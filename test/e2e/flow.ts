/** Reusable pieces of the release workflow, for scenarios that need a release as a setup step. */

import { expect } from "vitest";
import type { Job, World } from "./helpers.ts";

export interface PlanJson {
  mode: string;
  channel: string;
  version: string;
  buildNumber: number | null;
  releaseSha: string;
  matrix: string[];
  tag?: string;
  distTag: string;
  targets: Record<string, { marketingVersion: string; buildNumber: number | null }>;
}

export const parsePlan = (plan: string): PlanJson => JSON.parse(plan) as PlanJson;

/** One build job of the release workflow: its own checkout at release-sha, stamp, verify. */
export async function buildJob(releaseJob: Job, plan: string, target: string): Promise<Job> {
  const job = releaseJob.sibling(parsePlan(plan).releaseSha);
  await job.ok(["stamp", "--target", target, "--plan", plan]);
  await job.ok(["verify", "--target", target, "--plan", plan]);
  return job;
}

export interface ReleaseCycle {
  version: string;
  plan: string;
  releaseSha: string;
  releaseJob: Job;
  prNumber: number;
  finalize?: { result: { status: string } & Record<string, unknown> };
}

export interface CycleOptions {
  branch?: string;
  method?: "merge" | "squash" | "rebase";
  /** Targets whose build job succeeds (default: the whole matrix). */
  mark?: string[];
  /** Run the finalize job (default true). */
  finalize?: boolean;
}

/**
 * Release what is pending on `branch`: the release PR, its merge, the publish plan, the build
 * jobs of `mark`, and the finalize job. Pending changesets must already be pushed.
 */
export async function releaseCycle(
  world: World,
  options: CycleOptions = {},
): Promise<ReleaseCycle> {
  const branch = options.branch ?? "main";
  const first = world.pushJob(branch);
  const pr = await first.actionOk("release");
  expect(pr.outputs.mode, `release on ${branch}: ${pr.logs.join("\n")}`).toBe("release-pr");
  const prNumber = Number(pr.outputs["pr-number"]);
  world.mergePr(prNumber, options.method ? { method: options.method } : {});

  const releaseJob = world.pushJob(branch);
  const publish = await releaseJob.actionOk("release");
  expect(publish.outputs.mode).toBe("publish");
  const plan = publish.outputs.plan as string;
  const { releaseSha, matrix, version } = parsePlan(plan);
  expect(releaseSha).toBe(releaseJob.repo.head());
  for (const target of options.mark ?? matrix) {
    const job = await buildJob(releaseJob, plan, target);
    await job.ok(["mark", "--target", target, "--plan", plan]);
  }
  const cycle: ReleaseCycle = { version, plan, releaseSha, releaseJob, prNumber };
  if (options.finalize !== false) {
    // Like the generated workflow: the finalize job checks out release-sha (detached).
    cycle.finalize = await releaseJob.sibling(releaseSha).json(["finalize", "--plan", plan]);
  }
  return cycle;
}
