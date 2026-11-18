import { describe, expect, it } from "vitest";
import { npmLockfile } from "../../src/platforms/npm-lockfile.ts";
import { changedLines, expectStampError, fixture, replaceEach } from "./stamper-test-utils.ts";

const F = "package-lock.json";
const write = (text: string, marketing?: string, build?: number) =>
  npmLockfile.write(text, F, { marketing, build });

describe("npmLockfile", () => {
  it("package-lock.json v3: top-level version and packages[''].version only", () => {
    const text = fixture("npm/package-lock.json");
    const out = write(text, "1.5.0");
    expect(out).toBe(
      replaceEach(text, [
        [
          '  "version": "1.4.0",\n  "lockfileVersion"',
          '  "version": "1.5.0",\n  "lockfileVersion"',
        ],
        [
          '      "version": "1.4.0",\n      "dependencies"',
          '      "version": "1.5.0",\n      "dependencies"',
        ],
      ]),
    );
    expect(changedLines(text, out)).toBe(2);
    expect(out).toContain('"version": "1.3.0"');
    expect(out).toContain('"version": "5.6.3"');
  });

  it("reads both values with their lines", () => {
    const text = fixture("npm/package-lock.json");
    expect(npmLockfile.read(text, F)).toEqual([
      { field: "marketing", key: "version", value: "1.4.0", line: 3 },
      { field: "marketing", key: 'packages[""].version', value: "1.4.0", line: 9 },
    ]);
  });

  it("npm-shrinkwrap.json with tabs and a prerelease version", () => {
    const text = fixture("npm/npm-shrinkwrap.json");
    const out = write(text, "2.0.0");
    expect(out).toBe(text.replaceAll('"version": "2.0.0-rc.1"', '"version": "2.0.0"'));
    expect(changedLines(text, out)).toBe(2);
  });

  it("CRLF", () => {
    const text = fixture("npm/package-lock-crlf.json");
    const out = write(text, "1.5.0");
    expect(out).toBe(text.replaceAll('"version": "1.4.0"', '"version": "1.5.0"'));
    expect(changedLines(text, out)).toBe(2);
  });

  it("lockfile without packages['']: only the top-level version", () => {
    const text = fixture("npm/package-lock-no-root.json");
    const out = write(text, "1.5.0");
    expect(out).toBe(replaceEach(text, [['"version": "1.4.0"', '"version": "1.5.0"']]));
    expect(npmLockfile.read(text, F)).toEqual([
      { field: "marketing", key: "version", value: "1.4.0", line: 3 },
    ]);
  });

  it("lockfile without any root version: skipped silently", () => {
    const text = fixture("npm/package-lock-no-version.json");
    expect(write(text, "1.5.0")).toBe(text);
    expect(npmLockfile.read(text, F)).toEqual([]);
  });

  it("ignores build; no marketing returns the input", () => {
    const text = fixture("npm/package-lock.json");
    expect(write(text, undefined, 5)).toBe(text);
    expect(write(text, "1.5.0", 5)).toBe(write(text, "1.5.0"));
  });

  it("errors: invalid JSON, wrong shapes", () => {
    expectStampError(() => write("{", "1.0.0"), F, "invalid JSON");
    expectStampError(
      () => write("[]", "1.0.0"),
      F,
      "expected a JSON object at the top level, found array",
    );
    expectStampError(
      () => write('{"version": 1}', "1.0.0"),
      F,
      "version (line 1) is a number, expected a string",
    );
    expectStampError(
      () => write('{"version": "1", "version": "2"}', "1.0.0"),
      F,
      'key "version" appears 2 times',
    );
  });
});

describe("npmLockfile: BOM", () => {
  it("keeps a leading UTF-8 BOM and stamps both values", () => {
    const text = `\uFEFF${fixture("npm/package-lock.json")}`;
    const out = write(text, "1.5.0");
    expect(out.startsWith("\uFEFF{")).toBe(true);
    expect(out).toBe(`\uFEFF${write(fixture("npm/package-lock.json"), "1.5.0")}`);
    expect(npmLockfile.read(text, F).map((v) => v.value)).toEqual(["1.4.0", "1.4.0"]);
  });
});
