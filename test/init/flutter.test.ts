import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  flutterBuildFlagNotes,
  gradleWiringNotes,
  insertPubspecVersion,
  isFlutterAppPubspec,
  plistWiringNotes,
  runnerBuildSettings,
} from "../../src/init/flutter.ts";
import { type InitDetectJson, runInit } from "../../src/init/index.ts";
import { commandKinds } from "../../src/init/machinery.ts";
import { collect, fixture, fixtureRepo, options, read, repoFrom, status } from "./helpers.ts";

async function detectJson(dir: string): Promise<InitDetectJson> {
  const out = collect();
  const result = await runInit(options(dir, { detect: true, json: true, output: out }));
  return result.detect as InitDetectJson;
}

function decision(json: InitDetectJson, id: string) {
  const found = json.decisions.find((d) => d.id === id);
  if (!found) throw new Error(`no decision ${id}: ${json.decisions.map((d) => d.id).join(", ")}`);
  return found;
}

const APP_PUBSPEC = fixture("flutter-only", "pubspec.yaml");
const APP_GRADLE = fixture("flutter-only", "android/app/build.gradle.kts");
const APP_PLIST = fixture("flutter-only", "ios/Runner/Info.plist");

/** A Flutter app's files under `dir`, with overrides. */
function app(dir: string, overrides: Record<string, string> = {}): Record<string, string> {
  const prefix = dir === "." ? "" : `${dir}/`;
  return {
    [`${prefix}pubspec.yaml`]: APP_PUBSPEC,
    [`${prefix}android/app/build.gradle.kts`]: APP_GRADLE,
    [`${prefix}ios/Runner/Info.plist`]: APP_PLIST,
    [`${prefix}lib/main.dart`]: "void main() {}\n",
    ...Object.fromEntries(Object.entries(overrides).map(([p, t]) => [`${prefix}${p}`, t])),
  };
}

describe("init --detect: a repo with only a Flutter app", () => {
  it("proposes android and ios targets that stamp pubspec.yaml, and pubspec.yaml as version file", async () => {
    const dir = fixtureRepo("flutter-only");
    const json = await detectJson(dir);
    expect(status(dir)).toEqual([]);
    const d = json.detection;
    expect(d.flutterApps).toEqual(["."]);
    expect(d.canonical.version).toBe("1.4.0");
    expect(
      d.targets.map((t) => [
        t.name,
        t.type,
        t.source,
        t.proposed,
        t.marketingVersion,
        t.buildNumber,
      ]),
    ).toEqual([
      ["android", "android", { kind: "flutter", dir: "." }, "auto", "1.4.0", 12],
      ["ios", "ios", { kind: "flutter", dir: "." }, "manual", "1.4.0", 12],
      ["web", "web", undefined, "none", undefined, undefined],
    ]);
    // `flutter build appbundle` in a workflow makes android auto.
    expect(d.targets[0]?.builtBy).toEqual([
      { path: ".github/workflows/android.yml", line: 16, note: "runs flutter build for Android" },
    ]);
    expect(decision(json, "version.file")).toMatchObject({
      default: "pubspec.yaml",
      ask: false,
      options: [{ value: "pubspec.yaml" }, { value: "package.json" }],
    });
    expect(decision(json, "version").ask).toBe(false);
  });

  it("finds the scripts and steps that write the pubspec version, and notes the rest", async () => {
    const d = (await detectJson(fixtureRepo("flutter-only"))).detection;
    expect(d.machinery.map((m) => [m.path, m.line, m.kinds])).toEqual([
      [".github/workflows/android.yml", 15, ["version-writer"]],
      ["ios/fastlane/Fastfile", 5, ["version-writer"]],
      ["tool/bump_version.dart", 6, ["version-writer"]],
    ]);
    const notes = d.notes.map((n) => `${n.level} ${n.path}:${n.line ?? ""} ${n.message}`);
    expect(notes).toContainEqual(
      expect.stringMatching(/^info pubspec\.yaml: Flutter app: launchset stamps/),
    );
    expect(notes).toContainEqual(
      expect.stringMatching(
        /^info \.github\/workflows\/android\.yml:16 this flutter build passes its own --build-number/,
      ),
    );
    expect(notes).toContainEqual(
      expect.stringMatching(/^info codemagic\.yaml: Codemagic builds this repo/),
    );
    expect(notes).toContainEqual(
      expect.stringMatching(/^info web: The Flutter app also has web\. A web build/),
    );
    // A project made by flutter create is wired to Flutter's numbers: no warnings.
    expect(d.notes.filter((n) => n.level === "warning")).toEqual([]);
  });
});

describe("init --yes: a repo with only a Flutter app", () => {
  it("writes pubspec.yaml as version file, keeps +N, creates no package.json and Flutter build steps", async () => {
    const dir = fixtureRepo("flutter-only");
    await runInit(options(dir, { yes: true, decide: { version: "1.5.0" } }));
    expect(existsSync(join(dir, "package.json"))).toBe(false);
    expect(read(dir, "pubspec.yaml")).toBe(
      APP_PUBSPEC.replace("version: 1.4.0+12", "version: 1.5.0+12"),
    );
    const config = read(dir, "launchset.config.ts");
    expect(config).toContain('version: { file: "pubspec.yaml" },');
    expect(config).toContain('source: { kind: "flutter", dir: "." },');
    expect(config).toContain("// Stamps the version in pubspec.yaml; Flutter passes it to Gradle.");
    const release = read(dir, ".github/workflows/launchset-release.yml");
    expect(release).toContain("flutter build appbundle --release --build-name");
    expect(release).toContain("flutter build ipa --release");
    // The step that wrote the version is gone; the build step stays.
    const old = read(dir, ".github/workflows/android.yml");
    expect(old).not.toContain("sed -i");
    expect(old).toContain("flutter build appbundle");
    expect(read(dir, "ios/fastlane/Fastfile")).toContain("# launchset: disabled");
  });
});

describe("init: a Flutter app in a monorepo next to an API and a web app", () => {
  it("finds the app outside the pnpm workspace, and skips packages, plugins and their examples", async () => {
    const json = await detectJson(fixtureRepo("flutter-monorepo"));
    const d = json.detection;
    expect(d.flutterApps).toEqual(["apps/mobile"]);
    expect(d.targets.map((t) => [t.name, t.type, t.source, t.proposed])).toEqual([
      ["api", "docker", undefined, "auto"],
      ["android", "android", { kind: "flutter", dir: "apps/mobile" }, "manual"],
      ["ios", "ios", { kind: "flutter", dir: "apps/mobile" }, "auto"],
      ["web", "web", undefined, "none"],
    ]);
    expect(
      d.versions.filter((v) => v.source !== "tag").map((v) => [v.path, v.key, v.value]),
    ).toEqual([
      ["package.json", "version", "1.4.0"],
      ["apps/mobile/pubspec.yaml", "version", "1.3.0"],
    ]);
    // package.json holds the version: no version.file decision.
    expect(json.decisions.some((x) => x.id === "version.file")).toBe(false);
    expect(d.machinery.map((m) => [m.path, m.line, m.kinds])).toEqual([
      [".github/workflows/mobile.yml", 9, ["release-tool"]],
    ]);
  });

  it("aligns the app's pubspec.yaml to the root version and keeps package.json as version file", async () => {
    const dir = fixtureRepo("flutter-monorepo");
    await runInit(options(dir, { yes: true }));
    expect(read(dir, "apps/mobile/pubspec.yaml")).toContain("\nversion: 1.4.0+5\n");
    expect(read(dir, "package.json")).toContain('"version": "1.4.0"');
    const config = read(dir, "launchset.config.ts");
    expect(config).not.toContain("version: {");
    expect(config).toContain('source: { kind: "flutter", dir: "apps/mobile" },');
    expect(read(dir, ".github/workflows/launchset-release.yml")).toContain(
      "#   working-directory: apps/mobile",
    );
  });
});

describe("init: Flutter edge cases", () => {
  it("warns when the native projects don't read Flutter's numbers", async () => {
    const dir = repoFrom(
      app(".", {
        "android/app/build.gradle.kts": APP_GRADLE.replace(
          "versionCode = flutter.versionCode",
          "versionCode = 42",
        ),
        "ios/Runner/Info.plist": APP_PLIST.replace(
          "$(FLUTTER_BUILD_NUMBER)",
          "$(CURRENT_PROJECT_VERSION)",
        ),
      }),
    );
    const warnings = (await detectJson(dir)).detection.notes.filter((n) => n.level === "warning");
    expect(warnings.map((n) => [n.path, n.line])).toEqual([
      ["android/app/build.gradle.kts", 22],
      ["ios/Runner/Info.plist", 24],
    ]);
    expect(warnings[0]?.message).toMatch(/^versionCode is 42, not flutter\.versionCode/);
    expect(warnings[1]?.message).toMatch(
      /^CFBundleVersion is \$\(CURRENT_PROJECT_VERSION\), not \$\(FLUTTER_BUILD_NUMBER\)/,
    );
  });

  it("asks which pubspec.yaml holds the version when there are several apps", async () => {
    const dir = repoFrom({ ...app("apps/driver"), ...app("apps/rider") });
    const json = await detectJson(dir);
    expect(decision(json, "version.file")).toMatchObject({
      default: "apps/driver/pubspec.yaml",
      ask: true,
      options: [
        { value: "apps/driver/pubspec.yaml" },
        { value: "apps/rider/pubspec.yaml" },
        { value: "package.json" },
      ],
    });
    expect(json.detection.targets.map((t) => t.name)).toEqual([
      "driver-android",
      "driver-ios",
      "rider-android",
      "rider-ios",
      "web",
    ]);
  });

  it("adds a version to a pubspec.yaml that has none", async () => {
    const pubspec = APP_PUBSPEC.replace("version: 1.4.0+12\n", "");
    const dir = repoFrom(app(".", { "pubspec.yaml": pubspec }), { tags: ["v2.0.0"] });
    const json = await detectJson(dir);
    expect(json.detection.notes).toContainEqual(
      expect.objectContaining({
        level: "info",
        path: "pubspec.yaml",
        message: expect.stringContaining("no top-level version"),
      }),
    );
    await runInit(options(dir, { yes: true }));
    expect(read(dir, "pubspec.yaml")).toBe(
      pubspec.replace(
        'description: "The Acme app."\n',
        'description: "The Acme app."\nversion: 2.0.0+1\n',
      ),
    );
  });

  it("gives a flutter build to the app whose folder it runs in", async () => {
    const workflow = (dir: string) =>
      [
        "name: Build",
        "on: push",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v6",
        "      - run: flutter build appbundle",
        ...(dir ? [`        working-directory: ${dir}`] : []),
        "",
      ].join("\n");
    const apps = { ...app("apps/driver"), ...app("apps/rider") };
    const proposed = (json: InitDetectJson) =>
      Object.fromEntries(
        json.detection.targets.filter((t) => t.type === "android").map((t) => [t.dir, t.proposed]),
      );

    const one = await detectJson(
      repoFrom({ ...apps, ".github/workflows/build.yml": workflow("apps/driver") }),
    );
    expect(proposed(one)).toEqual({ "apps/driver": "auto", "apps/rider": "manual" });

    const unclear = await detectJson(
      repoFrom({ ...apps, ".github/workflows/build.yml": workflow("") }),
    );
    expect(proposed(unclear)).toEqual({ "apps/driver": "manual", "apps/rider": "manual" });
    expect(unclear.detection.notes.map((n) => n.message)).toContainEqual(
      expect.stringContaining("can't tell for which of the android apps (apps/driver, apps/rider)"),
    );
  });

  it("takes the version of a web-only Flutter app, which no android or ios target carries", async () => {
    const pubspec = APP_PUBSPEC.replace("1.4.0+12", "3.2.1+42");
    const dir = repoFrom({
      "pubspec.yaml": pubspec,
      "web/index.html": "<!doctype html>\n",
      "lib/main.dart": "void main() {}\n",
    });
    const json = await detectJson(dir);
    expect(json.detection.canonical.version).toBe("3.2.1");
    expect(json.detection.buildNumbers.highest?.value).toBe(42);
    await runInit(options(dir, { yes: true }));
    expect(read(dir, "pubspec.yaml")).toBe(pubspec);
  });

  it("warns about date-based build numbers close to Google Play's limit", async () => {
    const dir = repoFrom(
      app(".", { "pubspec.yaml": APP_PUBSPEC.replace("1.4.0+12", "1.4.0+2026112701") }),
    );
    const json = await detectJson(dir);
    expect(json.detection.buildNumbers.highest?.value).toBe(2026112701);
    const note = json.detection.notes.find((n) => /close to Google Play's limit/.test(n.message));
    expect(note).toMatchObject({ level: "warning", path: "pubspec.yaml", line: 12 });
    expect(note?.message).toContain("room for about 2 year(s)");
    // Rounded up, the offset (1,900,000,000) would put the first build number above the limit.
    const { strategyNow, offset } = json.detection.buildNumbers;
    expect(offset).toBe(2026112701 - strategyNow + 1);
    expect(strategyNow + offset).toBeLessThanOrEqual(2_100_000_000);
  });

  it("sees --build-number on the next line of a multiline flutter build", () => {
    const text = [
      "      - run: |",
      "          flutter build ipa --release \\",
      '            --build-number "$GITHUB_RUN_NUMBER"',
      "      - run: >",
      "          flutter build appbundle",
      '          --build-name "1.0.0"',
      "      - run: |",
      "          flutter build web \\",
      '            --build-number "$LAUNCHSET_BUILD_NUMBER"',
      "",
    ].join("\n");
    const notes = flutterBuildFlagNotes([{ path: "ci.yml", text }]);
    expect(notes.map((n) => n.line)).toEqual([2, 5]);
  });

  it("sees version tools run through fvm", () => {
    expect(commandKinds("fvm dart run cider bump build")).toEqual(["version-writer"]);
    expect(commandKinds("fvm flutter pub run cider bump patch")).toEqual(["version-writer"]);
    expect(commandKinds("fvm exec melos version")).toEqual(["release-tool"]);
    expect(commandKinds("fvm flutter build apk")).toEqual([]);
    expect(commandKinds("cider version")).toEqual([]);
    expect(commandKinds("cider version 2.0.0+1")).toEqual(["version-writer"]);
  });

  it("flags cider, pubver and yq edits of pubspec.yaml in workflows", async () => {
    const dir = repoFrom({
      ...app("."),
      ".github/workflows/bump.yml": [
        "name: Bump",
        "on: workflow_dispatch",
        "jobs:",
        "  bump:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: dart pub global run cider bump patch",
        "      - run: pubver bump build",
        "      - run: yq -i '.version = \"1.2.3+4\"' pubspec.yaml",
        "      - run: yq '.version' pubspec.yaml",
        "",
      ].join("\n"),
    });
    const machinery = (await detectJson(dir)).detection.machinery;
    expect(machinery.map((m) => [m.path, m.line, m.kinds])).toEqual([
      [".github/workflows/bump.yml", 7, ["version-writer"]],
      [".github/workflows/bump.yml", 8, ["version-writer"]],
      [".github/workflows/bump.yml", 9, ["version-writer"]],
    ]);
  });
});

describe("Flutter helpers", () => {
  it("tells apps from plugins and Dart packages", () => {
    expect(isFlutterAppPubspec(APP_PUBSPEC)).toBe(true);
    expect(isFlutterAppPubspec("name: x\ndependencies:\n  http: ^1.0.0\n")).toBe(false);
    expect(
      isFlutterAppPubspec(
        "name: x\ndependencies:\n  flutter:\n    sdk: flutter\nflutter:\n  plugin:\n    platforms: {}\n",
      ),
    ).toBe(false);
    expect(isFlutterAppPubspec("name: [x\n")).toBe(false);
  });

  it("warns about a version set in a Gradle flavor, not about versionNameSuffix", () => {
    const gradle = [
      "android {",
      "    defaultConfig {",
      "        versionCode = flutter.versionCode",
      "        versionName = flutter.versionName",
      "    }",
      "    productFlavors {",
      '        create("staging") {',
      '            versionNameSuffix = "-staging"',
      "            versionCode = 2",
      "        }",
      "    }",
      "}",
    ].join("\n");
    expect(gradleWiringNotes(gradle, "build.gradle.kts").map((n) => n.line)).toEqual([9]);
  });

  it("accepts the old Groovy template's flutterVersionCode", () => {
    const groovy = [
      "android {",
      "    defaultConfig {",
      "        versionCode flutterVersionCode.toInteger()",
      "        versionName flutterVersionName",
      "    }",
      "}",
    ].join("\n");
    expect(gradleWiringNotes(groovy, "build.gradle")).toEqual([]);
    expect(plistWiringNotes(APP_PLIST, "Info.plist")).toEqual([]);
  });

  it("follows $(SETTING) in Info.plist to the Runner target's build settings", () => {
    const config = (id: string, name: string, settings: string) =>
      `\t\t${id} = {isa = XCBuildConfiguration; name = ${name}; buildSettings = {${settings}}; };`;
    const pbx = [
      "// !$*UTF8*$!",
      "{",
      "\tobjects = {",
      "\t\tP1 = {isa = PBXProject; targets = (T1, T2); };",
      "\t\tT1 = {isa = PBXNativeTarget; name = Runner; buildConfigurationList = L1; };",
      "\t\tT2 = {isa = PBXNativeTarget; name = RunnerTests; buildConfigurationList = L2; };",
      "\t\tL1 = {isa = XCConfigurationList; buildConfigurations = (C1, C2); };",
      "\t\tL2 = {isa = XCConfigurationList; buildConfigurations = (C3); };",
      config(
        "C1",
        "Debug",
        'CURRENT_PROJECT_VERSION = "$(FLUTTER_BUILD_NUMBER)"; MARKETING_VERSION = 1.0;',
      ),
      config(
        "C2",
        "Release",
        'CURRENT_PROJECT_VERSION = "$(FLUTTER_BUILD_NUMBER)"; MARKETING_VERSION = 1.0;',
      ),
      config("C3", "Debug", "CURRENT_PROJECT_VERSION = 1; MARKETING_VERSION = 1.0;"),
      "\t};",
      "\trootObject = P1;",
      "}",
    ].join("\n");
    const plist = APP_PLIST.replace("$(FLUTTER_BUILD_NAME)", "$(MARKETING_VERSION)").replace(
      "$(FLUTTER_BUILD_NUMBER)",
      "$(CURRENT_PROJECT_VERSION)",
    );
    const settings = runnerBuildSettings(pbx, "project.pbxproj");
    expect(settings.CURRENT_PROJECT_VERSION).toEqual([
      "$(FLUTTER_BUILD_NUMBER)",
      "$(FLUTTER_BUILD_NUMBER)",
    ]);
    const notes = plistWiringNotes(plist, "Info.plist", settings);
    expect(notes.map((n) => n.message)).toEqual([
      expect.stringMatching(
        /^CFBundleShortVersionString is \$\(MARKETING_VERSION\) \(the Runner target sets MARKETING_VERSION to 1\.0\), not/,
      ),
    ]);
    // Without the project the reference can't be followed: both get the warning.
    expect(plistWiringNotes(plist, "Info.plist")).toHaveLength(2);
    expect(runnerBuildSettings("not a project", "project.pbxproj")).toEqual({});

    // Release sets nothing itself and inherits a literal number from the project level.
    const inherited = pbx
      .replace(
        "P1 = {isa = PBXProject; targets = (T1, T2); };",
        "P1 = {isa = PBXProject; targets = (T1, T2); buildConfigurationList = L3; };",
      )
      .replace(
        "L2 = {isa = XCConfigurationList; buildConfigurations = (C3); };",
        "L2 = {isa = XCConfigurationList; buildConfigurations = (C3); };\n\t\tL3 = {isa = XCConfigurationList; buildConfigurations = (C4); };\n" +
          config("C4", "Release", "CURRENT_PROJECT_VERSION = 42;"),
      )
      .replace(
        config(
          "C2",
          "Release",
          'CURRENT_PROJECT_VERSION = "$(FLUTTER_BUILD_NUMBER)"; MARKETING_VERSION = 1.0;',
        ),
        config("C2", "Release", "MARKETING_VERSION = 1.0;"),
      );
    const fromProject = runnerBuildSettings(inherited, "project.pbxproj");
    expect(fromProject.CURRENT_PROJECT_VERSION).toEqual(["$(FLUTTER_BUILD_NUMBER)", "42"]);
    expect(plistWiringNotes(plist, "Info.plist", fromProject).map((n) => n.message)).toContainEqual(
      expect.stringContaining(
        "the Runner target sets CURRENT_PROJECT_VERSION to $(FLUTTER_BUILD_NUMBER), 42",
      ),
    );
  });

  it("inserts the version after description, else after name, else at the top, with the file's line endings", () => {
    expect(insertPubspecVersion("name: a\ndescription: b\n\ndependencies: {}\n", "1.0.0")).toBe(
      "name: a\ndescription: b\nversion: 1.0.0+1\n\ndependencies: {}\n",
    );
    expect(insertPubspecVersion("name: a # app\r\nflutter: {}\r\n", "1.0.0")).toBe(
      "name: a # app\r\nversion: 1.0.0+1\r\nflutter: {}\r\n",
    );
    expect(insertPubspecVersion("name: a", "1.0.0")).toBe("name: a\nversion: 1.0.0+1\n");
    expect(insertPubspecVersion("flutter: {}\n", "1.0.0")).toBe("version: 1.0.0+1\nflutter: {}\n");
  });

  it("adds the version after a block scalar description, not inside the next map", () => {
    for (const style of ["|", ">"]) {
      const text = `name: a\ndescription: ${style}\n  An app.\nenvironment:\n  sdk: ^3.0.0\n`;
      const next = insertPubspecVersion(text, "1.0.0");
      expect(next).toBe(
        `name: a\ndescription: ${style}\n  An app.\nversion: 1.0.0+1\nenvironment:\n  sdk: ^3.0.0\n`,
      );
      expect(parse(next ?? "")).toMatchObject({
        version: "1.0.0+1",
        environment: { sdk: "^3.0.0" },
      });
    }
  });

  it("fills in an empty version instead of adding a second one", () => {
    expect(insertPubspecVersion("name: a\nversion:\nflutter: {}\n", "1.0.0")).toBe(
      "name: a\nversion: 1.0.0+1\nflutter: {}\n",
    );
    expect(insertPubspecVersion("name: a\nversion: # set in CI\n", "1.0.0")).toBe(
      "name: a\nversion: 1.0.0+1 # set in CI\n",
    );
    expect(insertPubspecVersion('name: a\nversion: ""\n', "1.0.0")).toBe(
      "name: a\nversion: 1.0.0+1\n",
    );
    expect(insertPubspecVersion("name: a\nversion: ~\n", "1.0.0")).toBe(
      "name: a\nversion: 1.0.0+1\n",
    );
  });

  it("adds the version inside a flow mapping, with the keys' indentation, or not at all", () => {
    expect(
      insertPubspecVersion("{name: mobile, dependencies: {flutter: {sdk: flutter}}}\n", "1.0.0"),
    ).toBe("{version: 1.0.0+1, name: mobile, dependencies: {flutter: {sdk: flutter}}}\n");
    expect(insertPubspecVersion("{}\n", "1.0.0")).toBe("{version: 1.0.0+1}\n");
    expect(insertPubspecVersion("  name: a\n  flutter: {}\n", "1.0.0")).toBe(
      "  name: a\n  version: 1.0.0+1\n  flutter: {}\n",
    );
    expect(insertPubspecVersion("# app\n---\nflutter: {}\n", "1.0.0")).toBe(
      "# app\n---\nversion: 1.0.0+1\nflutter: {}\n",
    );
    // Not a mapping: nothing to add the version to.
    expect(insertPubspecVersion("- a\n", "1.0.0")).toBeNull();
  });

  it("leaves a pubspec that has a version alone", () => {
    const text = "name: a\nversion: 2.0.0 # no build number\n";
    expect(insertPubspecVersion(text, "1.0.0")).toBe(text);
  });
});
