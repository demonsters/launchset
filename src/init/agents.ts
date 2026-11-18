/**
 * Agent skill (spec 11.1 step 7, 16.2): copies the launchset skill into
 * `.claude/skills/launchset/SKILL.md` and keeps a launchset section in `AGENTS.md` between
 * markers, so running init again updates it in place.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { absolute, readTextOrNull } from "./fs.ts";
import { readPackageFile } from "./package-files.ts";
import { eolOf } from "./text-edit.ts";
import type { Change } from "./types.ts";

export const AGENTS_START = "<!-- launchset:start -->";
export const AGENTS_END = "<!-- launchset:end -->";
export const SKILL_PATH = ".claude/skills/launchset/SKILL.md";
export const AGENTS_PATH = "AGENTS.md";

/** `existing` with the launchset section added or replaced. */
export function upsertAgentsSection(existing: string | null, snippet: string): string {
  const eol = existing ? eolOf(existing) : "\n";
  const body = snippet.replace(/\r\n/g, "\n").trim().split("\n").join(eol);
  const block = `${AGENTS_START}${eol}${body}${eol}${AGENTS_END}`;
  if (existing === null || existing.trim() === "") return `${block}${eol}`;
  const start = existing.indexOf(AGENTS_START);
  const end = existing.indexOf(AGENTS_END);
  if (start !== -1 && end > start) {
    return existing.slice(0, start) + block + existing.slice(end + AGENTS_END.length);
  }
  const sep = existing.endsWith(`${eol}${eol}`)
    ? ""
    : existing.endsWith(eol)
      ? eol
      : `${eol}${eol}`;
  return `${existing}${sep}${block}${eol}`;
}

async function writeIfChanged(root: string, path: string, text: string): Promise<Change | null> {
  const file = absolute(root, path);
  const before = await readTextOrNull(file);
  if (before === text) return null;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  return {
    path,
    action: before === null ? "created" : "updated",
    summary: path === SKILL_PATH ? "launchset agent skill" : "launchset section for agents",
  };
}

/** Install the skill and the AGENTS.md section. */
export async function installSkill(root: string): Promise<Change[]> {
  const skill = readPackageFile("skills", "launchset", "SKILL.md");
  const snippet = readPackageFile("skills", "launchset", "AGENTS-snippet.md");
  const changes: Change[] = [];
  const a = await writeIfChanged(root, SKILL_PATH, skill);
  if (a) changes.push(a);
  const existing = await readTextOrNull(absolute(root, AGENTS_PATH));
  const b = await writeIfChanged(root, AGENTS_PATH, upsertAgentsSection(existing, snippet));
  if (b) changes.push(b);
  return changes;
}
