/**
 * Expo `app.json` stampers (spec 6.3 `expo`, 6.4 `expo`).
 *
 * - `expoAndroid`: marketing = `expo.version`, build = `expo.android.versionCode` (JSON integer).
 * - `expoIos`:     marketing = `expo.version`, build = `expo.ios.buildNumber` (JSON string).
 *
 * Existing values are replaced in place. When the build-number key (or its `android` / `ios`
 * parent object) is missing and a build number is given, one property is inserted right after
 * the last property of the object it belongs to, in the file's indentation and line endings.
 * Nothing else in the file moves: no neighbouring line is reformatted. That only happens in CI
 * (build numbers are never committed, spec 1.1), so the file is never left changed in git.
 *
 * A key that appears twice in the same object (on the stamped path) is an error: parsers
 * disagree about which one wins, so launchset won't pick one.
 *
 * `app.config.js` / `app.config.ts` are code and are not handled here (spec 6.5).
 */

import { findNodeAtLocation, type Node } from "jsonc-parser";
import { indentAt } from "../core/text.ts";
import { assertBuildNumber, assertIosMarketing } from "./ios-version.ts";
import { assertUniquePath } from "./json.ts";
import {
  findJsonScalar,
  type JsonPath,
  type JsonValueLocation,
  jsonLiteral,
  parseJsonTree,
} from "./json-splice.ts";
import {
  applySplices,
  detectEol,
  type FoundValue,
  type Splice,
  StampError,
  type StampValues,
  type TextStamper,
} from "./types.ts";

/** Play Store limit for `versionCode` (spec 6.3). */
const MAX_VERSION_CODE = 2_100_000_000;

type Platform = "android" | "ios";

const VERSION_PATH: JsonPath = ["expo", "version"];

/** One indentation level of the file: a tab, or the width of its first indented line. */
function indentUnit(text: string): string {
  const indent = /^([ \t]+)\S/m.exec(text)?.[1];
  if (indent?.startsWith("\t")) return "\t";
  return " ".repeat(indent ? indent.length : 2);
}

/**
 * Splice that adds `"name": <value>` as the last property of `obj`, touching only the text right
 * after the last property (or inside an empty `{}`). `value(indent)` renders the value for a
 * property whose line is indented by `indent` (`null` for single-line objects).
 */
function insertProperty(
  text: string,
  obj: Node,
  name: string,
  value: (indent: string | null) => string,
): Splice {
  const eol = detectEol(text);
  const unit = indentUnit(text);
  const key = JSON.stringify(name);
  const last = obj.children?.at(-1);
  const multiline = text.slice(obj.offset, obj.offset + obj.length).includes("\n");
  if (last) {
    const at = last.offset + last.length;
    if (!multiline) return { start: at, end: at, text: `, ${key}: ${value(null)}` };
    const indent = indentAt(text, last.offset);
    return { start: at, end: at, text: `,${eol}${indent}${key}: ${value(indent)}` };
  }
  // Empty object: `{}` becomes a one-property object, laid out like its surroundings.
  const start = obj.offset;
  const end = obj.offset + obj.length;
  if (!text.includes("\n")) return { start, end, text: `{${key}: ${value(null)}}` };
  const outer = indentAt(text, obj.offset);
  const inner = outer + unit;
  return { start, end, text: `{${eol}${inner}${key}: ${value(inner)}${eol}${outer}}` };
}

function createExpoStamper(platform: Platform): TextStamper {
  const buildPath: JsonPath =
    platform === "android" ? ["expo", "android", "versionCode"] : ["expo", "ios", "buildNumber"];
  const buildKey = buildPath.join(".");
  const buildAs = platform === "android" ? "number" : "string";

  function requireExpo(text: string, file: string): Node {
    const tree = parseJsonTree(text, file);
    const expo = findNodeAtLocation(tree, ["expo"]);
    if (expo?.type !== "object") {
      throw new StampError(
        file,
        `no top-level "expo" object. launchset stamps the Expo config in app.json; for app.config.js/ts read the version from LAUNCHSET_VERSION instead`,
      );
    }
    return tree;
  }

  function findVersion(text: string, tree: Node, file: string) {
    assertUniquePath(tree, VERSION_PATH, file);
    const loc = findJsonScalar(text, tree, VERSION_PATH, file);
    if (!loc) {
      throw new StampError(file, `expo.version is missing; add it, it is the marketing version`);
    }
    if (loc.node.type !== "string") {
      throw new StampError(file, `expo.version must be a string, got ${loc.node.type}`);
    }
    return loc;
  }

  function replacement(loc: JsonValueLocation, value: string | number, as: "string" | "number") {
    return {
      start: loc.node.offset,
      end: loc.node.offset + loc.node.length,
      text: jsonLiteral(value, as),
    };
  }

  return {
    read(text, file) {
      const tree = requireExpo(text, file);
      const version = findVersion(text, tree, file);
      const found: FoundValue[] = [
        { field: "marketing", key: "expo.version", value: version.value, line: version.line },
      ];
      assertUniquePath(tree, buildPath, file);
      const build = findJsonScalar(text, tree, buildPath, file);
      if (build)
        found.push({ field: "build", key: buildKey, value: build.value, line: build.line });
      return found;
    },

    write(text, file, values: StampValues) {
      if (values.marketing === undefined && values.build === undefined) return text;
      if (platform === "ios" && values.marketing !== undefined)
        assertIosMarketing(values.marketing, file);
      if (values.build !== undefined) {
        assertBuildNumber(values.build, file);
        if (platform === "android" && values.build > MAX_VERSION_CODE) {
          throw new StampError(
            file,
            `versionCode ${values.build} is above the Play Store limit of ${MAX_VERSION_CODE}`,
          );
        }
      }

      let out = text;
      if (values.marketing !== undefined) {
        const tree = requireExpo(out, file);
        out = applySplices(out, [
          replacement(findVersion(out, tree, file), values.marketing, "string"),
        ]);
      }

      if (values.build !== undefined) {
        const tree = requireExpo(out, file);
        assertUniquePath(tree, buildPath, file);
        const existing = findJsonScalar(out, tree, buildPath, file);
        if (existing) {
          out = applySplices(out, [replacement(existing, values.build, buildAs)]);
        } else {
          const parent = findNodeAtLocation(tree, buildPath.slice(0, 2));
          const literal = jsonLiteral(values.build, buildAs);
          if (parent && parent.type !== "object") {
            throw new StampError(
              file,
              `expo.${platform} is a ${parent.type}, expected an object, so ${buildKey} can't be added`,
            );
          }
          let splice: Splice;
          if (parent) {
            splice = insertProperty(out, parent, buildPath[2] as string, () => literal);
          } else {
            const expo = findNodeAtLocation(tree, ["expo"]) as Node;
            const leaf = JSON.stringify(buildPath[2]);
            const nested = (indent: string | null): string =>
              indent === null
                ? `{ ${leaf}: ${literal} }`
                : `{${detectEol(out)}${indent}${indentUnit(out)}${leaf}: ${literal}${detectEol(out)}${indent}}`;
            splice = insertProperty(out, expo, platform, nested);
          }
          out = applySplices(out, [splice]);
        }
      }
      return out;
    },
  };
}

export const expoAndroid: TextStamper = createExpoStamper("android");
export const expoIos: TextStamper = createExpoStamper("ios");
