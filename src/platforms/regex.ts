/**
 * Regex stamper (spec 6.6, kind `regex`): `pattern` must match exactly once in the file; the match
 * is replaced by `replace`.
 *
 * Replacement semantics (decision: same as `String.prototype.replace` for the single match):
 * 1. The placeholders `{version}`, `{major}`, `{minor}`, `{patch}` and `{buildNumber}` are filled
 *    in first. `{version}` is `values.marketing` as given (prerelease suffix included); `major`,
 *    `minor`, `patch` are its numeric parts. Any other `{…}` stays literal, so templates can
 *    contain JSON or code braces.
 * 2. The result is then used as the replacement string of `text.replace(pattern, …)`, so `$1`,
 *    `$<name>`, `$&`, `` $` ``, `$'` and `$$` work as in JavaScript. Values substituted in step 1
 *    are escaped, so a `$` inside a value is never interpreted. To write a literal `$`, use `$$`.
 *
 * Flags: any valid JavaScript flags except `y`; `g` is accepted and ignored (exactly one match is
 * required anyway). `read` returns the matched text as the value; `write` needs the version
 * (and the build number only if the template uses `{buildNumber}`).
 *
 * Line endings (decision: patterns see LF): in a file with CRLF line endings, a pattern that
 * doesn't mention `\r` is matched against a copy in which every `\r\n` reads as `\n`, so a pattern
 * written against an LF checkout matches a Windows (`core.autocrlf`) checkout of the same commit.
 * The match is mapped back to the file and only that range is replaced; `$1`, `$&`, … expand to
 * the file's own text, and line breaks written in `replace` become `\r\n`. A pattern that mentions
 * `\r` (`\r?\n`, `\r\n`, `[^\r]`) is matched against the file as it is, as before.
 */

import { parse as parseSemver } from "semver";
import {
  type FoundValue,
  lineOf,
  StampError,
  type StampValues,
  type TextStamper,
} from "./types.ts";

export interface RegexFileOptions {
  pattern: string;
  flags?: string;
  replace: string;
}

/**
 * True when the pattern names a carriage return itself: `\r`, `\x0d`, `\u000d`, `\u{d}`, `\cM`
 * or a literal CR. Such a pattern was written for CRLF text, so it runs on the file as it is.
 */
export function mentionsCarriageReturn(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\r") return true;
    if (c !== "\\") continue;
    if (/^(?:r|x0[dD]|u000[dD]|u\{0*[dD]\}|c[mM])/.test(pattern.slice(i + 1))) return true;
    i++;
  }
  return false;
}

/**
 * The text with every `\r\n` turned into `\n`, and a map from its offsets back to the original's.
 * Lone `\n` and lone `\r` stay as they are.
 */
function lfView(text: string): { lf: string; toOriginal: (offset: number) => number } {
  /** Offsets in `lf` of each `\n` that had a `\r` before it. */
  const joined: number[] = [];
  let lf = "";
  let last = 0;
  for (let at = text.indexOf("\r\n"); at !== -1; at = text.indexOf("\r\n", at + 2)) {
    lf += text.slice(last, at);
    joined.push(lf.length);
    last = at + 1;
  }
  lf += text.slice(last);
  const toOriginal = (offset: number) => {
    // Number of joined newlines before `offset`; a span that covers a `\n` covers its `\r` too.
    let lo = 0;
    let hi = joined.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((joined[mid] as number) < offset) lo = mid + 1;
      else hi = mid;
    }
    return offset + lo;
  };
  return { lf, toOriginal };
}

function compile(file: string, options: RegexFileOptions, indices: boolean) {
  const flags = options.flags ?? "";
  if (flags.includes("y")) {
    throw new StampError(file, `regex flags "${flags}": the sticky flag (y) isn't supported`);
  }
  try {
    const base = flags.replaceAll("g", "");
    const counting = indices && !base.includes("d") ? `${base}dg` : `${base}g`;
    return {
      single: new RegExp(options.pattern, base),
      counting: new RegExp(options.pattern, counting),
    };
  } catch (e) {
    throw new StampError(
      file,
      `invalid regex /${options.pattern}/${flags}: ${(e as Error).message}`,
    );
  }
}

/** Extra advice for a pattern that matched nothing, when line endings may be the cause. */
function lineEndingHint(text: string, mentionsCr: boolean): string {
  const crlf = text.includes("\r\n");
  const loneCr = /\r(?!\n)/.test(text);
  if (mentionsCr && !text.includes("\r")) {
    return (
      ". The pattern mentions \\r, but the file has none (LF line endings); write \\n for a line break, " +
      "launchset matches it against LF and CRLF line endings alike"
    );
  }
  if (mentionsCr) {
    return (
      ". The file has CR (\\r) characters and the pattern mentions \\r, so it was matched against the file as is; " +
      "leave \\r out and write \\n for a line break, launchset then matches it against LF and CRLF line endings alike"
    );
  }
  if (loneCr) {
    return `. The file has CR (\\r) characters that aren't followed by \\n${crlf ? "" : " (old Mac line endings)"}; a \\n in the pattern doesn't match those`;
  }
  if (crlf) {
    return ". The file has CRLF (\\r\\n) line endings; launchset matched the pattern as if they were \\n, so line endings aren't the cause";
  }
  return "";
}

/** The single match, as a range in the original text, and a function that writes the new text. */
interface Located {
  start: number;
  end: number;
  /** The whole file with the match replaced by `template` (`$1` etc. expanded). */
  replaceWith(template: string): string;
}

/**
 * Finds the single match. In a file with CRLF line endings a pattern that doesn't mention `\r`
 * runs on an LF view of the file, so a `\n` in it matches a CRLF line ending, and the match is
 * mapped back to the original text (decision in design/DECISIONS.md).
 */
function locate(text: string, file: string, options: RegexFileOptions): Located {
  const mentionsCr = mentionsCarriageReturn(options.pattern);
  const useLf = text.includes("\r\n") && !mentionsCr;
  const { single, counting } = compile(file, options, useLf);
  const view = useLf ? lfView(text) : undefined;
  const matches = [...(view?.lf ?? text).matchAll(counting)];
  if (matches.length !== 1) {
    throw new StampError(
      file,
      `pattern /${options.pattern}/${options.flags ?? ""} matched ${matches.length} times, expected exactly 1; ` +
        (matches.length === 0
          ? `check the pattern against the file${lineEndingHint(text, mentionsCr)}`
          : "make the pattern more specific"),
    );
  }
  const match = matches[0] as RegExpExecArray;
  if (!view) {
    return {
      start: match.index,
      end: match.index + match[0].length,
      // Exactly one match exists, so this replaces only that match; every other byte is untouched.
      replaceWith: (template) => text.replace(single, template),
    };
  }
  const { indices } = match as RegExpExecArray & { indices: RegExpIndicesArray };
  const original = (range: [number, number] | undefined) =>
    range && text.slice(view.toOriginal(range[0]), view.toOriginal(range[1]));
  const start = view.toOriginal(match.index);
  const end = view.toOriginal(match.index + match[0].length);
  return {
    start,
    end,
    replaceWith: (template) => {
      // `$1`, `$&`, … expand to the original text (CRLF kept); line breaks the template adds
      // itself get the file's CRLF.
      const groups = indices.groups;
      const replacement = expandReplacement(template.replace(/(?<!\r)\n/g, "\r\n"), {
        matched: text.slice(start, end),
        before: text.slice(0, start),
        after: text.slice(end),
        captures: indices.slice(1).map(original),
        named:
          groups &&
          Object.fromEntries(
            Object.entries(groups).map(([name, range]) => [name, original(range)]),
          ),
      });
      return text.slice(0, start) + replacement + text.slice(end);
    },
  };
}

interface Substitution {
  matched: string;
  before: string;
  after: string;
  captures: (string | undefined)[];
  named: Record<string, string | undefined> | undefined;
}

/**
 * `String.prototype.replace`'s replacement patterns (ECMA-262 GetSubstitution): `$$`, `$&`,
 * `` $` ``, `$'`, `$n`, `$nn` and `$<name>`; anything else stays literal. Used for the LF view,
 * where the engine's own expansion would copy captures from the view instead of the file.
 */
export function expandReplacement(template: string, s: Substitution): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const c = template[i];
    const next = template[i + 1];
    if (c !== "$" || next === undefined) {
      out += c;
      i++;
    } else if (next === "$") {
      out += "$";
      i += 2;
    } else if (next === "&") {
      out += s.matched;
      i += 2;
    } else if (next === "`") {
      out += s.before;
      i += 2;
    } else if (next === "'") {
      out += s.after;
      i += 2;
    } else if (/[0-9]/.test(next)) {
      const two = /^[0-9]{2}/.test(template.slice(i + 1))
        ? Number(template.slice(i + 1, i + 3))
        : 0;
      const one = Number(next);
      if (two >= 1 && two <= s.captures.length) {
        out += s.captures[two - 1] ?? "";
        i += 3;
      } else if (one >= 1 && one <= s.captures.length) {
        out += s.captures[one - 1] ?? "";
        i += 2;
      } else {
        out += "$";
        i++;
      }
    } else if (next === "<") {
      const close = template.indexOf(">", i + 2);
      if (s.named === undefined || close === -1) {
        out += "$<";
        i += 2;
      } else {
        out += s.named[template.slice(i + 2, close)] ?? "";
        i = close + 1;
      }
    } else {
      out += "$";
      i++;
    }
  }
  return out;
}

function render(template: string, file: string, values: StampValues): string {
  const needs = (name: string) => template.includes(`{${name}}`);
  const needsVersion = ["version", "major", "minor", "patch"].some(needs);
  if (needsVersion && values.marketing === undefined) {
    throw new StampError(
      file,
      "regex replacement needs the version ({version}, {major}, {minor} or {patch}), but none was given",
    );
  }
  if (needs("buildNumber") && values.build === undefined) {
    throw new StampError(
      file,
      "regex replacement uses {buildNumber}: needs a build number; it is only stamped in CI by `launchset stamp`",
    );
  }
  let parts: { major: number; minor: number; patch: number } | undefined;
  if (needsVersion && ["major", "minor", "patch"].some(needs)) {
    const parsed = parseSemver(values.marketing as string);
    if (!parsed)
      throw new StampError(
        file,
        `can't split "${values.marketing}" into major/minor/patch: not a semver version`,
      );
    parts = parsed;
  }
  const filled: Record<string, string> = {
    version: String(values.marketing),
    major: String(parts?.major),
    minor: String(parts?.minor),
    patch: String(parts?.patch),
    buildNumber: String(values.build),
  };
  return template.replace(/\{(version|major|minor|patch|buildNumber)\}/g, (_, name: string) =>
    (filled[name] as string).replaceAll("$", "$$$$"),
  );
}

export const regexFile: TextStamper<RegexFileOptions> = {
  read(text, file, options) {
    const { start, end } = locate(text, file, options);
    return [
      {
        field: "marketing",
        key: options.pattern,
        value: text.slice(start, end),
        line: lineOf(text, start),
      } satisfies FoundValue,
    ];
  },

  write(text, file, values, options) {
    if (values.marketing === undefined && values.build === undefined) return text;
    return locate(text, file, options).replaceWith(render(options.replace, file, values));
  },
};
