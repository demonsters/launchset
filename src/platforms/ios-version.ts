/**
 * Value rules shared by the iOS stampers (spec 6.4): marketing versions are plain `X.Y.Z`
 * (Apple rejects prerelease suffixes), build numbers are positive integers.
 */

import { StampError } from "./types.ts";

/** Throws unless `value` is a plain `X.Y.Z` version. Previews pass the plain next version. */
export function assertIosMarketing(value: string, file: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(value)) {
    throw new StampError(
      file,
      `iOS marketing version must be plain X.Y.Z (Apple rejects prerelease suffixes), got "${value}"`,
    );
  }
}

/** Throws unless `value` is a positive integer. */
export function assertBuildNumber(value: number, file: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new StampError(file, `build number must be a positive integer, got ${value}`);
  }
}

/** True for a build-setting reference such as `$(MARKETING_VERSION)` or `${CURRENT_PROJECT_VERSION}`. */
export function isBuildSettingReference(value: string): boolean {
  return /\$[({]/.test(value);
}
