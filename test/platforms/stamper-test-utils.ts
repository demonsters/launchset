import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { StampError } from "../../src/platforms/types.ts";

/** Reads `test/fixtures/<path>` without touching line endings. */
export function fixture(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${path}`, import.meta.url)), "utf8");
}

/** Replaces `from` with `to`; fails the test unless `from` occurs exactly once. */
export function replaceOnce(text: string, from: string, to: string): string {
  const count = text.split(from).length - 1;
  if (count !== 1)
    throw new Error(`expected exactly one occurrence of ${JSON.stringify(from)}, found ${count}`);
  return text.replace(from, () => to);
}

/** Applies several exact `[from, to]` replacements, each of which must match once. */
export function replaceEach(text: string, pairs: [string, string][]): string {
  return pairs.reduce((acc, [from, to]) => replaceOnce(acc, from, to), text);
}

/** Number of lines that differ between two texts with the same number of lines. */
export function changedLines(before: string, after: string): number {
  const a = before.split(/\r\n|\n/);
  const b = after.split(/\r\n|\n/);
  expect(b.length).toBe(a.length);
  return a.filter((line, i) => line !== b[i]).length;
}

/** 1-based line of the first occurrence of `needle`. */
export function lineOfText(text: string, needle: string): number {
  const at = text.indexOf(needle);
  if (at === -1) throw new Error(`${JSON.stringify(needle)} not in text`);
  return text.slice(0, at).split("\n").length;
}

/** Asserts that `fn` throws a StampError for `file` whose message contains every snippet. */
export function expectStampError(fn: () => unknown, file: string, ...snippets: string[]): void {
  let error: unknown;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(StampError);
  const err = error as StampError;
  expect(err.file).toBe(file);
  expect(err.message.startsWith(`${file}: `)).toBe(true);
  for (const s of snippets) expect(err.message).toContain(s);
}
