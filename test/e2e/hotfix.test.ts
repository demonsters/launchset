/**
 * Scenario 2 (spec 9.5, 8.1): a hotfix line. `hotfix 1.4` from v1.4.0, a patch release on
 * `release/1.4.x` through its own release PR, a maintenance release that is not "latest",
 * the changelog backport PR into main, and main's next version skipping what the hotfix took.
 */

import { describe, expect, it } from "vitest";
import { setupApp } from "./app.ts";
import { parsePlan, releaseCycle } from "./flow.ts";
import { World } from "./helpers.ts";

const OLD_CHANGELOG = [
  "# Changelog",
  "",
  "## 1.4.0 (2026-10-01)",
  "",
  "### Minor changes",
  "- Add the dashboard.",
  "",
  "## 1.3.0 (2026-09-01)",
  "",
  "### Minor changes",
  "- Add search.",
  "",
].join("\n");

describe("hotfix line", () => {
  it("releases 1.4.1 from release/1.4.x: not latest, backport PR into main at the right place", async () => {
    const world = new World();
    await setupApp(world, { changelog: OLD_CHANGELOG });
    const { github } = world;

    // main moves on to 1.5.0 (a normal, complete release).
    await world.devAddChangeset("minor", "Add offline mode.");
    const main = await releaseCycle(world);
    expect(main.version).toBe("1.5.0");
    expect(world.tagNames("v")).toEqual(["v1.4.0", "v1.5.0"]);
    expect(github.release("v1.5.0")?.make_latest).toBe("true");

    // --- hotfix 1.4: branch from the latest v1.4.* tag, pushed
    const hotfix = await world.devCli(["hotfix", "1.4"]);
    expect(hotfix.code, hotfix.stderr).toBe(0);
    expect(world.remoteHead("release/1.4.x")).toBe(world.tags().get("v1.4.0"));
    // Creating it again is an error.
    expect((await world.devCli(["hotfix", "1.4"])).code).toBe(1);
    expect((await world.devCli(["hotfix", "1.9"])).code).toBe(1);

    // --- the fix: a PR into release/1.4.x with a patch changeset
    world.devCheckout("release/1.4.x");
    await world.devAddChangeset("patch", "Fix the crash on the old line.");

    // --- release PR on the maintenance branch
    const cycle = await releaseCycle(world, { branch: "release/1.4.x" });
    expect(cycle.version).toBe("1.4.1");
    // Branch naming handles the slash: launchset/release/release/1.4.x.
    expect(github.prs.find((p) => p.head.ref === "launchset/release/release/1.4.x")).toMatchObject({
      title: "Release v1.4.1",
      base: { ref: "release/1.4.x" },
    });
    const plan = parsePlan(cycle.plan);
    expect(plan.distTag).toBe("release-1.4");
    // Maintenance releases never move `latest` or the major tag.
    expect(plan.targets.docker).toMatchObject({ marketingVersion: "1.4.1" });
    const docker = (
      JSON.parse(cycle.plan) as { targets: { docker: { docker: { tags: string[] } } } }
    ).targets.docker.docker.tags;
    expect(docker).toEqual(["1.4.1", "1.4"]);

    // v1.4.1 at the release commit, a Release that is not "latest".
    expect(world.tags().get("v1.4.1")).toBe(cycle.releaseSha);
    const release = github.release("v1.4.1");
    expect(release?.make_latest).toBe("false");
    expect(release?.prerelease).toBe(false);
    expect(github.release("v1.5.0")?.make_latest).toBe("true");

    // --- the changelog backport PR into main
    const backport = github.openPrs().find((p) => p.title === "Changelog: v1.4.1");
    expect(backport).toBeDefined();
    expect(backport?.base.ref).toBe("main");
    expect(backport?.head.ref).toBe("launchset/changelog/v1.4.1");
    const files = world.changedFiles(world.remoteHead("launchset/changelog/v1.4.1"));
    expect(files).toEqual(["M\tCHANGELOG.md"]);
    const changelog = world.file("launchset/changelog/v1.4.1", "CHANGELOG.md");
    const headings = changelog.split("\n").filter((l) => l.startsWith("## "));
    expect(headings).toEqual([
      "## 1.5.0 (2026-11-18)",
      expect.stringMatching(/^## 1\.4\.1 \(2026-11-18\)$/),
      "## 1.4.0 (2026-10-01)",
      "## 1.3.0 (2026-09-01)",
    ]);
    expect(changelog).toContain("- Fix the crash on the old line.");
    // Only the changelog: main's version files and changesets stay as they are.
    expect(world.file("launchset/changelog/v1.4.1", "package.json")).toContain(
      '"version": "1.5.0"',
    );

    // Re-running finalize changes nothing (idempotent) and doesn't duplicate the PR.
    const again = await cycleFinalizeAgain(world, cycle.plan);
    expect(again).toBe(0);
    expect(github.openPrs().filter((p) => p.title === "Changelog: v1.4.1")).toHaveLength(1);
  });

  it("main's next release skips the version the hotfix took (1.4.1 -> 1.4.2)", async () => {
    const world = new World();
    await setupApp(world);
    const { github } = world;

    // main has a pending patch: its release PR would be 1.4.1.
    await world.devAddChangeset("patch", "Fix the footer.");
    await world.pushJob("main").actionOk("release");
    expect(github.openPrs().map((p) => p.title)).toEqual(["Release v1.4.1"]);

    // Meanwhile a hotfix releases 1.4.1 from the maintenance branch.
    expect((await world.devCli(["hotfix", "1.4"])).code).toBe(0);
    world.devCheckout("release/1.4.x");
    await world.devAddChangeset("patch", "Fix the old crash.");
    const hotfix = await releaseCycle(world, { branch: "release/1.4.x" });
    expect(hotfix.version).toBe("1.4.1");
    expect(world.tagNames("v")).toEqual(["v1.4.0", "v1.4.1"]);

    // The next run on main updates the same release PR to the next free version.
    const run = await world.pushJob("main").actionOk("release");
    expect(run.outputs).toMatchObject({ mode: "release-pr", version: "1.4.2" });
    const mainPr = github.prs.find((p) => p.head.ref === "launchset/release/main");
    expect(mainPr?.title).toBe("Release v1.4.2");
    expect(world.file("launchset/release/main", "package.json")).toContain('"version": "1.4.2"');
    // `status` agrees.
    const status = await world.job("main").json<{ nextVersion: string }>(["status"]);
    expect(status.nextVersion).toBe("1.4.2");
  });

  it("a hotfix version with only some markers still counts as taken for main", async () => {
    const world = new World();
    await setupApp(world);
    await world.devAddChangeset("patch", "Fix the footer.");
    expect((await world.devCli(["hotfix", "1.4"])).code).toBe(0);
    world.devCheckout("release/1.4.x");
    await world.devAddChangeset("patch", "Fix the old crash.");
    // 1.4.1 is built for docker only: no release tag, but a marker.
    const hotfix = await releaseCycle(world, {
      branch: "release/1.4.x",
      mark: ["docker"],
      finalize: false,
    });
    expect(hotfix.version).toBe("1.4.1");
    expect(world.tagNames("v")).toEqual(["v1.4.0"]);
    const run = await world.pushJob("main").actionOk("release");
    expect(run.outputs).toMatchObject({ mode: "release-pr", version: "1.4.2" });
  });
});

async function cycleFinalizeAgain(world: World, plan: string): Promise<number> {
  const job = world.pushJob("release/1.4.x");
  const { releaseSha } = parsePlan(plan);
  return (await job.sibling(releaseSha).cli(["finalize", "--plan", plan])).code;
}
