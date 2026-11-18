import { describe, expect, it } from "vitest";
import { gradle } from "../../src/platforms/gradle.ts";
import {
  changedLines,
  expectStampError,
  fixture,
  lineOfText,
  replaceEach,
  replaceOnce,
} from "./stamper-test-utils.ts";

const F = "app/build.gradle";
const write = (text: string, values: { marketing?: string; build?: number }, file = F) =>
  gradle.write(text, file, values);

describe("gradle: fixtures", () => {
  it("Capacitor build.gradle: stamps versionCode and versionName only", () => {
    const text = fixture("android/capacitor-build.gradle");
    const out = write(text, { marketing: "1.4.0", build: 42 });
    expect(out).toBe(
      replaceEach(text, [
        ["versionCode 1\n", "versionCode 42\n"],
        ['versionName "1.0"', 'versionName "1.4.0"'],
      ]),
    );
    expect(changedLines(text, out)).toBe(2);
  });

  it("Capacitor build.gradle: marketing only leaves versionCode alone", () => {
    const text = fixture("android/capacitor-build.gradle");
    const out = write(text, { marketing: "2.0.0-pr.12.3" });
    expect(out).toBe(replaceOnce(text, 'versionName "1.0"', 'versionName "2.0.0-pr.12.3"'));
    expect(changedLines(text, out)).toBe(1);
  });

  it("Capacitor build.gradle: build only leaves versionName alone", () => {
    const text = fixture("android/capacitor-build.gradle");
    const out = write(text, { build: 1234 });
    expect(out).toBe(replaceOnce(text, "versionCode 1\n", "versionCode 1234\n"));
  });

  it("reads values with their lines", () => {
    const text = fixture("android/capacitor-build.gradle");
    expect(gradle.read(text, F)).toEqual([
      {
        field: "marketing",
        key: "versionName",
        value: "1.0",
        line: lineOfText(text, "versionName"),
      },
      { field: "build", key: "versionCode", value: "1", line: lineOfText(text, "versionCode 1") },
    ]);
  });

  it("bare React Native: ignores comments, strings, versionNameSuffix and other blocks", () => {
    const text = fixture("android/react-native-build.gradle");
    const out = write(text, { marketing: "1.4.0", build: 42 });
    expect(out).toBe(
      replaceEach(text, [
        ["        versionCode 1\n", "        versionCode 42\n"],
        ['versionName "0.0.1"', 'versionName "1.4.0"'],
      ]),
    );
    expect(changedLines(text, out)).toBe(2);
    expect(out).toContain('versionNameSuffix "-rc"');
    expect(out).toContain("'\"versionName is set by launchset\"'");
    expect(gradle.read(text, F).map((v) => [v.key, v.value])).toEqual([
      ["versionName", "0.0.1"],
      ["versionCode", "1"],
    ]);
  });

  it("Kotlin build.gradle.kts: assignments with =, trailing comment and versionNameSuffix kept", () => {
    const text = fixture("android/app-build.gradle.kts");
    const file = "app/build.gradle.kts";
    const out = gradle.write(text, file, { marketing: "1.5.0", build: 99 });
    expect(out).toBe(
      replaceEach(text, [
        ["versionCode = 12\n", "versionCode = 99\n"],
        ['versionName = "1.4.0" // keep', 'versionName = "1.5.0" // keep'],
      ]),
    );
    expect(changedLines(text, out)).toBe(2);
    expect(out).toContain('versionNameSuffix = "-beta"');
    expect(gradle.read(text, file)).toEqual([
      {
        field: "marketing",
        key: "versionName",
        value: "1.4.0",
        line: lineOfText(text, "versionName ="),
      },
      { field: "build", key: "versionCode", value: "12", line: lineOfText(text, "versionCode =") },
    ]);
  });

  it("CRLF file: line endings are preserved", () => {
    const text = fixture("android/crlf-build.gradle");
    expect(text).toContain("\r\n");
    const out = write(text, { marketing: "0.8.0", build: 8 });
    expect(out).toBe(
      replaceEach(text, [
        ["versionCode 7\r\n", "versionCode 8\r\n"],
        ['versionName "0.7.0"', 'versionName "0.8.0"'],
      ]),
    );
    expect(out.split("\n").every((l, i, a) => i === a.length - 1 || l.endsWith("\r"))).toBe(true);
    expect(changedLines(text, out)).toBe(2);
    expect(gradle.read(text, F).map((v) => v.value)).toEqual(["0.7.0", "7"]);
  });

  it("write with no values returns the input unchanged, even for unsupported files", () => {
    for (const name of ["capacitor-build.gradle", "flavors-build.gradle", "dynamic-build.gradle"]) {
      const text = fixture(`android/${name}`);
      expect(write(text, {})).toBe(text);
    }
  });
});

describe("gradle: syntax variants", () => {
  const wrap = (body: string) => `android {\n    defaultConfig {\n${body}\n    }\n}\n`;

  it("single quotes keep their style", () => {
    const text = wrap("        versionCode 3\n        versionName '1.0'");
    expect(write(text, { marketing: "1.1.0", build: 4 })).toBe(
      replaceEach(text, [
        ["versionCode 3", "versionCode 4"],
        ["versionName '1.0'", "versionName '1.1.0'"],
      ]),
    );
  });

  it("Groovy assignment with = and semicolons", () => {
    const text = wrap('        versionCode = 3;\n        versionName = "1.0";');
    expect(write(text, { marketing: "1.1.0", build: 4 })).toBe(
      replaceEach(text, [
        ["versionCode = 3;", "versionCode = 4;"],
        ['versionName = "1.0";', 'versionName = "1.1.0";'],
      ]),
    );
  });

  it("several statements on one line", () => {
    const text = 'android { defaultConfig { versionCode 3; versionName "1.0" } }';
    expect(write(text, { marketing: "1.1.0", build: 4 })).toBe(
      'android { defaultConfig { versionCode 4; versionName "1.1.0" } }',
    );
  });

  it("no trailing newline", () => {
    const text = 'android {\n  defaultConfig {\n    versionCode 3\n    versionName "1.0"\n  }\n}';
    expect(write(text, { marketing: "1.1.0", build: 4 })).toBe(
      'android {\n  defaultConfig {\n    versionCode 4\n    versionName "1.1.0"\n  }\n}',
    );
  });

  it("braces and comment markers inside strings and comments don't break matching", () => {
    const text = [
      "// } stray brace in a comment",
      "/* android { defaultConfig { versionCode 99 } } */",
      "android {",
      '    def label = "}{ // not a comment"',
      "    /* defaultConfig {",
      "       versionName 'comment' */",
      "    defaultConfig {",
      "        // versionCode 55",
      "        versionCode 7 // trailing } brace",
      '        versionName "1.0"',
      '        buildConfigField "String", "X", \'"}"\'',
      "    }",
      "}",
      "",
    ].join("\n");
    const out = write(text, { marketing: "1.1.0", build: 8 });
    expect(out).toBe(
      replaceEach(text, [
        ["versionCode 7 //", "versionCode 8 //"],
        ['versionName "1.0"', 'versionName "1.1.0"'],
      ]),
    );
  });

  it("string interpolation and triple quotes elsewhere are skipped", () => {
    const text = [
      "android {",
      `    def a = "\${foo("}")} {"`,
      "    def b = '''",
      "    }}}",
      "    '''",
      "    defaultConfig {",
      "        versionCode 7",
      '        versionName "1.0"',
      "    }",
      "}",
    ].join("\n");
    expect(write(text, { build: 8 })).toBe(replaceOnce(text, "versionCode 7", "versionCode 8"));
  });

  it("Kotlin nested block comments", () => {
    const text =
      "android {\n  /* a /* b */ defaultConfig { versionCode = 1 } */\n  defaultConfig {\n    versionCode = 2\n  }\n}\n";
    expect(gradle.write(text, "b.gradle.kts", { build: 3 })).toBe(
      replaceOnce(text, "versionCode = 2", "versionCode = 3"),
    );
  });

  it("underscored literals are read without the underscores", () => {
    const text = wrap('        versionCode 1_000\n        versionName "1"');
    expect(gradle.read(text, F).find((v) => v.key === "versionCode")?.value).toBe("1000");
    expect(write(text, { build: 1001 })).toContain("versionCode 1001");
  });

  it("keys inside nested blocks of defaultConfig are matched too (so a duplicate is caught)", () => {
    const text = wrap(
      '        versionCode 1\n        versionName "1.0"\n        if (x) {\n            versionCode 2\n        }',
    );
    expectStampError(
      () => write(text, { build: 3 }),
      F,
      "versionCode is set more than once",
      "lines 3 and 6",
    );
  });

  it("map entries named versionName are not assignments", () => {
    const text = wrap(
      '        versionCode 1\n        versionName "1.0"\n        manifestPlaceholders = [\n            versionName: "x"\n        ]',
    );
    expect(write(text, { marketing: "2.0.0" })).toBe(
      replaceOnce(text, 'versionName "1.0"', 'versionName "2.0.0"'),
    );
  });

  it("rejects values that aren't plain version strings", () => {
    const text = wrap('        versionCode 1\n        versionName "1.0"');
    expectStampError(
      () => write(text, { marketing: 'x"y' }),
      F,
      'can\'t write "x"y" as versionName',
    );
    expectStampError(() => write(text, { build: 1.5 }), F, "can't write 1.5 as versionCode");
  });
});

describe("gradle: errors", () => {
  it("product flavors overriding versionName/versionCode", () => {
    const text = fixture("android/flavors-build.gradle");
    expectStampError(
      () => write(text, { marketing: "1.0.0" }),
      F,
      "versionName is set inside productFlavors (line 22)",
      "product flavors that override versionName/versionCode aren't supported in v1",
      'use source kind "gradle-properties"',
    );
    expectStampError(() => gradle.read(text, F), F, "productFlavors");
  });

  it("product flavors with versionName only", () => {
    const text =
      'android {\n  defaultConfig { versionCode 1\n versionName "1" }\n  productFlavors { a { versionName "x" } }\n}\n';
    expectStampError(
      () => write(text, { build: 2 }),
      F,
      "versionName is set inside productFlavors",
    );
  });

  it("Kotlin product flavors with create()", () => {
    const text =
      'android {\n  defaultConfig { versionCode = 1\n versionName = "1" }\n  productFlavors { create("a") { versionCode = 5 } }\n}\n';
    expectStampError(
      () => gradle.write(text, "x.kts", { build: 2 }),
      "x.kts",
      "versionCode is set inside productFlavors",
    );
  });

  it("flavors that don't touch the version are fine", () => {
    const text =
      'android {\n  defaultConfig { versionCode 1\n versionName "1" }\n  productFlavors { a { applicationIdSuffix ".a" } }\n}\n';
    expect(write(text, { build: 2 })).toContain("versionCode 2");
  });

  it("versionCode that references a variable", () => {
    const text = fixture("android/dynamic-build.gradle");
    expectStampError(
      () => write(text, { build: 5 }),
      F,
      "versionCode (line 6) is not a literal value",
      "versionCode rootProject.ext.versionCode",
      'use source kind "gradle-properties"',
    );
    // a literal versionName is still fine on its own
    expect(write(text, { marketing: "2.0.0" })).toBe(
      replaceOnce(text, 'versionName "1.0"', 'versionName "2.0.0"'),
    );
  });

  it("versionName from a version catalog", () => {
    const text = fixture("android/dynamic-name-build.gradle.kts");
    expectStampError(
      () => gradle.write(text, "a.gradle.kts", { marketing: "1.0.0" }),
      "a.gradle.kts",
      "versionName (line 4) is not a literal value",
      "libs.versions.app.get()",
      "gradle-properties",
    );
  });

  it("concatenations, interpolation and escapes are not literals", () => {
    for (const expr of [
      '"1." + minor',
      "versionPrefix",
      '"$' + '{major}.0"',
      '"1\\0"',
      '"""1.0"""',
    ]) {
      const text = `android {\n  defaultConfig {\n    versionName ${expr}\n    versionCode 1\n  }\n}\n`;
      expectStampError(() => write(text, { marketing: "2.0.0" }), F, "is not a literal value");
    }
    const text =
      'android {\n  defaultConfig {\n    versionCode 1 + offset\n    versionName "1"\n  }\n}\n';
    expectStampError(
      () => write(text, { build: 2 }),
      F,
      "versionCode (line 3) is not a literal value",
      "1 + offset",
    );
    const paren = 'android {\n  defaultConfig {\n    versionCode(1)\n    versionName "1"\n  }\n}\n';
    expectStampError(
      () => write(paren, { build: 2 }),
      F,
      "uses the method-call form `versionCode(1)`, which isn't supported",
    );
  });

  it("key missing in defaultConfig", () => {
    const text =
      'android {\n  defaultConfig {\n    versionName "1"\n    applicationId "x"\n  }\n}\n';
    expectStampError(() => write(text, { build: 2 }), F, "versionCode not found in defaultConfig");
    // reading: the build number is optional, the marketing version is not
    expect(gradle.read(text, F)).toEqual([
      { field: "marketing", key: "versionName", value: "1", line: 3 },
    ]);
    expectStampError(
      () => gradle.read("android {\n  defaultConfig {\n    versionCode 1\n  }\n}\n", F),
      F,
      "versionName not found in defaultConfig",
    );
    // marketing-only write doesn't need versionCode
    expect(write(text, { marketing: "2" })).toContain('versionName "2"');
  });

  it("versionNameSuffix never matches versionName", () => {
    const text =
      'android {\n  defaultConfig {\n    versionCode 1\n    versionNameSuffix "-x"\n  }\n}\n';
    expectStampError(
      () => write(text, { marketing: "2.0.0" }),
      F,
      "versionName not found in defaultConfig",
    );
  });

  it("key set twice in defaultConfig", () => {
    const text =
      'android {\n  defaultConfig {\n    versionCode 1\n    versionName "1"\n    versionName "2"\n  }\n}\n';
    expectStampError(
      () => write(text, { marketing: "3" }),
      F,
      "versionName is set more than once",
      "lines 4 and 5",
    );
  });

  it("no android block / no defaultConfig / more than one", () => {
    expectStampError(
      () => write("plugins { id 'x' }\n", { build: 1 }),
      F,
      "no `android { … }` block",
    );
    expectStampError(
      () => write("android {\n  namespace 'x'\n}\n", { build: 1 }),
      F,
      "no `defaultConfig { … }` block",
    );
    expectStampError(
      () =>
        write(
          "android {\n  defaultConfig { versionCode 1 }\n  defaultConfig { versionCode 2 }\n}\n",
          { build: 3 },
        ),
      F,
      "more than one `defaultConfig",
    );
  });

  it("versionCode outside defaultConfig doesn't count", () => {
    const text =
      'android {\n  defaultConfig {\n    applicationId "x"\n  }\n  buildTypes { release { versionCode 5 } }\n}\nversionCode 9\n';
    expectStampError(() => write(text, { build: 2 }), F, "versionCode not found in defaultConfig");
  });

  it("unbalanced braces and unterminated strings", () => {
    expectStampError(
      () => write("android {\n  defaultConfig {\n", { build: 2 }),
      F,
      'unclosed "{" at line 2',
    );
    expectStampError(() => write("android {\n}\n}\n", { build: 2 }), F, 'unbalanced "}" at line 3');
    expectStampError(
      () => write('android {\n  x = "abc\n}\n', { build: 2 }),
      F,
      "unterminated string starting at line 2",
    );
    expectStampError(
      () => write("android {\n/* open\n}\n", { build: 2 }),
      F,
      "unterminated comment starting at line 2",
    );
  });
});

describe("gradle: overrides outside the direct productFlavors block and dotted assignments", () => {
  const base = (extra: string, inside = "") =>
    `android {\n  defaultConfig {\n    versionCode 1\n    versionName "1.0"\n  }\n${inside}}\n${extra}`;

  it.each([
    ['productFlavors.create("free") { versionName = "9" }', "versionName"],
    ['productFlavors.register("free") { versionCode = 9 }', "versionCode"],
    ['productFlavors.all { versionName "9" }', "versionName"],
    ["productFlavors.free.versionCode = 3", "versionCode"],
    ['productFlavors.getByName("free").versionName = "3"', "versionName"],
  ])("inside android: %s", (stmt, key) => {
    const text = base("", `  ${stmt}\n`);
    expectStampError(
      () => gradle.write(text, "a.gradle.kts", { build: 2, marketing: "2.0.0" }),
      "a.gradle.kts",
      `${key} is set inside productFlavors`,
      'use source kind "gradle-properties"',
    );
  });

  it("top-level android.productFlavors { … }", () => {
    const text = base("android.productFlavors {\n  free { versionCode 3 }\n}\n");
    expectStampError(
      () => write(text, { build: 2 }),
      F,
      "versionCode is set inside productFlavors (line 8)",
    );
  });

  it("Allman-style productFlavors block", () => {
    const text = base("", '  productFlavors\n  {\n    paid { versionName "x" }\n  }\n');
    expectStampError(
      () => write(text, { marketing: "2.0.0" }),
      F,
      "versionName is set inside productFlavors (line 8)",
    );
  });

  it("dotted assignment through defaultConfig inside android", () => {
    const text = base("", '  defaultConfig.versionName = "7.0"\n');
    expectStampError(
      () => write(text, { build: 2 }),
      F,
      "versionName is assigned through a dotted path (`defaultConfig.versionName =`, line 6)",
      "gradle-properties",
    );
  });

  it("top-level android.defaultConfig.versionCode = 99", () => {
    const text = base("android.defaultConfig.versionCode = 99\n");
    expectStampError(
      () => write(text, { marketing: "2.0.0" }),
      F,
      "versionCode is assigned through a dotted path",
      "line 7",
    );
  });

  it("variant overrides through mergedFlavor", () => {
    const text = base("", "  applicationVariants.all { v -> v.mergedFlavor.versionCode(5) }\n");
    expectStampError(
      () => write(text, { build: 2 }),
      F,
      "versionCode is assigned through a dotted path",
    );
  });

  it("reads and mentions of the same words are fine", () => {
    const text = base(
      "",
      '  // productFlavors.create("x") { versionName "9" }\n  def n = "defaultConfig.versionName = 1"\n  println defaultConfig.versionName\n  productFlavors { free { applicationIdSuffix ".free" } }\n',
    );
    expect(write(text, { marketing: "2.0.0" })).toBe(
      replaceOnce(text, 'versionName "1.0"', 'versionName "2.0.0"'),
    );
  });
});

describe("gradle: more syntax edge cases", () => {
  it("Kotlin raw strings: a backslash is not an escape", () => {
    const text =
      'val p = """C:\\"""\nval q = """a } b"""\nandroid {\n  defaultConfig {\n    versionCode = 1\n    versionName = "1.0"\n  }\n}\n';
    expect(gradle.write(text, "b.gradle.kts", { build: 2 })).toBe(
      replaceOnce(text, "versionCode = 1", "versionCode = 2"),
    );
  });

  it("Groovy triple-quoted strings still honour backslash escapes", () => {
    const text =
      "def p = '''a \\''' } b'''\nandroid {\n  defaultConfig {\n    versionCode 1\n    versionName \"1.0\"\n  }\n}\n";
    expect(write(text, { build: 2 })).toBe(replaceOnce(text, "versionCode 1", "versionCode 2"));
  });

  it("method-call form of versionName is called out", () => {
    const text =
      'android {\n  defaultConfig {\n    versionCode 1\n    versionName("1.0")\n  }\n}\n';
    expectStampError(
      () => write(text, { marketing: "2.0.0" }),
      F,
      'uses the method-call form `versionName("1.0")`, which isn\'t supported',
      "gradle-properties",
    );
  });

  it("reading: a non-literal versionCode is skipped, a non-literal versionName is an error", () => {
    const code = fixture("android/dynamic-build.gradle");
    expect(gradle.read(code, F)).toEqual([
      { field: "marketing", key: "versionName", value: "1.0", line: 7 },
    ]);
    expectStampError(
      () => gradle.read(fixture("android/dynamic-name-build.gradle.kts"), "a.gradle.kts"),
      "a.gradle.kts",
      "versionName (line 4) is not a literal value",
    );
  });

  it("build numbers must be positive", () => {
    const text = 'android {\n  defaultConfig {\n    versionCode 1\n    versionName "1"\n  }\n}\n';
    expectStampError(
      () => write(text, { build: 0 }),
      F,
      "can't write 0 as versionCode: not a positive integer",
    );
  });
});
