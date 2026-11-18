/**
 * Config loader (spec 5): finds `launchset.config.*`, loads it (TS/JS with jiti, JSON with
 * `JSON.parse`), validates it with `resolveConfig`, and checks that every file the config
 * references exists. I/O lives here; validation rules live in `src/core/config/schema.ts`.
 */

import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createJiti } from "jiti";
import { glob, isDynamicPattern } from "tinyglobby";
import {
  ConfigError,
  type ConfigIssue,
  defineConfig,
  type ResolvedConfig,
  type ResolvedTarget,
  resolveConfig,
} from "../core/config/schema.ts";
import { LaunchsetError } from "../core/errors.ts";
import { statOrNull, toRel } from "./fs.ts";

/** Config file names, in the order they're reported. */
export const CONFIG_FILE_NAMES = [
  "launchset.config.ts",
  "launchset.config.mts",
  "launchset.config.mjs",
  "launchset.config.js",
  "launchset.config.json",
] as const;

export interface LoadedConfig {
  config: ResolvedConfig;
  /** Absolute path of the config file. */
  file: string;
  /** Absolute path of the directory paths in the config are relative to. */
  root: string;
}

/**
 * The config file in `dir` (absolute path). Throws when there is none (suggesting
 * `launchset init`) or more than one.
 */
export async function findConfigFile(dir: string): Promise<string> {
  const root = resolve(dir);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    throw new LaunchsetError("no-config", `can't read the directory ${root}`, {
      cause: error,
      hint: "Pass the repo root with --cwd (or working-directory in the action).",
    });
  }
  const found = CONFIG_FILE_NAMES.filter((name) => entries.includes(name));
  if (found.length === 0) {
    throw new LaunchsetError("no-config", `no launchset config found in ${root}`, {
      hint: `Run \`launchset init\` to create one, or pass the directory that has it with --cwd. Looked for: ${CONFIG_FILE_NAMES.join(", ")}.`,
    });
  }
  if (found.length > 1) {
    throw new LaunchsetError(
      "multiple-configs",
      `found more than one launchset config in ${root}: ${found.join(", ")}`,
      { hint: "Keep one of them and delete the others." },
    );
  }
  return join(root, found[0] as string);
}

/** Loads the raw (unvalidated) config value from a file. */
export async function readConfigFile(file: string): Promise<unknown> {
  const name = file.split(/[\\/]/).at(-1) ?? file;
  if (file.endsWith(".json")) {
    const text = await readFile(file, "utf8");
    try {
      return JSON.parse(text.replace(/^﻿/, ""));
    } catch (error) {
      throw new LaunchsetError(
        "invalid-config",
        `${name}: invalid JSON (${(error as Error).message})`,
        {
          cause: error,
        },
      );
    }
  }
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    fsCache: false,
    // The raw namespace, so a missing default export can be told apart from a config.
    interopDefault: false,
    // Configs import `defineConfig` from the package; this works even where the package
    // isn't installed (the bundled GitHub Action).
    virtualModules: { "@demonsters/launchset": { defineConfig, default: { defineConfig } } },
  });
  let mod: unknown;
  try {
    mod = await jiti.import(file);
  } catch (error) {
    throw new LaunchsetError(
      "invalid-config",
      `${name}: failed to load: ${(error as Error).message}`,
      {
        cause: error,
        hint: "Fix the error in the config file. It must `export default defineConfig({ ... })`.",
      },
    );
  }
  const value =
    mod !== null && typeof mod === "object" && "default" in mod
      ? (mod as { default: unknown }).default
      : undefined;
  if (value === undefined) {
    throw new LaunchsetError("invalid-config", `${name}: no default export`, {
      hint: "Export the config with `export default defineConfig({ ... })`.",
    });
  }
  return value;
}

/** Which file format a source file is, for the stamping layer. */
export type SourceFormat =
  | "gradle"
  | "gradle-properties"
  | "pbxproj"
  | "plist"
  | "xcconfig"
  | "expo";

export interface SourceFile {
  /** Config field the path comes from, e.g. `targets.android.source.file`. */
  field: string;
  format: SourceFormat;
  /** Root-relative POSIX path of the file to edit (`.../project.pbxproj` for xcodeproj). */
  path: string;
  /** Absolute path. */
  absolute: string;
}

interface Resolved {
  files: SourceFile[];
  issues: ConfigIssue[];
}

function makeFile(root: string, field: string, format: SourceFormat, path: string): SourceFile {
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  return { field, format, path: toRel(root, absolute), absolute };
}

async function collectSourceFiles(target: ResolvedTarget, root: string): Promise<Resolved> {
  const files: SourceFile[] = [];
  const issues: ConfigIssue[] = [];
  const base = `targets.${target.name}.source`;

  const needFile = async (field: string, format: SourceFormat, path: string) => {
    const file = makeFile(root, field, format, path);
    const info = await statOrNull(file.absolute);
    if (!info?.isFile()) {
      issues.push({
        path: field,
        message: info ? `not a file: ${file.path}` : `file not found: ${file.path}`,
      });
      return;
    }
    files.push(file);
  };

  const needXcodeproj = async (field: string, path: string) => {
    const dir = isAbsolute(path) ? path : resolve(root, path);
    const info = await statOrNull(dir);
    if (!info?.isDirectory()) {
      issues.push({
        path: field,
        message: info
          ? `expected the .xcodeproj directory, got a file: ${toRel(root, dir)}`
          : `Xcode project not found: ${toRel(root, dir)}`,
      });
      return;
    }
    await needFile(field, "pbxproj", join(dir, "project.pbxproj"));
  };

  if (target.type === "android") {
    const source = target.source;
    switch (source.kind) {
      case "gradle":
        await needFile(`${base}.file`, "gradle", source.file);
        break;
      case "gradle-properties":
        await needFile(`${base}.file`, "gradle-properties", source.file);
        break;
      case "expo":
        await needFile(`${base}.file`, "expo", source.file);
        break;
      case "capacitor": {
        const groovy = join(source.dir, "android/app/build.gradle");
        const kts = join(source.dir, "android/app/build.gradle.kts");
        const [g, k] = await Promise.all([
          statOrNull(resolve(root, groovy)),
          statOrNull(resolve(root, kts)),
        ]);
        if (g?.isFile() && k?.isFile()) {
          issues.push({
            path: `${base}.dir`,
            message: `both ${toRel(root, resolve(root, groovy))} and build.gradle.kts exist: use source { kind: "gradle", file } to pick one`,
          });
        } else if (g?.isFile()) {
          files.push(makeFile(root, `${base}.dir`, "gradle", groovy));
        } else if (k?.isFile()) {
          files.push(makeFile(root, `${base}.dir`, "gradle", kts));
        } else {
          issues.push({
            path: `${base}.dir`,
            message: `file not found: ${toRel(root, resolve(root, groovy))} (or build.gradle.kts)`,
          });
        }
        break;
      }
    }
  } else if (target.type === "ios") {
    const source = target.source;
    switch (source.kind) {
      case "xcodeproj":
        await needXcodeproj(`${base}.file`, source.file);
        break;
      case "capacitor":
        await needXcodeproj(`${base}.dir`, join(source.dir, "ios/App/App.xcodeproj"));
        break;
      case "plist":
        for (const [index, file] of source.files.entries()) {
          await needFile(`${base}.files.${index}`, "plist", file);
        }
        break;
      case "xcconfig":
        await needFile(`${base}.file`, "xcconfig", source.file);
        break;
      case "expo":
        await needFile(`${base}.file`, "expo", source.file);
        break;
    }
  }
  return { files, issues };
}

/**
 * The files a target's `source` points at, with capacitor aliases and `.xcodeproj`
 * directories resolved (spec 6.3, 6.4). Docker, web and custom targets have none. Throws
 * `ConfigError` when a file is missing.
 */
export async function resolveSourcePaths(
  target: ResolvedTarget,
  root: string,
): Promise<SourceFile[]> {
  const { files, issues } = await collectSourceFiles(target, resolve(root));
  if (issues.length > 0) throw new ConfigError(issues);
  return files;
}

/**
 * Root-relative paths matched by an `image` file entry (a path or a glob), sorted. Empty
 * when nothing matches.
 */
export async function expandFilePattern(pattern: string, root: string): Promise<string[]> {
  if (!isDynamicPattern(pattern)) {
    const info = await statOrNull(resolve(root, pattern));
    return info?.isFile() ? [toRel(root, resolve(root, pattern))] : [];
  }
  const matches = await glob([pattern], {
    cwd: root,
    onlyFiles: true,
    dot: true,
    ignore: ["**/node_modules/**"],
    expandDirectories: false,
  });
  return matches.sort();
}

/**
 * Every problem with files the config references (spec 5: "Source files referenced by
 * targets must exist"): `version.file`, target sources, `files` entries (image globs must
 * match at least one file) and `npm.package`.
 */
export async function checkReferencedFiles(
  config: ResolvedConfig,
  root: string,
): Promise<ConfigIssue[]> {
  const absRoot = resolve(root);
  const issues: ConfigIssue[] = [];
  const exists = async (field: string, path: string) => {
    const absolute = resolve(absRoot, path);
    const info = await statOrNull(absolute);
    if (!info?.isFile()) {
      issues.push({
        path: field,
        message: info
          ? `not a file: ${toRel(absRoot, absolute)}`
          : `file not found: ${toRel(absRoot, absolute)}`,
      });
    }
  };

  await exists("version.file", config.version.file);
  for (const target of Object.values(config.targets)) {
    issues.push(...(await collectSourceFiles(target, absRoot)).issues);
    const base = `targets.${target.name}`;
    for (const [index, entry] of target.files.entries()) {
      const field = `${base}.files.${index}.path`;
      if (entry.kind === "image") {
        if ((await expandFilePattern(entry.path, absRoot)).length === 0) {
          issues.push({
            path: field,
            message: isDynamicPattern(entry.path)
              ? `no file matches ${entry.path}`
              : `file not found: ${entry.path}`,
          });
        }
      } else {
        await exists(field, entry.path);
      }
    }
    if (target.type === "custom" && target.npm) {
      await exists(`${base}.npm.package`, target.npm.package);
    }
  }
  return issues;
}

/**
 * Find, load, validate and check the config in `cwd` (spec 5). Throws `LaunchsetError`
 * when there is no config file (or several) or it can't be loaded, and `ConfigError`
 * (naming each field) when it's invalid or references missing files.
 */
export async function loadConfig(cwd: string): Promise<LoadedConfig> {
  const root = resolve(cwd);
  const file = await findConfigFile(root);
  const name = toRel(root, file);
  const raw = await readConfigFile(file);
  const config = resolveConfig(raw, { file: name });
  const issues = await checkReferencedFiles(config, root);
  if (issues.length > 0) throw new ConfigError(issues, name);
  return { config, file, root };
}
