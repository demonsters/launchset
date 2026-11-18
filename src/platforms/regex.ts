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

function compile(file: string, options: RegexFileOptions): { single: RegExp; counting: RegExp } {
  const flags = options.flags ?? "";
  if (flags.includes("y")) {
    throw new StampError(file, `regex flags "${flags}": the sticky flag (y) isn't supported`);
  }
  try {
    const base = flags.replaceAll("g", "");
    return {
      single: new RegExp(options.pattern, base),
      counting: new RegExp(options.pattern, `${base}g`),
    };
  } catch (e) {
    throw new StampError(
      file,
      `invalid regex /${options.pattern}/${flags}: ${(e as Error).message}`,
    );
  }
}

function matchOnce(text: string, file: string, options: RegexFileOptions) {
  const { single, counting } = compile(file, options);
  const matches = [...text.matchAll(counting)];
  if (matches.length !== 1) {
    throw new StampError(
      file,
      `pattern /${options.pattern}/${options.flags ?? ""} matched ${matches.length} times, expected exactly 1; ` +
        (matches.length === 0
          ? "check the pattern against the file"
          : "make the pattern more specific"),
    );
  }
  return { single, match: matches[0] as RegExpMatchArray };
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
    const { match } = matchOnce(text, file, options);
    return [
      {
        field: "marketing",
        key: options.pattern,
        value: match[0],
        line: lineOf(text, match.index as number),
      } satisfies FoundValue,
    ];
  },

  write(text, file, values, options) {
    if (values.marketing === undefined && values.build === undefined) return text;
    const { single } = matchOnce(text, file, options);
    // Exactly one match exists, so this replaces only that match; every other byte is untouched.
    return text.replace(single, render(options.replace, file, values));
  },
};
