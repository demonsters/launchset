/** Turning failures into the lines the CLI prints: `error:` and `hint:`, no stack. */

import { errorMessage, LaunchsetError } from "../core/errors.ts";
import { GitError } from "../git/index.ts";
import { GitHubError } from "../github/errors.ts";
import { StampError } from "../platforms/types.ts";
import { VerifyError } from "../verify/types.ts";
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

/** Errors that say what went wrong themselves: not bugs. */
function isExpected(error: unknown): boolean {
  if (
    error instanceof LaunchsetError ||
    error instanceof GitError ||
    error instanceof GitHubError ||
    error instanceof VerifyError ||
    error instanceof StampError
  ) {
    return true;
  }
  return typeof error === "object" && error !== null && "hint" in error;
}

const EMBEDDED_HINT = /\nHint: /;

/** The message and hint, with a hint that is also embedded in the message printed once. */
function messageAndHint(error: unknown): { message: string; hint?: string } {
  const text = errorMessage(error);
  const own = (error as { hint?: unknown } | null)?.hint;
  const match = EMBEDDED_HINT.exec(text);
  const message = match ? text.slice(0, match.index) : text;
  const embedded = match ? text.slice(match.index + match[0].length).trim() : undefined;
  const hint = typeof own === "string" && own !== "" ? own : embedded;
  return hint ? { message, hint } : { message };
}

/** Print `error:` / `hint:` for `error` to stderr; the stack too with `LAUNCHSET_DEBUG`. */
export function reportError(io: CliIo, error: unknown): void {
  const style = styler(io);
  const { message, hint } = messageAndHint(error);
  const out = [`${style("red", "error:")} ${message}`];
  if (hint) {
    out.push(`${style("dim", "hint:")} ${hint}`);
  } else if (!isExpected(error) && !io.env.LAUNCHSET_DEBUG) {
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
