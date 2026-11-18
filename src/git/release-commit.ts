/**
 * Release-commit detection (glossary "Release commit", spec 9.3 `release-sha` on a retry).
 *
 * The release commit is the newest commit on a branch's **first-parent** history whose root
 * version differs from its first parent's. Commits reached only through a second parent (a
 * release PR's side branch, a local merge) are never considered, so a retry finds the same
 * commit as the original run.
 */

import { LaunchsetError } from "../core/errors.ts";
import { type Git, topPathspec } from "./index.ts";

/**
 * Reads the root version at a commit; undefined when the file or field is missing. `prefetch`
 * (optional) reads the versions at many commits in one go, for the reads that follow.
 */
export interface ReadVersion {
  (sha: string): Promise<string | undefined>;
  prefetch?(shas: readonly string[]): Promise<void>;
}

export interface FindReleaseCommitOptions {
  /**
   * The version file(s), repo-relative, to narrow the walk to commits that changed them. Only an
   * optimisation: every candidate is still checked with `readVersion`.
   */
  paths?: string[];
}

/** Candidates whose versions are read per `git cat-file --batch`. */
const BATCH = 64;

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
  return text === undefined ? undefined : parseRootVersion(text, file, sha);
}

/** The `version` field of a JSON version file's text (`file` at `sha`, for the error). */
function parseRootVersion(text: string, file: string, sha: string): string | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new LaunchsetError(
      "invalid-version-file",
      `Could not parse ${file} at commit ${sha.slice(0, 12)}: ${(error as Error).message}`,
      { hint: "The version file must be valid JSON in every commit launchset inspects." },
    );
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const version = (data as Record<string, unknown>).version;
    if (typeof version === "string") return version;
  }
  return undefined;
}

/**
 * A `readVersion` for a JSON version file, cached per sha. `prefetch` reads the file at many
 * commits with one `git cat-file --batch`; a text is parsed only when its version is read.
 */
export function versionReader(git: Git, file: string): ReadVersion {
  const cache = new Map<string, Promise<string | undefined>>();
  /** Prefetched file texts (`null`: no such file at that commit). */
  const texts = new Map<string, string | null>();
  const read: ReadVersion = (sha) => {
    let value = cache.get(sha);
    if (!value) {
      const text = texts.get(sha);
      value =
        text === undefined
          ? readRootVersion(git, sha, file)
          : Promise.resolve().then(() =>
              text === null ? undefined : parseRootVersion(text, file, sha),
            );
      cache.set(sha, value);
    }
    return value;
  };
  read.prefetch = async (shas) => {
    const wanted = [...new Set(shas)].filter((sha) => !cache.has(sha) && !texts.has(sha));
    if (wanted.length === 0) return;
    const blobs = await git.readBlobs(wanted.map((sha) => `${sha}:${file}`));
    for (const sha of wanted) texts.set(sha, blobs.get(`${sha}:${file}`) ?? null);
  };
  return read;
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
    // paths compared with their first parent: a superset of the version changes. `%P` prints
    // the real parents (no parent rewriting without `--parents`).
    const candidates = await firstParentCandidates(git, ref, options.paths);
    for (let start = 0; start < candidates.length; start += BATCH) {
      const batch = candidates.slice(start, start + BATCH);
      await readVersion.prefetch?.(
        batch.flatMap((c) => (c.firstParent ? [c.sha, c.firstParent] : [c.sha])),
      );
      for (const { sha, firstParent } of batch) {
        if (await isVersionChange(sha, firstParent, readVersion)) return sha;
      }
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

/** First-parent commits of `ref` that changed `paths`, newest first, with their first parent. */
async function firstParentCandidates(
  git: Git,
  ref: string,
  paths: string[],
): Promise<{ sha: string; firstParent: string | undefined }[]> {
  const out = await git.run([
    "-c",
    "log.follow=false",
    "log",
    "--first-parent",
    "--format=%H %P",
    "--end-of-options",
    ref,
    "--",
    ...paths.map(topPathspec),
  ]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", firstParent] = line.split(" ");
      return { sha, firstParent: firstParent || undefined };
    });
}

/** True when the root version at `sha` differs from its first parent's (or `sha` is a root). */
async function isVersionChange(
  sha: string,
  firstParent: string | undefined,
  readVersion: ReadVersion,
): Promise<boolean> {
  const version = await readVersion(sha);
  const parentVersion = firstParent === undefined ? undefined : await readVersion(firstParent);
  return version !== parentVersion;
}

/**
 * True when `ref` (default HEAD; pass the known sha to save a lookup) changed the root version
 * compared with its first parent. A commit whose first parent has no root version (the version
 * file appears, e.g. the merge that adopts launchset, or a root commit) is not a release
 * commit: it starts the version line, it doesn't release it. `findReleaseCommit` still counts
 * it, for explicit retries.
 */
export async function headIsReleaseCommit(
  git: Git,
  readVersion: ReadVersion,
  ref = "HEAD",
): Promise<boolean> {
  const [sha = "", firstParent] = await git.commitAndParents(ref);
  if (firstParent === undefined) return false;
  await readVersion.prefetch?.([sha, firstParent]);
  if ((await readVersion(firstParent)) === undefined) return false;
  return isVersionChange(sha, firstParent, readVersion);
}
