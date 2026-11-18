import { describe, expect, it } from "vitest";
import { jsonValue } from "../../src/platforms/json.ts";
import {
  changedLines,
  expectStampError,
  fixture,
  lineOfText,
  replaceOnce,
} from "./stamper-test-utils.ts";

const F = "package.json";
const write = (text: string, key: string, marketing?: string, build?: number) =>
  jsonValue.write(text, F, { marketing, build }, { key });

describe("jsonValue", () => {
  it("2-space file: replaces only the top-level version", () => {
    const text = fixture("generic/package-2space.json");
    const out = write(text, "version", "1.5.0");
    expect(out).toBe(
      replaceOnce(text, '  "version": "1.4.0",\n  "private"', '  "version": "1.5.0",\n  "private"'),
    );
    expect(changedLines(text, out)).toBe(1);
  });

  it("nested dotted key", () => {
    const text = fixture("generic/package-2space.json");
    const out = write(text, "config.release.version", "1.5.0-pr.3.1");
    expect(out).toBe(
      replaceOnce(text, '      "version": "1.4.0"\n', '      "version": "1.5.0-pr.3.1"\n'),
    );
    expect(changedLines(text, out)).toBe(1);
    expect(jsonValue.read(text, F, { key: "config.release.version" })).toEqual([
      {
        field: "marketing",
        key: "config.release.version",
        value: "1.4.0",
        line: lineOfText(text, '      "version": "1.4.0"'),
      },
    ]);
  });

  it("tabs and no trailing newline", () => {
    const text = fixture("generic/package-tabs-no-eol.json");
    expect(text.endsWith("}")).toBe(true);
    const out = write(text, "version", "2.0.0");
    expect(out).toBe(replaceOnce(text, '"version": "1.4.0"', '"version": "2.0.0"'));
    expect(out.endsWith("}")).toBe(true);
  });

  it("CRLF", () => {
    const text = fixture("generic/package-crlf.json");
    const out = write(text, "version", "2.0.0");
    expect(out).toBe(replaceOnce(text, '"version": "1.4.0"', '"version": "2.0.0"'));
    expect(out.split("\r\n").length).toBe(text.split("\r\n").length);
    expect(changedLines(text, out)).toBe(1);
  });

  it("keeps comments and trailing commas (JSONC)", () => {
    const text = '{\n  // the version\n  "version": "1.0.0", /* x */\n}\n';
    expect(write(text, "version", "1.1.0")).toBe(
      '{\n  // the version\n  "version": "1.1.0", /* x */\n}\n',
    );
  });

  it("read returns the current value and line", () => {
    const text = fixture("generic/package-2space.json");
    expect(jsonValue.read(text, F, { key: "version" })).toEqual([
      { field: "marketing", key: "version", value: "1.4.0", line: 3 },
    ]);
  });

  it("ignores values.build; no marketing returns the input", () => {
    const text = fixture("generic/package-2space.json");
    expect(write(text, "version", undefined, 5)).toBe(text);
    expect(write(text, "version", "1.5.0", 5)).toBe(write(text, "version", "1.5.0"));
    expect(write("not even json", "version")).toBe("not even json");
  });

  it("a number is an error", () => {
    const text = fixture("generic/version-number.json");
    expectStampError(
      () => write(text, "version", "1.0.0"),
      F,
      'value of "version" (line 3) is a number, expected a string',
    );
    expectStampError(() => jsonValue.read(text, F, { key: "version" }), F, "is a number");
  });

  it("an object is an error", () => {
    expectStampError(
      () => write(fixture("generic/package-2space.json"), "config", "1.0.0"),
      F,
      "config is a object, expected a string or number",
    );
  });

  it("missing key", () => {
    expectStampError(
      () => write(fixture("generic/package-2space.json"), "config.nope", "1.0.0"),
      F,
      'key "config.nope" not found',
    );
    expectStampError(
      () => jsonValue.read("{}", F, { key: "version" }),
      F,
      'key "version" not found',
    );
  });

  it("duplicate key is ambiguous", () => {
    expectStampError(
      () => write('{"version":"1","version":"2"}', "version", "3"),
      F,
      'key "version" appears 2 times',
    );
  });

  it("invalid JSON names the line", () => {
    expectStampError(() => write('{\n  "version": \n', "version", "1"), F, "invalid JSON (line");
  });
});

describe("jsonValue: array items and BOM", () => {
  const text =
    '{\n  "items": [\n    { "version": "1.0.0" },\n    { "version": "2.0.0" }\n  ],\n  "0": "x"\n}\n';

  it("numeric segments index into arrays", () => {
    expect(write(text, "items.1.version", "3.0.0")).toBe(
      replaceOnce(text, '"version": "2.0.0"', '"version": "3.0.0"'),
    );
    expect(jsonValue.read(text, F, { key: "items.0.version" })).toEqual([
      { field: "marketing", key: "items.0.version", value: "1.0.0", line: 3 },
    ]);
  });

  it("out-of-range index and non-numeric segment on an array are 'not found'", () => {
    expectStampError(() => write(text, "items.2.version", "3.0.0"), F, "not found");
    expectStampError(() => write(text, "items.x.version", "3.0.0"), F, "not found");
  });

  it("numeric segments on objects stay object keys", () => {
    expect(write(text, "0", "y")).toBe(replaceOnce(text, '"0": "x"', '"0": "y"'));
  });

  it("duplicate keys inside an array item are still ambiguous", () => {
    expectStampError(
      () => write('{"a":[{"v":"1","v":"2"}]}', "a.0.v", "3"),
      F,
      'key "v" appears 2 times',
    );
  });

  it("a leading UTF-8 BOM is skipped for parsing and kept in the output", () => {
    const bom = `\uFEFF${fixture("generic/package-2space.json")}`;
    const out = write(bom, "version", "1.5.0");
    expect(out).toBe(replaceOnce(bom, '"version": "1.4.0",', '"version": "1.5.0",'));
    expect(out.startsWith("\uFEFF{")).toBe(true);
    expect(jsonValue.read(bom, F, { key: "version" })).toEqual([
      { field: "marketing", key: "version", value: "1.4.0", line: 3 },
    ]);
  });
});
