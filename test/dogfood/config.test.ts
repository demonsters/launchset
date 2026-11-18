import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.ts";
import { parseChangeset } from "../../src/core/changesets.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("launchset's own config (spec 15)", () => {
  it("loads from the repo root and validates", async () => {
    const { config, file } = await loadConfig(root);
    expect(file).toBe(join(root, "launchset.config.ts"));
    expect(config.baseBranch).toBe("main");
    expect(config.version.file).toBe("package.json");
  });

  it("has an npm target and an action target, both auto, no files, no verify", async () => {
    // No `verify` for npm: trusted-publishing tokens can't read the private package, so the
    // workflow's publish step is idempotent instead.
    const { config } = await loadConfig(root);
    expect(Object.keys(config.targets)).toEqual(["npm", "action"]);
    expect(config.targets.npm).toMatchObject({
      type: "custom",
      release: "auto",
      verify: [],
      npm: { package: "package.json" },
    });
    expect(config.targets.action).toMatchObject({ type: "custom", release: "auto", verify: [] });
    for (const target of Object.values(config.targets)) {
      expect(target).toMatchObject({ files: [] });
    }
  });

  it("previews only npm prereleases on next/* (dist-tag next)", async () => {
    const { config } = await loadConfig(root);
    expect(config.preview.enabled).toBe(true);
    expect(config.preview.targets).toEqual(["npm"]);
    expect(config.preview.branches).toEqual([
      { branch: "next/*", prerelease: "next", targets: ["npm"] },
    ]);
  });

  it("imports nothing at runtime, so it loads without node_modules (CI smoke test)", () => {
    const imports = read("launchset.config.ts")
      .split("\n")
      .filter((line) => /^import\b/.test(line));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).toMatch(/^import type\b/);
  });

  it("the package it releases is the root package.json, private and scoped", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.name).toBe("@demonsters/launchset");
    expect(pkg.publishConfig).toEqual({ access: "restricted" });
    // The workflows run these.
    expect(pkg.scripts.build).toBeTypeOf("string");
    expect(pkg.scripts["build:action"]).toBeTypeOf("string");
  });
});

describe(".launchset folder", () => {
  it("holds the README that `launchset init` writes", () => {
    expect(read(".launchset/README.md")).toBe(read("templates/launchset-readme.md"));
  });

  it("only holds valid changesets besides the README", () => {
    const files = readdirSync(join(root, ".launchset")).filter((f) => f !== "README.md");
    for (const file of files) {
      expect(file).toMatch(/^[a-z]+(-[a-z]+)*\.md$/);
      const { changeset, warnings } = parseChangeset(
        read(`.launchset/${file}`),
        `.launchset/${file}`,
      );
      expect(warnings).toEqual([]);
      expect(["major", "minor", "patch", "none"]).toContain(changeset.bump);
    }
  });

  it("keeps a changelog with just its title until the first release", () => {
    expect(existsSync(join(root, "CHANGELOG.md"))).toBe(true);
    expect(read("CHANGELOG.md")).toMatch(/^# Changelog\n/);
  });
});
