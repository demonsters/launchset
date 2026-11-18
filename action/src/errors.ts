/** How a failure is shown in the step error and the job summary. */

import { errorMessage, isLaunchsetError } from "../../src/core/errors.ts";

export interface FormattedError {
  /** The message, as thrown. */
  message: string;
  /** A hint that isn't already part of the message. */
  hint?: string;
}

/**
 * The message and the hint of an error. `LaunchsetError` keeps its hint apart, but `GitError`,
 * `GitHubError` and `VerifyError` embed "Hint: …" in the message and also carry it as `hint`:
 * the hint is only returned when the message doesn't contain it yet.
 */
export function formatError(error: unknown): FormattedError {
  const message = errorMessage(error);
  const raw = isLaunchsetError(error)
    ? error.hint
    : (error as { hint?: unknown } | null | undefined)?.hint;
  const hint = typeof raw === "string" ? raw.trim() : "";
  if (hint === "" || message.includes(hint)) return { message };
  return { message, hint };
}

/** The text of the step error (`setFailed`). */
export function errorText({ message, hint }: FormattedError): string {
  return hint ? `${message}\n${hint}` : message;
}

/** The job summary of a failed command. */
export function errorSummary(label: string, { message, hint }: FormattedError): string {
  const tip = hint ? `\n\n> [!TIP]\n> ${hint.split("\n").join("\n> ")}` : "";
  return `## ${label} failed\n\n${message.split("\n").join("  \n")}${tip}\n`;
}
