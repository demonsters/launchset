/** How a failure is shown in the step error and the job summary. */

import { describeError } from "../../src/core/errors.ts";

export interface FormattedError {
  /** The message, without the hint. */
  message: string;
  /** What to do about it. */
  hint?: string;
}

/** The message and the hint of an error ({@link describeError}: the hint once, apart). */
export function formatError(error: unknown): FormattedError {
  const { message, hint } = describeError(error);
  return hint ? { message, hint } : { message };
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
