/**
 * Minimal text edits for retiring machinery: every edit is a splice on the original text,
 * found from YAML node ranges or line numbers, so every other byte stays identical.
 */

import { isSeq, type Node, type Pair, type Scalar, type YAMLSeq } from "yaml";
import { escapeRegExp } from "../core/regex.ts";
import { detectEol, lineEnd, lineStart } from "../core/text.ts";
import type { Splice } from "../platforms/types.ts";

/** Collects splices; removals that contain others win, partial overlaps are a bug. */
export class SpliceSet {
  readonly #splices: Splice[] = [];

  add(splice: Splice): void {
    this.#splices.push(splice);
  }

  remove(start: number, end: number): void {
    if (end > start) this.add({ start, end, text: "" });
  }

  get size(): number {
    return this.#splices.length;
  }

  apply(text: string): string {
    const sorted = [...this.#splices].sort((a, b) => a.start - b.start || b.end - a.end);
    const kept: Splice[] = [];
    for (const s of sorted) {
      const last = kept.at(-1);
      if (last && s.start < last.end) {
        // Inside an earlier removal: nothing left to edit.
        if (last.text === "" && s.end <= last.end) continue;
        if (s.start === last.start && s.end === last.end && s.text === last.text) continue;
        throw new Error(`internal: overlapping edits at offset ${s.start}`);
      }
      kept.push(s);
    }
    let out = "";
    let pos = 0;
    for (const s of kept) {
      out += text.slice(pos, s.start) + s.text;
      pos = s.end;
    }
    return out + text.slice(pos);
  }
}

function range(node: Node | Scalar | null | undefined): [number, number] | undefined {
  const r = (node as { range?: [number, number, number] } | null | undefined)?.range;
  return r ? [r[0], r[1]] : undefined;
}

/** Whole lines from the line of `start` through the line holding offset `end - 1`. */
export function fullLines(text: string, start: number, end: number): [number, number] {
  return [lineStart(text, start), lineEnd(text, Math.max(start, end - 1))];
}

/** The lines a block-style map pair occupies (key line through the end of its value). */
export function pairLines(text: string, pair: Pair): [number, number] {
  const key = range(pair.key as Node);
  if (!key) throw new Error("internal: pair without a source range");
  const value = range(pair.value as Node);
  return fullLines(text, key[0], value ? value[1] : key[1]);
}

/** The lines a block sequence item occupies, `- ` included. */
export function itemLines(text: string, item: Node): [number, number] {
  const r = range(item);
  if (!r) throw new Error("internal: item without a source range");
  return fullLines(text, r[0], r[1]);
}

/**
 * Removes one item of a sequence: whole lines for a block sequence, the item and one
 * neighbouring comma for a flow sequence (`[a, b]`).
 */
export function removeSeqItem(text: string, seq: YAMLSeq, item: Node, edits: SpliceSet): void {
  const r = range(item);
  if (!r) throw new Error("internal: item without a source range");
  if (!seq.flow) {
    const [s, e] = itemLines(text, item);
    edits.remove(s, e);
    return;
  }
  const after = /^\s*,[ \t]*/.exec(text.slice(r[1]));
  if (after) {
    edits.remove(r[0], r[1] + after[0].length);
    return;
  }
  const before = /,\s*$/.exec(text.slice(0, r[0]));
  edits.remove(before ? r[0] - before[0].length : r[0], r[1]);
}

/** jsonc-parser formatting options matching a JSON text: its indentation and line ending. */
export function jsonFormatting(text: string): {
  insertSpaces: boolean;
  tabSize: number;
  eol: string;
} {
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? "  ";
  return {
    insertSpaces: !indent.includes("\t"),
    tabSize: indent.includes("\t") ? 1 : indent.length,
    eol: detectEol(text),
  };
}

/**
 * Removes one comma-separated `entry` from a one-line scalar's source (`a:1,a:latest`).
 * Returns false when the entry isn't found exactly once.
 */
export function removeListEntry(
  text: string,
  node: Scalar,
  entry: string,
  edits: SpliceSet,
): boolean {
  const r = range(node);
  if (!r) return false;
  const source = text.slice(r[0], r[1]);
  const index = source.indexOf(entry);
  if (index === -1 || source.indexOf(entry, index + 1) !== -1) return false;
  const start = r[0] + index;
  const end = start + entry.length;
  const after = /^\s*,\s*/.exec(text.slice(end, r[1]));
  if (after) {
    edits.remove(start, end + after[0].length);
    return true;
  }
  const before = /,\s*$/.exec(text.slice(r[0], start));
  edits.remove(before ? start - before[0].length : start, end);
  return true;
}

/**
 * The text range of a `-t <ref>` / `--tag <ref>` flag inside a script scalar, with the
 * whitespace before it; the whole line when the flag is alone on a continued line
 * (`  -t x:latest \\`). Undefined unless the flag occurs exactly once.
 */
export function latestFlagRange(
  text: string,
  node: Scalar,
  ref: string,
): [number, number] | undefined {
  const r = range(node);
  if (!r) return undefined;
  const source = text.slice(r[0], r[1]);
  const flag = new RegExp(
    `[ \\t]+(?:-t|--tag)(?:[ \\t]+|=)(["']?)${escapeRegExp(ref)}\\1(?=\\s|$)`,
    "g",
  );
  const found = [...source.matchAll(flag)];
  if (found.length !== 1) return undefined;
  const at = r[0] + (found[0]?.index ?? 0);
  const end = at + (found[0]?.[0].length ?? 0);
  const ls = lineStart(text, at);
  const le = lineEnd(text, at);
  if (text.slice(ls, at).trim() === "" && /^[ \t]*\\[ \t]*\r?\n?$/.test(text.slice(end, le))) {
    return [ls, le];
  }
  return [at, end];
}

export { isSeq };
