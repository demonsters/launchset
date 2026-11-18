/**
 * XML `Info.plist` stamper (spec 6.4 `plist`).
 *
 * Marketing version = `CFBundleShortVersionString`, build number = `CFBundleVersion`. Only keys
 * of the top-level `<dict>` count; keys of nested dictionaries are ignored. The edit replaces
 * the text of the key's `<string>` element and nothing else.
 *
 * A value that is a build-setting reference (`$(MARKETING_VERSION)`) is returned as-is by `read`
 * (`init` uses it to pick source kind `xcodeproj`) and is an error when that field is written.
 */

import { assertBuildNumber, assertIosMarketing, isBuildSettingReference } from "./ios-version.ts";
import {
  applySplices,
  type FoundValue,
  lineOf,
  type Splice,
  StampError,
  type StampValues,
  type TextStamper,
} from "./types.ts";

const MARKETING_KEY = "CFBundleShortVersionString";
const BUILD_KEY = "CFBundleVersion";

interface Token {
  type: "open" | "close" | "selfclose" | "other";
  name: string;
  start: number;
  end: number;
}

const TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![A-Za-z][^>]*>|<\/([A-Za-z][\w:.-]*)\s*>|<([A-Za-z][\w:.-]*)(?:\s[^>]*?)?(\/?)>/g;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index;
    const end = start + m[0].length;
    if (m[1] !== undefined) tokens.push({ type: "close", name: m[1], start, end });
    else if (m[2] !== undefined) {
      tokens.push({ type: m[3] ? "selfclose" : "open", name: m[2], start, end });
    } else tokens.push({ type: "other", name: "", start, end });
  }
  return tokens;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Where a key's `<string>` value sits. */
interface StringValue {
  key: string;
  value: string;
  /** Range to replace: the element's text, or the whole `<string/>` tag when empty and self-closing. */
  start: number;
  end: number;
  selfClosing: boolean;
}

function fail(file: string, reason: string): never {
  throw new StampError(file, reason);
}

/** Top-level `<string>` values by key. A key with a non-string value is reported when asked for. */
function scanTopLevel(text: string, file: string, wanted: string[]): Map<string, StringValue[]> {
  if (text.startsWith("bplist")) {
    fail(
      file,
      `this is a binary property list, which launchset can't edit as text. Convert it to XML (plutil -convert xml1 <file>), or set the version through the Xcode project with source kind "xcodeproj".`,
    );
  }
  const tokens = tokenize(text);
  let i = tokens.findIndex((t) => t.type === "open" && t.name === "plist");
  if (i < 0) fail(file, "not an XML property list: no <plist> element found");
  i++;
  while (tokens[i]?.type === "other") i++;
  const dictTok = tokens[i];
  if (dictTok?.name !== "dict") {
    fail(file, "not an Info.plist: the <plist> element doesn't contain a <dict>");
  }

  const found = new Map<string, StringValue[]>();
  if (dictTok.type === "selfclose") return found;
  i++;

  for (;;) {
    while (tokens[i]?.type === "other") i++;
    const keyTok = tokens[i];
    if (!keyTok) fail(file, "unterminated top-level <dict>");
    if (keyTok.type === "close" && keyTok.name === "dict") return found;
    if (keyTok.type !== "open" || keyTok.name !== "key") {
      fail(file, `expected a <key> in the top-level <dict> (line ${lineOf(text, keyTok.start)})`);
    }
    const keyClose = tokens[i + 1];
    if (keyClose?.type !== "close" || keyClose.name !== "key") {
      fail(file, `malformed <key> element (line ${lineOf(text, keyTok.start)})`);
    }
    const key = decodeEntities(text.slice(keyTok.end, keyClose.start).trim());
    i += 2;
    while (tokens[i]?.type === "other") i++;

    const valTok = tokens[i];
    if (!valTok) fail(file, `no value for key ${key}`);
    const line = lineOf(text, valTok.start);

    // Find the end of the value element, skipping nested containers.
    let endIdx = i;
    if (valTok.type === "open") {
      let depth = 1;
      let j = i + 1;
      for (; j < tokens.length && depth > 0; j++) {
        const t = tokens[j] as Token;
        if (t.type === "open") depth++;
        else if (t.type === "close") depth--;
      }
      if (depth > 0) fail(file, `unterminated <${valTok.name}> for key ${key} (line ${line})`);
      endIdx = j - 1;
    } else if (valTok.type !== "selfclose") {
      fail(file, `expected a value element for key ${key} (line ${line})`);
    }

    if (wanted.includes(key)) {
      if (valTok.name !== "string") {
        fail(file, `${key} is a <${valTok.name}> (line ${line}), expected a <string>`);
      }
      let sv: StringValue;
      if (valTok.type === "selfclose") {
        sv = { key, value: "", start: valTok.start, end: valTok.end, selfClosing: true };
      } else {
        const closeTok = tokens[endIdx] as Token;
        if (endIdx !== i + 1) {
          fail(
            file,
            `${key} has an unsupported <string> value (line ${line}): comments or CDATA inside it`,
          );
        }
        const raw = text.slice(valTok.end, closeTok.start);
        sv = {
          key,
          value: decodeEntities(raw),
          start: valTok.end,
          end: closeTok.start,
          selfClosing: false,
        };
      }
      const list = found.get(key) ?? [];
      list.push(sv);
      found.set(key, list);
    }
    i = endIdx + 1;
  }
}

function single(
  found: Map<string, StringValue[]>,
  key: string,
  file: string,
): StringValue | undefined {
  const list = found.get(key);
  if (list && list.length > 1) {
    fail(
      file,
      `${key} appears ${list.length} times in the top-level <dict>, can't tell which to change`,
    );
  }
  return list?.[0];
}

export const plist: TextStamper = {
  read(text, file) {
    const found = scanTopLevel(text, file, [MARKETING_KEY, BUILD_KEY]);
    const marketing = single(found, MARKETING_KEY, file);
    const build = single(found, BUILD_KEY, file);
    if (!marketing) {
      fail(
        file,
        `${MARKETING_KEY} not found in the top-level <dict>. Add the key, or use another source kind.`,
      );
    }
    const toFound = (field: FoundValue["field"], v: StringValue): FoundValue => ({
      field,
      key: v.key,
      value: v.value,
      line: lineOf(text, v.start),
    });
    return build
      ? [toFound("marketing", marketing), toFound("build", build)]
      : [toFound("marketing", marketing)];
  },

  write(text, file, values: StampValues) {
    if (values.marketing === undefined && values.build === undefined) return text;
    if (values.marketing !== undefined) assertIosMarketing(values.marketing, file);
    if (values.build !== undefined) assertBuildNumber(values.build, file);

    const found = scanTopLevel(text, file, [MARKETING_KEY, BUILD_KEY]);
    const splices: Splice[] = [];
    const targets: [string, string | undefined][] = [
      [MARKETING_KEY, values.marketing],
      [BUILD_KEY, values.build === undefined ? undefined : String(values.build)],
    ];
    for (const [key, value] of targets) {
      if (value === undefined) continue;
      const current = single(found, key, file);
      if (!current) {
        fail(
          file,
          `${key} not found in the top-level <dict>. Add the key with a placeholder value, or use another source kind.`,
        );
      }
      if (isBuildSettingReference(current.value)) {
        fail(
          file,
          `${key} uses the build setting ${current.value}; use source kind "xcodeproj" (or "xcconfig") instead`,
        );
      }
      splices.push(
        current.selfClosing
          ? { start: current.start, end: current.end, text: `<string>${value}</string>` }
          : { start: current.start, end: current.end, text: value },
      );
    }
    return applySplices(text, splices);
  },
};
