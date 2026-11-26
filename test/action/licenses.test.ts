import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bundledPackages,
  licenseAllowed,
  packageDir,
  renderNotices,
} from "../../scripts/build-action.ts";
import { tempDir } from "../git/helpers.ts";

/** A fake package in `<dir>/node_modules/<name>` with the given package.json and files. */
function fakePackage(
  dir: string,
  name: string,
  pkg: Record<string, unknown>,
  files: Record<string, string> = {},
): string {
  const at = join(dir, "node_modules", name);
  mkdirSync(join(at, "lib"), { recursive: true });
  writeFileSync(join(at, "package.json"), JSON.stringify({ name, version: "1.0.0", ...pkg }));
  writeFileSync(join(at, "lib/index.js"), "export {};\n");
  for (const [file, text] of Object.entries(files)) writeFileSync(join(at, file), text);
  return join(at, "lib/index.js");
}

describe("third-party licenses of the action bundle", () => {
  it("finds the package directory of a bundled file, scoped and nested in pnpm's store", () => {
    expect(packageDir("/r/node_modules/zod/lib/index.js")).toBe("/r/node_modules/zod");
    expect(packageDir("/r/node_modules/@octokit/core/dist/index.js")).toBe(
      "/r/node_modules/@octokit/core",
    );
    expect(packageDir("/r/node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/index.js")).toBe(
      "/r/node_modules/.pnpm/yaml@2.9.1/node_modules/yaml",
    );
    expect(packageDir("/r/src/index.ts")).toBeUndefined();
  });

  it("allows permissive licenses, and an OR expression when one side is permissive", () => {
    expect(licenseAllowed("MIT")).toBe(true);
    expect(licenseAllowed("(MIT OR GPL-3.0-only)")).toBe(true);
    expect(licenseAllowed("MIT AND ISC")).toBe(true);
    expect(licenseAllowed("MIT AND GPL-3.0-only")).toBe(false);
    expect(licenseAllowed("GPL-3.0-only")).toBe(false);
    expect(licenseAllowed("MPL-2.0")).toBe(false);
    expect(licenseAllowed("")).toBe(false);
  });

  it("copies every license file of each package, once per package", async () => {
    const dir = tempDir("licenses");
    const a = fakePackage(
      dir,
      "a",
      { license: "MIT" },
      { LICENSE: "MIT License\n\nCopyright A\n" },
    );
    const b = fakePackage(
      dir,
      "@s/b",
      { license: "Apache-2.0" },
      { "LICENSE.txt": "Apache License\n", NOTICE: "Copyright B\n", "README.md": "no" },
    );
    const packages = await bundledPackages([a, a.replace("index.js", "other.js"), b, "src/x.ts"]);
    expect(packages.map((p) => p.name)).toEqual(["@s/b", "a"]);
    expect(packages[0]?.files.map((f) => f.name)).toEqual(["LICENSE.txt", "NOTICE"]);
    const text = renderNotices(packages);
    expect(text).toContain("@s/b@1.0.0 (Apache-2.0)");
    expect(text).toContain("NOTICE:\n\nCopyright B");
    expect(text).toContain("a@1.0.0 (MIT)");
    expect(text).toContain("MIT License\n\nCopyright A");
    expect(text).not.toContain("README");
  });

  it("stops the build for a copyleft or missing license, or a package without a license file", async () => {
    const dir = tempDir("licenses");
    const inputs = [
      fakePackage(dir, "gpl", { license: "GPL-3.0-only" }, { LICENSE: "GPL\n" }),
      fakePackage(dir, "none", {}, { LICENSE: "?\n" }),
      fakePackage(dir, "bare", { license: "MIT" }),
      fakePackage(dir, "ok", { license: "ISC" }, { LICENCE: "ISC\n" }),
    ];
    const error = await bundledPackages(inputs).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("gpl@1.0.0");
    expect(message).toContain('license "GPL-3.0-only" isn\'t allowed');
    expect(message).toContain("none@1.0.0");
    expect(message).toContain('license "none" isn\'t allowed');
    expect(message).toContain("bare@1.0.0");
    expect(message).toContain("no LICENSE file");
    expect(message).not.toContain("ok@1.0.0");
  });
});
