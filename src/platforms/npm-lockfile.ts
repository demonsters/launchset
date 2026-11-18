/**
 * npm lockfile stamper (spec 6.6 "npm lockfile"): `package-lock.json` / `npm-shrinkwrap.json`
 * store the root version twice, as top-level `"version"` and as `packages[""].version`. Both are
 * updated; a missing value is skipped silently (lockfileVersion 1 has no `packages`, and some
 * lockfiles carry no root version at all). Marketing version only.
 */

import { findNodeAtLocation } from "jsonc-parser";
import { assertUniquePath } from "./json.ts";
import { type JsonPath, jsonLiteral, parseJsonTree } from "./json-splice.ts";
import {
  applySplices,
  type FoundValue,
  lineOf,
  type Splice,
  StampError,
  type TextStamper,
} from "./types.ts";

const LOCATIONS: { key: string; path: JsonPath }[] = [
  { key: "version", path: ["version"] },
  { key: 'packages[""].version', path: ["packages", "", "version"] },
];

function locate(text: string, file: string) {
  const tree = parseJsonTree(text, file);
  if (tree.type !== "object") {
    throw new StampError(file, `expected a JSON object at the top level, found ${tree.type}`);
  }
  const found: { key: string; offset: number; length: number; value: string; line: number }[] = [];
  for (const { key, path } of LOCATIONS) {
    assertUniquePath(tree, path, file);
    const node = findNodeAtLocation(tree, path);
    if (!node) continue;
    if (node.type !== "string") {
      throw new StampError(
        file,
        `${key} (line ${lineOf(text, node.offset)}) is a ${node.type}, expected a string`,
      );
    }
    found.push({
      key,
      offset: node.offset,
      length: node.length,
      value: String(node.value),
      line: lineOf(text, node.offset),
    });
  }
  return found;
}

export const npmLockfile: TextStamper = {
  read(text, file) {
    return locate(text, file).map(
      (f): FoundValue => ({ field: "marketing", key: f.key, value: f.value, line: f.line }),
    );
  },

  write(text, file, values) {
    if (values.marketing === undefined) return text;
    const literal = jsonLiteral(values.marketing, "string");
    const splices: Splice[] = locate(text, file).map((f) => ({
      start: f.offset,
      end: f.offset + f.length,
      text: literal,
    }));
    return applySplices(text, splices);
  },
};
