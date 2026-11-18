/**
 * Action outputs (spec 10, 6.1, 6.5) and the `plan` input validator. Pure.
 */

import { z } from "zod";
import { LaunchsetError } from "./errors.ts";
import type { Plan, TargetPlan } from "./types.ts";

const nullableInt = z.number().int().nullable();

const dockerPlanSchema = z.looseObject({
  images: z.array(z.string()),
  tags: z.array(z.string()),
  refs: z.array(z.string()),
  verifyTag: z.string(),
  labels: z.record(z.string(), z.string()),
});

const targetPlanSchema = z.looseObject({
  name: z.string().min(1),
  type: z.enum(["docker", "web", "android", "ios", "custom"]),
  release: z.enum(["auto", "manual"]),
  marketingVersion: z.string().min(1),
  buildNumber: nullableInt,
  marker: z.string().optional(),
  docker: dockerPlanSchema.optional(),
});

const planSchema = z.looseObject({
  schemaVersion: z.literal(1),
  mode: z.enum(["publish", "ship", "release-pr", "none", "preview"]),
  channel: z.enum(["release", "prerelease", "preview"]),
  version: z.string().min(1),
  baseVersion: z.string().min(1),
  buildNumber: nullableInt,
  releaseSha: z.string(),
  branch: z.string(),
  maintenance: z.boolean(),
  distTag: z.string(),
  tag: z.string().optional(),
  prNumber: z.number().int().optional(),
  branchSlug: z.string().optional(),
  preid: z.string().optional(),
  matrix: z.array(z.string()),
  targets: z.record(z.string(), targetPlanSchema),
  releasePr: z
    .looseObject({
      version: z.string(),
      bump: z.enum(["patch", "minor", "major"]),
      changesets: z.array(z.string()),
      botPrs: z.array(z.number().int()),
    })
    .optional(),
  repository: z.string().optional(),
  run: z
    .looseObject({
      id: z.number().optional(),
      number: z.number().optional(),
      attempt: z.number().optional(),
      url: z.string().optional(),
    })
    .optional(),
  createdAt: z.string(),
});

const PLAN_HINT =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template.
  'In a workflow, pass the launchset job\'s output: plan: "${{ needs.launchset.outputs.plan }}" (and add the launchset job to needs). On the CLI, pass --plan <json> or --plan @plan.json, or set LAUNCHSET_PLAN.';

/**
 * Parse and validate the `plan` input (JSON from the `plan` output). Throws a
 * `LaunchsetError` (`missing-plan` / `invalid-plan`) that says what is wrong.
 */
export function parsePlan(json: string | undefined | null): Plan {
  if (json === undefined || json === null || json.trim() === "") {
    throw new LaunchsetError("missing-plan", "the plan input is missing or empty", {
      hint: PLAN_HINT,
    });
  }
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (error) {
    throw new LaunchsetError(
      "invalid-plan",
      `the plan input is not valid JSON (${(error as Error).message})`,
      { hint: PLAN_HINT },
    );
  }
  const parsed = planSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new LaunchsetError("invalid-plan", `the plan input is not a launchset plan: ${issues}`, {
      hint: `${PLAN_HINT} The plan must come from the same launchset version.`,
    });
  }
  const plan = parsed.data as unknown as Plan;
  for (const name of plan.matrix) {
    if (!plan.targets[name]) {
      throw new LaunchsetError(
        "invalid-plan",
        `the plan's matrix lists "${name}" but has no target data for it`,
        { hint: PLAN_HINT },
      );
    }
  }
  return plan;
}

/** The plan of one target; throws when the plan doesn't build it. */
export function planTarget(plan: Plan, name: string): TargetPlan {
  const target = plan.targets[name];
  if (!target) {
    const built = plan.matrix.length > 0 ? plan.matrix.join(", ") : "nothing";
    throw new LaunchsetError(
      "target-not-in-plan",
      `target "${name}" is not in this plan (it builds ${built})`,
      { hint: "Run this step only for targets in the matrix (matrix.target)." },
    );
  }
  return target;
}

const str = (value: number | string | null | undefined): string =>
  value === null || value === undefined ? "" : String(value);

/**
 * The action's outputs (spec 10) for a plan, optionally for one target (`stamp`, `verify`):
 * `mode` (release plans only), `matrix`, `plan`, `version`, `marketing-version`,
 * `build-number`, `channel`, `release-sha`, `tag`, `dist-tag`, `pr-number`, `docker-tags`
 * (full refs, one per line), `docker-refs-json`, `docker-labels` (`key=value` per line).
 * Missing values are empty strings.
 */
export function actionOutputs(plan: Plan, targetName?: string): Record<string, string> {
  const target = targetName === undefined ? undefined : planTarget(plan, targetName);
  const outputs: Record<string, string> = {};
  // A preview plan's mode isn't a release mode: the `mode` output is only set by `release`.
  if (plan.mode !== "preview") outputs.mode = plan.mode;
  outputs.matrix = JSON.stringify(plan.matrix);
  outputs.plan = JSON.stringify(plan);
  outputs.version = plan.version;
  outputs["marketing-version"] = target ? target.marketingVersion : plan.version;
  outputs["build-number"] = str(target ? target.buildNumber : plan.buildNumber);
  outputs.channel = plan.channel;
  outputs["release-sha"] = plan.releaseSha;
  outputs.tag = str(plan.tag);
  outputs["dist-tag"] = plan.distTag;
  outputs["pr-number"] = str(plan.prNumber);
  const docker = target?.docker;
  outputs["docker-tags"] = docker ? docker.refs.join("\n") : "";
  outputs["docker-refs-json"] = JSON.stringify(docker ? docker.refs : []);
  outputs["docker-labels"] = docker
    ? Object.entries(docker.labels)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n")
    : "";
  return outputs;
}

/**
 * `LAUNCHSET_VERSION`, `LAUNCHSET_BUILD_NUMBER`, `LAUNCHSET_CHANNEL` (spec 6.5), for
 * `app.config.js` and build scripts. With a target, its marketing version (plain for iOS)
 * and build number.
 */
export function envOutputs(plan: Plan, targetName?: string): Record<string, string> {
  const target = targetName === undefined ? undefined : planTarget(plan, targetName);
  return {
    LAUNCHSET_VERSION: target ? target.marketingVersion : plan.version,
    LAUNCHSET_BUILD_NUMBER: str(target ? target.buildNumber : plan.buildNumber),
    LAUNCHSET_CHANNEL: plan.channel,
  };
}
