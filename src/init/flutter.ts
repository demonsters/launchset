/**
 * Flutter apps for `launchset init` (spec 11.1, 6.8): find them, propose `android` / `ios`
 * targets with `source: { kind: "flutter", dir }`, and warn when the native projects don't
 * read Flutter's numbers (then stamping `pubspec.yaml` would never reach the app).
 */

import { isMap, isScalar, parseDocument, parse as parseYaml } from "yaml";
import { detectEol } from "../core/text.ts";
import { effectiveVersionSettings } from "../platforms/pbxproj.ts";
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

/**
 * The Runner target's version settings, by name: the value each configuration builds with
 * (`undefined` where none is set, also not at the project level).
 */
export type BuildSettings = Record<string, (string | undefined)[]>;

/**
 * The Runner target's version settings from `ios/Runner.xcodeproj/project.pbxproj`, for an
 * Info.plist that reads them (`$(MARKETING_VERSION)`, `$(CURRENT_PROJECT_VERSION)`, as Xcode
 * writes when the version is edited in its General tab). Empty when the project can't be read.
 */
export function runnerBuildSettings(text: string, path: string): BuildSettings {
  try {
    const configs = effectiveVersionSettings(text, path, "Runner");
    if (configs.length === 0) return {};
    return {
      MARKETING_VERSION: configs.map((c) => c.MARKETING_VERSION),
      CURRENT_PROJECT_VERSION: configs.map((c) => c.CURRENT_PROJECT_VERSION),
    };
  } catch {
    return {};
  }
}

/**
 * Warnings for Info.plist version values that don't come from Flutter. A `$(SETTING)` value
 * is fine when every configuration of the Runner target builds with Flutter's value for it.
 */
export function plistWiringNotes(text: string, path: string, settings: BuildSettings = {}): Note[] {
  const notes: Note[] = [];
  for (const [key, expected] of Object.entries(PLIST_KEYS)) {
    const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(text);
    if (!m || m[1] === expected) continue;
    const value = m[1] as string;
    const setting = /^\$\((\w+)\)$/.exec(value)?.[1];
    const resolved = setting === undefined ? undefined : settings[setting];
    if (resolved && resolved.length > 0 && resolved.every((v) => v === expected)) continue;
    const values = [...new Set((resolved ?? []).map((v) => v ?? "nothing"))];
    const via =
      values.length > 0 ? ` (the Runner target sets ${setting} to ${values.join(", ")})` : "";
    const at = m.index + m[0].lastIndexOf("<string>");
    notes.push({
      level: "warning",
      path,
      line: text.slice(0, at).split("\n").length,
      message: `${key} is ${value || "empty"}${via}, not ${expected}: the numbers launchset writes into pubspec.yaml never reach this app. Set it to ${expected} (as flutter create does), or stamp the Xcode project with source { kind: "xcodeproj" } instead.`,
    });
  }
  return notes;
}

/**
 * The version and build number in `<dir>/pubspec.yaml`, for the canonical version and the
 * build-number offset. Also for an app without android/ or ios/ (a web-only app), whose
 * pubspec no target carries. Empty when the file has no readable version.
 */
export async function pubspecValues(
  root: string,
  dir: string,
): Promise<{ path: string; values: FoundValue[] }> {
  const path = joinRel(dir, "pubspec.yaml");
  const text = (await readTextOrNull(absolute(root, path))) ?? "";
  try {
    return { path, values: pubspec.read(text, path, undefined) };
  } catch {
    return { path, values: [] };
  }
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
    if (plistText !== null) {
      const pbxPath = joinRel(dir, "ios/Runner.xcodeproj/project.pbxproj");
      const pbxText = await readTextOrNull(absolute(root, pbxPath));
      const settings = pbxText === null ? {} : runnerBuildSettings(pbxText, pbxPath);
      notes.push(...plistWiringNotes(plistText, plistPath, settings));
    }
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
 * `text` with a top-level `version: <version>+1` (a pubspec without one): an empty `version:`
 * gets the value, else a new line goes after the top-level `description`, else after `name`,
 * else before the first key, indented like the keys. A flow mapping (`{name: app}`) gets it as
 * its first entry. Nothing else changes. A pubspec that has a version comes back unchanged.
 * `null` when the result wouldn't read back with that version: add it by hand then.
 */
export function insertPubspecVersion(text: string, version: string): string | null {
  const value = `${version}+1`;
  const next = addPubspecVersion(text, value);
  if (next === null || next === text) return next;
  const check = parseDocument(next);
  if (check.errors.length > 0 || !isMap(check.contents)) return null;
  return check.contents.toJSON().version === value ? next : null;
}

function addPubspecVersion(text: string, value: string): string | null {
  const eol = detectEol(text);
  const line = `version: ${value}`;
  const doc = parseDocument(text);
  if (doc.contents === null) return `${line}${eol}${text}`;
  if (!isMap(doc.contents)) return null;
  const map = doc.contents;
  const pairs = map.items;
  const existing = pairs.find((p) => isScalar(p.key) && p.key.value === "version");
  if (existing) {
    const node = existing.value;
    const empty = node === null || (isScalar(node) && (node.value === null || node.value === ""));
    const keyEnd = isScalar(existing.key) ? existing.key.range?.[1] : undefined;
    if (!empty || keyEnd === undefined) return text;
    // `version:`, `version: ""`, `version: ~` or `version: # comment`: fill in the value after
    // the colon and keep a comment.
    const colon = text.indexOf(":", keyEnd);
    const range = isScalar(node) ? node.range : undefined;
    const end = range && range[1] > range[0] ? range[1] : colon + 1;
    return `${text.slice(0, colon + 1)} ${value}${text.slice(end)}`;
  }
  if (map.flow) {
    const open = map.range?.[0];
    if (open === undefined) return null;
    const rest = text.slice(open + 1);
    return `${text.slice(0, open + 1)}${line}${pairs.length > 0 ? ", " : ""}${rest}`;
  }
  // The indentation of the line a key starts on (top-level keys are usually at column 0).
  const indentAt = (offset: number) => {
    const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
    const before = text.slice(lineStart, offset);
    return { lineStart, indent: /^[ \t]*$/.test(before) ? before : "" };
  };
  for (const key of ["description", "name"]) {
    const pair = pairs.find((p) => isScalar(p.key) && p.key.value === key);
    const end = pair && isScalar(pair.value) ? pair.value.range?.[1] : undefined;
    const keyStart = pair && isScalar(pair.key) ? pair.key.range?.[0] : undefined;
    if (end === undefined || keyStart === undefined) continue;
    const { indent } = indentAt(keyStart);
    // A block scalar (`description: |`) ends after its last newline: the line it ends on is
    // the one with its last character.
    const lineEnd = text.indexOf("\n", Math.max(end - 1, 0));
    if (lineEnd === -1) return `${text}${eol}${indent}${line}${eol}`;
    return `${text.slice(0, lineEnd + 1)}${indent}${line}${eol}${text.slice(lineEnd + 1)}`;
  }
  const first = pairs[0];
  const firstStart = first && isScalar(first.key) ? first.key.range?.[0] : undefined;
  if (firstStart === undefined) return `${line}${eol}${text}`;
  const { lineStart, indent } = indentAt(firstStart);
  return `${text.slice(0, lineStart)}${indent}${line}${eol}${text.slice(lineStart)}`;
}

/**
 * Notes for `flutter build` lines in CI files that pass their own `--build-number` or
 * `--build-name` (a run number, a date): those steps move into launchset's workflow with
 * launchset's numbers instead.
 */
export function flutterBuildFlagNotes(files: readonly { path: string; text: string }[]): Note[] {
  const notes: Note[] = [];
  for (const file of files) {
    const lines = linesOf(file.text);
    for (const [i, line] of lines.entries()) {
      let text = line.text.trim();
      if (text.startsWith("#") || !/\bflutter\s+build\b/.test(text)) continue;
      // The whole command: lines after a trailing `\`, and flag lines of a folded `run: >`.
      for (let j = i; j + 1 < lines.length; j++) {
        const next = (lines[j + 1]?.text ?? "").trim();
        if (!(lines[j]?.text ?? "").trimEnd().endsWith("\\") && !next.startsWith("--")) break;
        text += ` ${next}`;
      }
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
