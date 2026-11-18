/** The action's inputs (action.yml), read through `@actions/core`. */

import { LaunchsetError } from "../../src/core/errors.ts";

/** The commands of the action (spec 10), in the order they appear in the docs. */
export const COMMANDS = [
  "check",
  "release",
  "stamp",
  "verify",
  "mark",
  "finalize",
  "preview-plan",
  "preview-comment",
  "add",
] as const;

export type Command = (typeof COMMANDS)[number];

export interface Inputs {
  command: Command;
  token: string;
  target: string;
  bump: string;
  message: string;
  version: string;
  plan: string;
  workingDirectory: string;
}

export function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

/** Reads one input by its action.yml name; the action runner passes them as `INPUT_<NAME>`. */
export type GetInput = (name: string) => string;

/**
 * Read and validate the inputs. `getInput` trims values; an unknown or missing `command`
 * is an error that lists the valid commands.
 */
export function readInputs(getInput: GetInput): Inputs {
  const raw = getInput("command").trim();
  const command = raw.toLowerCase();
  if (!isCommand(command)) {
    throw new LaunchsetError(
      "unknown-command",
      raw === "" ? "the command input is missing" : `unknown command "${raw}"`,
      { hint: `Set command to one of: ${COMMANDS.join(", ")}.` },
    );
  }
  return {
    command,
    token: getInput("token"),
    target: getInput("target"),
    bump: getInput("bump"),
    message: getInput("message"),
    version: getInput("version"),
    plan: getInput("plan"),
    workingDirectory: getInput("working-directory") || ".",
  };
}
