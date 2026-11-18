import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StampError } from "../../src/platforms/types.ts";
import { xcconfig } from "../../src/platforms/xcconfig.ts";

const fixture = (path: string): string =>
  readFileSync(join(import.meta.dirname, "../fixtures", path), "utf8");

const FILE = "ios/Version.xcconfig";

function stampError(fn: () => unknown): StampError {
  try {
    fn();
  } catch (e) {
    if (e instanceof StampError) return e;
    throw e;
  }
  throw new Error("expected a StampError, nothing was thrown");
}

function changedLines(before: string, after: string): { before: string; after: string }[] {
  const a = before.split("\n");
  const b = after.split("\n");
  expect(b.length).toBe(a.length);
  return a.flatMap((line, i) => (line === b[i] ? [] : [{ before: line, after: b[i] as string }]));
}

describe("xcconfig read", () => {
  const text = fixture("ios/xcconfig/Version.xcconfig");

  it("finds the unconditional assignments and ignores conditional ones", () => {
    expect(xcconfig.read(text, FILE, undefined)).toEqual([
      { field: "marketing", key: "MARKETING_VERSION", value: "1.4.0", line: 7 },
      { field: "build", key: "CURRENT_PROJECT_VERSION", value: "12", line: 8 },
    ]);
    expect(text.split("\n")[6]).toBe("MARKETING_VERSION = 1.4.0 // set by launchset");
  });

  it("reads references as written and unquotes quoted values", () => {
    const found = xcconfig.read(
      'MARKETING_VERSION = $(BASE_VERSION)\nCURRENT_PROJECT_VERSION = "7"\n',
      FILE,
      undefined,
    );
    expect(found.map((f) => f.value)).toEqual(["$(BASE_VERSION)", "7"]);
  });

  it("allows a missing build number", () => {
    expect(xcconfig.read("MARKETING_VERSION = 1.0.0\n", FILE, undefined)).toHaveLength(1);
  });

  it("ignores commented-out assignments and other keys that merely share a prefix", () => {
    const t =
      "// MARKETING_VERSION = 9.9.9\nMARKETING_VERSION_EXTRA = 3\nMARKETING_VERSION = 1.0.0\n";
    expect(xcconfig.read(t, FILE, undefined)).toEqual([
      { field: "marketing", key: "MARKETING_VERSION", value: "1.0.0", line: 3 },
    ]);
  });
});

describe("xcconfig write", () => {
  const text = fixture("ios/xcconfig/Version-plain.xcconfig");
  const withConditional = fixture("ios/xcconfig/Version.xcconfig");

  it("replaces the values, keeping the trailing comment", () => {
    const out = xcconfig.write(text, FILE, { marketing: "1.5.0", build: 345 }, undefined);
    expect(out).toBe(
      text
        .replace(
          "MARKETING_VERSION = 1.4.0 // set by launchset",
          "MARKETING_VERSION = 1.5.0 // set by launchset",
        )
        .replace("\nCURRENT_PROJECT_VERSION = 12\n", "\nCURRENT_PROJECT_VERSION = 345\n"),
    );
    expect(changedLines(text, out)).toEqual([
      {
        before: "MARKETING_VERSION = 1.4.0 // set by launchset",
        after: "MARKETING_VERSION = 1.5.0 // set by launchset",
      },
      { before: "CURRENT_PROJECT_VERSION = 12", after: "CURRENT_PROJECT_VERSION = 345" },
    ]);
  });

  it("writes only the given field and returns the input when there is nothing to write", () => {
    expect(
      changedLines(text, xcconfig.write(text, FILE, { marketing: "1.5.0" }, undefined)),
    ).toHaveLength(1);
    expect(changedLines(text, xcconfig.write(text, FILE, { build: 5 }, undefined))).toHaveLength(1);
    expect(xcconfig.write(text, FILE, {}, undefined)).toBe(text);
    expect(xcconfig.write(withConditional, FILE, {}, undefined)).toBe(withConditional);
  });

  it("keeps spacing, tabs, quotes, CRLF and a missing trailing newline", () => {
    const t =
      'MARKETING_VERSION=1.0.0\r\n\tCURRENT_PROJECT_VERSION\t=\t"3"   // build\r\nOTHER = x';
    expect(xcconfig.write(t, FILE, { marketing: "2.0.0", build: 4 }, undefined)).toBe(
      'MARKETING_VERSION=2.0.0\r\n\tCURRENT_PROJECT_VERSION\t=\t"4"   // build\r\nOTHER = x',
    );
  });

  it("keeps a trailing semicolon outside the value", () => {
    const t = 'MARKETING_VERSION = 1.0.0;\nCURRENT_PROJECT_VERSION = "3";  // c\n';
    expect(xcconfig.read(t, FILE, undefined).map((f) => f.value)).toEqual(["1.0.0", "3"]);
    expect(xcconfig.write(t, FILE, { marketing: "2.0.0", build: 4 }, undefined)).toBe(
      'MARKETING_VERSION = 2.0.0;\nCURRENT_PROJECT_VERSION = "4";  // c\n',
    );
  });

  it("treats // inside quotes as part of the value, not a comment", () => {
    const t = 'MARKETING_VERSION = "1.0//x" // real comment\nCURRENT_PROJECT_VERSION = 1\n';
    expect(xcconfig.read(t, FILE, undefined)[0]?.value).toBe("1.0//x");
    expect(xcconfig.write(t, FILE, { marketing: "2.0.0" }, undefined)).toBe(
      'MARKETING_VERSION = "2.0.0" // real comment\nCURRENT_PROJECT_VERSION = 1\n',
    );
    const escaped = 'MARKETING_VERSION = "a\\"//b" // c\n';
    expect(xcconfig.read(escaped, FILE, undefined)[0]?.value).toBe('a\\"//b');
  });

  it("ignores conditional assignments of fields that are not being written", () => {
    const t =
      "MARKETING_VERSION = 1.0.0\nCURRENT_PROJECT_VERSION = 2\nCURRENT_PROJECT_VERSION[config=Debug] = 1\n";
    expect(xcconfig.write(t, FILE, { marketing: "1.1.0" }, undefined)).toBe(
      "MARKETING_VERSION = 1.1.0\nCURRENT_PROJECT_VERSION = 2\nCURRENT_PROJECT_VERSION[config=Debug] = 1\n",
    );
    // Release-PR write on the fixture that has a conditional build number.
    expect(
      changedLines(
        withConditional,
        xcconfig.write(withConditional, FILE, { marketing: "1.5.0" }, undefined),
      ),
    ).toHaveLength(1);
    // Reading ignores them too.
    expect(xcconfig.read(withConditional, FILE, undefined).map((f) => f.value)).toEqual([
      "1.4.0",
      "12",
    ]);
  });
});

describe("xcconfig errors", () => {
  it("fails when a field being written has a conditional assignment", () => {
    const t =
      "MARKETING_VERSION = 1.0.0\nCURRENT_PROJECT_VERSION = 3\nCURRENT_PROJECT_VERSION[config=Release] = 4\n";
    const err = stampError(() => xcconfig.write(t, FILE, { build: 5 }, undefined));
    expect(err.file).toBe(FILE);
    expect(err.reason).toBe(
      "line 3: CURRENT_PROJECT_VERSION[config=Release] is a conditional assignment. It overrides CURRENT_PROJECT_VERSION for matching builds, so those builds would ship a different value than the one launchset writes. Remove it, or manage CURRENT_PROJECT_VERSION by hand and don't stamp it with launchset.",
    );
    // Conditionals before the plain assignment are caught the same way.
    const before =
      "CURRENT_PROJECT_VERSION[sdk=iphoneos*] = 1\nCURRENT_PROJECT_VERSION = 2\nMARKETING_VERSION = 1.0.0\n";
    expect(
      stampError(() => xcconfig.write(before, FILE, { build: 9 }, undefined)).reason,
    ).toContain("line 1: CURRENT_PROJECT_VERSION[sdk=iphoneos*] is a conditional assignment");
    // Not writing that field is fine.
    expect(() => xcconfig.write(t, FILE, { marketing: "1.5.0" }, undefined)).not.toThrow();
  });

  it("fails when a key only has conditional assignments and no plain one", () => {
    const t = "MARKETING_VERSION = 1.0.0\nCURRENT_PROJECT_VERSION[config=Release] = 4\n";
    expect(
      stampError(() => xcconfig.read("MARKETING_VERSION[sdk=*] = 1.0.0\n", FILE, undefined)).reason,
    ).toBe(
      "MARKETING_VERSION: only conditional assignments exist (line 1) and launchset doesn't stamp those; add an unconditional `MARKETING_VERSION = <value>` line",
    );
    expect(() => xcconfig.write(t, FILE, { build: 5 }, undefined)).toThrow(
      /conditional assignment/,
    );
    expect(() => xcconfig.write(t, FILE, { marketing: "1.5.0" }, undefined)).not.toThrow();
  });

  it("fails when a key is assigned unconditionally more than once", () => {
    const t = "MARKETING_VERSION = 1.0.0\nMARKETING_VERSION = 1.1.0\n";
    const err = stampError(() => xcconfig.write(t, FILE, { marketing: "1.5.0" }, undefined));
    expect(err.file).toBe(FILE);
    expect(err.reason).toBe(
      "MARKETING_VERSION is assigned 2 times without a condition (lines 1, 2); keep one assignment, or make the others conditional",
    );
  });

  it("fails when a written key is missing", () => {
    const t = "MARKETING_VERSION = 1.0.0\n";
    expect(stampError(() => xcconfig.write(t, FILE, { build: 5 }, undefined)).reason).toBe(
      "CURRENT_PROJECT_VERSION: no `CURRENT_PROJECT_VERSION = ...` line found; add one",
    );
    expect(
      stampError(() => xcconfig.read("CURRENT_PROJECT_VERSION = 1\n", FILE, undefined)).reason,
    ).toContain("MARKETING_VERSION: no `MARKETING_VERSION = ...` line found");
  });

  it("refuses to overwrite a build-setting reference", () => {
    const t = "MARKETING_VERSION = $(BASE_VERSION)\nCURRENT_PROJECT_VERSION = 1\n";
    expect(
      stampError(() => xcconfig.write(t, FILE, { marketing: "1.5.0" }, undefined)).reason,
    ).toBe(
      "line 1: MARKETING_VERSION is the build-setting reference $(BASE_VERSION), which launchset won't overwrite; set a literal value or stamp the file that defines it",
    );
    expect(() => xcconfig.write(t, FILE, { build: 2 }, undefined)).not.toThrow();
  });

  it("rejects a prerelease marketing version and a bad build number", () => {
    const t = "MARKETING_VERSION = 1.0.0\nCURRENT_PROJECT_VERSION = 1\n";
    expect(
      stampError(() => xcconfig.write(t, FILE, { marketing: "1.5.0-rc.1" }, undefined)).reason,
    ).toBe(
      'iOS marketing version must be plain X.Y.Z (Apple rejects prerelease suffixes), got "1.5.0-rc.1"',
    );
    expect(stampError(() => xcconfig.write(t, FILE, { build: -3 }, undefined)).reason).toBe(
      "build number must be a positive integer, got -3",
    );
  });
});
