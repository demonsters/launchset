/**
 * Files that ship inside the launchset package (`templates/`, `skills/`), found relative to
 * this module. It runs from `src/init/` in the repo and from a bundled file in `dist/` (one
 * level below the package root, maybe deeper for shared chunks) in the npm package, so it
 * walks up to the directory whose package.json is `@demonsters/launchset`.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LaunchsetError } from "../core/errors.ts";

const PACKAGE_NAME = "@demonsters/launchset";

let cachedRoot: string | undefined;

function isPackageRoot(dir: string): boolean {
  const file = join(dir, "package.json");
  if (!existsSync(file)) return false;
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { name?: unknown }).name === PACKAGE_NAME;
  } catch {
    // An unreadable package.json is not ours; keep walking up.
    return false;
  }
}

/** Absolute path of the launchset package root. */
export function packageRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    if (isPackageRoot(dir)) {
      cachedRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new LaunchsetError(
    "package-root-not-found",
    `Could not find the ${PACKAGE_NAME} package folder from ${fileURLToPath(import.meta.url)}.`,
    { hint: "This is a packaging bug: templates/ and skills/ must ship next to dist/." },
  );
}

/** Absolute path of a file in the package, e.g. `packageFile("templates", "launchset-readme.md")`. */
export function packageFile(...segments: string[]): string {
  return join(packageRoot(), ...segments);
}

/** Text of a package file. Throws a clear error when it's missing. */
export function readPackageFile(...segments: string[]): string {
  const path = packageFile(...segments);
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new LaunchsetError(
      "package-file-missing",
      `Missing package file ${segments.join("/")}.`,
      {
        cause: error,
        hint: "This is a packaging bug: the file must ship with launchset.",
      },
    );
  }
}
