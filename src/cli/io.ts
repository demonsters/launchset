/**
 * The CLI's window to the outside world: output, environment, terminal and working
 * directory. `runCli` takes one, so tests run in-process with collected output.
 */

import { styleText } from "node:util";
import type { Prompter } from "../init/index.ts";
import type { AddPrompts } from "./prompts.ts";

export interface CliIo {
  /** Command results: the only place data goes. */
  stdout: (text: string) => void;
  /** Progress, warnings and errors. */
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  /** Stdin is a terminal: only then may a command ask questions. */
  isTTY: boolean;
  /** Stderr is a terminal: colors for `error:` and `hint:` (they go to stderr). Default false. */
  stderrIsTTY?: boolean;
  /** The shell's working directory (`--cwd` is resolved against it). */
  cwd: string;
  /** Interactive prompts for `add` (tests inject fakes; default: @clack/prompts). */
  addPrompts?: AddPrompts;
  /** Interactive prompts for `init` (default: @clack/prompts). */
  initPrompter?: Prompter;
  /** Clock, for tests. */
  now?: Date;
  /** Random source for changeset names, for tests. */
  rng?: () => number;
}

/** The real process. */
export function processIo(): CliIo {
  return {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    env: process.env,
    isTTY: Boolean(process.stdin.isTTY),
    stderrIsTTY: Boolean(process.stderr.isTTY),
    cwd: process.cwd(),
  };
}

type Format = "red" | "dim" | "bold";

/** Colors for stderr text: only when stderr is a terminal and `NO_COLOR` isn't set. */
export function styler(io: CliIo): (format: Format, text: string) => string {
  const color = (io.stderrIsTTY ?? false) && !io.env.NO_COLOR && io.env.TERM !== "dumb";
  return (format, text) => (color ? styleText(format, text, { validateStream: false }) : text);
}
