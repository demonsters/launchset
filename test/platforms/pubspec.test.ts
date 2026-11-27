import { describe, expect, it } from "vitest";
import { pubspec, splitPubspecVersion } from "../../src/platforms/pubspec.ts";
import {
  changedLines,
  expectStampError,
  fixture,
  lineOfText,
  replaceOnce,
} from "./stamper-test-utils.ts";

const F = "pubspec.yaml";
const app = () => fixture("flutter/app/pubspec.yaml");

describe("pubspec", () => {
  it("reads the build name and the build number of the top-level version", () => {
    const text = app();
    const line = lineOfText(text, "version: 1.4.0+12");
    expect(pubspec.read(text, F, undefined)).toEqual([
      { field: "marketing", key: "version", value: "1.4.0", line },
      { field: "build", key: "version (+build)", value: "12", line },
    ]);
  });

  it("the release PR changes only the build name and keeps +N and everything else", () => {
    const text = app();
    const out = pubspec.write(text, F, { marketing: "1.5.0" }, undefined);
    expect(out).toBe(replaceOnce(text, "version: 1.4.0+12", "version: 1.5.0+12"));
    expect(changedLines(text, out)).toBe(1);
    // The dependency's nested `version` is not the app's version.
    expect(out).toContain("    version: ^2.1.0");
  });

  it("CI writes the build number after the +", () => {
    const text = app();
    expect(
      pubspec.write(text, F, { marketing: "1.5.0-pr.12.3", build: 217175105 }, undefined),
    ).toBe(replaceOnce(text, "version: 1.4.0+12", "version: 1.5.0-pr.12.3+217175105"));
    expect(pubspec.write(text, F, { build: 99 }, undefined)).toBe(
      replaceOnce(text, "version: 1.4.0+12", "version: 1.4.0+99"),
    );
  });

  it("without a +N the release PR adds none, and CI appends one", () => {
    const text = "name: app\nversion: 1.4.0\n";
    expect(pubspec.read(text, F, undefined)).toEqual([
      { field: "marketing", key: "version", value: "1.4.0", line: 2 },
    ]);
    expect(pubspec.write(text, F, { marketing: "1.5.0" }, undefined)).toBe(
      "name: app\nversion: 1.5.0\n",
    );
    expect(pubspec.write(text, F, { marketing: "1.5.0", build: 7 }, undefined)).toBe(
      "name: app\nversion: 1.5.0+7\n",
    );
  });

  it("keeps an unusual build suffix as written on a marketing-only write", () => {
    const text = "name: app\nversion: 1.4.0+hotfix.1\n";
    expect(pubspec.write(text, F, { marketing: "1.5.0" }, undefined)).toBe(
      "name: app\nversion: 1.5.0+hotfix.1\n",
    );
  });

  it("keeps quotes, comments, CRLF and a missing trailing newline", () => {
    expect(
      pubspec.write("name: app\nversion: '1.4.0+3' # app\n", F, { marketing: "2.0.0" }, undefined),
    ).toBe("name: app\nversion: '2.0.0+3' # app\n");
    expect(pubspec.write('name: app\r\nversion: "1.4.0+3"\r\n', F, { build: 5 }, undefined)).toBe(
      'name: app\r\nversion: "1.4.0+5"\r\n',
    );
    expect(pubspec.write("name: app\nversion: 1.4.0+3", F, { marketing: "1.4.1" }, undefined)).toBe(
      "name: app\nversion: 1.4.1+3",
    );
  });

  it("writes a plain version for iOS and rejects a prerelease there", () => {
    const text = app();
    expect(pubspec.write(text, F, { marketing: "1.5.0", build: 3 }, { platform: "ios" })).toContain(
      "version: 1.5.0+3",
    );
    expectStampError(
      () => pubspec.write(text, F, { marketing: "1.5.0-pr.1.2" }, { platform: "ios" }),
      F,
      "plain X.Y.Z",
    );
    // Android keeps the full version (Flutter passes it to versionName unchanged).
    expect(
      pubspec.write(text, F, { marketing: "1.5.0-pr.1.2" }, { platform: "android" }),
    ).toContain("version: 1.5.0-pr.1.2+12");
  });

  it("fails on a missing version, a block scalar, escapes and invalid values", () => {
    expectStampError(
      () => pubspec.read("name: app\n", F, undefined),
      F,
      "no top-level version",
      "1.0.0+1",
    );
    expectStampError(() => pubspec.read("name: app\nversion:\n", F, undefined), F, "has no value");
    expectStampError(
      () => pubspec.read("name: app\nversion: >\n  1.0.0+1\n", F, undefined),
      F,
      "block scalar",
    );
    expectStampError(
      () => pubspec.write('version: "1.0.0\\x2b1"\n', F, { marketing: "1.1.0" }, undefined),
      F,
      "escape sequences",
    );
    expectStampError(
      () => pubspec.write("version: 1.0.0+1\n", F, { marketing: "1.1.0+4" }, undefined),
      F,
      "X.Y.Z",
    );
    expectStampError(
      () => pubspec.write("version: 1.0.0+1\n", F, { build: 0 }, undefined),
      F,
      "positive integer",
    );
    expectStampError(
      () => pubspec.read("version: 1.0.0+1\nversion: 1.0.0+2\n", F, undefined),
      F,
      "invalid YAML",
    );
  });

  it("splits a version at the first +", () => {
    expect(splitPubspecVersion("1.2.3+4")).toEqual({ name: "1.2.3", suffix: "+4" });
    expect(splitPubspecVersion("1.2.3")).toEqual({ name: "1.2.3", suffix: "" });
  });
});
