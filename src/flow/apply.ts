/**
 * The release PR commit's file changes (spec 9.3), shared by the release PR and
 * `launchset version`: delete the consumed changesets, bump the root version (+ npm
 * lockfile), stamp every target's marketing version, prepend the changelog section.
 */

import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { insertSection } from "../core/changelog.ts";
import type { ReleasePrContent } from "../core/release-pr.ts";
import { Git } from "../git/index.ts";
import { stampForRelease } from "../platforms/index.ts";
import type { FlowContext } from "./context.ts";

/** One file edit. `before`/`after` are `null` for a file that doesn't exist (yet / anymore). */
export interface PlannedChange {
  /** Repo-relative POSIX path. */
  path: string;
  absolute: string;
  before: string | null;
  after: string | null;
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * The working-tree edits that apply `content` (nothing is written): version files and
 * marketing versions (`stampForRelease`), the changelog, and the deleted changesets.
 */
export async function planReleaseChanges(
  context: FlowContext,
  content: ReleasePrContent,
): Promise<PlannedChange[]> {
  const { git } = context;
  const top = await git.topLevel();
  const changes: PlannedChange[] = [];
  for (const change of await stampForRelease(context.config, context.cwd, content.version)) {
    changes.push({
      path: await git.toRepoPath(change.path),
      absolute: change.absolute,
      before: change.before,
      after: change.after,
    });
  }
  const changelogAbsolute = resolve(context.cwd, content.changelogFile);
  const changelogBefore = await readOrNull(changelogAbsolute);
  changes.push({
    path: await git.toRepoPath(content.changelogFile),
    absolute: changelogAbsolute,
    before: changelogBefore,
    after: insertSection(changelogBefore, content.section),
  });
  for (const path of content.deletePaths) {
    const absolute = join(top, path);
    const before = await readOrNull(absolute);
    if (before !== null) changes.push({ path, absolute, before, after: null });
  }
  return changes;
}

/** Write (or delete) the planned files. */
export async function writePlannedChanges(changes: readonly PlannedChange[]): Promise<void> {
  for (const change of changes) {
    if (change.after === null) {
      await unlink(change.absolute).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    } else {
      await mkdir(dirname(change.absolute), { recursive: true });
      await writeFile(change.absolute, change.after);
    }
  }
}

/**
 * A unified diff (git format, `a/`/`b/` prefixes) of planned changes, made with
 * `git diff --no-index` on temporary copies. Empty when nothing changes.
 */
export async function unifiedDiff(changes: readonly PlannedChange[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "launchset-diff-"));
  try {
    const git = new Git({ cwd: dir });
    const parts: string[] = [];
    for (const [index, change] of changes.entries()) {
      if (change.before === change.after) continue;
      const a = `a${index}/${change.path}`;
      const b = `b${index}/${change.path}`;
      if (change.before !== null) {
        await mkdir(dirname(join(dir, a)), { recursive: true });
        await writeFile(join(dir, a), change.before);
      }
      if (change.after !== null) {
        await mkdir(dirname(join(dir, b)), { recursive: true });
        await writeFile(join(dir, b), change.after);
      }
      const out = await git.run(
        [
          "diff",
          "--no-index",
          "--no-color",
          "--no-ext-diff",
          "--no-prefix",
          "--",
          change.before === null ? "/dev/null" : a,
          change.after === null ? "/dev/null" : b,
        ],
        { okCodes: [1], raw: true },
      );
      parts.push(relabel(out, change.path, index));
    }
    return parts.join("");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Replace the temporary paths in a diff's header lines with `a/<path>` and `b/<path>`. */
function relabel(diff: string, path: string, index: number): string {
  const lines = diff.split("\n");
  let inHeader = true;
  return lines
    .map((line) => {
      if (!inHeader) return line;
      if (line.startsWith("@@")) {
        inHeader = false;
        return line;
      }
      if (line.startsWith("diff --git ")) return `diff --git a/${path} b/${path}`;
      if (line.startsWith("--- ") && line !== "--- /dev/null") return `--- a/${path}`;
      if (line.startsWith("+++ ") && line !== "+++ /dev/null") return `+++ b/${path}`;
      return line.replaceAll(`a${index}/`, "a/").replaceAll(`b${index}/`, "b/");
    })
    .join("\n");
}
