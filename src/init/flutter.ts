/**
 * Flutter apps for `launchset init` (spec 11.1, 6.8): find them, propose `android` / `ios`
 * targets with `source: { kind: "flutter", dir }`, and warn when the native projects don't
 * read Flutter's numbers (then stamping `pubspec.yaml` would never reach the app).
 */

import { isMap, isScalar, parseDocument, parse as parseYaml } from "yaml";
import { detectEol } from "../core/text.ts";
import { pubspec } from "../platforms/pubspec.ts";
import type { FoundValue } from "../platforms/types.ts";
import { absolute, globRel, isDirectory, isFile, joinRel, linesOf, readTextOrNull } from "./fs.ts";
import type { DetectedTarget, Note } from "./types.ts";

export type FlutterTarget = Omit<DetectedTarget, "name" | "builtBy" | "proposed" | "reason">;

/** The platform folders `flutter create` makes. */
const PLATFORMS = ["android", "ios", "web", "macos", "windows", "linux"];

/** Folders whose pubspec.yaml is never an app of this repo. */
const NOT_APPS = [
  "**/.dart_tool/**",
  "**/.symlinks/**",
  "**/ephemeral/**",
  "**/.pub-cache/**",
  "**/example/**",
  "**/examples/**",
  "**/test/**",
  "**/fixtures/**",
];

/** A Flutter app's pubspec: depends on the Flutter SDK and isn't a plugin or a package. */
export function isFlutterAppPubspec(text: string): boolean {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch {
    return false;
  }
  if (!data || typeof data !== "object") return false;
  const pubspecData = data as Record<string, unknown>;
  const flutterDep = (pubspecData.dependencies as Record<string, unknown> | undefined)?.flutter;
  if (!flutterDep || typeof flutterDep !== "object") return false;
  if ((flutterDep as Record<string, unknown>).sdk !== "flutter") return false;
  const flutterSection = pubspecData.flutter as Record<string, unknown> | undefined;
  return !(flutterSection && typeof flutterSection === "object" && "plugin" in flutterSection);
}

/** Globs of a Dart pub workspace (`workspace:` in the root pubspec) and melos (`packages:`). */
async function workspaceGlobs(root: string): Promise<string[]> {
  const globs: string[] = [];
  const rootPubspec = await readTextOrNull(absolute(root, "pubspec.yaml"));
  if (rootPubspec !== null) {
    try {
      const data = parseYaml(rootPubspec) as Record<string, unknown> | null;
      if (Array.isArray(data?.workspace)) globs.push(...data.workspace.map(String));
      const melos = data?.melos as Record<string, unknown> | undefined;
      if (Array.isArray(melos?.packages)) globs.push(...melos.packages.map(String));
    } catch {
      // An unreadable root pubspec is reported where it is read as an app.
    }
  }
  const melosYaml = await readTextOrNull(absolute(root, "melos.yaml"));
  if (melosYaml !== null) {
    try {
      const data = parseYaml(melosYaml) as Record<string, unknown> | null;
      if (Array.isArray(data?.packages)) globs.push(...data.packages.map(String));
    } catch {
      // Not a melos file we can read: the bounded search below still finds the apps.
    }
  }
  return globs.map((g) => g.replace(/\/+$/, ""));
}

/**
 * Folders with a Flutter app: the repo root, the folders of a pub workspace or melos, and any
 * `pubspec.yaml` up to four levels deep (a Flutter app in a JS monorepo has no package.json,
 * so the npm/pnpm workspace lists don't name it). Plugins, packages, `example/` apps and
 * generated copies are left out.
 */
export async function findFlutterApps(root: string): Promise<string[]> {
  const candidates = new Set<string>();
  if (await isFile(absolute(root, "pubspec.yaml"))) candidates.add(".");
  const globs = await workspaceGlobs(root);
  if (globs.length > 0) {
    for (const dir of await globRel(root, globs, { directories: true, ignore: NOT_APPS })) {
      if (await isFile(absolute(root, joinRel(dir, "pubspec.yaml")))) candidates.add(dir);
    }
  }
  for (const path of await globRel(root, ["**/pubspec.yaml"], { deep: 4, ignore: NOT_APPS })) {
    candidates.add(path === "pubspec.yaml" ? "." : path.slice(0, -"/pubspec.yaml".length));
  }
  const apps: string[] = [];
  for (const dir of [...candidates].sort()) {
    const text = await readTextOrNull(absolute(root, joinRel(dir, "pubspec.yaml")));
    if (text === null || !isFlutterAppPubspec(text)) continue;
    // A package of shared widgets depends on Flutter too, but has no platform folder.
    for (const platform of PLATFORMS) {
      if (await isDirectory(absolute(root, joinRel(dir, platform)))) {
        apps.push(dir);
        break;
      }
    }
  }
  return apps;
}

/** The Android Gradle file of a Flutter app, when there is exactly one. */
async function androidGradle(root: string, dir: string): Promise<string | undefined> {
  const files = [
    joinRel(dir, "android/app/build.gradle"),
    joinRel(dir, "android/app/build.gradle.kts"),
  ];
  for (const file of files) if (await isFile(absolute(root, file))) return file;
  return undefined;
}

const FLUTTER_GRADLE_VALUE = /\bflutter\.version(?:Code|Name)\b|\bflutterVersion(?:Code|Name)\b/;

/** Warnings for `versionCode` / `versionName` lines that don't come from Flutter. */
export function gradleWiringNotes(text: string, path: string): Note[] {
  const notes: Note[] = [];
  for (const line of linesOf(text)) {
    const m = /^\s*(versionCode|versionName)\b\s*=?\s*(.+?)\s*$/.exec(line.text);
    if (!m || line.text.trimStart().startsWith("//")) continue;
    const value = (m[2] as string).replace(/\s*\/\/.*$/, "");
    if (FLUTTER_GRADLE_VALUE.test(value)) continue;
    const flutterKey = m[1] === "versionCode" ? "flutter.versionCode" : "flutter.versionName";
    notes.push({
      level: "warning",
      path,
      line: line.number,
      message: `${m[1]} is ${value}, not ${flutterKey}: the numbers launchset writes into pubspec.yaml never reach this app. Set ${m[1]} = ${flutterKey} (as flutter create does), or stamp this file with source { kind: "gradle" } instead.`,
    });
  }
  return notes;
}

const PLIST_KEYS = {
  CFBundleShortVersionString: "$(FLUTTER_BUILD_NAME)",
  CFBundleVersion: "$(FLUTTER_BUILD_NUMBER)",
} as const;

/** Warnings for Info.plist version values that don't come from Flutter. */
export function plistWiringNotes(text: string, path: string): Note[] {
  const notes: Note[] = [];
  for (const [key, expected] of Object.entries(PLIST_KEYS)) {
    const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(text);
    if (!m || m[1] === expected) continue;
    const at = m.index + m[0].lastIndexOf("<string>");
    notes.push({
      level: "warning",
      path,
      line: text.slice(0, at).split("\n").length,
      message: `${key} is ${m[1] || "empty"}, not ${expected}: the numbers launchset writes into pubspec.yaml never reach this app. Set it to ${expected} (as flutter create does), or stamp the Xcode project with source { kind: "xcodeproj" } instead.`,
    });
  }
  return notes;
}

/**
 * The android and ios targets of the Flutter app in `dir`: one per platform folder, both
 * stamping `<dir>/pubspec.yaml`. Notes say what is ignored and what is wired wrong.
 */
export async function detectFlutterApp(
  root: string,
  dir: string,
  notes: Note[],
): Promise<FlutterTarget[]> {
  const path = joinRel(dir, "pubspec.yaml");
  const text = (await readTextOrNull(absolute(root, path))) ?? "";
  let values: FoundValue[] = [];
  try {
    values = pubspec.read(text, path, undefined);
  } catch (error) {
    notes.push({
      level: "info",
      path,
      message: `${(error as Error).message.replace(`${path}: `, "")} (init adds one with the version it decides on)`,
    });
  }
  const files = [{ path, values }];
  const source = { kind: "flutter", dir };
  const targets: FlutterTarget[] = [];

  const gradleFile = await androidGradle(root, dir);
  if (gradleFile) {
    targets.push({ type: "android", dir, source, files });
    const gradleText = (await readTextOrNull(absolute(root, gradleFile))) ?? "";
    notes.push(...gradleWiringNotes(gradleText, gradleFile));
  }
  if (await isDirectory(absolute(root, joinRel(dir, "ios")))) {
    targets.push({ type: "ios", dir, source, files });
    const plistPath = joinRel(dir, "ios/Runner/Info.plist");
    const plistText = await readTextOrNull(absolute(root, plistPath));
    if (plistText !== null) notes.push(...plistWiringNotes(plistText, plistPath));
  }
  if (targets.length > 0) {
    notes.push({
      level: "info",
      path,
      message:
        "Flutter app: launchset stamps the version in pubspec.yaml (the build number after the + in CI); the android/ and ios/ projects read it through Flutter and are left alone.",
    });
  }
  const others = ["web", "macos", "windows", "linux"];
  const present: string[] = [];
  for (const platform of others) {
    if (await isDirectory(absolute(root, joinRel(dir, platform)))) present.push(platform);
  }
  if (present.length > 0) {
    notes.push({
      level: "info",
      path: joinRel(dir, present[0] as string),
      message: `The Flutter app also has ${present.join(", ")}. ${[
        present.includes("web") ? "A web build runs as a web target." : "",
        present.some((p) => p !== "web")
          ? "Desktop builds run as custom targets with your own build steps."
          : "",
      ]
        .filter(Boolean)
        .join(" ")} See Flutter in the launchset docs.`,
    });
  }
  return targets;
}

/**
 * `text` with a top-level `version: <version>+1` added (a pubspec without one): after the
 * top-level `description`, else after `name`, else at the top. Nothing else changes.
 */
export function insertPubspecVersion(text: string, version: string): string {
  const eol = detectEol(text);
  const line = `version: ${version}+1`;
  const doc = parseDocument(text);
  if (isMap(doc.contents)) {
    for (const key of ["description", "name"]) {
      const pair = doc.contents.items.find((p) => isScalar(p.key) && p.key.value === key);
      const end = pair && isScalar(pair.value) ? pair.value.range?.[1] : undefined;
      if (end === undefined) continue;
      const lineEnd = text.indexOf("\n", end);
      if (lineEnd === -1) return `${text}${eol}${line}${eol}`;
      return `${text.slice(0, lineEnd + 1)}${line}${eol}${text.slice(lineEnd + 1)}`;
    }
  }
  return `${line}${eol}${text}`;
}

/**
 * Notes for `flutter build` lines in CI files that pass their own `--build-number` or
 * `--build-name` (a run number, a date): those steps move into launchset's workflow with
 * launchset's numbers instead.
 */
export function flutterBuildFlagNotes(files: readonly { path: string; text: string }[]): Note[] {
  const notes: Note[] = [];
  for (const file of files) {
    for (const line of linesOf(file.text)) {
      const text = line.text.trim();
      if (text.startsWith("#") || !/\bflutter\s+build\b/.test(text)) continue;
      if (!/--build-(?:number|name)\b/.test(text) || /LAUNCHSET_|steps\.stamp\./.test(text)) {
        continue;
      }
      notes.push({
        level: "info",
        path: file.path,
        line: line.number,
        message:
          "this flutter build passes its own --build-number or --build-name. When you move it into launchset's workflow, pass launchset's numbers instead ($LAUNCHSET_VERSION and $LAUNCHSET_BUILD_NUMBER, or the stamp step's marketing-version and build-number outputs).",
      });
    }
  }
  return notes;
}

/** Build services launchset doesn't run in (spec 1.2): their config files, with a note. */
export async function externalCiNotes(root: string): Promise<Note[]> {
  const notes: Note[] = [];
  for (const [path, name] of [
    ["codemagic.yaml", "Codemagic"],
    ["bitrise.yml", "Bitrise"],
  ] as const) {
    if (!(await isFile(absolute(root, path)))) continue;
    notes.push({
      level: "info",
      path,
      message: `${name} builds this repo. launchset runs in GitHub Actions or GitLab CI, not in ${name}: move the app builds there, or make the apps manual targets (see Manual targets in the launchset docs).`,
      manual: true,
    });
  }
  return notes;
}
