import { describe, expect, it } from "vitest";
import { regexFile } from "../../src/platforms/regex.ts";
import { changedLines, expectStampError, fixture, replaceOnce } from "./stamper-test-utils.ts";

const F = "version.txt";
type Values = { marketing?: string; build?: number };
const write = (
  text: string,
  options: { pattern: string; flags?: string; replace: string },
  values: Values,
) => regexFile.write(text, F, values, options);

describe("regexFile", () => {
  const text = fixture("generic/version.txt");

  it("replaces the single match with {version}", () => {
    const out = write(
      text,
      { pattern: "APP_VERSION=.*", replace: "APP_VERSION={version}" },
      { marketing: "1.5.0" },
    );
    expect(out).toBe(replaceOnce(text, "APP_VERSION=1.4.0-rc.1", "APP_VERSION=1.5.0"));
    expect(changedLines(text, out)).toBe(1);
  });

  it("{major} {minor} {patch} from a version with a prerelease suffix; {version} keeps the suffix", () => {
    const out = write(
      text,
      { pattern: "APP_VERSION=.*", replace: "APP_VERSION={major}.{minor}.{patch} ({version})" },
      { marketing: "2.10.3-pr.12.4" },
    );
    expect(out).toBe(
      replaceOnce(text, "APP_VERSION=1.4.0-rc.1", "APP_VERSION=2.10.3 (2.10.3-pr.12.4)"),
    );
  });

  it("{buildNumber}", () => {
    const out = write(
      text,
      { pattern: "BUILD=\\d+", replace: "BUILD={buildNumber}" },
      { build: 77 },
    );
    expect(out).toBe(replaceOnce(text, "BUILD=42", "BUILD=77"));
    const both = write(
      text,
      { pattern: "APP_VERSION=.*", replace: "APP_VERSION={version}+{buildNumber}" },
      { marketing: "1.5.0", build: 9 },
    );
    expect(both).toBe(replaceOnce(text, "APP_VERSION=1.4.0-rc.1", "APP_VERSION=1.5.0+9"));
  });

  it("{buildNumber} without a build number is an error", () => {
    expectStampError(
      () =>
        write(
          text,
          { pattern: "BUILD=\\d+", replace: "BUILD={buildNumber}" },
          { marketing: "1.5.0" },
        ),
      F,
      "needs a build number; it is only stamped in CI by `launchset stamp`",
    );
  });

  it("a version placeholder without a version is an error", () => {
    expectStampError(
      () => write(text, { pattern: "BUILD=\\d+", replace: "{version}" }, { build: 1 }),
      F,
      "needs the version",
    );
  });

  it("capture references work like String.prototype.replace", () => {
    const out = write(
      text,
      { pattern: "(APP_VERSION=)\\S+", replace: "$1{version}" },
      { marketing: "1.5.0" },
    );
    expect(out).toBe(replaceOnce(text, "APP_VERSION=1.4.0-rc.1", "APP_VERSION=1.5.0"));
    const named = write(
      text,
      { pattern: "(?<key>APP_VERSION)=\\S+", replace: "$<key>:{version}" },
      { marketing: "1.5.0" },
    );
    expect(named).toBe(replaceOnce(text, "APP_VERSION=1.4.0-rc.1", "APP_VERSION:1.5.0"));
    const dollar = write(
      text,
      { pattern: "BUILD=42", replace: "COST=$$5" },
      { marketing: "1.0.0" },
    );
    expect(dollar).toBe(replaceOnce(text, "BUILD=42", "COST=$5"));
  });

  it("unknown {placeholders} stay literal", () => {
    const json = '{"v": "1.0.0"}\n';
    expect(
      write(
        json,
        { pattern: '"v": "[^"]+"', replace: '"v": "{version}", "x": {other}' },
        { marketing: "2.0.0" },
      ),
    ).toBe('{"v": "2.0.0", "x": {other}}\n');
  });

  it("flags: multiline anchors and case-insensitive; g is ignored", () => {
    const out = write(
      text,
      { pattern: "^app_version=.*$", flags: "im", replace: "APP_VERSION={version}" },
      { marketing: "1.5.0" },
    );
    expect(out).toBe(replaceOnce(text, "APP_VERSION=1.4.0-rc.1", "APP_VERSION=1.5.0"));
    expect(
      write(text, { pattern: "BUILD=42", flags: "g", replace: "BUILD=1" }, { marketing: "1.0.0" }),
    ).toBe(replaceOnce(text, "BUILD=42", "BUILD=1"));
  });

  it("CRLF and no trailing newline survive", () => {
    const crlf = "# v\r\nVERSION=1.0.0\r\nX=1";
    expect(
      write(
        crlf,
        { pattern: "VERSION=\\S+", replace: "VERSION={version}" },
        { marketing: "1.1.0" },
      ),
    ).toBe("# v\r\nVERSION=1.1.0\r\nX=1");
  });

  it("$ in a version value is not interpreted", () => {
    expect(
      write("v=1\n", { pattern: "v=\\d", replace: "v={version}" }, { marketing: "1.0.0-$&" }),
    ).toBe("v=1.0.0-$&\n");
  });

  it("must match exactly once: states the count", () => {
    expectStampError(
      () => write(text, { pattern: "nope", replace: "x" }, { marketing: "1.0.0" }),
      F,
      "matched 0 times, expected exactly 1",
      "check the pattern",
    );
    expectStampError(
      () => write("a=1\na=2\n", { pattern: "a=\\d", replace: "a=3" }, { marketing: "1.0.0" }),
      F,
      "matched 2 times, expected exactly 1",
      "more specific",
    );
    expectStampError(
      () => regexFile.read("a=1\na=2\n", F, { pattern: "a=\\d", replace: "" }),
      F,
      "matched 2 times",
    );
  });

  it("invalid pattern / flags", () => {
    expectStampError(
      () => write("x", { pattern: "(", replace: "" }, { marketing: "1.0.0" }),
      F,
      "invalid regex /(/",
    );
    expectStampError(
      () => write("x", { pattern: "x", flags: "q", replace: "" }, { marketing: "1.0.0" }),
      F,
      "invalid regex /x/q",
    );
    expectStampError(
      () => write("x", { pattern: "x", flags: "y", replace: "" }, { marketing: "1.0.0" }),
      F,
      "sticky",
    );
  });

  it("non-semver version can't fill {major}", () => {
    expectStampError(
      () => write(text, { pattern: "BUILD=42", replace: "{major}" }, { marketing: "banana" }),
      F,
      "not a semver version",
    );
  });

  it("read returns the matched text and its line", () => {
    expect(regexFile.read(text, F, { pattern: "APP_VERSION=\\S+", replace: "" })).toEqual([
      { field: "marketing", key: "APP_VERSION=\\S+", value: "APP_VERSION=1.4.0-rc.1", line: 2 },
    ]);
  });

  it("no values: input returned unchanged without matching", () => {
    expect(write(text, { pattern: "nope", replace: "x" }, {})).toBe(text);
  });
});
