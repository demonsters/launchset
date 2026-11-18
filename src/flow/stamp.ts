/**
 * `launchset stamp --target <name>` (spec 7.1, 6): write the run's version and build number
 * into one target's files in the CI checkout (never committed). Takes the plan, or for CLI
 * use `--version` / `--build-number` / `--channel`.
 */

import type { ResolvedConfig } from "../core/config/schema.ts";
import { dockerPlan } from "../core/docker-tags.ts";
import { LaunchsetError } from "../core/errors.ts";
import { actionOutputs, envOutputs, planTarget } from "../core/outputs.ts";
import { isoTime, unknownTarget } from "../core/plan-common.ts";
import type { Channel, Plan, TargetPlan } from "../core/types.ts";
import { baseVersionOf, distTag, marketingVersion } from "../core/versions.ts";
import { stampForBuild, writeChanges } from "../platforms/index.ts";
import type { FlowContext, FlowResult } from "./context.ts";
import { checkHeadAtPlan } from "./git-ops.ts";
import { appendAlerts, resolvePlan } from "./result.ts";

export interface StampOptions {
  target: string;
  /** The plan (JSON text from the `plan` output, or parsed). */
  plan?: string | Plan;
  /** Without a plan: the version to write (CLI). */
  version?: string;
  /** Without a plan: the build number; leave out to stamp only the version. */
  buildNumber?: number;
  /** Without a plan: default `release`. */
  channel?: Channel;
}

export interface StampData {
  target: string;
  version: string;
  marketingVersion: string;
  buildNumber: number | null;
  channel: Channel;
  /** Files written, relative to the config root. */
  files: string[];
}

/**
 * A plan for one target built from flags (`launchset stamp --version … --build-number …`),
 * so the same stamping and outputs apply as with a real plan.
 */
export function flagPlan(
  config: ResolvedConfig,
  options: {
    target: string;
    version: string;
    buildNumber?: number;
    channel?: Channel;
    sha: string;
    now: Date;
  },
): Plan {
  const target = config.targets[options.target];
  if (!target) throw unknownTarget(config, options.target);
  const version = options.version.trim().replace(/^[vV](?=\d)/, "");
  const baseVersion = baseVersionOf(version);
  const channel = options.channel ?? "release";
  const buildNumber = options.buildNumber ?? null;
  const createdAt = isoTime(options.now);
  const targetPlan: TargetPlan = {
    name: target.name,
    type: target.type,
    release: target.release,
    marketingVersion: marketingVersion(target.type, version),
    buildNumber,
  };
  if (target.type === "docker") {
    targetPlan.docker = dockerPlan(target, {
      channel,
      version,
      maintenance: false,
      sha: options.sha,
      buildNumber,
      createdAt,
    });
  }
  return {
    schemaVersion: 1,
    mode: channel === "release" ? "publish" : "preview",
    channel,
    version,
    baseVersion,
    buildNumber,
    releaseSha: options.sha,
    branch: "",
    maintenance: false,
    distTag:
      channel === "release"
        ? distTag({ channel, version, maintenance: false })
        : channel === "prerelease"
          ? "prerelease"
          : "preview",
    matrix: [target.name],
    targets: { [target.name]: targetPlan },
    createdAt,
  };
}

function checkBuildNumber(value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new LaunchsetError(
      "invalid-build-number",
      `--build-number ${value} is not a positive integer`,
      {
        hint: "Pass the build number from the plan, e.g. --build-number 217000000.",
      },
    );
  }
}

/** `command: stamp` (spec 7.1). */
export async function stamp(
  context: FlowContext,
  options: StampOptions,
): Promise<FlowResult<StampData>> {
  let plan: Plan;
  if (options.plan !== undefined) {
    plan = resolvePlan(options.plan);
  } else {
    if (!options.version) {
      throw new LaunchsetError("missing-plan", "stamp needs the plan or a --version", {
        hint: "In workflows pass the launchset job's plan output as plan; from the CLI pass --version (and --build-number, --channel).",
      });
    }
    checkBuildNumber(options.buildNumber);
    plan = flagPlan(context.config, {
      target: options.target,
      version: options.version,
      ...(options.buildNumber !== undefined ? { buildNumber: options.buildNumber } : {}),
      ...(options.channel ? { channel: options.channel } : {}),
      sha: await context.git.headSha(),
      now: context.now,
    });
  }
  const targetPlan = planTarget(plan, options.target);
  const checkout =
    options.plan !== undefined ? await checkHeadAtPlan(context, plan, "stamp") : undefined;
  const changes = await stampForBuild(context.config, context.cwd, plan, targetPlan);
  await writeChanges(changes);
  const files = changes.map((c) => c.path);
  const outputs = actionOutputs(plan, options.target);
  const env = envOutputs(plan, options.target);
  const build = targetPlan.buildNumber;
  const lines = [
    `${options.target}: version ${targetPlan.marketingVersion}${build !== null ? `, build number ${build}` : ""} (${plan.channel})`,
    ...(files.length > 0 ? files.map((f) => `  stamped ${f}`) : ["  no files to stamp"]),
    ...(checkout ? [`warning: ${checkout}`] : []),
  ];
  const summary = [
    `## launchset: stamp ${options.target}`,
    "",
    `Version **${targetPlan.marketingVersion}**${build !== null ? `, build number **${build}**` : ""}, channel \`${plan.channel}\`.`,
    "",
    files.length > 0
      ? files.map((f) => `- \`${f}\``).join("\n")
      : "No files to stamp for this target.",
    "",
  ].join("\n");
  return {
    ok: true,
    outputs,
    env,
    summary: checkout ? appendAlerts(summary, "WARNING", [checkout]) : summary,
    lines,
    data: {
      target: options.target,
      version: plan.version,
      marketingVersion: targetPlan.marketingVersion,
      buildNumber: build,
      channel: plan.channel,
      files,
    },
  };
}
