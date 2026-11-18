/**
 * Changesets migration (spec 4.2, 11.1 step 6): converts `.changeset/*.md` into
 * `.launchset/` changesets. `.changeset/config.json`, `README.md` and the files themselves
 * are left alone; `pre.json` (pre mode) is ignored with a warning (spec 9.9).
 */

import { mkdir, readdir, writeFile } from "node:fs/promises";
import {
  CHANGESET_DIR,
  convertChangesetsFile,
  generateChangesetName,
  serializeChangeset,
} from "../core/changesets.ts";
import { absolute, isFile, readTextOrNull } from "./fs.ts";
import type { Change } from "./types.ts";

export const CHANGESETS_DIR = ".changeset";

export interface ChangesetsFound {
  /** Repo-relative paths of the Changesets files to convert, sorted. */
  files: string[];
  /** `.changeset/pre.json` exists. */
  preMode: boolean;
}

export async function findChangesets(root: string): Promise<ChangesetsFound> {
  let names: string[];
  try {
    names = await readdir(absolute(root, CHANGESETS_DIR));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { files: [], preMode: false };
    throw error;
  }
  const files = names
    .filter((n) => n.endsWith(".md") && n.toLowerCase() !== "readme.md")
    .sort()
    .map((n) => `${CHANGESETS_DIR}/${n}`);
  return { files, preMode: await isFile(absolute(root, `${CHANGESETS_DIR}/pre.json`)) };
}

export interface PlannedConversion {
  from: string;
  to: string;
  text: string;
  /** True when `to` already exists (an earlier run converted it): nothing is written. */
  exists: boolean;
  /** True when the file had a bump but no summary, so a TODO placeholder was written. */
  placeholder: boolean;
}

const THREE_WORDS = /^[a-z]+-[a-z]+-[a-z]+\.md$/;

/** A deterministic random source seeded from a string (FNV-1a hash, mulberry32 generator). */
export function seededRng(seed: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function placeholderSummary(from: string): string {
  return `TODO: describe this change (converted from ${from})`;
}

/** `text` with a placeholder summary when it has a bump but no summary; else `null`. */
function withPlaceholder(text: string, from: string): string | null {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(text);
  if (!m || (m[1] ?? "").trim() === "" || (m[2] ?? "").trim() !== "") return null;
  return `${text.replace(/\s*$/, "")}\n\n${placeholderSummary(from)}\n`;
}

/**
 * Convert every file in memory (all or nothing: a broken file throws before anything is
 * written). Names are deterministic: the Changesets name when it's already three words, else
 * three words seeded from the source path, so a re-run picks the same name. A source whose
 * target already exists was converted before and is skipped.
 */
export async function planConversion(
  root: string,
  found: ChangesetsFound,
): Promise<PlannedConversion[]> {
  const taken = new Set<string>();
  const planned: PlannedConversion[] = [];
  for (const from of found.files) {
    const source = await readTextOrNull(absolute(root, from));
    if (source === null) continue;
    const filled = withPlaceholder(source, from);
    const { changeset } = convertChangesetsFile(filled ?? source, from);
    const text = serializeChangeset(changeset);
    const original = from.slice(from.lastIndexOf("/") + 1);
    const name =
      THREE_WORDS.test(original) && !taken.has(original)
        ? original
        : generateChangesetName(taken, seededRng(from));
    taken.add(name);
    const to = `${CHANGESET_DIR}/${name}`;
    const exists = await isFile(absolute(root, to));
    planned.push({ from, to, text, exists, placeholder: filled !== null });
  }
  return planned;
}

export async function writeConversion(
  root: string,
  planned: PlannedConversion[],
): Promise<Change[]> {
  const changes: Change[] = [];
  for (const p of planned) {
    if (p.exists) continue;
    await mkdir(absolute(root, CHANGESET_DIR), { recursive: true });
    await writeFile(absolute(root, p.to), p.text);
    changes.push({ path: p.to, action: "created", summary: `converted from ${p.from}` });
  }
  return changes;
}

export const PRE_MODE_WARNING =
  ".changeset/pre.json (Changesets pre mode) is ignored: launchset has no pre mode. Use a prerelease branch instead (preview.branches with prerelease), and run `launchset init --convert-only` on that branch.";

export const DELETE_CHANGESET_HINT =
  "The .changeset/ folder is no longer used: you can delete it (config.json and README.md were left alone).";
