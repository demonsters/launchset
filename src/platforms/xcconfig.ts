/**
 * `.xcconfig` stamper (spec 6.4 `xcconfig`).
 *
 * Edits the value of `MARKETING_VERSION = 1.4.0` and `CURRENT_PROJECT_VERSION = 12` lines.
 * Spacing, quotes and trailing `// comments` stay as they are.
 *
 * Only the unconditional assignment of a key is stamped, and per key exactly one must exist
 * (none or several is an error: launchset can't tell which one is the version). A trailing `;`
 * and a `// comment` stay outside the value; `//` inside quotes belongs to the value.
 *
 * Conditional assignments (`CURRENT_PROJECT_VERSION[config=Debug] = 1`) override the plain one for
 * matching builds, so stamping around them would ship a different value than the one written.
 * Only the fields being written matter: a conditional assignment of such a field is an error
 * (remove it, or manage that value by hand); conditionals of fields that aren't being written,
 * and all conditionals when reading, are ignored.
 */

import { assertBuildNumber, assertIosMarketing, isBuildSettingReference } from "./ios-version.ts";
import {
  applySplices,
  type FoundValue,
  type Splice,
  StampError,
  type StampValues,
  type TextStamper,
} from "./types.ts";

const KEYS = { marketing: "MARKETING_VERSION", build: "CURRENT_PROJECT_VERSION" } as const;

interface Assignment {
  key: string;
  /** The bracketed conditions, e.g. `[config=Debug]`; empty for an unconditional assignment. */
  conditions: string;
  conditional: boolean;
  /** Range of the value text (without surrounding whitespace and the trailing comment). */
  start: number;
  end: number;
  value: string;
  line: number;
}

// KEY, optional [conditions], `=`, then the rest of the line (value, `;`, comment).
const LINE = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)((?:\[[^\]]*\])*)(\s*=\s*)([^\r\n]*)$/;

/** The value at the start of `rest`: up to an unquoted `;` or `//`, without trailing whitespace. */
function valueText(rest: string): string {
  let inQuote = false;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (inQuote) {
      if (c === "\\") i++;
      else if (c === '"') inQuote = false;
    } else if (c === '"') {
      inQuote = true;
    } else if (c === ";" || (c === "/" && rest[i + 1] === "/")) {
      return rest.slice(0, i).trimEnd();
    }
  }
  return rest.trimEnd();
}

function scan(text: string, keys: string[]): Assignment[] {
  const out: Assignment[] = [];
  let pos = 0;
  let line = 1;
  while (pos <= text.length) {
    const nl = text.indexOf("\n", pos);
    const lineEnd = nl < 0 ? text.length : nl;
    const raw = text.slice(pos, lineEnd).replace(/\r$/, "");
    const m = LINE.exec(raw);
    const key = m?.[2];
    if (m && key !== undefined && keys.includes(key)) {
      const prefixLen =
        (m[1] as string).length + key.length + (m[3] as string).length + (m[4] as string).length;
      const value = valueText(m[5] as string);
      out.push({
        key,
        conditions: m[3] as string,
        conditional: (m[3] as string).length > 0,
        start: pos + prefixLen,
        end: pos + prefixLen + value.length,
        value: value,
        line,
      });
    }
    if (nl < 0) break;
    pos = nl + 1;
    line++;
  }
  return out;
}

/** The single unconditional assignment of `key`, or an error saying why there isn't one. */
function pick(found: Assignment[], key: string, file: string): Assignment {
  const all = found.filter((a) => a.key === key);
  const plain = all.filter((a) => !a.conditional);
  if (plain.length > 1) {
    throw new StampError(
      file,
      `${key} is assigned ${plain.length} times without a condition (lines ${plain.map((a) => a.line).join(", ")}); keep one assignment, or make the others conditional`,
    );
  }
  const only = plain[0];
  if (!only) {
    const hint =
      all.length > 0
        ? `only conditional assignments exist (line ${all.map((a) => a.line).join(", ")}) and launchset doesn't stamp those; add an unconditional \`${key} = <value>\` line`
        : `no \`${key} = ...\` line found; add one`;
    throw new StampError(file, `${key}: ${hint}`);
  }
  return only;
}

/** Throws when `key` has a conditional assignment: it would override the value being written. */
function assertNoConditional(found: Assignment[], key: string, file: string): void {
  const conditional = found.find((a) => a.key === key && a.conditional);
  if (conditional) {
    throw new StampError(
      file,
      `line ${conditional.line}: ${key}${conditional.conditions} is a conditional assignment. It overrides ${key} for matching builds, so those builds would ship a different value than the one launchset writes. Remove it, or manage ${key} by hand and don't stamp it with launchset.`,
    );
  }
}

export const xcconfig: TextStamper = {
  read(text, file) {
    const found = scan(text, [KEYS.marketing, KEYS.build]);
    const marketing = pick(found, KEYS.marketing, file);
    const result: FoundValue[] = [
      {
        field: "marketing",
        key: marketing.key,
        value: unquote(marketing.value),
        line: marketing.line,
      },
    ];
    // The build number is optional for reading (it's a CI-only placeholder).
    if (found.some((a) => a.key === KEYS.build && !a.conditional)) {
      const build = pick(found, KEYS.build, file);
      result.push({
        field: "build",
        key: build.key,
        value: unquote(build.value),
        line: build.line,
      });
    }
    return result;
  },

  write(text, file, values: StampValues) {
    if (values.marketing === undefined && values.build === undefined) return text;
    if (values.marketing !== undefined) assertIosMarketing(values.marketing, file);
    if (values.build !== undefined) assertBuildNumber(values.build, file);

    const found = scan(text, [KEYS.marketing, KEYS.build]);
    const splices: Splice[] = [];
    const wanted: [string, string | undefined][] = [
      [KEYS.marketing, values.marketing],
      [KEYS.build, values.build === undefined ? undefined : String(values.build)],
    ];
    for (const [key, value] of wanted) {
      if (value === undefined) continue;
      assertNoConditional(found, key, file);
      const current = pick(found, key, file);
      if (isBuildSettingReference(current.value)) {
        throw new StampError(
          file,
          `line ${current.line}: ${key} is the build-setting reference ${current.value}, which launchset won't overwrite; set a literal value or stamp the file that defines it`,
        );
      }
      const quoted =
        current.value.length >= 2 && current.value.startsWith('"') && current.value.endsWith('"');
      splices.push({
        start: current.start,
        end: current.end,
        text: quoted ? `"${value}"` : value,
      });
    }
    return applySplices(text, splices);
  },
};

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}
