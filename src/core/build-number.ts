/**
 * Build numbers (spec 7.2): strategies and store limits. Pure: `now` is passed in.
 */

import type { BuildNumberConfig, TargetType } from "./config/schema.ts";
import { LaunchsetError } from "./errors.ts";
import { versionParts } from "./versions.ts";

/** Google Play's highest allowed `versionCode` (spec 6.3). */
export const ANDROID_MAX_VERSION_CODE = 2_100_000_000;

export interface BuildNumberContext {
  /** The current time (the plan step's clock). */
  now: Date | number;
  /** `github.run_number`; required by `run-number`. */
  runNumber?: number;
  /** `github.run_attempt` (1-based); used by `semver`, default 1. */
  runAttempt?: number;
  /** Version being built; required by `semver` (only its `X.Y.Z` part is used). */
  version?: string;
}

const HINT_OFFSET =
  "Lower buildNumber.offset, or pick a strategy that produces smaller numbers (see the build-numbers docs).";

function ms(now: Date | number): number {
  return typeof now === "number" ? now : now.getTime();
}

/**
 * Compute the build number for a strategy (spec 7.2). `eas` returns `null` (EAS assigns
 * build numbers itself). `offset` is added for every strategy that produces a number.
 */
export function computeBuildNumber(
  config: BuildNumberConfig,
  context: BuildNumberContext,
): number | null {
  switch (config.strategy) {
    case "eas":
      return null;
    case "timestamp": {
      const epoch = Date.parse(config.epoch);
      if (Number.isNaN(epoch)) {
        throw new LaunchsetError(
          "invalid-config",
          `buildNumber.epoch "${config.epoch}" is not a valid date-time`,
        );
      }
      const seconds = Math.floor((ms(context.now) - epoch) / 1000);
      if (seconds < 0) {
        throw new LaunchsetError(
          "invalid-build-number",
          `buildNumber.epoch ${config.epoch} is in the future, so the "timestamp" strategy would give a negative build number`,
          { hint: "Use an epoch in the past (the default is 2020-01-01T00:00:00Z)." },
        );
      }
      return positive(seconds + config.offset, "timestamp");
    }
    case "run-number": {
      const run = context.runNumber;
      if (run === undefined) {
        throw new LaunchsetError(
          "no-run-number",
          'the "run-number" build-number strategy only works in GitHub Actions: there is no run number here',
          {
            hint: 'Run it in a workflow, or use the "timestamp" strategy for builds outside CI (for example `launchset ship`).',
          },
        );
      }
      if (!Number.isSafeInteger(run) || run < 1) {
        throw new LaunchsetError(
          "invalid-build-number",
          `the run number must be a positive integer, got ${run}`,
        );
      }
      return positive(run + config.offset, "run-number");
    }
    case "semver": {
      if (context.version === undefined) {
        throw new LaunchsetError(
          "invalid-build-number",
          'the "semver" build-number strategy needs the version being built',
        );
      }
      return positive(
        semverBuildNumber(context.version, context.runAttempt ?? 1) + config.offset,
        "semver",
      );
    }
  }
}

function positive(value: number, strategy: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new LaunchsetError(
      "invalid-build-number",
      `the "${strategy}" strategy produced ${value}, but build numbers must be positive integers`,
    );
  }
  return value;
}

/**
 * `major·10^7 + minor·10^5 + patch·10^2 + attempt` (spec 7.2). Errors for minor > 99,
 * patch > 999 or an attempt outside 1..99, since the parts would overlap.
 */
export function semverBuildNumber(version: string, attempt: number): number {
  const { major, minor, patch } = versionParts(version);
  if (minor > 99) {
    throw new LaunchsetError(
      "invalid-build-number",
      `version ${version}: the "semver" build-number strategy supports minor versions up to 99`,
      {
        hint: 'Switch to the "timestamp" strategy (with a buildNumber.offset above your current numbers).',
      },
    );
  }
  if (patch > 999) {
    throw new LaunchsetError(
      "invalid-build-number",
      `version ${version}: the "semver" build-number strategy supports patch versions up to 999`,
      {
        hint: 'Switch to the "timestamp" strategy (with a buildNumber.offset above your current numbers).',
      },
    );
  }
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 99) {
    throw new LaunchsetError(
      "invalid-build-number",
      `run attempt ${attempt}: the "semver" build-number strategy supports attempts 1 to 99`,
      { hint: "Start a new workflow run instead of re-running this one again." },
    );
  }
  return major * 10_000_000 + minor * 100_000 + patch * 100 + attempt;
}

/**
 * Throws when a build number can't be used for a target type: every build number must be a
 * positive integer, and Android's `versionCode` can't exceed 2,100,000,000 (spec 6.3).
 */
export function assertBuildNumberFits(
  type: TargetType,
  buildNumber: number,
  target?: string,
): void {
  const who = target ? `target "${target}": ` : "";
  if (!Number.isSafeInteger(buildNumber) || buildNumber < 1) {
    throw new LaunchsetError(
      "invalid-build-number",
      `${who}build number ${buildNumber} is not a positive integer`,
    );
  }
  if (type === "android" && buildNumber > ANDROID_MAX_VERSION_CODE) {
    throw new LaunchsetError(
      "build-number-too-large",
      `${who}build number ${buildNumber} is higher than Google Play's versionCode limit of 2,100,000,000`,
      { hint: HINT_OFFSET },
    );
  }
}

/**
 * The build number for one target (its own `buildNumber` override is already merged in
 * `target.buildNumber`), checked against the target's limits. `null` for `eas`.
 */
export function targetBuildNumber(
  target: { name: string; type: TargetType; buildNumber: BuildNumberConfig },
  context: BuildNumberContext,
): number | null {
  const value = computeBuildNumber(target.buildNumber, context);
  if (value !== null) assertBuildNumberFits(target.type, value, target.name);
  return value;
}
