import { describe, expect, it } from "vitest";
import { yamlValue } from "../../src/platforms/yaml.ts";
import {
  changedLines,
  expectStampError,
  fixture,
  lineOfText,
  replaceOnce,
} from "./stamper-test-utils.ts";

const F = "Chart.yaml";
const write = (text: string, key: string, marketing?: string) =>
  yamlValue.write(text, F, { marketing }, { key });

describe("yamlValue", () => {
  it("Helm Chart.yaml: double-quoted appVersion, comments kept", () => {
    const text = fixture("generic/Chart.yaml");
    const out = write(text, "appVersion", "1.5.0");
    expect(out).toBe(
      replaceOnce(
        text,
        'appVersion: "1.4.0"   # stamped by launchset',
        'appVersion: "1.5.0"   # stamped by launchset',
      ),
    );
    expect(changedLines(text, out)).toBe(1);
    expect(yamlValue.read(text, F, { key: "appVersion" })).toEqual([
      {
        field: "marketing",
        key: "appVersion",
        value: "1.4.0",
        line: lineOfText(text, "appVersion:"),
      },
    ]);
  });

  it("Chart.yaml: the plain `version` key is separate from appVersion", () => {
    const text = fixture("generic/Chart.yaml");
    expect(write(text, "version", "0.4.0")).toBe(
      replaceOnce(text, "\nversion: 0.3.1\n", "\nversion: 0.4.0\n"),
    );
  });

  it("plain, single-quoted and double-quoted scalars keep their style", () => {
    const text = fixture("generic/chart-plain-single.yaml");
    expect(write(text, "meta.plain", "2.0.0")).toBe(
      replaceOnce(text, "plain: 1.4.0 # plain", "plain: 2.0.0 # plain"),
    );
    expect(write(text, "meta.single", "2.0.0")).toBe(
      replaceOnce(text, "single: '1.4.0'", "single: '2.0.0'"),
    );
    expect(write(text, "meta.double", "2.0.0")).toBe(
      replaceOnce(text, 'double: "1.4.0"', 'double: "2.0.0"'),
    );
    expect(yamlValue.read(text, F, { key: "meta.plain" })[0]?.value).toBe("1.4.0");
    expect(yamlValue.read(text, F, { key: "meta.single" })[0]?.value).toBe("1.4.0");
  });

  it("preserves CRLF and a missing trailing newline", () => {
    const text = 'a:\r\n  version: "1.0.0"\r\n  other: 1';
    expect(write(text, "a.version", "1.1.0")).toBe('a:\r\n  version: "1.1.0"\r\n  other: 1');
  });

  it("multi-document file: key in one document only", () => {
    const text = fixture("generic/multi-doc.yaml");
    const out = write(text, "data.version", "1.5.0");
    expect(out).toBe(replaceOnce(text, 'version: "1.4.0"', 'version: "1.5.0"'));
    expect(yamlValue.read(text, F, { key: "data.version" })[0]?.line).toBe(
      lineOfText(text, "version:"),
    );
  });

  it("multi-document file: key in several documents is ambiguous", () => {
    const text = fixture("generic/multi-doc-ambiguous.yaml");
    expectStampError(
      () => write(text, "data.version", "1.5.0"),
      F,
      '"data.version" exists in more than one YAML document (documents 1, 2)',
    );
  });

  it("missing key and no marketing", () => {
    const text = fixture("generic/Chart.yaml");
    expectStampError(() => write(text, "nope", "1.0.0"), F, 'key "nope" not found');
    expectStampError(
      () => yamlValue.read(text, F, { key: "dependencies.version" }),
      F,
      "not found",
    );
    expect(write(text, "nope")).toBe(text);
  });

  it("non-scalar targets, block scalars, empty values and invalid YAML are errors", () => {
    expectStampError(() => write("a:\n  b: 1\n", "a", "1.0.0"), F, "expected a string value");
    expectStampError(() => write("a: |\n  1.0.0\n", "a", "1.0.0"), F, "block scalar");
    expectStampError(() => write("a:\nb: 1\n", "a", "1.0.0"), F, '"a" (line');
    expectStampError(() => write("a: [1,\n", "a", "1.0.0"), F, "invalid YAML (line");
    expectStampError(() => write("a: 1\na: 2\n", "a", "1.0.0"), F, "invalid YAML");
  });

  it("refuses values that aren't plain version strings", () => {
    expectStampError(() => write('a: "1"\n', "a", 'x"y'), F, "not a plain version string");
  });
});

describe("yamlValue: anchors, aliases, merge keys and BOM", () => {
  it("an anchored scalar is an error (an alias elsewhere would share it)", () => {
    const text = "appVersion: &v 1.0.0\nother: *v\n";
    expectStampError(
      () => write(text, "appVersion", "2.0.0"),
      F,
      '"appVersion" is anchored (&v)',
      "anchors can't be stamped",
    );
    expectStampError(() => yamlValue.read(text, F, { key: "appVersion" }), F, "is anchored");
  });

  it("a value that is an alias is an error", () => {
    const text = "base: &v 1.0.0\nappVersion: *v\n";
    expectStampError(() => write(text, "appVersion", "2.0.0"), F, '"appVersion" is an alias (*v)');
  });

  it("a path through an alias is an error", () => {
    const text = "base: &b\n  version: 1.0.0\nother: *b\n";
    expectStampError(
      () => write(text, "other.version", "2.0.0"),
      F,
      "is reached through an alias (*b)",
    );
  });

  it("a value that only exists through a merge key is an error", () => {
    const text = "base: &b\n  version: 1.0.0\nchild:\n  <<: *b\n  name: x\n";
    expectStampError(
      () => write(text, "child.version", "2.0.0"),
      F,
      'a "<<" merge key is in the way',
    );
  });

  it("anchors on other nodes don't matter; array items are addressable", () => {
    const text = "common: &c\n  a: 1\nitems:\n  - version: 1.0.0\n  - version: 2.0.0\n";
    expect(write(text, "items.1.version", "3.0.0")).toBe(
      replaceOnce(text, "version: 2.0.0", "version: 3.0.0"),
    );
  });

  it("a leading UTF-8 BOM is kept", () => {
    const text = '\uFEFFappVersion: "1.0.0"\n';
    expect(write(text, "appVersion", "1.1.0")).toBe('\uFEFFappVersion: "1.1.0"\n');
  });
});
