/**
 * Flutter / Dart `pubspec.yaml` stamper (spec 6.3 and 6.4 `flutter`, 5 `version.file`).
 *
 * The top-level `version` holds both numbers in one value: `1.5.0+217175105` is the build name
 * `1.5.0` and the build number `217175105`. Flutter passes them to the native projects
 * (`flutter.versionName` / `flutter.versionCode` in Gradle, `$(FLUTTER_BUILD_NAME)` /
 * `$(FLUTTER_BUILD_NUMBER)` in `Info.plist`).
 *
 * - marketing: the part before `+`. Writing only the marketing version (the release PR) keeps
 *   the `+…` suffix exactly as written, or its absence, so the diff is the version alone.
 * - build: the part after `+`. Written only in CI (build numbers are never committed, spec 1.1):
 *   replaces the suffix, or appends `+<n>` when there is none.
 *
 * The scalar is found with the `yaml` library's node ranges and spliced; plain, 'single' and
 * "double" quoted values keep their style. Nested `version` keys (a dependency's) are ignored.
 */

import { assertBuildNumber, assertIosMarketing } from "./ios-version.ts";
import {
  applySplices,
  type FoundValue,
  StampError,
  type StampValues,
  type TextStamper,
} from "./types.ts";
import { type LocatedScalar, locateYamlScalar } from "./yaml.ts";

export interface PubspecOptions {
  /** The platform the value is for: iOS needs a plain `X.Y.Z` build name. */
  platform?: "android" | "ios";
}

/** A version without build metadata: `X.Y.Z` with an optional prerelease. */
const BUILD_NAME = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function locateVersion(text: string, file: string): LocatedScalar {
  try {
    return locateYamlScalar(text, file, "version");
  } catch (error) {
    if (error instanceof StampError && error.reason.startsWith('key "version" not found')) {
      throw new StampError(
        file,
        "no top-level version; add one, e.g. `version: 1.0.0+1` (build name + build number)",
      );
    }
    throw error;
  }
}

/** The value as written in the file (the text between the quotes for a quoted scalar). */
function source(text: string, loc: LocatedScalar, file: string): string {
  const raw = text.slice(loc.start, loc.end);
  if (loc.quote === '"' && raw.includes("\\")) {
    throw new StampError(
      file,
      `version (line ${loc.line}) uses escape sequences; write it as a plain value like 1.0.0+1`,
    );
  }
  return raw;
}

/** `1.5.0+12` → `{ name: "1.5.0", suffix: "+12" }`; without `+` the suffix is empty. */
export function splitPubspecVersion(value: string): { name: string; suffix: string } {
  const at = value.indexOf("+");
  return at === -1
    ? { name: value, suffix: "" }
    : { name: value.slice(0, at), suffix: value.slice(at) };
}

export const pubspec: TextStamper<PubspecOptions | undefined> = {
  read(text, file) {
    const loc = locateVersion(text, file);
    const { name, suffix } = splitPubspecVersion(source(text, loc, file));
    const found: FoundValue[] = [
      { field: "marketing", key: "version", value: name, line: loc.line },
    ];
    if (suffix !== "") {
      found.push({
        field: "build",
        key: "version (+build)",
        value: suffix.slice(1),
        line: loc.line,
      });
    }
    return found;
  },

  write(text, file, values: StampValues, options) {
    if (values.marketing === undefined && values.build === undefined) return text;
    if (values.marketing !== undefined) {
      if (!BUILD_NAME.test(values.marketing)) {
        throw new StampError(
          file,
          `can't write "${values.marketing}" as the version: expected X.Y.Z with an optional prerelease`,
        );
      }
      if (options?.platform === "ios") assertIosMarketing(values.marketing, file);
    }
    if (values.build !== undefined) assertBuildNumber(values.build, file);

    const loc = locateVersion(text, file);
    const current = splitPubspecVersion(source(text, loc, file));
    const name = values.marketing ?? current.name;
    const suffix = values.build !== undefined ? `+${values.build}` : current.suffix;
    return applySplices(text, [{ start: loc.start, end: loc.end, text: `${name}${suffix}` }]);
  },
};
