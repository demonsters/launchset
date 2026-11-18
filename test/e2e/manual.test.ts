/**
 * Scenario 5 (spec 9.8): a manual target (iOS) shipped by hand two releases later, and shipped
 * from CI with a `workflow_dispatch`. The release tag never waits for it.
 */

import { describe, expect, it } from "vitest";
import { setupApp } from "./app.ts";
import { parsePlan, releaseCycle } from "./flow.ts";
import { read, World } from "./helpers.ts";

interface ManualStatus {
  manualTargets: { target: string; lastShipped: string | null; releasesBehind: number }[];
  lastRelease: { version: string };
}

/** 0.9.0 -> 1.0.0 -> 1.1.0, ios never shipped. */
async function twoReleases(): Promise<World> {
  const world = new World();
  await setupApp(world, { version: "0.9.0" });
  await world.devAddChangeset("major", "Launch 1.0.");
  expect((await releaseCycle(world)).version).toBe("1.0.0");
  await world.devAddChangeset("minor", "Add dark mode.");
  expect((await releaseCycle(world)).version).toBe("1.1.0");
  return world;
}

describe("manual target shipped by hand", () => {
  it("ship -> build -> mark: stamped files, marker, Release body, status, never backwards", async () => {
    const world = await twoReleases();
    const { github } = world;
    // Both releases are complete without ios.
    expect(world.tagNames("v")).toEqual(["v0.9.0", "v1.0.0", "v1.1.0"]);
    expect(world.tagNames("launchset/ios")).toEqual([]);
    for (const tag of ["v1.0.0", "v1.1.0"]) {
      expect(github.release(tag)?.body).toContain("`ios`: not shipped yet");
    }

    world.pushDev("More work after the release", { "work.txt": "x\n" });
    // The Mac: a developer's machine with a token, not GitHub Actions.
    const mac = world.job("main", { local: true });
    const before = await mac.json<ManualStatus>(["status"]);
    expect(before.manualTargets).toEqual([{ target: "ios", lastShipped: null, releasesBehind: 3 }]);
    expect((await mac.ok(["status"])).stdout).toContain("ios: never shipped");

    // --- HEAD is not at v1.1.0: error naming the checkout
    const wrong = await mac.cli(["ship", "--target", "ios"]);
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain("is not at v1.1.0");
    expect(wrong.stderr).toContain("git checkout v1.1.0");
    expect(mac.repo.git("status", "--porcelain")).toBe("");

    // --- on the release: version + build number, ios files stamped
    mac.repo.git("checkout", "--quiet", "v1.1.0");
    const ship = await mac.json<{
      version: string;
      buildNumber: number;
      files: string[];
      env: Record<string, string>;
    }>(["ship", "--target", "ios"]);
    expect(ship.version).toBe("1.1.0");
    expect(ship.buildNumber).toBeGreaterThan(217_000_000);
    expect(ship.files).toEqual(["ios/App/App.xcodeproj/project.pbxproj"]);
    expect(ship.env).toMatchObject({
      LAUNCHSET_VERSION: "1.1.0",
      LAUNCHSET_BUILD_NUMBER: String(ship.buildNumber),
    });
    const pbx = read(mac.dir, "ios/App/App.xcodeproj/project.pbxproj");
    expect(pbx.match(/CURRENT_PROJECT_VERSION = (\d+);/g)).toEqual([
      `CURRENT_PROJECT_VERSION = ${ship.buildNumber};`,
      `CURRENT_PROJECT_VERSION = ${ship.buildNumber};`,
    ]);
    expect(pbx.match(/MARKETING_VERSION = [^;]+;/g)).toEqual([
      "MARKETING_VERSION = 1.1.0;",
      "MARKETING_VERSION = 1.1.0;",
    ]);
    expect(mac.repo.git("diff", "--name-only")).toBe("ios/App/App.xcodeproj/project.pbxproj");
    // Nothing is published until `mark`.
    expect(world.tagNames("launchset/ios")).toEqual([]);

    // --- after the upload: marker + Release body
    const mark = await mac.ok([
      "mark",
      "--target",
      "ios",
      "--version",
      "1.1.0",
      "--build-number",
      String(ship.buildNumber),
    ]);
    expect(mark.stdout).toContain("launchset/ios@1.1.0");
    expect(world.tags().get("launchset/ios@1.1.0")).toBe(world.tags().get("v1.1.0"));
    const body = github.release("v1.1.0")?.body ?? "";
    expect(body).toContain(`- \`ios\`: shipped 2026-11-18, build ${ship.buildNumber}`);
    expect(body).not.toContain("`ios`: not shipped yet");
    // The older Release is untouched.
    expect(github.release("v1.0.0")?.body).toContain("`ios`: not shipped yet");
    // No new release tag, nothing else moved.
    expect(world.tagNames("v")).toEqual(["v0.9.0", "v1.0.0", "v1.1.0"]);

    // Shipping it again says so and stops.
    mac.repo.git("checkout", "--quiet", "--", ".");
    const again = await mac.ok(["ship", "--target", "ios"]);
    expect(again.stdout + again.stderr).toContain("ios 1.1.0 is already shipped");
    expect(mac.repo.git("status", "--porcelain")).toBe("");

    // --- status: ios is on 1.1.0, 0 releases behind
    mac.repo.git("checkout", "--quiet", "main");
    const after = await mac.json<ManualStatus>(["status"]);
    expect(after.manualTargets).toEqual([
      { target: "ios", lastShipped: "1.1.0", releasesBehind: 0 },
    ]);
    expect((await mac.ok(["status"])).stdout).toContain("ios: 1.1.0 (up to date)");

    // --- never backwards: 1.0.0 is lower than what shipped
    mac.repo.git("checkout", "--quiet", "v1.0.0");
    const back = await mac.cli(["ship", "--target", "ios"]);
    expect(back.code).toBe(1);
    expect(back.stderr).toContain("ios already shipped 1.1.0, which is higher than 1.0.0");
    // (default version is the latest release, 1.1.0: name 1.0.0 explicitly)
    const older = await mac.cli(["ship", "--target", "ios", "--version", "1.0.0"]);
    expect(older.code).toBe(1);
    expect(older.stderr).toContain("goes backwards");
    expect(mac.repo.git("status", "--porcelain")).toBe("");
    const forced = await mac.json<{ version: string; files: string[] }>([
      "ship",
      "--target",
      "ios",
      "--version",
      "1.0.0",
      "--force",
    ]);
    expect(forced).toMatchObject({
      version: "1.0.0",
      files: ["ios/App/App.xcodeproj/project.pbxproj"],
    });
  });

  it("ships from CI: workflow_dispatch with target and version -> ship mode -> finalize updates the Release", async () => {
    const world = await twoReleases();
    const { github } = world;

    const dispatch = world.dispatchJob("main", { target: "ios", version: "1.0.0" });
    const ship = await dispatch.actionOk("release", { target: "ios", version: "1.0.0" });
    expect(ship.outputs).toMatchObject({
      mode: "ship",
      version: "1.0.0",
      channel: "release",
      "release-sha": world.tags().get("v1.0.0"),
    });
    expect(JSON.parse(ship.outputs.matrix ?? "")).toEqual(["ios"]);
    const plan = ship.outputs.plan as string;
    expect(parsePlan(plan).buildNumber).toBeGreaterThan(217_000_000);

    // The build job checks out the commit of v1.0.0 and builds as usual.
    const build = dispatch.sibling(parsePlan(plan).releaseSha);
    await build.ok(["stamp", "--target", "ios", "--plan", plan]);
    expect(read(build.dir, "ios/App/App.xcodeproj/project.pbxproj")).toContain(
      `CURRENT_PROJECT_VERSION = ${parsePlan(plan).buildNumber};`,
    );
    await build.ok(["mark", "--target", "ios", "--plan", plan]);
    expect(world.tags().get("launchset/ios@1.0.0")).toBe(world.tags().get("v1.0.0"));

    // finalize in ship mode only updates the Release; it never creates tags.
    const tags = world.tagNames();
    await dispatch.sibling("main").ok(["finalize", "--plan", plan]);
    expect(world.tagNames()).toEqual(tags);
    expect(github.release("v1.0.0")?.body).toContain(
      `- \`ios\`: shipped 2026-11-18, build ${parsePlan(plan).buildNumber}`,
    );
    expect(github.release("v1.1.0")?.body).toContain("`ios`: not shipped yet");

    // Shipping 1.0.0 again is a no-op: nothing to build.
    const again = await world
      .dispatchJob("main", { target: "ios", version: "1.0.0" })
      .action("release", { target: "ios", version: "1.0.0" });
    expect(again.ok).toBe(true);
    expect(JSON.parse(again.outputs.matrix || "[]")).toEqual([]);
  });

  it("ships the latest release of the branch it is started from (a maintenance line)", async () => {
    const world = new World();
    await setupApp(world);
    await world.devAddChangeset("minor", "Add offline mode.");
    await releaseCycle(world);
    expect((await world.devCli(["hotfix", "1.4"])).code).toBe(0);
    world.devCheckout("release/1.4.x");
    await world.devAddChangeset("patch", "Fix the old crash.");
    const hotfix = await releaseCycle(world, { branch: "release/1.4.x" });
    expect(hotfix.version).toBe("1.4.1");

    // On main the latest release is 1.5.0; on release/1.4.x it is 1.4.1.
    const onMain = await world.dispatchJob("main", { target: "ios" }).actionOk("release");
    expect(onMain.outputs).toMatchObject({ mode: "ship", version: "1.5.0" });
    const job = world.dispatchJob("release/1.4.x", { target: "ios" });
    const ship = await job.actionOk("release");
    expect(ship.outputs).toMatchObject({
      mode: "ship",
      version: "1.4.1",
      "release-sha": hotfix.releaseSha,
      // A maintenance release is never "latest".
      "dist-tag": "release-1.4",
    });
    const plan = ship.outputs.plan as string;
    const build = job.sibling(hotfix.releaseSha);
    await build.ok(["stamp", "--target", "ios", "--plan", plan]);
    await build.ok(["mark", "--target", "ios", "--plan", plan]);
    await job.sibling(hotfix.releaseSha).ok(["finalize", "--plan", plan]);
    expect(world.github.release("v1.4.1")?.body).toContain("`ios`: shipped 2026-11-18");
    expect(world.github.release("v1.4.1")?.make_latest).toBe("false");
    expect(world.github.release("v1.5.0")?.body).toContain("`ios`: not shipped yet");
  });

  // BUG (reported): `git checkout v1.1.0` is where `ship` has to be run, and it leaves HEAD
  // detached. `status` then fails with "pass --branch", a flag `status` doesn't have. It should
  // work there (the version is at HEAD, the branch rules fall back to the base branch), or at
  // least not point at a missing flag.
  it("status works on the detached checkout of a release tag", async () => {
    const world = new World();
    await setupApp(world);
    await world.devAddChangeset("minor", "Add offline mode.");
    await releaseCycle(world);
    const mac = world.job("v1.5.0", { local: true });
    const run = await mac.cli(["status", "--json"]);
    expect(run.code, run.stderr).toBe(0);
    expect(mac.repo.git("branch", "--show-current")).toBe("");
  });
});
