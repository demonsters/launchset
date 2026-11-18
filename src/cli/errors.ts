/** Turning failures into the lines the CLI prints: `error: …` and `hint: …`, no stack. */

import { isLaunchsetError } from "../core/errors.ts";
import type { CliIo } from "./io.ts";
import { styler } from "./io.ts";

/** Print `error:` / `hint:` for `error` to stderr; the stack too with `LAUNCHSET_DEBUG`. */
export function reportError(io: CliIo, error: unknown): void {
  const style = styler(io);
  const message = error instanceof Error ? error.message : String(error);
  const out = [`${style("red", "error:")} ${message}`];
  if (isLaunchsetError(error)) {
    if (error.hint) out.push(`${style("dim", "hint:")} ${error.hint}`);
  } else if (!io.env.LAUNCHSET_DEBUG) {
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
