/**
 * Releases from checkouts that look like a team's CI after an install step: git hooks installed
 * (husky, simple-git-hooks, lefthook and git-lfs all add some), every one failing, and the
 * read-only `GITHUB_TOKEN` header actions/checkout persists. launchset's commits, checkouts,
 * branch pushes and tag pushes must run none of the hooks. Before, a pre-push hook ran on
 * every push: git-lfs's lock check failed `mark` in the first release of an LFS repo, and a
 * team's pre-push (tests, lint, `npx launchset check --push`) would have done the same.
 */

import { describe, expect, it } from "vitest";
import { setupApp } from "./app.ts";
import { releaseCycle } from "./flow.ts";
import { World } from "./helpers.ts";

describe("releasing from checkouts with the team's git hooks installed", () => {
  it("runs no hooks: release PR, mark, finalize, and a hotfix line with its backport PR", async () => {
    const world = new World();
    await setupApp(world);
    world.installTeamHooks();

    // main: release PR (commit, checkout, branch push), mark (tag pushes), finalize (v tag).
    await world.devAddChangeset("minor", "Add offline mode.");
    const main = await releaseCycle(world);
    expect(main.version).toBe("1.5.0");
    expect(world.tags().get("v1.5.0")).toBe(main.releaseSha);
    expect(world.tagNames("launchset/")).toEqual([
      "launchset/android@1.5.0",
      "launchset/docker@1.5.0",
      "launchset/web@1.5.0",
    ]);

    // A hotfix line: its finalize also commits and pushes the changelog backport branch.
    expect((await world.devCli(["hotfix", "1.5"])).code).toBe(0);
    world.devCheckout("release/1.5.x");
    await world.devAddChangeset("patch", "Fix the crash on the old line.");
    const hotfix = await releaseCycle(world, { branch: "release/1.5.x" });
    expect(hotfix.version).toBe("1.5.1");
    expect(world.tags().get("v1.5.1")).toBe(hotfix.releaseSha);
    expect(world.remoteHead("launchset/changelog/v1.5.1")).toBeTruthy();

    expect(world.hooksRan()).toBe("");
  });
});
