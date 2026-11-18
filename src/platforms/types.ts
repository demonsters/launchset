/**
 * Stamper contract (spec 6). A format stamper is a pair of **pure text functions**:
 * `read` finds the current values, `write` splices new values into the original text.
 *
 * Rule: parse to find, splice to edit. `write` may parse only to locate the exact
 * character range of each value it changes, then replaces those characters in the
 * original text. Every other byte stays identical (indentation, quotes, comments,
 * line endings, trailing newline). Never re-serialize a parsed structure.
 *
 * If a value can't be located unambiguously, throw `StampError` with the file and the
 * reason; never guess.
 */

/** Which version value a field holds. */
export type VersionField = "marketing" | "build";

/** A value found in a file, for the consistency check (6.7) and `init` (11.1). */
export interface FoundValue {
  field: VersionField;
  /** Human-readable key, e.g. `versionName`, `MARKETING_VERSION (Release, App)`, `expo.version`. */
  key: string;
  /** The value as written, without quotes. May be a build-setting reference like `$(MARKETING_VERSION)`. */
  value: string;
  /** 1-based line number of the value. */
  line: number;
}

/**
 * Values to write. A field that is `undefined` is left untouched: the release PR passes
 * only `marketing` (build numbers are never committed, spec 1.1 principle 4); `stamp`
 * in CI passes both.
 */
export interface StampValues {
  marketing?: string;
  build?: number;
}

export interface TextStamper<Options = void> {
  /** Find the values. Throws `StampError` when a value is ambiguous or required but missing. */
  read(text: string, file: string, options: Options): FoundValue[];
  /** Return `text` with only the given values replaced. */
  write(text: string, file: string, values: StampValues, options: Options): string;
}

export class StampError extends Error {
  readonly file: string;
  readonly reason: string;
  constructor(file: string, reason: string) {
    super(`${file}: ${reason}`);
    this.name = "StampError";
    this.file = file;
    this.reason = reason;
  }
}

export { detectEol, lineOf } from "../core/text.ts";

/** A range in the original text to replace. */
export interface Splice {
  start: number;
  end: number;
  text: string;
}

/** Apply non-overlapping splices to `text` (in any order). Throws on overlap. */
export function applySplices(text: string, splices: Splice[]): string {
  const sorted = [...splices].sort((a, b) => a.start - b.start);
  let out = "";
  let pos = 0;
  for (const s of sorted) {
    if (s.start < pos) throw new Error("applySplices: overlapping splices");
    out += text.slice(pos, s.start) + s.text;
    pos = s.end;
  }
  return out + text.slice(pos);
}
