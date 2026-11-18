/**
 * Generic JSON stamper (spec 6.6, kind `json`): replaces one string value, addressed by a dotted
 * key (`version`, `expo.version`), keeping everything else byte for byte. Marketing version only:
 * `values.build` is ignored. Keys that themselves contain a dot can't be addressed.
 */

import type { Node } from "jsonc-parser";
import {
  dottedPath,
  findJsonScalar,
  type JsonPath,
  jsonLiteral,
  parseJsonTree,
  resolveJsonPath,
} from "./json-splice.ts";
import { applySplices, type FoundValue, StampError, type TextStamper } from "./types.ts";

export interface JsonValueOptions {
  key: string;
}

/**
 * Throws when an object along `path` has the same property twice: which one a reader sees is
 * parser-dependent, so launchset refuses to guess.
 */
export function assertUniquePath(tree: Node, path: JsonPath, file: string): void {
  let node: Node | undefined = tree;
  for (const segment of resolveJsonPath(tree, path)) {
    if (node?.type === "array") {
      node = typeof segment === "number" ? node.children?.[segment] : undefined;
      continue;
    }
    if (node?.type !== "object") return;
    const props: Node[] = (node.children ?? []).filter((p) => p.children?.[0]?.value === segment);
    if (props.length > 1) {
      throw new StampError(
        file,
        `key "${segment}" appears ${props.length} times in the same object; can't tell which one to stamp`,
      );
    }
    node = props[0]?.children?.[1];
  }
}

function locate(text: string, file: string, key: string) {
  const tree = parseJsonTree(text, file);
  const path = dottedPath(key);
  assertUniquePath(tree, path, file);
  const loc = findJsonScalar(text, tree, path, file);
  if (!loc) throw new StampError(file, `key "${key}" not found`);
  if (loc.node.type !== "string") {
    throw new StampError(
      file,
      `value of "${key}" (line ${loc.line}) is a ${loc.node.type}, expected a string`,
    );
  }
  return loc;
}

export const jsonValue: TextStamper<JsonValueOptions> = {
  read(text, file, options) {
    const loc = locate(text, file, options.key);
    return [
      {
        field: "marketing",
        key: options.key,
        value: loc.value,
        line: loc.line,
      } satisfies FoundValue,
    ];
  },

  write(text, file, values, options) {
    if (values.marketing === undefined) return text;
    const { node } = locate(text, file, options.key);
    return applySplices(text, [
      {
        start: node.offset,
        end: node.offset + node.length,
        text: jsonLiteral(values.marketing, "string"),
      },
    ]);
  },
};
