/**
 * Adopting launchset in a repo that used Changesets (spec 4.2, 11.1, 12), then releasing it:
 * the converted changesets end up in the release PR, the old changelog keeps its title and
 * its old sections, and a repo with a single web target releases like any other.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { releaseCycle } from "./flow.ts";
import { FIXTURES, read, World } from "./helpers.ts";

const INIT_FIXTURES = join(FIXTURES, "../../fixtures/init");

describe("adopting launchset from Changesets", () => {
  it("converts the changesets, keeps the old changelog, and releases 0.10.0", async () => {
    const world = new World();
    const { dev, github } = world;
    world.wipeDev();
    world.copyDir(join(INIT_FIXTURES, "changesets"));
    dev.git("add", "--all");
    dev.git("commit", "--quiet", "--no-verify", "-m", "The repo, before launchset");
    const init = await world.devCli(["init", "--yes", "--baseline"]);
    expect(init.code, init.stdout + init.stderr).toBe(0);
    // 0.9.4 is marked as released by the baseline tag.
    expect(dev.git("tag")).toBe("v0.9.4");
    dev.git("add", "--all");
    dev.git("commit", "--quiet", "--no-verify", "-m", "Set up launchset");
    dev.git("push", "--quiet", "origin", "main", "v0.9.4");

    // The converted changesets are pending; the Changesets folder is left alone.
    const status = await world
      .job("main")
      .json<{ pending: { bump: string; summary: string }[]; nextVersion: string }>(["status"]);
    expect(status.pending.map((p) => `${p.bump}: ${p.summary}`).sort()).toEqual([
      "minor: Add a date picker widget.",
      "patch: Fix the button focus ring.",
    ]);
    expect(status.nextVersion).toBe("0.10.0");
    expect(dev.git("ls-files", ".changeset")).toContain(".changeset/config.json");

    const cycle = await releaseCycle(world);
    expect(cycle.version).toBe("0.10.0");
    expect(JSON.parse(cycle.plan).matrix).toEqual(["web"]);

    // The new section sits above the old one; the title and the old section are untouched.
    const changelog = world.file("main", "CHANGELOG.md");
    expect(changelog).toBe(
      [
        "# @demonsters/widgets",
        "",
        "## 0.10.0 (2026-11-18)",
        "",
        "### Minor changes",
        "- Add a date picker widget.",
        "",
        "### Patch changes",
        "- Fix the button focus ring.",
        "",
        "## 0.9.4",
        "",
        "### Patch Changes",
        "",
        "- Fix the tooltip.",
        "",
      ].join("\n"),
    );
    expect(world.tags().get("v0.10.0")).toBe(cycle.releaseSha);
    expect(github.release("v0.10.0")?.body).toContain("- Add a date picker widget.");
    // Consumed: nothing pending anymore, and the version file was bumped.
    expect(world.file("main", "package.json")).toContain('"version": "0.10.0"');
    const after = await world
      .job("main")
      .json<{ pending: unknown[]; lastRelease: { version: string } }>(["status"]);
    expect(after.pending).toEqual([]);
    expect(after.lastRelease.version).toBe("0.10.0");
    expect(read(world.job("main").dir, ".changeset/config.json")).toContain("changelog");
  });
});
