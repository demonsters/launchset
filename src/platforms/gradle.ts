/**
 * Gradle stamper (spec 6.3, kind `gradle`): edits `versionName` and `versionCode` inside
 * `android { defaultConfig { … } }` of a Groovy `build.gradle` or a Kotlin `build.gradle.kts`.
 *
 * Approach: build a masked copy of the file in which comments and the insides of strings are
 * blanked (same length, same offsets, newlines kept). Brace matching and key matching run on the
 * masked copy, so a `}` in a string or a `versionCode` in a comment can't confuse them. Values are
 * then located by offset and spliced into the original text.
 *
 * Known limits: Groovy slashy strings (`/…/`) and dollar-slashy strings are not recognised. Only
 * literal values are supported (`versionCode 12`, `versionName "1.4.0"`, `=` optional); anything
 * else is an error pointing at `gradle-properties`.
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

const GRADLE_PROPERTIES_HINT =
  'Move the value into gradle.properties and use source kind "gradle-properties".';

type Key = "versionName" | "versionCode";

/** Index after the closing quote of the string starting at `start`. */
function skipString(text: string, start: number, file: string, kts: boolean): number {
  const q = text[start] as string;
  const triple = text.startsWith(q + q + q, start);
  if (triple) {
    const close = q + q + q;
    let i = start + 3;
    while (i < text.length) {
      // In Kotlin a backslash is not an escape inside a raw (\"\"\") string: `\"\"\"C:\\\"\"\"` is valid.
      if (text[i] === "\\" && !(kts && q === '"')) i += 2;
      else if (text.startsWith(close, i)) {
        // Kotlin allows extra quotes at the end of a raw string ("""a"""").
        let end = i + 3;
        while (text[end] === q) end++;
        return end;
      } else i++;
    }
    throw new StampError(file, `unterminated string starting at line ${lineOf(text, start)}`);
  }
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") i += 2;
    else if (c === q) return i + 1;
    else if (c === "\n") break;
    else if (c === "$" && q === '"' && text[i + 1] === "{")
      i = skipInterpolation(text, i + 2, file, kts);
    else i++;
  }
  throw new StampError(file, `unterminated string starting at line ${lineOf(text, start)}`);
}

/** Index after the `}` closing a `${ … }` interpolation whose body starts at `start`. */
function skipInterpolation(text: string, start: number, file: string, kts: boolean): number {
  let depth = 1;
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") i = skipString(text, i, file, kts);
    else {
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return i + 1;
      i++;
    }
  }
  throw new StampError(file, `unterminated "\${" starting at line ${lineOf(text, start)}`);
}

function blank(s: string): string {
  return s.replace(/[^\r\n]/g, " ");
}

/**
 * Same length as the original; comments and string interiors are blanked. `kts` enables Kotlin
 * rules: nested block comments and no escapes in raw strings.
 */
function mask(text: string, file: string, kts: boolean): string {
  const out: string[] = [];
  let i = 0;
  let last = 0;
  const flush = (upTo: number) => {
    if (upTo > last) out.push(text.slice(last, upTo));
  };
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === "/" && n === "/") {
      flush(i);
      let end = text.indexOf("\n", i);
      if (end === -1) end = text.length;
      out.push(blank(text.slice(i, end)));
      i = last = end;
    } else if (c === "/" && n === "*") {
      flush(i);
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text.startsWith("*/", j)) {
          depth--;
          j += 2;
        } else if (kts && text.startsWith("/*", j)) {
          depth++;
          j += 2;
        } else j++;
      }
      if (depth > 0) {
        throw new StampError(file, `unterminated comment starting at line ${lineOf(text, i)}`);
      }
      out.push(blank(text.slice(i, j)));
      i = last = j;
    } else if (c === '"' || c === "'") {
      const end = skipString(text, i, file, kts);
      flush(i);
      // Keep the first and last character (the quotes) so the token stays visible as a string.
      out.push((c as string) + blank(text.slice(i + 1, end - 1)) + text[end - 1]);
      i = last = end;
    } else i++;
  }
  flush(text.length);
  return out.join("");
}

/** Matching close offset for every `{` in the masked code. */
function matchBraces(code: string, text: string, file: string): Map<number, number> {
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === "{") stack.push(i);
    else if (c === "}") {
      const open = stack.pop();
      if (open === undefined) {
        throw new StampError(file, `unbalanced "}" at line ${lineOf(text, i)}`);
      }
      pairs.set(open, i);
    }
  }
  const unclosed = stack.pop();
  if (unclosed !== undefined) {
    throw new StampError(file, `unclosed "{" at line ${lineOf(text, unclosed)}`);
  }
  return pairs;
}

interface Block {
  /** First identifier of the block header (`android`, `defaultConfig`, `create` for `create("x")`). */
  name: string | null;
  open: number;
  close: number;
}

/** Blocks that are direct children of the range `[from, to)`. */
function childBlocks(code: string, pairs: Map<number, number>, from: number, to: number): Block[] {
  const blocks: Block[] = [];
  let i = from;
  while (i < to) {
    if (code[i] !== "{") {
      i++;
      continue;
    }
    const close = pairs.get(i) as number;
    let j = i - 1;
    while (j >= from && /\s/.test(code[j] as string)) j--;
    const headerEnd = j + 1;
    while (j >= from && !"\n;{}".includes(code[j] as string)) j--;
    const header = code.slice(j + 1, headerEnd).trim();
    const m = /^([A-Za-z_]\w*)\s*(?:\(.*\))?$/s.exec(header);
    blocks.push({ name: m ? (m[1] as string) : null, open: i, close });
    i = close + 1;
  }
  return blocks;
}

/** Offsets of `key` used as a statement (`key value`, `key = value`) inside `[from, to)`. */
function findKeyStatements(code: string, from: number, to: number, key: Key): number[] {
  const re = new RegExp(`(?<![\\w.$])${key}(?![\\w$])`, "g");
  re.lastIndex = from;
  const hits: number[] = [];
  for (let m = re.exec(code); m && m.index < to; m = re.exec(code)) {
    let j = m.index - 1;
    while (j >= from && (code[j] === " " || code[j] === "\t")) j--;
    const atStatementStart = j < from || "\n\r;{".includes(code[j] as string);
    if (!atStatementStart) continue;
    // `versionName: "x"` is a map entry, not an assignment.
    let k = m.index + key.length;
    while (code[k] === " " || code[k] === "\t") k++;
    if (code[k] === ":") continue;
    hits.push(m.index);
  }
  return hits;
}

/** A version key whose value isn't a plain literal. `read` tolerates it for versionCode. */
class NotLiteral extends StampError {}

interface Located {
  key: Key;
  /** Offset range of the text that holds the value (without quotes for versionName). */
  start: number;
  end: number;
  value: string;
}

function locateValue(text: string, code: string, file: string, keyOffset: number, key: Key) {
  const where = `line ${lineOf(text, keyOffset)}`;
  const notLiteral = (found: string): StampError =>
    new NotLiteral(
      file,
      `${key} (${where}) is not a literal value (found \`${found}\`). launchset can only stamp ` +
        `literal values in defaultConfig. ${GRADLE_PROPERTIES_HINT}`,
    );
  const lineEnd = (from: number) => {
    const nl = code.indexOf("\n", from);
    return nl === -1 ? code.length : nl;
  };
  let i = keyOffset + key.length;
  while (code[i] === " " || code[i] === "\t") i++;
  if (code[i] === "=" && code[i + 1] !== "=") {
    i++;
    while (code[i] === " " || code[i] === "\t") i++;
  }
  const expression = () => text.slice(keyOffset, lineEnd(keyOffset)).trim();
  if (code[i] === "(") {
    throw new NotLiteral(
      file,
      `${key} (${where}) uses the method-call form \`${expression()}\`, which isn't supported. ` +
        `Write it as a plain literal (\`${key}${key === "versionCode" ? " 1" : ' "1.0.0"'}\`). ${GRADLE_PROPERTIES_HINT}`,
    );
  }
  // After the literal only a statement end may follow: end of line, `;` or the closing `}`.
  const endsStatement = (at: number) => /^[ \t\r]*(?:;|\}|$)/.test(code.slice(at, lineEnd(at)));

  if (key === "versionCode") {
    const m = /^\d[\d_]*/.exec(code.slice(i, lineEnd(i)));
    if (!m || !endsStatement(i + m[0].length)) throw notLiteral(expression());
    return { key, start: i, end: i + m[0].length, value: m[0].replaceAll("_", "") } as Located;
  }
  const q = code[i];
  if (q !== '"' && q !== "'") throw notLiteral(expression());
  if (text[i + 1] === q && text[i + 2] === q) throw notLiteral(expression());
  const end = skipString(text, i, file, file.endsWith(".kts"));
  const inner = text.slice(i + 1, end - 1);
  if ((q === '"' && inner.includes("$")) || inner.includes("\\") || !endsStatement(end)) {
    throw notLiteral(expression());
  }
  return { key, start: i + 1, end: end - 1, value: inner } as Located;
}

/** End of the statement that starts at `from`: its block (`… { … }` on the same line) or its line. */
function statementEnd(code: string, pairs: Map<number, number>, from: number): number {
  let parens = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (c === "(") parens++;
    else if (c === ")") parens--;
    else if (c === "{") return (pairs.get(i) as number) + 1;
    else if (c === "\n" && parens <= 0) {
      // Allman style: the block's `{` may sit alone on the next line.
      const next = /^\s*(.)/.exec(code.slice(i));
      if (next?.[1] !== "{") return i;
    }
  }
  return code.length;
}

const KEYS: Key[] = ["versionName", "versionCode"];

/**
 * Ways to set the version that launchset can't stamp safely, wherever they are in the file:
 * anything mentioning `productFlavors` that sets versionName/versionCode (`productFlavors { … }`,
 * `productFlavors.create("x") { … }`, `android.productFlavors { … }`, `productFlavors.free.versionCode
 * = 1`) and dotted assignments through `defaultConfig`/`mergedFlavor`.
 */
function assertNoOverrides(text: string, code: string, pairs: Map<number, number>, file: string) {
  const occurrences = [...code.matchAll(/(?<![\w$])productFlavors(?![\w$])/g)].map((m) => m.index);
  for (const key of KEYS) {
    const keyRe = new RegExp(`(?<![\\w$])${key}(?![\\w$])(?!\\s*:)`, "g");
    for (const at of occurrences) {
      const end = statementEnd(code, pairs, at);
      keyRe.lastIndex = at;
      const hit = keyRe.exec(code);
      if (hit && hit.index < end) {
        throw new StampError(
          file,
          `${key} is set inside productFlavors (line ${lineOf(text, hit.index)}): product flavors that ` +
            `override versionName/versionCode aren't supported in v1; use source kind "gradle-properties".`,
        );
      }
    }
    const dotted = new RegExp(
      `(?<![\\w$])(?:defaultConfig|mergedFlavor)\\s*\\.\\s*${key}(?![\\w$])\\s*(?:=(?!=)|\\()`,
    ).exec(code);
    if (dotted) {
      throw new StampError(
        file,
        `${key} is assigned through a dotted path (\`${dotted[0].trim()}\`, line ${lineOf(text, dotted.index)}), ` +
          `which launchset can't stamp safely. Set it as a literal inside \`android { defaultConfig { … } }\`, ` +
          GRADLE_PROPERTIES_HINT.replace("Move", "or move"),
      );
    }
  }
}

/**
 * Locate the values of `required` keys (errors when missing or not literal) and of `optional`
 * keys (skipped when missing or not literal).
 */
function analyse(text: string, file: string, required: Key[], optional: Key[] = []): Located[] {
  const code = mask(text, file, file.endsWith(".kts"));
  const pairs = matchBraces(code, text, file);
  const androids = childBlocks(code, pairs, 0, code.length).filter((b) => b.name === "android");
  if (androids.length === 0) {
    throw new StampError(file, "no `android { … }` block found at the top level of the file");
  }
  const androidChildren = androids.flatMap((a) => childBlocks(code, pairs, a.open + 1, a.close));

  assertNoOverrides(text, code, pairs, file);

  const configs = androidChildren.filter((b) => b.name === "defaultConfig");
  if (configs.length === 0) {
    throw new StampError(file, "no `defaultConfig { … }` block found inside `android { … }`");
  }
  if (configs.length > 1) {
    throw new StampError(file, "more than one `defaultConfig { … }` block found inside `android`");
  }
  const config = configs[0] as Block;
  const located: Located[] = [];
  for (const key of [...required, ...optional]) {
    const isOptional = optional.includes(key);
    const hits = findKeyStatements(code, config.open + 1, config.close, key);
    if (hits.length === 0) {
      if (isOptional) continue;
      const example = key === "versionCode" ? "versionCode 1" : 'versionName "1.0.0"';
      throw new StampError(
        file,
        `${key} not found in defaultConfig; add a literal value there (for example \`${example}\`). ` +
          `If the version lives elsewhere: ${GRADLE_PROPERTIES_HINT}`,
      );
    }
    if (hits.length > 1) {
      const lines = hits.map((h) => lineOf(text, h)).join(" and ");
      throw new StampError(
        file,
        `${key} is set more than once in defaultConfig (lines ${lines}); launchset can't tell which one wins.`,
      );
    }
    try {
      located.push(locateValue(text, code, file, hits[0] as number, key));
    } catch (e) {
      if (!(isOptional && e instanceof NotLiteral)) throw e;
    }
  }
  return located;
}

function requestedKeys(values: StampValues): Key[] {
  const keys: Key[] = [];
  if (values.marketing !== undefined) keys.push("versionName");
  if (values.build !== undefined) keys.push("versionCode");
  return keys;
}

export const gradle: TextStamper = {
  read(text, file) {
    // The build number is optional when reading: the consistency check only compares marketing.
    return analyse(text, file, ["versionName"], ["versionCode"]).map(
      (l): FoundValue => ({
        field: l.key === "versionName" ? "marketing" : "build",
        key: l.key,
        value: l.value,
        line: lineOf(text, l.start),
      }),
    );
  },

  write(text, file, values) {
    const keys = requestedKeys(values);
    if (keys.length === 0) return text;
    const splices: Splice[] = [];
    for (const l of analyse(text, file, keys)) {
      if (l.key === "versionName") {
        const name = values.marketing as string;
        if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(name)) {
          throw new StampError(
            file,
            `can't write "${name}" as versionName: not a plain version string`,
          );
        }
        splices.push({ start: l.start, end: l.end, text: name });
      } else {
        const build = values.build as number;
        if (!Number.isSafeInteger(build) || build < 1) {
          throw new StampError(file, `can't write ${build} as versionCode: not a positive integer`);
        }
        splices.push({ start: l.start, end: l.end, text: String(build) });
      }
    }
    return applySplices(text, splices);
  },
};
