/** User-facing errors (pure). */

export interface LaunchsetErrorOptions {
  /** What the user can do about it, shown under the message. */
  hint?: string;
  cause?: unknown;
}

/**
 * A failure the user can act on: the message says what is wrong and where (file, field,
 * line), `hint` says what to do. `code` is a stable kebab-case identifier for tests,
 * JSON output and the action's job summary.
 */
export class LaunchsetError extends Error {
  readonly code: string;
  readonly hint?: string;

  constructor(code: string, message: string, options: LaunchsetErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LaunchsetError";
    this.code = code;
    if (options.hint !== undefined) this.hint = options.hint;
  }
}

/**
 * Marks error classes outside core that say what went wrong themselves (git, GitHub, verify
 * and stamp errors): {@link describeError} treats them as expected, not as bugs.
 */
export const EXPECTED_ERROR: unique symbol = Symbol.for("launchset.expected-error");

/** True for errors meant for the user (as opposed to bugs). */
export function isLaunchsetError(error: unknown): error is LaunchsetError {
  return error instanceof LaunchsetError;
}

/** The message of an error, or the thrown value as text. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The message with the error's hint on a `Hint:` line, for warnings that quote an error. */
export function messageWithHint(error: unknown): string {
  const { message, hint } = describeError(error);
  return hint ? `${message}\nHint: ${hint}` : message;
}

/** How a failure is shown: the message, the hint (once), and whether it's a known failure. */
export interface DescribedError {
  message: string;
  hint?: string;
  /** False for anything that looks like a bug in launchset (no hint, not a known error type). */
  expected: boolean;
}

/** A hint embedded in the message (`…\nHint: …`), as errors from before hints were apart. */
const EMBEDDED_HINT = /\nHint: /;

/**
 * The message and hint of any thrown value. The error's own `hint` wins; a hint embedded in
 * the message is split off, so it's shown once either way.
 */
export function describeError(error: unknown): DescribedError {
  const text = errorMessage(error);
  const match = EMBEDDED_HINT.exec(text);
  const message = match ? text.slice(0, match.index) : text;
  const embedded = match ? text.slice(match.index + match[0].length).trim() : "";
  const own = (error as { hint?: unknown } | null | undefined)?.hint;
  const hint = typeof own === "string" && own.trim() !== "" ? own.trim() : embedded;
  const expected =
    error instanceof LaunchsetError ||
    (typeof error === "object" && error !== null && (EXPECTED_ERROR in error || "hint" in error));
  return hint ? { message, hint, expected } : { message, expected };
}
