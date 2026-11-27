/** Small file helpers for init. Paths given to callers are repo-relative POSIX. */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { glob } from "tinyglobby";
import { statOrNull } from "../config/fs.ts";

/** Directories init never looks into. */
export const IGNORED_DIRS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/Pods/**",
  "**/DerivedData/**",
  "**/.gradle/**",
  "**/build/**",
  "**/dist/**",
  "**/vendor/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/.dart_tool/**",
  "**/.symlinks/**",
];

/** Files larger than this are skipped by the text scans. */
export const MAX_SCAN_BYTES = 1024 * 1024;

export { statOrNull };

export async function isFile(path: string): Promise<boolean> {
  return (await statOrNull(path))?.isFile() ?? false;
}

export async function isDirectory(path: string): Promise<boolean> {
  return (await statOrNull(path))?.isDirectory() ?? false;
}

/** File text, or `null` when the file doesn't exist. */
export async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return null;
    throw error;
  }
}

/** `join` for repo-relative POSIX paths, where `.` is the root. */
export function joinRel(dir: string, ...parts: string[]): string {
  const all = [dir, ...parts].filter((p) => p !== "" && p !== ".");
  const joined = all.join("/").replace(/\/+/g, "/");
  return joined === "" ? "." : joined;
}

export function dirOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "." : path.slice(0, index);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function absolute(root: string, rel: string): string {
  return resolve(root, rel);
}

/** Normalize a path written in a workflow or script: `./a/b/` → `a/b`, `.`/`` → `.`. */
export function normalizeRel(path: string): string {
  const cleaned = path
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "");
  return cleaned === "" || cleaned === "." ? "." : cleaned;
}

/**
 * The paths (relative to `root`) git ignores: matched by `.gitignore` and not tracked. Empty
 * outside a git repository or without git. Paths needn't exist.
 */
export function gitIgnored(root: string, paths: readonly string[]): Promise<Set<string>> {
  if (paths.length === 0) return Promise.resolve(new Set());
  return new Promise((done) => {
    const child = execFile(
      "git",
      ["check-ignore", "--stdin", "-z"],
      { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      // Exit 1 means nothing is ignored, 128 not a repository: both leave stdout empty.
      (_error, stdout) =>
        done(
          new Set(
            String(stdout ?? "")
              .split("\0")
              .filter(Boolean),
          ),
        ),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(`${paths.join("\0")}\0`);
  });
}

/**
 * Glob relative to `root` (sorted), never descending into {@link IGNORED_DIRS} and leaving out
 * what git ignores (a gitignored `out/` copy of the app is no target). With `base`,
 * patterns and `deep` are relative to that directory; results stay relative to `root`.
 */
export async function globRel(
  root: string,
  patterns: string[],
  options: { directories?: boolean; ignore?: string[]; deep?: number; base?: string } = {},
): Promise<string[]> {
  const base = options.base ?? ".";
  const cwd = resolve(root, base);
  if (!(await isDirectory(cwd))) return [];
  const found = await glob(patterns, {
    cwd,
    dot: true,
    onlyFiles: !options.directories,
    onlyDirectories: options.directories ?? false,
    ignore: [...IGNORED_DIRS, ...(options.ignore ?? [])],
    expandDirectories: false,
    ...(options.deep === undefined ? {} : { deep: options.deep }),
  });
  const paths = found.map((p) => joinRel(base, p.replace(/\/+$/, "")));
  const ignored = await gitIgnored(root, paths);
  return paths.filter((p) => !ignored.has(p)).sort();
}

/** The text's lines with their start offsets (line endings excluded from `text`). */
export function linesOf(text: string): { text: string; start: number; number: number }[] {
  const out: { text: string; start: number; number: number }[] = [];
  let start = 0;
  let number = 1;
  while (start <= text.length) {
    const end = text.indexOf("\n", start);
    const stop = end === -1 ? text.length : end;
    out.push({ text: text.slice(start, stop).replace(/\r$/, ""), start, number });
    if (end === -1) break;
    start = end + 1;
    number++;
  }
  return out;
}
