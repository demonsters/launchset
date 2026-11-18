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

/** True for errors meant for the user (as opposed to bugs). */
export function isLaunchsetError(error: unknown): error is LaunchsetError {
  return error instanceof LaunchsetError;
}

/** The message of an error, or the thrown value as text. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
