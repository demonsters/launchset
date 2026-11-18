/**
 * `launchset verify --target <name>` (spec 7.3–7.5): store, registry or npm check before the
 * upload. Output `already-published`.
 */

import { LaunchsetError } from "../core/errors.ts";
import { actionOutputs, planTarget } from "../core/outputs.ts";
import { renderSummary, unknownTarget } from "../core/plan-common.ts";
import type { Plan } from "../core/types.ts";
import { VerifyError, verifyTarget } from "../verify/index.ts";
import type { FlowContext, FlowResult } from "./context.ts";
import { checkHeadAtPlan } from "./git-ops.ts";
import { resolvePlan } from "./result.ts";

export interface VerifyOptions {
  target: string;
  plan: string | Plan;
  /** For tests; default `globalThis.fetch`. */
  fetch?: typeof fetch;
}

export interface VerifyData {
  target: string;
  version: string;
  alreadyPublished: boolean;
  message: string;
}

/** `command: verify` (spec 7.3–7.5). */
export async function verify(
  context: FlowContext,
  options: VerifyOptions,
): Promise<FlowResult<VerifyData>> {
  const plan = resolvePlan(options.plan);
  const targetPlan = planTarget(plan, options.target);
  const target = context.config.targets[options.target];
  if (!target) throw unknownTarget(context.config, options.target);
  const checkout = await checkHeadAtPlan(context, plan, "verify");
  let result: Awaited<ReturnType<typeof verifyTarget>>;
  try {
    result = await verifyTarget(
      target,
      { version: plan.version, target: targetPlan },
      {
        cwd: context.cwd,
        env: context.env,
        now: () => context.now,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      },
    );
  } catch (error) {
    if (error instanceof VerifyError) {
      throw new LaunchsetError("verify-failed", `verify ${options.target}: ${error.message}`, {
        hint: 'A failed check never counts as "not published". Fix the credentials or config and re-run the job.',
        cause: error,
      });
    }
    throw error;
  }
  const outputs = actionOutputs(plan, options.target);
  outputs["already-published"] = String(result.alreadyPublished);
  const verdict = result.alreadyPublished
    ? "already published: skip the upload and go straight to mark"
    : "not published yet";
  return {
    ok: true,
    outputs,
    summary: renderSummary({
      title: `launchset: verify ${options.target}`,
      paragraphs: [
        `${targetPlan.marketingVersion}${targetPlan.buildNumber !== null ? ` (build ${targetPlan.buildNumber})` : ""}: **${verdict}**.`,
        result.message,
      ],
      warnings: checkout ? [checkout] : [],
    }),
    lines: [
      `${options.target}: ${verdict} (${result.message})`,
      ...(checkout ? [`warning: ${checkout}`] : []),
    ],
    data: {
      target: options.target,
      version: plan.version,
      alreadyPublished: result.alreadyPublished,
      message: result.message,
    },
  };
}
