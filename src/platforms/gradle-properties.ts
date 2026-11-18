/**
 * `gradle.properties` stamper (spec 6.3, kind `gradle-properties`): edits the values of two
 * configurable keys (`VERSION_NAME`, `VERSION_CODE`, …) in a Java properties file.
 *
 * Supported syntax: `KEY=value`, `KEY = value`, `KEY:value`, `KEY value`; comment lines starting
 * with `#` or `!`; blank lines; `\` line continuations of other properties (so a continued
 * `org.gradle.jvmargs` doesn't hide or fake a key). The value is the rest of the line; as in Java
 * properties there are no inline comments, and trailing whitespace is left as it was. A version
 * key whose value continues on the next line is an error.
 */

import {
  applySplices,
  type FoundValue,
  lineOf,
  type Splice,
  StampError,
  type StampValues,
  type TextStamper,
} from "./types.ts";

export interface GradlePropertiesOptions {
  versionNameKey: string;
  versionCodeKey: string;
}

interface Entry {
  key: string;
  /** Range of the value text, trailing whitespace excluded. */
  start: number;
  end: number;
  continued: boolean;
}

function scanEntries(original: string): Entry[] {
  // A leading UTF-8 BOM would end up in the first key: scan a copy where it is a blank, so
  // offsets are unchanged and the BOM stays in the output.
  const text = original.startsWith("\uFEFF") ? ` ${original.slice(1)}` : original;
  const entries: Entry[] = [];
  const lineRe = /[^\r\n]*(?:\r\n|\r|\n|$)/y;
  let pos = 0;
  while (pos < text.length) {
    // Logical line: physical lines joined while the line ends in an odd number of backslashes.
    // Comment lines never continue.
    const start = pos;
    let end = pos;
    let physicalLines = 0;
    for (;;) {
      lineRe.lastIndex = end;
      const raw = (lineRe.exec(text) as RegExpExecArray)[0];
      end += raw.length;
      physicalLines++;
      const content = raw.replace(/[\r\n]+$/, "");
      const backslashes = /\\*$/.exec(content)?.[0].length ?? 0;
      const isComment = /^[ \t\f]*[#!]/.test(text.slice(start, end));
      if (backslashes % 2 === 1 && !isComment && end < text.length) continue;
      break;
    }
    pos = end;
    const logical = text.slice(start, end);
    if (/^[ \t\f]*(?:[#!]|[\r\n]*$)/.test(logical)) continue;
    // key = chars up to an unescaped `=`, `:` or whitespace
    const m = /^[ \t\f]*((?:\\.|[^\s=:\\])+)[ \t\f]*[=:]?[ \t\f]*/.exec(logical);
    if (!m) continue;
    const valueStart = start + m[0].length;
    const valueEnd = start + logical.replace(/[\r\n]+$/, "").replace(/[ \t\f]+$/, "").length;
    entries.push({
      key: m[1] as string,
      start: valueStart,
      end: Math.max(valueStart, valueEnd),
      continued: physicalLines > 1,
    });
  }
  return entries;
}

/** Like `locate`, but `undefined` when the key is missing. */
function locateOptional(text: string, file: string, key: string): Entry | undefined {
  return hasKey(text, key) ? locate(text, file, key) : undefined;
}

function hasKey(text: string, key: string): boolean {
  return scanEntries(text).some((e) => e.key === key);
}

function locate(text: string, file: string, key: string): Entry {
  const hits = scanEntries(text).filter((e) => e.key === key);
  if (hits.length === 0) {
    throw new StampError(
      file,
      `key ${key} not found; add a line like \`${key}=…\` or fix the key name in the config`,
    );
  }
  if (hits.length > 1) {
    const lines = hits.map((h) => lineOf(text, h.start)).join(" and ");
    throw new StampError(
      file,
      `key ${key} is defined more than once (lines ${lines}); launchset can't tell which one wins`,
    );
  }
  const hit = hits[0] as Entry;
  if (hit.continued) {
    throw new StampError(
      file,
      `value of ${key} (line ${lineOf(text, hit.start)}) continues on the next line; put it on one line`,
    );
  }
  return hit;
}

export const gradleProperties: TextStamper<GradlePropertiesOptions> = {
  read(text, file, options) {
    const name = locate(text, file, options.versionNameKey);
    // The build number is optional when reading: the consistency check only compares marketing.
    const code = locateOptional(text, file, options.versionCodeKey);
    const found = (field: FoundValue["field"], key: string, e: Entry): FoundValue => ({
      field,
      key,
      value: text.slice(e.start, e.end),
      line: lineOf(text, e.start),
    });
    return [
      found("marketing", options.versionNameKey, name),
      ...(code ? [found("build", options.versionCodeKey, code)] : []),
    ];
  },

  write(text, file, values: StampValues, options) {
    const splices: Splice[] = [];
    if (values.marketing !== undefined) {
      const e = locate(text, file, options.versionNameKey);
      if (/[\r\n\\]/.test(values.marketing)) {
        throw new StampError(
          file,
          `can't write "${values.marketing}" as ${options.versionNameKey}`,
        );
      }
      splices.push({ start: e.start, end: e.end, text: values.marketing });
    }
    if (values.build !== undefined) {
      const e = locate(text, file, options.versionCodeKey);
      if (!Number.isSafeInteger(values.build) || values.build < 1) {
        throw new StampError(
          file,
          `can't write ${values.build} as ${options.versionCodeKey}: not a positive integer`,
        );
      }
      splices.push({ start: e.start, end: e.end, text: String(values.build) });
    }
    return splices.length === 0 ? text : applySplices(text, splices);
  },
};
