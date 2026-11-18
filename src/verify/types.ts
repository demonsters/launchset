/**
 * Verify contract (spec 7.3, 7.4, 7.5). `verify` checks whether this run's build is
 * already published, as a safety net before uploading. It never guesses: a check that
 * can't give a clear answer throws `VerifyError`, and is never treated as "not published".
 */

import { EXPECTED_ERROR } from "../core/errors.ts";
import { redactUrls } from "./redact.ts";

export interface VerifyResult {
  alreadyPublished: boolean;
  /** One line for the log and job summary. */
  message: string;
}

export interface VerifyContext {
  /** Repo root (package.json, .npmrc). */
  cwd: string;
  env: Record<string, string | undefined>;
  /** Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  now?: () => Date;
}

/**
 * A check failed (auth, network, unexpected response, store ahead, bad config). The
 * message never carries URL credentials: `user:password@` is masked.
 */
export class VerifyError extends Error {
  override name = "VerifyError";
  readonly [EXPECTED_ERROR] = true;
  constructor(message: string, options?: ErrorOptions) {
    super(redactUrls(message), options);
  }
}

/** Input shared by the store checks (spec 7.3). */
export interface StoreCheck {
  /** Marketing version of this run (`versionName` / `CFBundleShortVersionString`). */
  version: string;
  /** This run's build number; `null` with the `eas` strategy (an error for store checks). */
  buildNumber: number | null;
  /** The target's current `buildNumber.offset`, used for the suggestion when the store is ahead. */
  offset?: number;
  /** Target name, for messages. */
  target?: string;
}
