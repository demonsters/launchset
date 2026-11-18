/**
 * Generic YAML stamper (spec 6.6, kind `yaml`): replaces one scalar, addressed by a dotted key
 * (`appVersion`, `metadata.labels.version`), using the `yaml` library only to find the scalar's
 * source range. Only the scalar's text changes; plain, 'single' and "double" quote styles are kept.
 *
 * In a multi-document file the key must exist in exactly one document. Block scalars (`|`, `>`),
 * multi-line scalars and anchors/aliases are not supported (error). Marketing version only.
 */

import {
  type Document,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
  type Scalar,
} from "yaml";
import { applySplices, type FoundValue, lineOf, StampError, type TextStamper } from "./types.ts";

export interface YamlValueOptions {
  key: string;
}

interface Located {
  start: number;
  end: number;
  quote: '"' | "'" | null;
  value: string;
  line: number;
}

function parse(text: string, file: string): Document.Parsed[] {
  const docs = parseAllDocuments(text);
  const list = Array.isArray(docs) ? docs : [docs];
  for (const doc of list) {
    const err = doc.errors[0];
    if (err) {
      const line = err.linePos?.[0]?.line ?? lineOf(text, err.pos[0]);
      throw new StampError(file, `invalid YAML (line ${line}): ${err.message.split("\n")[0]}`);
    }
  }
  return list;
}

function describe(text: string, file: string, key: string, scalar: Scalar): Located {
  const range = scalar.range;
  const line = range ? lineOf(text, range[0]) : 1;
  const where = `"${key}" (line ${line})`;
  if (!range || range[1] === range[0]) throw new StampError(file, `${where} has no value`);
  const type = scalar.type;
  if (type !== "PLAIN" && type !== "QUOTE_DOUBLE" && type !== "QUOTE_SINGLE") {
    throw new StampError(
      file,
      `${where} is a block scalar; only plain or quoted values are supported`,
    );
  }
  const source = text.slice(range[0], range[1]);
  if (/[\r\n]/.test(source))
    throw new StampError(file, `${where} spans multiple lines, which isn't supported`);
  if (type === "PLAIN") {
    return { start: range[0], end: range[1], quote: null, value: source, line };
  }
  const quote = type === "QUOTE_DOUBLE" ? '"' : "'";
  return { start: range[0] + 1, end: range[1] - 1, quote, value: String(scalar.value), line };
}

/** Walk `path` through maps and sequences; `undefined` when a key is missing. */
function walk(doc: Document.Parsed, path: string[], file: string, key: string): unknown {
  let node: unknown = doc.contents;
  for (const segment of path) {
    if (isAlias(node)) {
      throw new StampError(
        file,
        `"${key}" is reached through an alias (*${node.source}); aliases and anchors can't be stamped`,
      );
    }
    if (isMap(node)) {
      const next = node.get(segment, true);
      if (next === undefined) {
        const merged = node.items.some((pair) => isScalar(pair.key) && pair.key.value === "<<");
        if (merged) {
          throw new StampError(
            file,
            `"${key}" isn't set directly: a "<<" merge key is in the way and merge keys can't be stamped`,
          );
        }
        return undefined;
      }
      node = next;
    } else if (isSeq(node) && /^(0|[1-9]\d*)$/.test(segment)) {
      node = node.get(Number(segment), true);
    } else {
      return undefined;
    }
  }
  return node;
}

function locate(text: string, file: string, key: string): Located {
  const path = key.split(".");
  const hits: { doc: number; scalar: Scalar }[] = [];
  parse(text, file).forEach((doc, index) => {
    const node = walk(doc, path, file, key);
    if (node === undefined || node === null) return;
    if (isAlias(node)) {
      throw new StampError(
        file,
        `"${key}" is an alias (*${node.source}); aliases and anchors can't be stamped`,
      );
    }
    if (!isScalar(node)) {
      throw new StampError(file, `"${key}" is a collection, expected a string value`);
    }
    if (node.anchor) {
      throw new StampError(
        file,
        `"${key}" is anchored (&${node.anchor}), so other places may share this value through an alias; anchors can't be stamped`,
      );
    }
    hits.push({ doc: index + 1, scalar: node });
  });
  if (hits.length === 0) throw new StampError(file, `key "${key}" not found`);
  if (hits.length > 1) {
    const docs = hits.map((h) => h.doc).join(", ");
    throw new StampError(
      file,
      `key "${key}" exists in more than one YAML document (documents ${docs}); can't tell which one to stamp`,
    );
  }
  return describe(text, file, key, (hits[0] as { scalar: Scalar }).scalar);
}

export const yamlValue: TextStamper<YamlValueOptions> = {
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
    const loc = locate(text, file, options.key);
    const version = values.marketing;
    if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(version)) {
      throw new StampError(
        file,
        `can't write "${version}" as "${options.key}": not a plain version string`,
      );
    }
    return applySplices(text, [{ start: loc.start, end: loc.end, text: version }]);
  },
};
