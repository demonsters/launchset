import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  gradleWiringNotes,
  insertPubspecVersion,
  isFlutterAppPubspec,
  plistWiringNotes,
} from "../../src/init/flutter.ts";
import { type InitDetectJson, runInit } from "../../src/init/index.ts";
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

  it("warns about date-based build numbers close to Google Play's limit", async () => {
    const dir = repoFrom(
      app(".", { "pubspec.yaml": APP_PUBSPEC.replace("1.4.0+12", "1.4.0+2026112701") }),
    );
    const json = await detectJson(dir);
    expect(json.detection.buildNumbers.highest?.value).toBe(2026112701);
    const note = json.detection.notes.find((n) => /close to Google Play's limit/.test(n.message));
    expect(note).toMatchObject({ level: "warning", path: "pubspec.yaml", line: 12 });
    expect(note?.message).toContain("room for about 2 year(s)");
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
});
