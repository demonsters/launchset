import { describe, expect, it } from "vitest";
import { gradleProperties } from "../../src/platforms/gradle-properties.ts";
import {
  changedLines,
  expectStampError,
  fixture,
  lineOfText,
  replaceEach,
  replaceOnce,
} from "./stamper-test-utils.ts";

const F = "android/gradle.properties";
const options = { versionNameKey: "VERSION_NAME", versionCodeKey: "VERSION_CODE" };
const write = (text: string, values: { marketing?: string; build?: number }, o = options) =>
  gradleProperties.write(text, F, values, o);

describe("gradle-properties", () => {
  it("fixture: stamps both values, keeping separators, comments and the rest", () => {
    const text = fixture("android/gradle.properties");
    const out = write(text, { marketing: "1.5.0", build: 77 });
    expect(out).toBe(
      replaceEach(text, [
        ["VERSION_NAME = 1.4.0\n", "VERSION_NAME = 1.5.0\n"],
        ["VERSION_CODE:12\n", "VERSION_CODE:77\n"],
      ]),
    );
    expect(changedLines(text, out)).toBe(2);
    // the commented-out old value and the suffix key are untouched
    expect(out).toContain("# VERSION_CODE=99 (old value, keep commented)");
    expect(out).toContain("VERSION_NAME_SUFFIX=-beta");
  });

  it("fixture: marketing only / build only", () => {
    const text = fixture("android/gradle.properties");
    expect(write(text, { marketing: "2.0.0" })).toBe(
      replaceOnce(text, "VERSION_NAME = 1.4.0", "VERSION_NAME = 2.0.0"),
    );
    expect(write(text, { build: 5 })).toBe(replaceOnce(text, "VERSION_CODE:12", "VERSION_CODE:5"));
  });

  it("fixture: reads values with 1-based lines", () => {
    const text = fixture("android/gradle.properties");
    expect(gradleProperties.read(text, F, options)).toEqual([
      {
        field: "marketing",
        key: "VERSION_NAME",
        value: "1.4.0",
        line: lineOfText(text, "VERSION_NAME ="),
      },
      { field: "build", key: "VERSION_CODE", value: "12", line: lineOfText(text, "VERSION_CODE:") },
    ]);
  });

  it("write with no values returns the input unchanged (even if keys are missing)", () => {
    expect(write("a=b\n", {})).toBe("a=b\n");
    expect(write(fixture("android/gradle.properties"), {})).toBe(
      fixture("android/gradle.properties"),
    );
  });

  it("custom keys, CRLF, no trailing newline, trailing whitespace kept", () => {
    const text = "# c\r\nappVersion=1.0   \r\n  build : 3\r\nother=x";
    const out = gradleProperties.write(
      text,
      F,
      { marketing: "1.1", build: 4 },
      { versionNameKey: "appVersion", versionCodeKey: "build" },
    );
    expect(out).toBe("# c\r\nappVersion=1.1   \r\n  build : 4\r\nother=x");
  });

  it("empty value gets filled in", () => {
    expect(write("VERSION_NAME=\nVERSION_CODE=1\n", { marketing: "1.0.0" })).toBe(
      "VERSION_NAME=1.0.0\nVERSION_CODE=1\n",
    );
  });

  it("a key hidden in a continued value or a comment is not a key", () => {
    const text =
      "org.gradle.jvmargs=-Xmx1g \\\n  VERSION_NAME=fake\n#VERSION_NAME=comment\n!VERSION_NAME=comment\nVERSION_NAME=1.0.0\nVERSION_CODE=1\n";
    expect(write(text, { marketing: "2.0.0" })).toBe(
      replaceOnce(text, "\nVERSION_NAME=1.0.0", "\nVERSION_NAME=2.0.0"),
    );
  });

  it("a key that only starts with the wanted key is not a match", () => {
    expectStampError(
      () => write("VERSION_NAME_SUFFIX=x\nVERSION_CODE=1\n", { marketing: "1" }),
      F,
      "key VERSION_NAME not found",
    );
  });

  it("missing key", () => {
    const text = "VERSION_NAME=1.0.0\n";
    expectStampError(() => write(text, { build: 2 }), F, "key VERSION_CODE not found");
    // reading: the build number is optional, the marketing version is not
    expect(gradleProperties.read(text, F, options)).toEqual([
      { field: "marketing", key: "VERSION_NAME", value: "1.0.0", line: 1 },
    ]);
    expectStampError(
      () => gradleProperties.read("VERSION_CODE=1\n", F, options),
      F,
      "key VERSION_NAME not found",
    );
    // a duplicated build key is still an error when reading
    expectStampError(
      () => gradleProperties.read("VERSION_NAME=1\nVERSION_CODE=1\nVERSION_CODE=2\n", F, options),
      F,
      "VERSION_CODE is defined more than once",
    );
    expect(write(text, { marketing: "1.0.1" })).toBe("VERSION_NAME=1.0.1\n");
  });

  it("duplicate key", () => {
    const text = "VERSION_NAME=1.0.0\nx=y\nVERSION_NAME: 1.0.1\nVERSION_CODE=1\n";
    expectStampError(
      () => write(text, { marketing: "2" }),
      F,
      "key VERSION_NAME is defined more than once",
      "lines 1 and 3",
    );
  });

  it("value continued on the next line", () => {
    expectStampError(
      () => write("VERSION_NAME=1.0.\\\n0\nVERSION_CODE=1\n", { marketing: "2" }),
      F,
      "continues on the next line",
    );
  });

  it("rejects build numbers below 1", () => {
    expectStampError(() => write("VERSION_CODE=1\n", { build: 0 }), F, "not a positive integer");
  });

  it("handles a leading UTF-8 BOM (kept in the output, key still found)", () => {
    const text = "\uFEFFVERSION_NAME=1.0.0\nVERSION_CODE=1\n";
    expect(write(text, { marketing: "2.0.0", build: 5 })).toBe(
      "\uFEFFVERSION_NAME=2.0.0\nVERSION_CODE=5\n",
    );
    expect(gradleProperties.read(text, F, options)[0]).toEqual({
      field: "marketing",
      key: "VERSION_NAME",
      value: "1.0.0",
      line: 1,
    });
    const commented = "\uFEFF# header\nVERSION_NAME=1.0.0\nVERSION_CODE=1\n";
    expect(write(commented, { build: 2 })).toBe(
      "\uFEFF# header\nVERSION_NAME=1.0.0\nVERSION_CODE=2\n",
    );
  });

  it("rejects unwritable values", () => {
    expectStampError(() => write("VERSION_CODE=1\n", { build: -1 }), F, "not a positive integer");
    expectStampError(() => write("VERSION_NAME=1\n", { marketing: "a\nb" }), F, "can't write");
  });
});
