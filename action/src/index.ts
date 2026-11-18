/**
 * The launchset GitHub Action (spec 10): reads the inputs, runs one command from src/flow
 * and reports the result as outputs, environment variables, a job summary and log lines.
 */

import { resolve } from "node:path";
import * as core from "@actions/core";
import { isLaunchsetError } from "../../src/core/errors.ts";
import { createContext, type FlowResult, type Logger } from "../../src/flow/index.ts";
import { dispatch, outputsFor } from "./commands.ts";
import { readInputs } from "./inputs.ts";

const log: Logger = {
  info: (message) => core.info(message),
  warn: (message) => core.warning(message),
  debug: (message) => core.debug(message),
};

/** Append markdown to the job summary (when the runner provides one). */
async function writeSummary(markdown: string): Promise<void> {
  if (!process.env.GITHUB_STEP_SUMMARY || markdown.trim() === "") return;
  try {
    await core.summary.addRaw(`${markdown.trimEnd()}\n\n`).write();
  } catch (error) {
    core.warning(`Couldn't write the job summary: ${(error as Error).message}`);
  }
}

function report(command: string, result: FlowResult, outputs: Record<string, string>): void {
  for (const [name, value] of Object.entries(outputs)) core.setOutput(name, value);
  for (const [name, value] of Object.entries(result.env ?? {})) core.exportVariable(name, value);
  for (const line of result.lines) core.info(line);
  if (!result.ok) core.setFailed(result.lines[0] ?? `launchset ${command} failed`);
}

/** A failure the user can act on: message and hint, the stack only with step debugging. */
async function reportError(command: string | undefined, error: unknown): Promise<void> {
  const label = command ? `launchset ${command}` : "launchset";
  const message = error instanceof Error ? error.message : String(error);
  const hint = isLaunchsetError(error) ? error.hint : (error as { hint?: string } | null)?.hint;
  const full = hint ? `${message}\n${hint}` : message;
  core.setFailed(full);
  if (error instanceof Error && error.stack && core.isDebug()) core.debug(error.stack);
  await writeSummary(
    `## ${label} failed\n\n${message.split("\n").join("  \n")}${hint ? `\n\n> [!TIP]\n> ${hint.split("\n").join("\n> ")}` : ""}\n`,
  );
}

async function main(): Promise<void> {
  let command: string | undefined;
  try {
    const inputs = readInputs((name) => core.getInput(name));
    command = inputs.command;
    if (inputs.token) core.setSecret(inputs.token);
    const root = resolve(process.env.GITHUB_WORKSPACE || process.cwd(), inputs.workingDirectory);
    const context = await createContext({
      cwd: root,
      ...(inputs.token ? { token: inputs.token } : {}),
      env: process.env,
      log,
    });
    const result = await dispatch(inputs.command, inputs, context);
    await writeSummary(result.summary);
    report(inputs.command, result, outputsFor(inputs.command, result, context));
  } catch (error) {
    await reportError(command, error);
  }
}

await main();
