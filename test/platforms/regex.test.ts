import { describe, expect, it } from "vitest";
import { expandReplacement, mentionsCarriageReturn, regexFile } from "../../src/platforms/regex.ts";
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

describe("regexFile: line endings", () => {
  const lf = fixture("generic/Cargo.lock");
  const crlf = fixture("generic/Cargo-crlf.lock");
  const mixed = fixture("generic/Cargo-mixed.lock");
  const cargo = {
    pattern: '(name = "attica-core"\\nversion = ")[^"]*"',
    replace: '$1{version}"',
  };
  const stamped = (text: string) =>
    replaceOnce(text, 'version = "0.11.1"\r\ndependencies', 'version = "0.11.2"\r\ndependencies');

  it("fixtures have the line endings they claim", () => {
    expect(lf).not.toContain("\r");
    expect(crlf.split("\n").length - 1).toBe(crlf.split("\r\n").length - 1);
    expect(mixed).toContain("\r\n");
    expect(mixed).toMatch(/[^\r]\n/);
  });

  it("a \\n in the pattern matches LF, CRLF and mixed files alike", () => {
    expect(write(lf, cargo, { marketing: "0.11.2" })).toBe(
      replaceOnce(lf, 'version = "0.11.1"\ndependencies', 'version = "0.11.2"\ndependencies'),
    );
    expect(write(crlf, cargo, { marketing: "0.11.2" })).toBe(stamped(crlf));
    // In the mixed file the attica-core version line ends in a lone \n; it stays that way.
    expect(write(mixed, cargo, { marketing: "0.11.2" })).toBe(
      replaceOnce(mixed, 'version = "0.11.1"\ndependencies', 'version = "0.11.2"\ndependencies'),
    );
  });

  it("only the matched range changes: every other byte, CRLF or LF, stays", () => {
    for (const text of [crlf, mixed]) {
      const out = write(text, cargo, { marketing: "0.11.2" });
      const at = text.indexOf('name = "attica-core"');
      expect(out.slice(0, at)).toBe(text.slice(0, at));
      const tail = text.indexOf("dependencies");
      expect(out.slice(out.length - (text.length - tail))).toBe(text.slice(tail));
      expect(out.length).toBe(text.length);
    }
  });

  it("captures spanning a CRLF and a LF keep both, byte for byte", () => {
    const pattern = '(name = "attica-core"\\nversion = ")[^"]*("\\ndependencies)';
    const out = write(mixed, { pattern, replace: "$1{version}$2" }, { marketing: "0.11.2" });
    expect(out).toBe(replaceOnce(mixed, '"0.11.1"\ndependencies', '"0.11.2"\ndependencies'));
    expect(out).toContain('name = "attica-core"\r\nversion = "0.11.2"\ndependencies');
    const named = write(
      crlf,
      {
        pattern: '(?<head>name = "attica-core"\\nversion = ")[^"]*"',
        replace: '$<head>{version}"',
      },
      { marketing: "0.11.2" },
    );
    expect(named).toBe(stamped(crlf));
  });

  it("$&, $` and $' expand to the file's own text", () => {
    const text = "a\r\nV=1\r\nb\r\n";
    expect(write(text, { pattern: "\\nV=1\\n", replace: "$&" }, { marketing: "1.0.0" })).toBe(text);
    expect(write(text, { pattern: "V=1", replace: "[$`|$']" }, { marketing: "1.0.0" })).toBe(
      "a\r\n[a\r\n|\r\nb\r\n]\r\nb\r\n",
    );
  });

  it("line breaks written in the replacement get the file's CRLF", () => {
    const text = "# v\r\nVERSION=1.0.0\r\nX=1\r\n";
    expect(
      write(
        text,
        { pattern: "VERSION=.*\\n", replace: "VERSION={version}\n# stamped\n" },
        { marketing: "1.1.0" },
      ),
    ).toBe("# v\r\nVERSION=1.1.0\r\n# stamped\r\nX=1\r\n");
  });

  it("m flag: ^ and $ see lines, not the \\r", () => {
    expect(
      write(
        crlf,
        { pattern: '^version = "0\\.11\\.1"$\\n^dependencies', flags: "m", replace: "X" },
        { marketing: "0.11.2" },
      ),
    ).toBe(replaceOnce(crlf, 'version = "0.11.1"\r\ndependencies', "X"));
    // [^\n]* stops at the line end and doesn't eat the \r.
    expect(
      write(
        "A=1\r\nVERSION=1.0.0\r\n",
        { pattern: "^VERSION=[^\\n]*", flags: "m", replace: "VERSION={version}" },
        { marketing: "2.0.0" },
      ),
    ).toBe("A=1\r\nVERSION=2.0.0\r\n");
  });

  it("read returns the matched text as written in the file, and its line", () => {
    expect(regexFile.read(crlf, F, cargo)).toEqual([
      {
        field: "marketing",
        key: cargo.pattern,
        value: 'name = "attica-core"\r\nversion = "0.11.1"',
        line: 11,
      },
    ]);
    expect(regexFile.read(lf, F, cargo)[0]?.line).toBe(11);
  });

  it("patterns that spell out \\r?\\n or \\r\\n keep working", () => {
    const optional = { ...cargo, pattern: '(name = "attica-core"\\r?\\nversion = ")[^"]*"' };
    expect(write(crlf, optional, { marketing: "0.11.2" })).toBe(stamped(crlf));
    expect(write(lf, optional, { marketing: "0.11.2" })).toBe(
      write(lf, cargo, { marketing: "0.11.2" }),
    );
    const explicit = { ...cargo, pattern: '(name = "attica-core"\\r\\nversion = ")[^"]*"' };
    expect(write(crlf, explicit, { marketing: "0.11.2" })).toBe(stamped(crlf));
    // [^\r]* is matched against the file as is, so it stops at the \r.
    expect(
      write(
        "A=1\r\nVERSION=1.0.0\r\n",
        { pattern: "VERSION=[^\\r]*", replace: "VERSION={version}" },
        { marketing: "2.0.0" },
      ),
    ).toBe("A=1\r\nVERSION=2.0.0\r\n");
  });

  it("the same config gives the same result on an LF and a CRLF checkout", () => {
    const patterns = [
      cargo,
      {
        pattern: 'name = "attica-core"\\s+version = "[^"]*"',
        replace: 'name = "attica-core"\nversion = "{version}"',
      },
      {
        pattern: '(?<=attica-core"\\n)version = "[^"]*"$',
        flags: "m",
        replace: 'version = "{version}"',
      },
      { pattern: '"0\\.11\\.1"\\n(dependencies)', replace: '"{major}.{minor}.{patch}"\n$1' },
    ];
    for (const options of patterns) {
      const fromLf = write(lf, options, { marketing: "0.11.2" });
      expect(write(crlf, options, { marketing: "0.11.2" })).toBe(fromLf.replaceAll("\n", "\r\n"));
    }
  });

  it("0 matches in a file with \\r says what line endings it has", () => {
    expectStampError(
      () => write(crlf, { pattern: "nope", replace: "x" }, { marketing: "1.0.0" }),
      F,
      "matched 0 times",
      "CRLF (\\r\\n) line endings",
      "line endings aren't the cause",
    );
    expectStampError(
      () => write(crlf, { pattern: "nope\\r\\n", replace: "x" }, { marketing: "1.0.0" }),
      F,
      "matched 0 times",
      "the pattern mentions \\r, so it was matched against the file as is",
    );
    expectStampError(
      () => write("a=1\rb=2\r", { pattern: "a=1\\nb", replace: "x" }, { marketing: "1.0.0" }),
      F,
      "matched 0 times",
      "aren't followed by \\n (old Mac line endings)",
    );
    expectStampError(
      () => write(lf, { ...cargo, pattern: 'attica-core"\\r\\n' }, { marketing: "1.0.0" }),
      F,
      "matched 0 times",
      "The pattern mentions \\r, but the file has none",
    );
    // No hint for an LF file and a pattern without \r.
    let message = "";
    try {
      write(lf, { pattern: "nope", replace: "x" }, { marketing: "1.0.0" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/check the pattern against the file$/);
  });

  it("several matches in the LF view is still an error", () => {
    expectStampError(
      () =>
        write(crlf, { pattern: 'version = "0\\.11\\.1"\\n', replace: "x" }, { marketing: "1.0.0" }),
      F,
      "matched 2 times",
    );
  });
});

describe("mentionsCarriageReturn", () => {
  it.each([
    ["\\r?\\n", true],
    ["\\r\\n", true],
    ["[^\\r]", true],
    ["\\x0d", true],
    ["\\x0D", true],
    ["\\u000d", true],
    ["\\u{d}", true],
    ["\\cM", true],
    ["a\rb", true],
    ["\\n", false],
    ["\\\\r", false],
    ["\\s+", false],
    ["r", false],
  ])("%j → %s", (pattern, expected) => {
    expect(mentionsCarriageReturn(pattern)).toBe(expected);
  });
});

describe("expandReplacement matches String.prototype.replace", () => {
  const text = "pre-ab12cd-post";
  const re = "(?<x>a)(b)(1)(2)?(c)(d)(z)?(e)?(f)?(g)?(h)?";
  const templates = [
    "$1|$2|$3",
    "$$|$&|$`|$'",
    "$0|$00|$01|$05|$10|$11|$12|$13|$99",
    "$4|$7",
    "$<x>|$<nope>|$<x|$<",
    "$|$x|end$",
    "{version}$",
  ];
  it.each(templates)("%j", (template) => {
    const m = new RegExp(re, "d").exec(text) as RegExpExecArray & { indices: RegExpIndicesArray };
    const slice = (r: [number, number] | undefined) => r && text.slice(r[0], r[1]);
    const expanded = expandReplacement(template, {
      matched: m[0],
      before: text.slice(0, m.index),
      after: text.slice(m.index + m[0].length),
      captures: m.indices.slice(1).map(slice),
      named: { x: slice(m.indices.groups?.x) },
    });
    expect(text.slice(0, m.index) + expanded + text.slice(m.index + m[0].length)).toBe(
      text.replace(new RegExp(re), template),
    );
  });

  it("$<name> is literal without named groups", () => {
    const s = { matched: "a", before: "", after: "b", captures: ["a"], named: undefined };
    expect("ab".replace(/(a)/, "$<a>$1")).toBe("$<a>ab");
    expect(expandReplacement("$<a>$1", s)).toBe("$<a>a");
  });
});
