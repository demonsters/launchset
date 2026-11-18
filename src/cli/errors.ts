/** Turning failures into the lines the CLI prints: `error:` and `hint:`, no stack. */

import { describeError, LaunchsetError } from "../core/errors.ts";
import type { CliIo } from "./io.ts";
import { styler } from "./io.ts";

/** Wrong usage of the command line (a missing or conflicting flag): exit code 2. */
export class UsageError extends LaunchsetError {
  constructor(message: string, hint?: string) {
    super("usage", message, hint === undefined ? {} : { hint });
    this.name = "UsageError";
  }
}

/** Exit code for a failure: 2 for wrong usage, else 1. */
export function exitCodeFor(error: unknown): number {
  return error instanceof UsageError ? 2 : 1;
}

/** Print `error:` / `hint:` for `error` to stderr; the stack too with `LAUNCHSET_DEBUG`. */
export function reportError(io: CliIo, error: unknown): void {
  const style = styler(io);
  const { message, hint, expected } = describeError(error);
  const out = [`${style("red", "error:")} ${message}`];
  if (hint) {
    out.push(`${style("dim", "hint:")} ${hint}`);
  } else if (!expected && !io.env.LAUNCHSET_DEBUG) {
    out.push(
      `${style("dim", "hint:")} this looks like a bug in launchset; run again with LAUNCHSET_DEBUG=1 for the stack trace.`,
    );
  }
  if (io.env.LAUNCHSET_DEBUG && error instanceof Error) {
    const stack = error.stack ?? "";
    const cause =
      error.cause instanceof Error
        ? `\nCaused by: ${error.cause.stack ?? error.cause.message}`
        : "";
    out.push(`${stack}${cause}`);
  }
  io.stderr(`${out.join("\n")}\n`);
}
