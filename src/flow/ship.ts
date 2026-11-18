/**
 * `launchset ship --target <name>` (spec 9.8 "By hand"): prepare a manual target for a
 * hand-made build of a released version. Checks HEAD is at `v{version}`, computes a build
 * number with the target's strategy and stamps the target's files.
 */

import { LaunchsetError } from "../core/errors.ts";
import { actionOutputs, envOutputs } from "../core/outputs.ts";
import { unknownTarget } from "../core/plan-common.ts";
import { planRelease } from "../core/release.ts";
import type { Plan } from "../core/types.ts";
import { readRootVersion, stampForBuild, writeChanges } from "../platforms/index.ts";
import type { FlowContext, FlowResult } from "./context.ts";
import { reachableReleaseVersions, readTagSnapshot, syncTags, tryResolveBranch } from "./gather.ts";
import { noteLines, plain } from "./result.ts";

export interface ShipOptions {
  target: string;
  /** Default: the latest release reachable from HEAD. */
  version?: string;
  /** Allow shipping a version lower than the target's highest marker. */
  force?: boolean;
  /** `git fetch --tags` first (when a remote exists). Default true. */
  fetch?: boolean;
}

export interface ShipData {
  target: string;
  version: string;
  tag: string;
  buildNumber: number | null;
  /** False when the target already shipped this version (nothing stamped). */
  shipped: boolean;
  /** Files stamped, relative to the config root. */
  files: string[];
  plan: Plan;
}

/** `launchset ship` (spec 9.8). */
export async function ship(
  context: FlowContext,
  options: ShipOptions,
): Promise<FlowResult<ShipData>> {
  const { config, git } = context;
  const target = config.targets[options.target];
  if (!target) throw unknownTarget(config, options.target);
  if (target.buildNumber.strategy === "run-number" && context.run?.number === undefined) {
    throw new LaunchsetError(
      "run-number-outside-ci",
      `${options.target} uses the run-number build-number strategy, which only works in CI (it needs github.run_number)`,
      {
        hint: "Ship it from CI: start the release workflow with the target input (and version). Or give the target another buildNumber strategy.",
      },
    );
  }
  await syncTags(context, options.fetch ?? true);
  const tags = await readTagSnapshot(context);
  const headSha = await git.headSha();
  const event = {
    kind: "dispatch" as const,
    target: options.target,
    ...(options.version ? { version: options.version } : {}),
    ...(options.force ? { force: true } : {}),
  };
  const decision = planRelease({
    config,
    branch: (await tryResolveBranch(context)) ?? "HEAD",
    event,
    headSha,
    version: await readRootVersion(config, context.cwd),
    headIsReleaseCommit: false,
    tags,
    reachableReleases: await reachableReleaseVersions(context),
    changesets: [],
    botPrs: [],
    commitsSinceRelease: [],
    now: context.now,
    ...(context.run ? { run: context.run } : {}),
    ...(context.repository ? { repository: context.repository } : {}),
  });
  const { plan } = decision;
  const tag = plan.tag ?? "";
  if (plan.mode !== "ship") {
    // Already shipped (planShip returns mode none with a notice).
    return {
      ok: true,
      outputs: {},
      summary: decision.summary,
      lines: noteLines(decision.warnings, decision.notices),
      data: {
        target: options.target,
        version: plan.version,
        tag,
        buildNumber: null,
        shipped: false,
        files: [],
        plan,
      },
    };
  }
  if (plan.releaseSha !== headSha) {
    throw new LaunchsetError(
      "head-not-at-release",
      `HEAD (${headSha.slice(0, 7)}) is not at ${tag} (${plan.releaseSha.slice(0, 7)}): a hand-made build must be built from the released commit`,
      { hint: `Run \`git checkout ${tag}\` and try again.` },
    );
  }
  const targetPlan = plan.targets[options.target];
  if (!targetPlan) throw new Error(`internal: ship plan without ${options.target}`);
  const changes = await stampForBuild(config, context.cwd, plan, targetPlan);
  await writeChanges(changes);
  const files = changes.map((c) => c.path);
  const build = targetPlan.buildNumber;
  const lines = [
    `${options.target}: ready to build ${plan.version}${build !== null ? ` with build number ${build}` : ""}`,
    ...files.map((f) => `  stamped ${f}`),
    ...noteLines(decision.warnings, decision.notices),
    `After the upload: launchset mark --target ${options.target} --version ${plan.version}${build !== null ? ` --build-number ${build}` : ""}`,
  ];
  return {
    ok: true,
    outputs: actionOutputs(plan, options.target),
    env: envOutputs(plan, options.target),
    summary: decision.summary,
    lines: lines.map(plain),
    data: {
      target: options.target,
      version: plan.version,
      tag,
      buildNumber: build,
      shipped: true,
      files,
      plan,
    },
  };
}
