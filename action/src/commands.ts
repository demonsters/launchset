/**
 * Maps the action's `command` input to the flow functions (src/flow) and shapes the outputs
 * (spec 10). No GitHub Actions I/O here: `index.ts` reads the inputs and writes the results.
 */

import { LaunchsetError } from "../../src/core/errors.ts";
import {
  add,
  check,
  eventInfo,
  type FlowContext,
  type FlowResult,
  finalize,
  mark,
  release,
  stamp,
  verify,
} from "../../src/flow/index.ts";
import { previewComment, previewPlan } from "../../src/flow/preview.ts";
import type { Command, Inputs } from "./inputs.ts";

/** The flow functions the action calls; tests pass mocks. */
export interface Flows {
  add: typeof add;
  check: typeof check;
  finalize: typeof finalize;
  mark: typeof mark;
  previewComment: typeof previewComment;
  previewPlan: typeof previewPlan;
  release: typeof release;
  stamp: typeof stamp;
  verify: typeof verify;
}

export const realFlows: Flows = {
  add,
  check,
  finalize,
  mark,
  previewComment,
  previewPlan,
  release,
  stamp,
  verify,
};

function requireInput(inputs: Inputs, name: "target" | "plan"): string {
  const value = inputs[name];
  if (value !== "") return value;
  throw new LaunchsetError(
    "missing-input",
    `the ${name} input is required for command ${inputs.command}`,
    {
      hint:
        name === "target"
          ? // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression.
            'Pass the target name: target: "${{ matrix.target }}".'
          : // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression.
            'Pass the plan job\'s output: plan: "${{ needs.launchset.outputs.plan }}".',
    },
  );
}

/** Run one command. Throws `LaunchsetError` (or whatever the flow throws). */
export async function dispatch(
  command: Command,
  inputs: Inputs,
  context: FlowContext,
  flows: Flows = realFlows,
): Promise<FlowResult> {
  switch (command) {
    case "check":
      return flows.check(context, { comment: true });
    case "release":
      return flows.release(context, {
        ...(inputs.target ? { target: inputs.target } : {}),
        ...(inputs.version ? { version: inputs.version } : {}),
      });
    case "stamp":
      return flows.stamp(context, {
        target: requireInput(inputs, "target"),
        plan: requireInput(inputs, "plan"),
      });
    case "verify":
      return flows.verify(context, {
        target: requireInput(inputs, "target"),
        plan: requireInput(inputs, "plan"),
      });
    case "mark":
      return flows.mark(context, {
        target: requireInput(inputs, "target"),
        // Shipped by hand (spec 9.8): a version instead of a plan.
        ...(inputs.plan ? { plan: inputs.plan } : { version: inputs.version }),
      });
    case "finalize":
      return flows.finalize(context, { plan: requireInput(inputs, "plan") });
    case "preview-plan": {
      // An input without a name means "not given"; previewPlan splits the comma-separated list.
      const given = /[^\s,]/.test(inputs.target);
      return flows.previewPlan(context, given ? { targets: [inputs.target] } : {});
    }
    case "preview-comment":
      // Empty when the preview was skipped (spec 9.7): the flow reports "nothing to report".
      return flows.previewComment(context, { plan: inputs.plan });
    case "add":
      return flows.add(context, {
        ...(inputs.bump ? { bump: inputs.bump } : {}),
        ...(inputs.message ? { message: inputs.message } : {}),
      });
  }
}

/** The pull request number of the event, when it is a `pull_request` run. */
function eventPrNumber(context: FlowContext): string {
  const number = eventInfo(context)?.pr?.number;
  return number === undefined ? "" : String(number);
}

/**
 * The outputs to set: the flow's, plus the ones that depend on the command
 * (`prerelease` from the channel, `pr-number` for `check`, `path` for `add`).
 */
export function outputsFor(
  command: Command,
  result: FlowResult,
  context: FlowContext,
): Record<string, string> {
  const outputs = { ...result.outputs };
  // Empty when there is no plan (a skipped preview).
  if (outputs.channel !== undefined) {
    outputs.prerelease = outputs.channel === "" ? "" : String(outputs.channel === "prerelease");
  }
  if (command === "check" && outputs["pr-number"] === undefined) {
    outputs["pr-number"] = eventPrNumber(context);
  }
  if (command === "add") {
    const data = result.data as { path?: unknown } | undefined;
    if (typeof data?.path === "string") outputs.path = data.path;
  }
  return outputs;
}
