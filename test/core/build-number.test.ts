import { describe, expect, it } from "vitest";
import {
  ANDROID_MAX_VERSION_CODE,
  assertBuildNumberFits,
  computeBuildNumber,
  semverBuildNumber,
  targetBuildNumber,
} from "../../src/core/build-number.ts";
import type { BuildNumberConfig } from "../../src/core/config/schema.ts";
import { LaunchsetError } from "../../src/core/errors.ts";

const config = (overrides: Partial<BuildNumberConfig> = {}): BuildNumberConfig => ({
  strategy: "timestamp",
  epoch: "2020-01-01T00:00:00Z",
  offset: 0,
  ...overrides,
});

const NOV_2026 = new Date("2026-11-18T12:00:00Z");

describe("timestamp", () => {
  it("is seconds since the epoch (about 217 million in November 2026)", () => {
    const n = computeBuildNumber(config(), { now: NOV_2026 });
    expect(n).toBe(Math.floor((NOV_2026.getTime() - Date.parse("2020-01-01T00:00:00Z")) / 1000));
    expect(n).toBeGreaterThan(215_000_000);
    expect(n).toBeLessThan(220_000_000);
  });

  it("floors partial seconds and adds the offset", () => {
    const epoch = Date.parse("2020-01-01T00:00:00Z");
    expect(computeBuildNumber(config({ offset: 1000 }), { now: epoch + 5_999 })).toBe(1005);
  });

  it("honors a custom epoch with an offset in the date", () => {
    expect(
      computeBuildNumber(config({ epoch: "2026-01-01T01:00:00+01:00" }), {
        now: Date.parse("2026-01-01T00:01:40Z"),
      }),
    ).toBe(100);
  });

  it("errors when the epoch is in the future", () => {
    expect(() =>
      computeBuildNumber(config({ epoch: "2030-01-01T00:00:00Z" }), { now: NOV_2026 }),
    ).toThrow(/is in the future/);
  });

  it("errors at exactly the epoch (0 isn't a valid build number)", () => {
    expect(() => computeBuildNumber(config(), { now: Date.parse("2020-01-01T00:00:00Z") })).toThrow(
      /must be positive integers/,
    );
  });
});

describe("run-number", () => {
  it("is the run number plus the offset", () => {
    expect(computeBuildNumber(config({ strategy: "run-number" }), { now: 0, runNumber: 42 })).toBe(
      42,
    );
    expect(
      computeBuildNumber(config({ strategy: "run-number", offset: 500 }), {
        now: 0,
        runNumber: 42,
      }),
    ).toBe(542);
  });

  it("only works in GitHub Actions", () => {
    try {
      computeBuildNumber(config({ strategy: "run-number" }), { now: NOV_2026 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LaunchsetError);
      expect((error as LaunchsetError).message).toContain("only works in GitHub Actions");
      expect((error as LaunchsetError).code).toBe("no-run-number");
      expect((error as LaunchsetError).hint).toContain("timestamp");
    }
  });
});

describe("semver", () => {
  it("is major·10^7 + minor·10^5 + patch·10^2 + attempt", () => {
    expect(semverBuildNumber("1.5.3", 2)).toBe(10_000_000 + 500_000 + 300 + 2);
    expect(
      computeBuildNumber(config({ strategy: "semver" }), {
        now: 0,
        version: "2.10.999",
        runAttempt: 99,
      }),
    ).toBe(20_000_000 + 1_000_000 + 99_900 + 99);
  });

  it("defaults the attempt to 1 (builds outside CI) and uses the base version", () => {
    expect(computeBuildNumber(config({ strategy: "semver" }), { now: 0, version: "1.0.0" })).toBe(
      10_000_001,
    );
    expect(semverBuildNumber("1.0.0-rc.1", 1)).toBe(10_000_001);
  });

  it("enforces the part limits", () => {
    expect(() => semverBuildNumber("1.100.0", 1)).toThrow(/minor versions up to 99/);
    expect(() => semverBuildNumber("1.99.1000", 1)).toThrow(/patch versions up to 999/);
    expect(() => semverBuildNumber("1.0.0", 0)).toThrow(/attempts 1 to 99/);
    expect(() => semverBuildNumber("1.0.0", 100)).toThrow(/attempts 1 to 99/);
    expect(semverBuildNumber("1.99.999", 99)).toBe(10_000_000 + 9_900_000 + 99_900 + 99);
  });

  it("needs the version", () => {
    expect(() => computeBuildNumber(config({ strategy: "semver" }), { now: 0 })).toThrow(
      /needs the version/,
    );
  });
});

describe("eas", () => {
  it("has no build number", () => {
    expect(computeBuildNumber(config({ strategy: "eas" }), { now: NOV_2026 })).toBeNull();
  });
});

describe("limits", () => {
  it("allows Android up to 2,100,000,000", () => {
    expect(() => assertBuildNumberFits("android", ANDROID_MAX_VERSION_CODE)).not.toThrow();
  });

  it("rejects Android above the Play limit, with the number and a hint", () => {
    try {
      assertBuildNumberFits("android", 2_100_000_001, "android");
      expect.unreachable();
    } catch (error) {
      const e = error as LaunchsetError;
      expect(e.message).toBe(
        'target "android": build number 2100000001 is higher than Google Play\'s versionCode limit of 2,100,000,000',
      );
      expect(e.hint).toContain("buildNumber.offset");
    }
  });

  it("allows big numbers on other platforms but requires positive integers everywhere", () => {
    expect(() => assertBuildNumberFits("ios", 3_000_000_000)).not.toThrow();
    for (const type of ["ios", "docker", "web", "custom", "android"] as const) {
      expect(() => assertBuildNumberFits(type, 0)).toThrow(/not a positive integer/);
      expect(() => assertBuildNumberFits(type, 1.5)).toThrow(/not a positive integer/);
      expect(() => assertBuildNumberFits(type, -3)).toThrow(/not a positive integer/);
    }
  });

  it("checks a target's own strategy and limits", () => {
    const target = {
      name: "android",
      type: "android" as const,
      buildNumber: config({ strategy: "run-number", offset: ANDROID_MAX_VERSION_CODE }),
    };
    expect(() => targetBuildNumber(target, { now: 0, runNumber: 1 })).toThrow(/versionCode limit/);
    expect(
      targetBuildNumber({ ...target, buildNumber: config({ strategy: "eas" }) }, { now: 0 }),
    ).toBeNull();
    expect(targetBuildNumber({ ...target, type: "ios" }, { now: 0, runNumber: 1 })).toBe(
      ANDROID_MAX_VERSION_CODE + 1,
    );
  });
});
