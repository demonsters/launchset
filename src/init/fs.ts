/** Small file helpers for init. Paths given to callers are repo-relative POSIX. */

import { readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { glob } from "tinyglobby";

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
];

/** Files larger than this are skipped by the text scans. */
export const MAX_SCAN_BYTES = 1024 * 1024;

export async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

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

/** Repo-relative POSIX path (`.` for the root itself). */
export function toRel(root: string, absolute: string): string {
  const rel = relative(root, absolute);
  return (rel === "" ? "." : rel).split(sep).join("/");
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
 * Glob relative to `root` (sorted), never descending into {@link IGNORED_DIRS}. With `base`,
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
  return found.map((p) => joinRel(base, p.replace(/\/+$/, ""))).sort();
}

/** 1-based line number of a character offset. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Start offset of the line containing `offset`. */
export function lineStart(text: string, offset: number): number {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

/** Offset just after the newline ending the line that contains `offset` (or the text end). */
export function lineEnd(text: string, offset: number): number {
  const index = text.indexOf("\n", offset);
  return index === -1 ? text.length : index + 1;
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
