import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listNativeTargets, pbxproj } from "../../src/platforms/pbxproj.ts";
import { StampError } from "../../src/platforms/types.ts";

const fixture = (path: string): string =>
  readFileSync(join(import.meta.dirname, "../fixtures", path), "utf8");

const MULTI = "ios/multi-target.xcodeproj/project.pbxproj";
const FILE = "ios/App.xcodeproj/project.pbxproj";

function stampError(fn: () => unknown): StampError {
  try {
    fn();
  } catch (e) {
    if (e instanceof StampError) return e;
    throw e;
  }
  throw new Error("expected a StampError, nothing was thrown");
}

/** Lines that differ between two texts with the same number of lines. */
function changedLines(before: string, after: string): { before: string; after: string }[] {
  const a = before.split("\n");
  const b = after.split("\n");
  expect(b.length).toBe(a.length);
  return a.flatMap((line, i) => (line === b[i] ? [] : [{ before: line, after: b[i] as string }]));
}

/** Every changed line is a `KEY = value;` line, and only the value (inside the same quotes) changed. */
function expectOnlyValuesChanged(before: string, after: string, expectedCount: number): void {
  const changes = changedLines(before, after);
  expect(changes).toHaveLength(expectedCount);
  const re = /^(\t+(?:MARKETING_VERSION|CURRENT_PROJECT_VERSION) = )("?)([^";]*)\2;(\r?)$/;
  for (const c of changes) {
    const b = re.exec(c.before);
    const a = re.exec(c.after);
    expect(b, c.before).not.toBeNull();
    expect(a, c.after).not.toBeNull();
    expect(a?.[1]).toBe(b?.[1]);
    expect(a?.[2]).toBe(b?.[2]);
    expect(a?.[4]).toBe(b?.[4]);
    expect(a?.[3]).not.toBe(b?.[3]);
  }
}

/** Apply `fn` to the `XCBuildConfiguration` block with the given ID. */
function editBlock(text: string, id: string, fn: (block: string) => string): string {
  const start = text.indexOf(`\t\t${id} /* `);
  const end = text.indexOf("\n\t\t};\n", start) + "\n\t\t};\n".length;
  expect(start).toBeGreaterThan(0);
  return text.slice(0, start) + fn(text.slice(start, end)) + text.slice(end);
}

/** The multi-target fixture with the given values, built by replacing the known literals. */
function expectedMulti(text: string, marketing: string | undefined, build: number | undefined) {
  let out = text;
  if (marketing !== undefined) {
    out = out
      .replaceAll("MARKETING_VERSION = 1.4.0;", `MARKETING_VERSION = ${marketing};`)
      .replaceAll('MARKETING_VERSION = "1.4.0";', `MARKETING_VERSION = "${marketing}";`);
  }
  if (build !== undefined) {
    out = out
      .replaceAll("CURRENT_PROJECT_VERSION = 12;", `CURRENT_PROJECT_VERSION = ${build};`)
      .replaceAll('CURRENT_PROJECT_VERSION = "12";', `CURRENT_PROJECT_VERSION = "${build}";`);
  }
  return out;
}

describe("pbxproj read", () => {
  const text = fixture(MULTI);

  it("defaults to every native target that has version settings (skips AppTests and the project level)", () => {
    const found = pbxproj.read(text, FILE, {});
    expect(found.map((f) => `${f.field} ${f.key} ${f.value}`)).toEqual([
      "marketing MARKETING_VERSION (App, Debug) 1.4.0",
      "build CURRENT_PROJECT_VERSION (App, Debug) 12",
      "marketing MARKETING_VERSION (App, Release) 1.4.0",
      "build CURRENT_PROJECT_VERSION (App, Release) 12",
      "marketing MARKETING_VERSION (ShareExtension, Debug) 1.4.0",
      "build CURRENT_PROJECT_VERSION (ShareExtension, Debug) 12",
      "marketing MARKETING_VERSION (ShareExtension, Release) 1.4.0",
      "build CURRENT_PROJECT_VERSION (ShareExtension, Release) 12",
      "marketing MARKETING_VERSION (Widget, Debug) 1.4.0",
      "build CURRENT_PROJECT_VERSION (Widget, Debug) 12",
      "marketing MARKETING_VERSION (Widget, Release) 1.4.0",
      "build CURRENT_PROJECT_VERSION (Widget, Release) 12",
    ]);
  });

  it("reports the 1-based line of each value, without quotes", () => {
    const lines = text.split("\n");
    for (const f of pbxproj.read(text, FILE, {})) {
      const name = f.field === "marketing" ? "MARKETING_VERSION" : "CURRENT_PROJECT_VERSION";
      expect(lines[f.line - 1]).toMatch(new RegExp(`^\\t+${name} = "?${f.value}"?;$`));
    }
  });

  it("limits to the given targets", () => {
    const found = pbxproj.read(text, FILE, { targets: ["Widget"] });
    expect(found.map((f) => f.key)).toEqual([
      "MARKETING_VERSION (Widget, Debug)",
      "CURRENT_PROJECT_VERSION (Widget, Debug)",
      "MARKETING_VERSION (Widget, Release)",
      "CURRENT_PROJECT_VERSION (Widget, Release)",
    ]);
  });

  it("returns a build-setting reference as written", () => {
    const withRef = text.replace(
      "\t\t\t\tMARKETING_VERSION = 1.4.0;\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.example.app;",
      '\t\t\t\tMARKETING_VERSION = "$(APP_VERSION)";\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.example.app;',
    );
    expect(withRef).not.toBe(text);
    const first = pbxproj.read(withRef, FILE, { targets: ["App"] })[0];
    expect(first?.value).toBe("$(APP_VERSION)");
  });

  it("works on the default Capacitor project", () => {
    const cap = fixture("capacitor/ios/App/App.xcodeproj/project.pbxproj");
    expect(pbxproj.read(cap, FILE, {}).map((f) => `${f.key} ${f.value}`)).toEqual([
      "MARKETING_VERSION (App, Debug) 1.0",
      "CURRENT_PROJECT_VERSION (App, Debug) 1",
      "MARKETING_VERSION (App, Release) 1.0",
      "CURRENT_PROJECT_VERSION (App, Release) 1",
    ]);
  });
});

describe("pbxproj write", () => {
  const text = fixture(MULTI);

  it("writes both values to every selected configuration, keeping quotes", () => {
    const out = pbxproj.write(text, FILE, { marketing: "1.5.0", build: 345 }, {});
    expect(out).toBe(expectedMulti(text, "1.5.0", 345));
    expectOnlyValuesChanged(text, out, 12);
    expect(out).toContain('MARKETING_VERSION = "1.5.0";');
    expect(out).toContain('CURRENT_PROJECT_VERSION = "345";');
    expect(out).toContain("MARKETING_VERSION = 1.5.0;");
    expect(out).toContain("CURRENT_PROJECT_VERSION = 345;");
  });

  it("leaves the project-level configurations and AppTests alone", () => {
    const out = pbxproj.write(text, FILE, { marketing: "1.5.0", build: 345 }, {});
    // Project-level configs still carry CURRENT_PROJECT_VERSION = 1.
    expect(out.match(/CURRENT_PROJECT_VERSION = 1;/g)).toHaveLength(2);
    expect(out).toContain("PRODUCT_BUNDLE_IDENTIFIER = com.example.app.AppTests;");
  });

  it("writes only the marketing version when no build number is given (release PR)", () => {
    const out = pbxproj.write(text, FILE, { marketing: "1.5.0" }, {});
    expect(out).toBe(expectedMulti(text, "1.5.0", undefined));
    expectOnlyValuesChanged(text, out, 6);
  });

  it("writes only the build number when no marketing version is given (stamp)", () => {
    const out = pbxproj.write(text, FILE, { build: 345 }, {});
    expect(out).toBe(expectedMulti(text, undefined, 345));
    expectOnlyValuesChanged(text, out, 6);
  });

  it("returns the input unchanged when there is nothing to write", () => {
    expect(pbxproj.write(text, FILE, {}, {})).toBe(text);
  });

  it("limits to the given targets", () => {
    const out = pbxproj.write(
      text,
      FILE,
      { marketing: "1.5.0", build: 7 },
      { targets: ["App", "Widget"] },
    );
    expectOnlyValuesChanged(text, out, 8);
    expect(out).toContain(
      'MARKETING_VERSION = "1.4.0";\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.example.app.ShareExtension;',
    );
    expect(out.match(/MARKETING_VERSION = "?1\.5\.0"?;/g)).toHaveLength(4);
  });

  it("keeps CRLF line endings", () => {
    const crlf = text.replaceAll("\n", "\r\n");
    const out = pbxproj.write(crlf, FILE, { marketing: "1.5.0", build: 345 }, {});
    expect(out).toBe(expectedMulti(text, "1.5.0", 345).replaceAll("\n", "\r\n"));
  });

  it("stamps a shared configuration list once", () => {
    // Widget now uses ShareExtension's configuration list.
    const shared = text.replace(
      'buildConfigurationList = 4A7C1E2B2D9F3A5600B1C023 /* Build configuration list for PBXNativeTarget "Widget" */;',
      'buildConfigurationList = 4A7C1E2B2D9F3A5600B1C022 /* Build configuration list for PBXNativeTarget "ShareExtension" */;',
    );
    expect(shared).not.toBe(text);
    const found = pbxproj.read(shared, FILE, {}).filter((f) => f.field === "marketing");
    expect(found.map((f) => f.key)).toEqual([
      "MARKETING_VERSION (App, Debug)",
      "MARKETING_VERSION (App, Release)",
      "MARKETING_VERSION (ShareExtension, Debug)",
      "MARKETING_VERSION (ShareExtension, Release)",
    ]);
    const out = pbxproj.write(shared, FILE, { marketing: "1.5.0", build: 9 }, {});
    expectOnlyValuesChanged(shared, out, 8);
  });

  it("tolerates comments, escapes and one-line dictionaries", () => {
    const mini = [
      "// !$*UTF8*$!",
      "{",
      "\tobjects = {",
      '\t\tAAA /* My App */ = { isa = PBXNativeTarget; buildConfigurationList = BBB; name = "My \\"Best\\" App"; productType = "com.apple.product-type.application"; };',
      "\t\tBBB = { isa = XCConfigurationList; buildConfigurations = ( CCC /* Release */, ); };",
      "\t\tCCC /* Release */ = {",
      "\t\t\tisa = XCBuildConfiguration;",
      "\t\t\tbuildSettings = {",
      "\t\t\t\t/* MARKETING_VERSION = 9.9.9; */",
      "\t\t\t\tMARKETING_VERSION = 1.0.0; // CURRENT_PROJECT_VERSION = 99;",
      "\t\t\t\tCURRENT_PROJECT_VERSION = 3;",
      "\t\t\t};",
      "\t\t\tname = Release;",
      "\t\t};",
      "\t};",
      "\trootObject = ZZZ;",
      "}",
      "",
    ].join("\n");
    const out = pbxproj.write(mini, FILE, { marketing: "2.0.0", build: 4 }, {});
    expect(out).toBe(
      mini
        .replace("\tMARKETING_VERSION = 1.0.0;", "\tMARKETING_VERSION = 2.0.0;")
        .replace("\tCURRENT_PROJECT_VERSION = 3;", "\tCURRENT_PROJECT_VERSION = 4;"),
    );
    expect(pbxproj.read(mini, FILE, { targets: ['My "Best" App'] })).toHaveLength(2);
  });

  it("stamps a bare React Native project's app target and skips its test target", () => {
    const rn = fixture("react-native/ios/MyApp.xcodeproj/project.pbxproj");
    const out = pbxproj.write(rn, FILE, { marketing: "2.1.0", build: 55 }, {});
    expectOnlyValuesChanged(rn, out, 4);
    expect(out.match(/MARKETING_VERSION = 2\.1\.0;/g)).toHaveLength(2);
    expect(out.match(/CURRENT_PROJECT_VERSION = 55;/g)).toHaveLength(2);
  });

  it("stamps the Capacitor project exactly", () => {
    const cap = fixture("capacitor/apps/mobile/ios/App/App.xcodeproj/project.pbxproj");
    const out = pbxproj.write(cap, FILE, { marketing: "1.5.0", build: 345 }, {});
    expect(out).toBe(
      cap
        .replaceAll("MARKETING_VERSION = 1.0;", "MARKETING_VERSION = 1.5.0;")
        .replaceAll("CURRENT_PROJECT_VERSION = 1;", "CURRENT_PROJECT_VERSION = 345;"),
    );
    expectOnlyValuesChanged(cap, out, 4);
  });
});

describe("pbxproj project-level inheritance", () => {
  const base = fixture(MULTI);
  // Widget sets neither value in either configuration; the project-level configurations carry
  // MARKETING_VERSION (and the CURRENT_PROJECT_VERSION they already had).
  let inherited = base;
  for (const id of ["4A7C1E2B2D9F3A5600B1C037", "4A7C1E2B2D9F3A5600B1C038"]) {
    inherited = editBlock(inherited, id, (b) =>
      b.replace(/\t+(MARKETING_VERSION|CURRENT_PROJECT_VERSION) = .*\n/g, ""),
    );
  }
  for (const id of ["4A7C1E2B2D9F3A5600B1C031", "4A7C1E2B2D9F3A5600B1C032"]) {
    inherited = editBlock(inherited, id, (b) =>
      b.replace(
        "\t\t\t\tCURRENT_PROJECT_VERSION = 1;\n",
        "\t\t\t\tCURRENT_PROJECT_VERSION = 1;\n\t\t\t\tMARKETING_VERSION = 1.0.0;\n",
      ),
    );
  }

  it("reads the project-level value for a target that inherits it", () => {
    const found = pbxproj.read(inherited, FILE, { targets: ["Widget"] });
    expect(found.map((f) => `${f.key} ${f.value}`)).toEqual([
      "MARKETING_VERSION (project level, Debug) 1.0.0",
      "CURRENT_PROJECT_VERSION (project level, Debug) 1",
      "MARKETING_VERSION (project level, Release) 1.0.0",
      "CURRENT_PROJECT_VERSION (project level, Release) 1",
    ]);
  });

  it("stamps the project-level configurations too, so an inheriting target doesn't stay stale", () => {
    const out = pbxproj.write(inherited, FILE, { marketing: "1.5.0", build: 345 }, {});
    // App (4 lines) + ShareExtension (4 lines) + project level (2 configurations x 2 values).
    expectOnlyValuesChanged(inherited, out, 12);
    const lines = out.split("\n");
    expect(lines.filter((l) => l === "\t\t\t\tMARKETING_VERSION = 1.5.0;")).toHaveLength(4);
    expect(lines.filter((l) => l === "\t\t\t\tCURRENT_PROJECT_VERSION = 345;")).toHaveLength(4);
    // Widget's own configurations stay as they were.
    expect(out).toContain(
      "INFOPLIST_KEY_CFBundleDisplayName = Widget;\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER",
    );
  });

  it("stamps a configuration that several inheriting targets share only once", () => {
    // ShareExtension also inherits now.
    let both = inherited;
    for (const id of ["4A7C1E2B2D9F3A5600B1C035", "4A7C1E2B2D9F3A5600B1C036"]) {
      both = editBlock(both, id, (b) =>
        b.replace(/\t+(MARKETING_VERSION|CURRENT_PROJECT_VERSION) = .*\n/g, ""),
      );
    }
    const out = pbxproj.write(both, FILE, { marketing: "1.5.0", build: 345 }, {});
    expectOnlyValuesChanged(both, out, 8);
  });

  it("stamps only the project level when no target sets anything itself (test bundles don't count)", () => {
    let projectOnly = inherited;
    for (const id of [
      "4A7C1E2B2D9F3A5600B1C033",
      "4A7C1E2B2D9F3A5600B1C034",
      "4A7C1E2B2D9F3A5600B1C035",
      "4A7C1E2B2D9F3A5600B1C036",
    ]) {
      projectOnly = editBlock(projectOnly, id, (b) =>
        b.replace(/\t+(MARKETING_VERSION|CURRENT_PROJECT_VERSION) = .*\n/g, ""),
      );
    }
    const out = pbxproj.write(projectOnly, FILE, { marketing: "1.5.0", build: 345 }, {});
    expectOnlyValuesChanged(projectOnly, out, 4);
    expect(pbxproj.read(projectOnly, FILE, {}).map((f) => f.key)).toEqual([
      "MARKETING_VERSION (project level, Debug)",
      "CURRENT_PROJECT_VERSION (project level, Debug)",
      "MARKETING_VERSION (project level, Release)",
      "CURRENT_PROJECT_VERSION (project level, Release)",
    ]);
  });

  it("leaves the project level alone when every target overrides the value", () => {
    const out = pbxproj.write(base, FILE, { marketing: "1.5.0", build: 345 }, {});
    expect(out.match(/CURRENT_PROJECT_VERSION = 1;/g)).toHaveLength(2);
  });

  it("stamps the project level when a named target lacks a value the project provides", () => {
    // AppTests sets nothing; the project level has CURRENT_PROJECT_VERSION = 1.
    const out = pbxproj.write(base, FILE, { build: 345 }, { targets: ["AppTests"] });
    expectOnlyValuesChanged(base, out, 2);
    expect(out.match(/CURRENT_PROJECT_VERSION = 345;/g)).toHaveLength(2);
  });
});

describe("pbxproj parsing", () => {
  it("accepts // inside unquoted strings", () => {
    const base = fixture(MULTI);
    const text = base.replace(
      "path = AppDelegate.swift;",
      "path = Sources//App/AppDelegate.swift;",
    );
    expect(text).not.toBe(base);
    expect(pbxproj.write(text, FILE, { marketing: "1.5.0" }, {})).toBe(
      text
        .replaceAll("MARKETING_VERSION = 1.4.0;", "MARKETING_VERSION = 1.5.0;")
        .replaceAll('MARKETING_VERSION = "1.4.0";', 'MARKETING_VERSION = "1.5.0";'),
    );
  });
});

describe("pbxproj errors", () => {
  const text = fixture(MULTI);

  it("rejects an unknown target and lists the available ones", () => {
    const err = stampError(() =>
      pbxproj.write(text, FILE, { marketing: "1.5.0" }, { targets: ["Watch"] }),
    );
    expect(err.file).toBe(FILE);
    expect(err.reason).toBe(
      'unknown target "Watch" in xcodeTargets. Native targets in this project: App, ShareExtension, Widget, AppTests',
    );
    expect(stampError(() => pbxproj.read(text, FILE, { targets: ["Watch"] })).reason).toContain(
      "unknown target",
    );
  });

  it("rejects a selected target that lacks a setting being written", () => {
    const err = stampError(() =>
      pbxproj.write(text, FILE, { marketing: "1.5.0" }, { targets: ["AppTests"] }),
    );
    expect(err.reason).toBe(
      `target "AppTests", configuration "Debug" doesn't set MARKETING_VERSION, and neither does the project-level configuration, so it can't be stamped. Set it in Build Settings in Xcode, or limit xcodeTargets to the targets that carry the version.`,
    );
    expect(() => pbxproj.read(text, FILE, { targets: ["AppTests"] })).toThrow(StampError);
  });

  it("rejects a default-selected target that lacks a value being written (and nothing inherits it)", () => {
    const widgetDebugMarketing = editBlock(text, "4A7C1E2B2D9F3A5600B1C037", (b) =>
      b.replace("\t\t\t\tMARKETING_VERSION = 1.4.0;\n", ""),
    );
    expect(widgetDebugMarketing).not.toBe(text);
    const err = stampError(() =>
      pbxproj.write(widgetDebugMarketing, FILE, { marketing: "1.5.0" }, {}),
    );
    expect(err.reason).toContain(
      'target "Widget", configuration "Debug" doesn\'t set MARKETING_VERSION, and neither does the project-level configuration',
    );
    // Build only is fine: every selected configuration has it.
    expect(() => pbxproj.write(widgetDebugMarketing, FILE, { build: 3 }, {})).not.toThrow();
  });

  it("refuses to overwrite a build-setting reference", () => {
    const withRef = text.replace(
      "MARKETING_VERSION = 1.4.0;\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.example.app;",
      'MARKETING_VERSION = "$(APP_VERSION)";\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.example.app;',
    );
    const err = stampError(() => pbxproj.write(withRef, FILE, { marketing: "1.5.0" }, {}));
    expect(err.reason).toBe(
      `target "App", configuration "Debug": MARKETING_VERSION is the build-setting reference $(APP_VERSION), which launchset won't overwrite. Set a literal value in the Xcode project, or use source kind "xcconfig" for the file that defines it.`,
    );
    // Not writing that field is fine.
    expect(() => pbxproj.write(withRef, FILE, { build: 5 }, {})).not.toThrow();
  });

  it("rejects a conditional assignment of a field being written, ignores the other field's", () => {
    const conditional = text.replace(
      "\t\t\t\tMARKETING_VERSION = 1.4.0;\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.example.app;",
      '\t\t\t\tMARKETING_VERSION = 1.4.0;\n\t\t\t\t"MARKETING_VERSION[sdk=iphoneos*]" = 2.0.0;\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.example.app;',
    );
    expect(conditional).not.toBe(text);
    const err = stampError(() => pbxproj.write(conditional, FILE, { marketing: "1.5.0" }, {}));
    expect(err.reason).toBe(
      `target "App", configuration "Debug": MARKETING_VERSION[sdk=iphoneos*] is a conditional setting. It overrides MARKETING_VERSION for matching builds, so those builds would ship a different value than the one launchset writes. Remove it, or manage MARKETING_VERSION by hand and don't stamp it with launchset.`,
    );
    // A build-number-only write isn't blocked by a conditional marketing version, nor is read().
    const out = pbxproj.write(conditional, FILE, { build: 9 }, {});
    expect(out).toBe(expectedMulti(conditional, undefined, 9));
    expect(() => pbxproj.read(conditional, FILE, {})).not.toThrow();
    // The reverse: a conditional build number blocks a build write but not a release-PR write.
    const conditionalBuild = text.replace(
      "\t\t\t\tCURRENT_PROJECT_VERSION = 12;\n\t\t\t\tDEVELOPMENT_TEAM = ABCDE12345;\n\t\t\t\tINFOPLIST_FILE = App/Info.plist;",
      '\t\t\t\tCURRENT_PROJECT_VERSION = 12;\n\t\t\t\t"CURRENT_PROJECT_VERSION[config=Debug]" = 1;\n\t\t\t\tDEVELOPMENT_TEAM = ABCDE12345;\n\t\t\t\tINFOPLIST_FILE = App/Info.plist;',
    );
    expect(conditionalBuild).not.toBe(text);
    expect(() => pbxproj.write(conditionalBuild, FILE, { marketing: "1.5.0" }, {})).not.toThrow();
    expect(
      stampError(() => pbxproj.write(conditionalBuild, FILE, { build: 9 }, {})).reason,
    ).toContain("CURRENT_PROJECT_VERSION[config=Debug] is a conditional setting");
  });

  it("rejects duplicate settings in a selected configuration only", () => {
    const dup = text.replace(
      "\t\t\t\tMARKETING_VERSION = 1.4.0;\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.example.app;",
      "\t\t\t\tMARKETING_VERSION = 1.4.0;\n\t\t\t\tMARKETING_VERSION = 1.3.0;\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.example.app;",
    );
    expect(stampError(() => pbxproj.write(dup, FILE, { marketing: "1.5.0" }, {})).reason).toBe(
      `target "App", configuration "Debug": MARKETING_VERSION is set 2 times, can't tell which to change`,
    );
    // The same problem in an unselected target is not our business.
    expect(() =>
      pbxproj.write(dup, FILE, { marketing: "1.5.0" }, { targets: ["Widget"] }),
    ).not.toThrow();
  });

  it("rejects a project where no target has version settings", () => {
    const stripped = text.replace(/^\t+(MARKETING_VERSION|CURRENT_PROJECT_VERSION) = .*\n/gm, "");
    const err = stampError(() => pbxproj.write(stripped, FILE, { marketing: "1.5.0" }, {}));
    expect(err.reason).toBe(
      'no native target or project-level configuration sets MARKETING_VERSION or CURRENT_PROJECT_VERSION (targets: App, ShareExtension, Widget, AppTests). Set them in the Build Settings in Xcode; if they come from an .xcconfig file, use source kind "xcconfig" for that file instead.',
    );
  });

  it("rejects a prerelease marketing version and a bad build number", () => {
    for (const marketing of ["1.5.0-pr.12.3", "1.5", "v1.5.0", ""]) {
      expect(stampError(() => pbxproj.write(text, FILE, { marketing }, {})).reason).toBe(
        `iOS marketing version must be plain X.Y.Z (Apple rejects prerelease suffixes), got "${marketing}"`,
      );
    }
    for (const build of [0, -1, 1.5, Number.NaN]) {
      expect(stampError(() => pbxproj.write(text, FILE, { build }, {})).reason).toBe(
        `build number must be a positive integer, got ${build}`,
      );
    }
  });

  it("reports files that aren't project files, with the line of a syntax error", () => {
    expect(stampError(() => pbxproj.read("{ foo = bar; }\n", FILE, {})).reason).toContain(
      "no top-level `objects`",
    );
    expect(stampError(() => pbxproj.read("<plist></plist>", FILE, {})).reason).toContain(
      "can't parse as an Xcode project file",
    );
    const broken = text.replace("isa = PBXBuildFile;", "isa PBXBuildFile;");
    const err = stampError(() => pbxproj.read(broken, FILE, {}));
    expect(err.reason).toBe(
      `can't parse as an Xcode project file (line 10): expected "=" after key "isa"`,
    );
    expect(
      stampError(() =>
        pbxproj.read(text.slice(0, text.indexOf("/* End PBXBuildFile section */")), FILE, {}),
      ).reason,
    ).toContain("unterminated");
  });
});

describe("listNativeTargets", () => {
  it("lists targets in project order with their version settings", () => {
    expect(listNativeTargets(fixture(MULTI), FILE)).toEqual([
      {
        name: "App",
        productType: "com.apple.product-type.application",
        hasVersionSettings: true,
        marketingVersions: ["1.4.0"],
        buildNumbers: ["12"],
      },
      {
        name: "ShareExtension",
        productType: "com.apple.product-type.app-extension",
        hasVersionSettings: true,
        marketingVersions: ["1.4.0"],
        buildNumbers: ["12"],
      },
      {
        name: "Widget",
        productType: "com.apple.product-type.app-extension",
        hasVersionSettings: true,
        marketingVersions: ["1.4.0"],
        buildNumbers: ["12"],
      },
      {
        name: "AppTests",
        productType: "com.apple.product-type.bundle.unit-test",
        hasVersionSettings: false,
        marketingVersions: [],
        buildNumbers: [],
      },
    ]);
  });

  it("returns every distinct value when configurations differ", () => {
    const text = fixture(MULTI).replace(
      '\t\t\t\tCURRENT_PROJECT_VERSION = 12;\n\t\t\t\tDEVELOPMENT_TEAM = ABCDE12345;\n\t\t\t\tINFOPLIST_FILE = App/Info.plist;\n\t\t\t\tLD_RUNPATH_SEARCH_PATHS = (\n\t\t\t\t\t"$(inherited)",\n\t\t\t\t\t"@executable_path/Frameworks",\n\t\t\t\t);\n\t\t\t\tMARKETING_VERSION = 1.4.0;',
      '\t\t\t\tCURRENT_PROJECT_VERSION = 13;\n\t\t\t\tDEVELOPMENT_TEAM = ABCDE12345;\n\t\t\t\tINFOPLIST_FILE = App/Info.plist;\n\t\t\t\tLD_RUNPATH_SEARCH_PATHS = (\n\t\t\t\t\t"$(inherited)",\n\t\t\t\t\t"@executable_path/Frameworks",\n\t\t\t\t);\n\t\t\t\tMARKETING_VERSION = 1.3.0;',
    );
    const app = listNativeTargets(text, FILE)[0];
    expect(app?.marketingVersions).toEqual(["1.3.0", "1.4.0"]);
    expect(app?.buildNumbers).toEqual(["13", "12"]);
  });

  it("lists the Capacitor and React Native targets", () => {
    const cap = listNativeTargets(
      fixture("capacitor/apps/mobile/ios/App/App.xcodeproj/project.pbxproj"),
      FILE,
    );
    expect(cap).toEqual([
      {
        name: "App",
        productType: "com.apple.product-type.application",
        hasVersionSettings: true,
        marketingVersions: ["1.0"],
        buildNumbers: ["1"],
      },
    ]);
    const rn = listNativeTargets(fixture("react-native/ios/MyApp.xcodeproj/project.pbxproj"), FILE);
    expect(rn.map((t) => [t.name, t.hasVersionSettings])).toEqual([
      ["MyApp", true],
      ["MyAppTests", false],
    ]);
  });
});
