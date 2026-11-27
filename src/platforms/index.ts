/**
 * Stamping layer (spec 6): maps a target's config to the files it stamps and the stamper
 * for each, and applies version values. I/O lives here; the format stampers stay pure.
 *
 * Two kinds of stamping:
 * - `stampForRelease`: the release PR commit. Root version file (+ npm lockfile) and every
 *   target's marketing version, manual targets included. Never build numbers.
 * - `stampForBuild`: `launchset stamp` in a CI checkout. Version and build number for one
 *   target, from the plan. Never committed.
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { expandFilePattern, resolveSourcePaths, type SourceFile } from "../config/load.ts";
import { assertBuildNumberFits } from "../core/build-number.ts";
import {
  type FileEntry,
  type ResolvedConfig,
  type ResolvedTarget,
  rootVersionHint,
  versionFileFormat,
} from "../core/config/schema.ts";
import { releaseVerifyTag } from "../core/docker-tags.ts";
import { LaunchsetError } from "../core/errors.ts";
import type { Plan, TargetPlan } from "../core/types.ts";
import { marketingVersion } from "../core/versions.ts";
import { expoAndroid, expoIos } from "./expo.ts";
import { gradle } from "./gradle.ts";
import { gradleProperties } from "./gradle-properties.ts";
import { hasImageRef, imageRefs } from "./image.ts";
import { jsonValue } from "./json.ts";
import { npmLockfile } from "./npm-lockfile.ts";
import { pbxproj } from "./pbxproj.ts";
import { plist } from "./plist.ts";
import { pubspec } from "./pubspec.ts";
import { regexFile } from "./regex.ts";
import type { FoundValue, StampValues, TextStamper } from "./types.ts";
import { xcconfig } from "./xcconfig.ts";
import { yamlValue } from "./yaml.ts";

/** What the marketing value of a binding is. */
type ValueKind =
  /** The version, adapted to the target platform (plain X.Y.Z for iOS). */
  | "version"
  /** The docker verify tag (`kind: "image"` manifests, spec 6.6). */
  | "image-tag";

/** One file a target stamps, with its stamper. */
export interface FileBinding {
  /** Root-relative POSIX path. */
  path: string;
  absolute: string;
  /** Config field the binding comes from, for messages. */
  field: string;
  // biome-ignore lint/suspicious/noExplicitAny: bindings hold stampers with different option types
  stamper: TextStamper<any>;
  options: unknown;
  value: ValueKind;
  /** Whether this file carries a build number. */
  build: boolean;
  /**
   * Only stamped in CI (`stampForBuild`): a regex entry whose template needs `{buildNumber}`.
   * Skipped by the release PR and the consistency check.
   */
  ciOnly: boolean;
}

/** A file edit, before writing. `before === after` never appears in results. */
export interface FileChange {
  path: string;
  absolute: string;
  before: string;
  after: string;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function sourceBinding(target: ResolvedTarget, file: SourceFile): FileBinding {
  const base = {
    path: file.path,
    absolute: file.absolute,
    field: file.field,
    value: "version" as const,
    build: true,
    ciOnly: false,
  };
  switch (file.format) {
    case "gradle":
      return { ...base, stamper: gradle, options: undefined };
    case "gradle-properties": {
      if (target.type !== "android" || target.source.kind !== "gradle-properties") break;
      const { versionNameKey, versionCodeKey } = target.source;
      return { ...base, stamper: gradleProperties, options: { versionNameKey, versionCodeKey } };
    }
    case "pbxproj": {
      if (target.type !== "ios") break;
      const source = target.source;
      const targets =
        source.kind === "xcodeproj" || source.kind === "capacitor"
          ? source.xcodeTargets
          : undefined;
      return { ...base, stamper: pbxproj, options: { targets } };
    }
    case "plist":
      return { ...base, stamper: plist, options: undefined };
    case "xcconfig":
      return { ...base, stamper: xcconfig, options: undefined };
    case "expo":
      return {
        ...base,
        stamper: target.type === "ios" ? expoIos : expoAndroid,
        options: undefined,
      };
    case "pubspec":
      if (target.type !== "android" && target.type !== "ios") break;
      return { ...base, stamper: pubspec, options: { platform: target.type } };
  }
  throw new Error(`internal: source format ${file.format} doesn't fit target ${target.name}`);
}

async function fileEntryBindings(
  target: ResolvedTarget,
  entry: FileEntry,
  index: number,
  root: string,
): Promise<FileBinding[]> {
  const field = `targets.${target.name}.files.${index}`;
  const one = (
    stamper: FileBinding["stamper"],
    options: unknown,
    extra: Partial<FileBinding> = {},
  ) => {
    const absolute = resolve(root, entry.path);
    return [
      {
        path: entry.path,
        absolute,
        field,
        stamper,
        options,
        value: "version" as const,
        build: false,
        ciOnly: false,
        ...extra,
      },
    ];
  };
  switch (entry.kind) {
    case "json":
      return one(jsonValue, { key: entry.key });
    case "yaml":
      return one(yamlValue, { key: entry.key });
    case "regex": {
      const needsBuild = entry.replace.includes("{buildNumber}");
      return one(
        regexFile,
        { pattern: entry.pattern, flags: entry.flags, replace: entry.replace },
        { build: needsBuild, ciOnly: needsBuild },
      );
    }
    case "image": {
      if (target.type !== "docker") {
        throw new LaunchsetError(
          "invalid-config",
          `${field}.kind: kind "image" is only allowed in docker targets`,
        );
      }
      const matches = await expandFilePattern(entry.path, root);
      const bindings: FileBinding[] = [];
      for (const path of matches) {
        const absolute = resolve(root, path);
        const text = await readFile(absolute, "utf8");
        if (!hasImageRef(text, target.image)) continue;
        bindings.push({
          path,
          absolute,
          field,
          stamper: imageRefs,
          options: { images: target.image },
          value: "image-tag",
          build: false,
          ciOnly: false,
        });
      }
      if (bindings.length === 0) {
        throw new LaunchsetError(
          "no-image-reference",
          `${field}.path: no file matching ${entry.path} references ${target.image.join(" or ")}`,
          { hint: "Check the path and the image name, or remove the entry." },
        );
      }
      return bindings;
    }
  }
}

/** Every file a target stamps: its source files, then its extra `files` entries. */
export async function targetBindings(target: ResolvedTarget, root: string): Promise<FileBinding[]> {
  const sources = await resolveSourcePaths(target, root);
  const bindings = sources.map((file) => sourceBinding(target, file));
  for (const [index, entry] of target.files.entries()) {
    bindings.push(...(await fileEntryBindings(target, entry, index, root)));
  }
  return bindings;
}

/**
 * The root version file and, for a `package.json`, a sibling `package-lock.json` /
 * `npm-shrinkwrap.json` (spec 6.6 "npm lockfile"). A `pubspec.yaml` version file also carries
 * the build number in CI (its `+N`), so `flutter build` of any target sees the run's numbers.
 */
export async function versionFileBindings(
  config: ResolvedConfig,
  root: string,
): Promise<FileBinding[]> {
  const file = config.version.file;
  const absolute = resolve(root, file);
  if (versionFileFormat(file) === "pubspec") {
    return [
      {
        path: file,
        absolute,
        field: "version.file",
        stamper: pubspec,
        options: undefined,
        value: "version",
        build: true,
        ciOnly: false,
      },
    ];
  }
  const bindings: FileBinding[] = [
    {
      path: file,
      absolute,
      field: "version.file",
      stamper: jsonValue,
      options: { key: "version" },
      value: "version",
      build: false,
      ciOnly: false,
    },
  ];
  if (basename(file) === "package.json") {
    for (const lock of ["package-lock.json", "npm-shrinkwrap.json"]) {
      const lockAbsolute = join(dirname(absolute), lock);
      if (await isFile(lockAbsolute)) {
        const path = join(dirname(file), lock).replaceAll("\\", "/");
        bindings.push({
          path,
          absolute: lockAbsolute,
          field: "version.file",
          stamper: npmLockfile,
          options: undefined,
          value: "version",
          build: false,
          ciOnly: false,
        });
      }
    }
  }
  return bindings;
}

/** Read the root version from `version.file`. */
export async function readRootVersion(config: ResolvedConfig, root: string): Promise<string> {
  const absolute = resolve(root, config.version.file);
  const text = await readFile(absolute, "utf8").catch((error: NodeJS.ErrnoException) => {
    throw new LaunchsetError(
      "version-file-missing",
      `version.file: can't read ${config.version.file} (${error.code ?? error.message})`,
    );
  });
  const found =
    versionFileFormat(config.version.file) === "pubspec"
      ? pubspec.read(text, config.version.file, undefined)
      : jsonValue.read(text, config.version.file, { key: "version" });
  const value = found.find((f) => f.field === "marketing")?.value;
  if (!value) {
    throw new LaunchsetError("no-root-version", `${config.version.file} has no "version"`, {
      hint: rootVersionHint(config.version.file),
    });
  }
  return value;
}

interface Values {
  /** Version for the target's platform (already plain for iOS). */
  version: string;
  build?: number;
  imageTag?: string;
}

function valuesFor(binding: FileBinding, values: Values, withBuild: boolean): StampValues {
  const marketing = binding.value === "image-tag" ? values.imageTag : values.version;
  if (marketing === undefined) {
    throw new Error(`internal: no ${binding.value} value for ${binding.path}`);
  }
  const out: StampValues = { marketing };
  if (withBuild && binding.build && values.build !== undefined) out.build = values.build;
  return out;
}

/** Applies bindings in order; several bindings may edit the same file (e.g. a shared app.json). */
async function apply(
  bindings: { binding: FileBinding; values: StampValues }[],
): Promise<FileChange[]> {
  const texts = new Map<string, { path: string; before: string; current: string }>();
  for (const { binding, values } of bindings) {
    let entry = texts.get(binding.absolute);
    if (!entry) {
      const text = await readFile(binding.absolute, "utf8");
      entry = { path: binding.path, before: text, current: text };
      texts.set(binding.absolute, entry);
    }
    entry.current = binding.stamper.write(entry.current, binding.path, values, binding.options);
  }
  const changes: FileChange[] = [];
  for (const [absolute, entry] of texts) {
    if (entry.current !== entry.before) {
      changes.push({ path: entry.path, absolute, before: entry.before, after: entry.current });
    }
  }
  return changes;
}

function targetValues(target: ResolvedTarget, version: string): Values {
  const values: Values = { version: marketingVersion(target.type, version) };
  if (target.type === "docker") values.imageTag = releaseVerifyTag(target, version);
  return values;
}

/**
 * The release PR's file edits (spec 9.3): root version file (+ lockfile) and every target's
 * marketing version, manual targets included. No build numbers, no CI-only entries.
 */
export async function stampForRelease(
  config: ResolvedConfig,
  root: string,
  version: string,
): Promise<FileChange[]> {
  const work: { binding: FileBinding; values: StampValues }[] = [];
  for (const binding of await versionFileBindings(config, root)) {
    work.push({ binding, values: { marketing: version } });
  }
  for (const target of Object.values(config.targets)) {
    const values = targetValues(target, version);
    for (const binding of await targetBindings(target, root)) {
      if (binding.ciOnly) continue;
      work.push({ binding, values: valuesFor(binding, values, false) });
    }
  }
  return apply(work);
}

/**
 * `launchset stamp --target` in CI: the run's version into the root version file
 * (+ lockfile) and the target's files, plus the target's build number. Never committed.
 */
export async function stampForBuild(
  config: ResolvedConfig,
  root: string,
  plan: Pick<Plan, "version">,
  targetPlan: TargetPlan,
): Promise<FileChange[]> {
  const target = config.targets[targetPlan.name];
  if (!target) {
    throw new LaunchsetError("unknown-target", `unknown target "${targetPlan.name}"`, {
      hint: `Known targets: ${Object.keys(config.targets).join(", ")}`,
    });
  }
  const build = targetPlan.buildNumber ?? undefined;
  if (build !== undefined) assertBuildNumberFits(target.type, build, target.name);
  const values: Values = { version: targetPlan.marketingVersion };
  if (build !== undefined) values.build = build;
  if (targetPlan.docker) values.imageTag = targetPlan.docker.verifyTag;

  const work: { binding: FileBinding; values: StampValues }[] = [];
  const own = await targetBindings(target, root);
  // A target that stamps the version file itself (a Flutter app's pubspec.yaml) writes its own
  // values: for iOS the plain version, so the root's full preview version must not go there.
  const ownFiles = new Set(own.map((b) => b.absolute));
  for (const binding of await versionFileBindings(config, root)) {
    if (ownFiles.has(binding.absolute)) continue;
    const rootValues: StampValues = { marketing: plan.version };
    if (binding.build && build !== undefined) rootValues.build = build;
    work.push({ binding, values: rootValues });
  }
  for (const binding of own) {
    work.push({ binding, values: valuesFor(binding, values, true) });
  }
  return apply(work);
}

/** Write changes to disk. */
export async function writeChanges(changes: FileChange[]): Promise<void> {
  for (const change of changes) await writeFile(change.absolute, change.after);
}

/** A committed marketing version that differs from the root version (spec 6.7). */
export interface Mismatch {
  /** Target name, or `null` for the version file's npm lockfile. */
  target: string | null;
  path: string;
  /** Values found, e.g. `versionName = 1.3.0`. */
  found: FoundValue[];
  expected: string;
}

/**
 * Spec 6.7: every target's committed marketing version equals the root version (plain
 * for iOS; the docker verify tag for image manifests). A file is consistent when stamping
 * the expected value is a no-op.
 */
export async function checkConsistency(config: ResolvedConfig, root: string): Promise<Mismatch[]> {
  const version = await readRootVersion(config, root);
  const mismatches: Mismatch[] = [];
  const check = async (target: string | null, binding: FileBinding, expected: string) => {
    const text = await readFile(binding.absolute, "utf8");
    const after = binding.stamper.write(
      text,
      binding.path,
      { marketing: expected },
      binding.options,
    );
    if (after !== text) {
      const found = binding.stamper
        .read(text, binding.path, binding.options)
        .filter((value: FoundValue) => value.field === "marketing");
      mismatches.push({ target, path: binding.path, found, expected });
    }
  };
  for (const binding of (await versionFileBindings(config, root)).slice(1)) {
    await check(null, binding, version);
  }
  for (const target of Object.values(config.targets)) {
    const values = targetValues(target, version);
    for (const binding of await targetBindings(target, root)) {
      if (binding.ciOnly) continue;
      const expected = binding.value === "image-tag" ? values.imageTag : values.version;
      if (expected !== undefined) await check(target.name, binding, expected);
    }
  }
  return mismatches;
}
