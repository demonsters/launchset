/**
 * Release-commit detection (glossary "Release commit", spec 9.3 `release-sha` on a retry).
 *
 * The release commit is the newest commit on a branch's **first-parent** history whose root
 * version differs from its first parent's. Commits reached only through a second parent (a
 * release PR's side branch, a local merge) are never considered, so a retry finds the same
 * commit as the original run.
 */

import type { Git } from "./index.ts";

/** Reads the root version at a commit; undefined when the file or field is missing. */
export type ReadVersion = (sha: string) => Promise<string | undefined>;

export interface FindReleaseCommitOptions {
  /**
   * The version file(s), repo-relative, to narrow the walk to commits that changed them. Only an
   * optimisation: every candidate is still checked with `readVersion`.
   */
  paths?: string[];
}

/**
 * Read `version` from the JSON version file at commit `sha`. `file` is repo-relative (convert
 * a config-root-relative `version.file` with `git.toRepoPath`).
 */
export async function readRootVersion(
  git: Git,
  sha: string,
  file: string,
): Promise<string | undefined> {
  const text = await git.showFile(sha, file);
  if (text === undefined) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    throw new Error(
      `Could not parse ${file} at commit ${sha.slice(0, 12)}: ${(error as Error).message}\n` +
        `Hint: the version file must be valid JSON in every commit launchset inspects.`,
    );
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const version = (data as Record<string, unknown>).version;
    if (typeof version === "string") return version;
  }
  return undefined;
}

/** A `readVersion` for a JSON version file, cached per sha. */
export function versionReader(git: Git, file: string): ReadVersion {
  const cache = new Map<string, Promise<string | undefined>>();
  return (sha) => {
    let value = cache.get(sha);
    if (!value) {
      value = readRootVersion(git, sha, file);
      cache.set(sha, value);
    }
    return value;
  };
}

/**
 * The release commit of `ref`: the newest first-parent commit whose root version differs
 * from its first parent's (a root commit with a version counts as a change). Undefined when
 * no commit ever set a version.
 */
export async function findReleaseCommit(
  git: Git,
  ref: string,
  readVersion: ReadVersion,
  options: FindReleaseCommitOptions = {},
): Promise<string | undefined> {
  if (options.paths?.length) {
    // `--first-parent` with a pathspec lists first-parent commits that changed one of the
    // paths compared with their first parent: a superset of the version changes.
    const candidates = await git.revList(ref, { firstParent: true, paths: options.paths });
    for (const sha of candidates) {
      if (await isVersionChange(git, sha, readVersion)) return sha;
    }
    return undefined;
  }

  // Walk the first-parent chain: each entry's first parent is the next entry.
  const chain = await git.firstParentLog(ref);
  let newer = chain[0];
  if (newer === undefined) return undefined;
  let newerVersion = await readVersion(newer);
  for (let i = 1; i <= chain.length; i++) {
    const older = chain[i];
    const olderVersion = older === undefined ? undefined : await readVersion(older);
    if (newerVersion !== olderVersion) return newer;
    if (older === undefined) break;
    newer = older;
    newerVersion = olderVersion;
  }
  return undefined;
}

/** True when the root version at `sha` differs from its first parent's (or `sha` is a root). */
async function isVersionChange(git: Git, sha: string, readVersion: ReadVersion): Promise<boolean> {
  const [firstParent] = await git.parents(sha);
  const version = await readVersion(sha);
  const parentVersion = firstParent === undefined ? undefined : await readVersion(firstParent);
  return version !== parentVersion;
}

/** True when `ref` (default HEAD) changed the root version compared with its first parent. */
export async function headIsReleaseCommit(
  git: Git,
  readVersion: ReadVersion,
  ref = "HEAD",
): Promise<boolean> {
  return isVersionChange(git, await git.revParse(ref), readVersion);
}
