/** File helpers shared by config loading and init. */

import { stat } from "node:fs/promises";
import { relative, sep } from "node:path";

/** `stat`, or `null` when the path (or a parent) doesn't exist. */
export async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

/** Repo-relative POSIX path (`.` for the root itself). */
export function toRel(root: string, absolute: string): string {
  const rel = relative(root, absolute);
  return (rel === "" ? "." : rel).split(sep).join("/");
}
