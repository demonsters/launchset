/** Shapes the outputs a command reports (shared by the GitHub Action and the CLI's `--ci` mode). */

import type { FlowContext, FlowResult } from "./context.ts";

/** The pull request number of the event, when it is a `pull_request` run. */
function eventPrNumber(context: FlowContext): string {
  const number = context.ci.event?.pr?.number;
  return number === undefined ? "" : String(number);
}

/**
 * The outputs to set: the flow's, plus the ones that depend on the command
 * (`prerelease` from the channel, `pr-number` for `check`, `path` for `add`).
 */
export function outputsFor(
  command: string,
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
