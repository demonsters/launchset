/**
 * Locate and splice single JSON values without re-serializing (spec 6, rule "parse to find,
 * splice to edit"). Shared by the json, npm-lockfile and expo stampers.
 */

import { findNodeAtLocation, type Node, type ParseError, parseTree } from "jsonc-parser";
import { lineOf, StampError } from "./types.ts";

export type JsonPath = (string | number)[];

/**
 * Parse `text` into a jsonc-parser tree, or throw `StampError` with the first syntax error.
 * A leading UTF-8 BOM is skipped (parsed as a blank), so node offsets are valid in `text` itself
 * and splicing keeps the BOM.
 */
export function parseJsonTree(text: string, file: string): Node {
  const errors: ParseError[] = [];
  const source = text.startsWith("\uFEFF") ? ` ${text.slice(1)}` : text;
  const tree = parseTree(source, errors, { allowTrailingComma: true, disallowComments: false });
  const first = errors[0];
  if (!tree || first) {
    const line = first ? lineOf(text, first.offset) : 1;
    throw new StampError(file, `invalid JSON (line ${line})`);
  }
  return tree;
}

/** Split a dotted key (`expo.android.versionCode`, `items.0.version`) into a path. */
export function dottedPath(key: string): JsonPath {
  return key.split(".");
}

/**
 * Turns numeric string segments into array indexes wherever the node at that point is an array
 * (`["items", "0", "version"]` → `["items", 0, "version"]`). Object keys that look like numbers
 * stay strings.
 */
export function resolveJsonPath(tree: Node, path: JsonPath): JsonPath {
  const out: JsonPath = [];
  let node: Node | undefined = tree;
  for (const segment of path) {
    const isIndex = typeof segment === "string" && /^(0|[1-9]\d*)$/.test(segment);
    const resolved: string | number = node?.type === "array" && isIndex ? Number(segment) : segment;
    out.push(resolved);
    node = node ? findNodeAtLocation(node, [resolved]) : undefined;
  }
  return out;
}

export interface JsonValueLocation {
  node: Node;
  /** The value as a string (strings without quotes, numbers as written). */
  value: string;
  line: number;
}

/** Find a scalar value. Returns `undefined` when the path doesn't exist. */
export function findJsonScalar(
  text: string,
  tree: Node,
  path: JsonPath,
  file: string,
): JsonValueLocation | undefined {
  const node = findNodeAtLocation(tree, resolveJsonPath(tree, path));
  if (!node) return undefined;
  if (node.type !== "string" && node.type !== "number") {
    throw new StampError(file, `${path.join(".")} is a ${node.type}, expected a string or number`);
  }
  const raw = text.slice(node.offset, node.offset + node.length);
  return {
    node,
    value: node.type === "string" ? String(node.value) : raw,
    line: lineOf(text, node.offset),
  };
}

/**
 * Text that replaces the value at `location`: a JSON string literal when `as` is `string`,
 * a bare number when `as` is `number`.
 */
export function jsonLiteral(value: string | number, as: "string" | "number"): string {
  return as === "string" ? JSON.stringify(String(value)) : String(value);
}
