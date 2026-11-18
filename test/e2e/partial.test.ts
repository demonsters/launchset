/**
 * Scenario 3 (spec 9.6): a superseded partial release. 1.5.0 is published but only one of its
 * two auto targets is marked; 1.5.1 is released next. finalize of 1.5.1 supersedes 1.5.0 with
 * the partial tag and a pre-release, and no `v1.5.0` tag ever exists.
 */

import { describe, expect, it } from "vitest";
import { setupApp } from "./app.ts";
import { releaseCycle } from "./flow.ts";
import { World } from "./helpers.ts";

describe("superseded partial release", () => {
  it("1.5.0 with one target shipped is superseded by 1.5.1", async () => {
    const world = new World();
    // Two auto targets: docker and android.
    await setupApp(world, { decide: { "target.web": "none" } });
    const { github } = world;

    // --- 1.5.0: docker ships, android doesn't
    await world.devAddChangeset("minor", "Add offline mode.");
    const partial = await releaseCycle(world, { mark: ["docker"], finalize: false });
    expect(partial.version).toBe("1.5.0");
    const finalizeRun = await partial.releaseJob
      .sibling(partial.releaseSha)
      .cli(["finalize", "--plan", partial.plan]);
    expect(finalizeRun.code).toBe(1);
    expect(finalizeRun.stdout + finalizeRun.stderr).toContain("android");
    expect(world.tagNames("v")).toEqual(["v1.4.0"]);
    expect(world.tagNames("launchset/")).toEqual(["launchset/docker@1.5.0"]);
    expect(github.releases).toEqual([]);

    // `status` reports the unfinished release.
    const status = await world.job("main").json<{
      lastRelease: { version: string };
      unfinished: { version: string; shipped: string[]; missing: string[] }[];
    }>(["status"]);
    expect(status.lastRelease.version).toBe("1.4.0");
    expect(status.unfinished).toEqual([
      { version: "1.5.0", shipped: ["docker"], missing: ["android"] },
    ]);

    // A push after the release commit doesn't retry the release, and says what is missing.
    world.pushDev("Unrelated work", { "work.txt": "x\n" });
    const idle = await world.pushJob("main").actionOk("release");
    expect(idle.outputs.mode).toBe("none");
    expect(`${idle.result?.summary}\n${idle.result?.lines.join("\n")}`).toContain(
      "1.5.0 is not released (missing android)",
    );

    // A new changeset: the next release PR, not a retry.
    await world.devAddChangeset("patch", "Fix the login crash.");
    const next = await world.pushJob("main").actionOk("release");
    expect(next.outputs.mode).toBe("release-pr");
    expect(next.outputs.version).toBe("1.5.1");

    // --- 1.5.1 supersedes it
    const second = await releaseCycle(world);
    expect(second.version).toBe("1.5.1");
    expect(world.tags().get("v1.5.1")).toBe(second.releaseSha);
    expect(world.tagNames("v")).toEqual(["v1.4.0", "v1.5.1"]);
    expect(world.tags().has("v1.5.0")).toBe(false);

    // The partial tag sits on the old release commit, outside the v* namespace.
    expect(world.tags().get("launchset/partial/1.5.0")).toBe(partial.releaseSha);
    expect(world.tags().get("launchset/docker@1.5.0")).toBe(partial.releaseSha);
    expect(second.finalize?.result).toMatchObject({ status: "released", version: "1.5.1" });
    expect(second.finalize?.result.superseded).toEqual([
      {
        version: "1.5.0",
        tag: "launchset/partial/1.5.0",
        shipped: ["docker"],
        missing: ["android"],
      },
    ]);

    const pre = github.release("launchset/partial/1.5.0");
    expect(pre).toMatchObject({
      name: "v1.5.0 (partial, superseded by v1.5.1)",
      prerelease: true,
    });
    expect(pre?.body).toContain("docker");
    expect(pre?.body).toContain("android");
    expect(pre?.body).toContain("Add offline mode.");
    expect(github.release("v1.5.0")).toBeUndefined();
    expect(github.release("v1.5.1")?.make_latest).toBe("true");

    // Re-running finalize 1.5.1 changes nothing.
    const releases = github.releases.length;
    const tags = world.tagNames();
    await second.releaseJob.sibling(second.releaseSha).ok(["finalize", "--plan", second.plan]);
    expect(github.releases).toHaveLength(releases);
    expect(world.tagNames()).toEqual(tags);

    // The superseded version is not a release: status shows 1.5.1 as the last one, nothing unfinished.
    const after = await world.job("main").json<{
      lastRelease: { version: string };
      unfinished: unknown[];
    }>(["status"]);
    expect(after.lastRelease.version).toBe("1.5.1");
    expect(after.unfinished).toEqual([]);
  });
});
