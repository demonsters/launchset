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
 * A unified diff (git format, `a/`/`b/` prefixes) of planned changes, in their order, made with
 * one `git diff --no-index` over temporary copies. Empty when nothing changes.
 */
export async function unifiedDiff(changes: readonly PlannedChange[]): Promise<string> {
  const changed = changes.filter((c) => c.before !== c.after);
  if (changed.length === 0) return "";
  const dir = await mkdtemp(join(tmpdir(), "launchset-diff-"));
  try {
    const write = async (side: string, path: string, text: string | null) => {
      if (text === null) return;
      const file = join(dir, side, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, text);
    };
    for (const change of changed) {
      await write("a", change.path, change.before);
      await write("b", change.path, change.after);
    }
    await mkdir(join(dir, "a"), { recursive: true });
    await mkdir(join(dir, "b"), { recursive: true });
    const out = await new Git({ cwd: dir }).run(
      [
        "diff",
        "--no-index",
        "--no-color",
        "--no-ext-diff",
        "--no-prefix",
        "--no-renames",
        "--",
        "a",
        "b",
      ],
      { okCodes: [1], raw: true },
    );
    // git walks the directories with each level sorted: one file diff per changed path, in
    // that order. Relabel each and put them back in the changes' order.
    const files = splitFileDiffs(out);
    const walked = changed.map((c) => c.path).sort(byTreeOrder);
    if (files.length !== walked.length) {
      throw new Error(`internal: ${files.length} file diffs for ${walked.length} changed files`);
    }
    const byPath = new Map(walked.map((path, i) => [path, relabel(files[i] ?? "", path)]));
    return changed.map((c) => byPath.get(c.path) ?? "").join("");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Paths in the order git walks a directory: segment by segment, each level sorted. */
function byTreeOrder(a: string, b: string): number {
  const left = a.split("/");
  const right = b.split("/");
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const x = left[i] as string;
    const y = right[i] as string;
    if (x !== y) return x < y ? -1 : 1;
  }
  return left.length - right.length;
}

/** A multi-file diff split at its `diff --git` lines. */
function splitFileDiffs(diff: string): string[] {
  const starts = [...diff.matchAll(/^diff --git /gm)].map((m) => m.index);
  return starts.map((start, i) => diff.slice(start, starts[i + 1] ?? diff.length));
}

/** Replace the temporary paths in a file diff's header lines with `a/<path>` and `b/<path>`. */
function relabel(diff: string, path: string): string {
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
      return line;
    })
    .join("\n");
}
