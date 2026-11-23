/** The common error of every forge client (see `./types.ts`). */

import { EXPECTED_ERROR } from "../core/errors.ts";

/** A forge API call failed. The message says which call and why; `hint` what to do. */
export class ForgeError extends Error {
  override name = "ForgeError";
  readonly [EXPECTED_ERROR] = true;
  /** HTTP status, or undefined when no response arrived. */
  readonly status: number | undefined;
  /** Method and path, e.g. `POST /repos/acme/app/pulls`; empty for errors before a call. */
  readonly endpoint: string;
  readonly hint: string | undefined;
  constructor(
    message: string,
    status: number | undefined,
    endpoint: string,
    hint: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.status = status;
    this.endpoint = endpoint;
    this.hint = hint;
  }
}
