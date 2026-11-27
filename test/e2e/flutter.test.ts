/**
 * A repo with only a Flutter app (spec 6.8), end to end: init makes pubspec.yaml the version
 * file, the release PR bumps the build name and keeps the +N, and each build job stamps its own
 * build number after the + (the plain version for iOS), then mark and finalize release it.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { read, World } from "./helpers.ts";

const FLUTTER_ONLY = join(import.meta.dirname, "../fixtures/init/flutter-only");

const versionLine = (text: string) => text.split("\n").find((l) => l.startsWith("version:"));

describe("a Flutter-only repo", () => {
  it("init -> release PR -> merge -> stamp android and ios -> mark -> finalize", async () => {
    const world = new World();
    const { dev, github } = world;
    world.wipeDev();
    world.copyDir(FLUTTER_ONLY);
    dev.git("add", "--all");
    dev.git("commit", "--quiet", "--no-verify", "-m", "The app, before launchset");
    const init = await world.devCli([
      "init",
      "--yes",
      "--decide",
      "target.ios=auto",
      "--decide",
      "machinery.tool/bump_version.dart#1=remove",
    ]);
    expect(init.code, `${init.stdout}\n${init.stderr}`).toBe(0);
    expect(read(dev.dir, "launchset.config.ts")).toContain('version: { file: "pubspec.yaml" },');
    dev.git("add", "--all");
    dev.git("commit", "--quiet", "--no-verify", "-m", "Set up launchset");
    dev.git("push", "--quiet", "origin", "main");
    dev.git("tag", "v1.4.0");
    dev.git("push", "--quiet", "origin", "v1.4.0");

    await world.devAddChangeset("minor", "Add offline mode.");
    const pr = await world.pushJob("main").actionOk("release");
    expect(pr.outputs).toMatchObject({ mode: "release-pr", version: "1.5.0" });

    // The release commit: the build name changes, the +12 placeholder stays.
    const mainBefore = world.remoteHead("main");
    const releaseCommit = world.remoteHead("launchset/release/main");
    const changed = world.changedFiles(releaseCommit).filter((f) => !f.includes(".launchset/"));
    expect(changed).toEqual(["M\tCHANGELOG.md", "M\tpubspec.yaml"]);
    expect(world.file(releaseCommit, "pubspec.yaml")).toBe(
      world.file(mainBefore, "pubspec.yaml").replace("version: 1.4.0+12", "version: 1.5.0+12"),
    );
    expect(github.openPrs()[0]?.title).toBe("Release v1.5.0");

    const merged = world.mergePr(1);
    const publishJob = world.pushJob("main");
    const publish = await publishJob.actionOk("release");
    expect(publish.outputs).toMatchObject({
      mode: "publish",
      version: "1.5.0",
      "release-sha": merged,
    });
    expect(JSON.parse(publish.outputs.matrix ?? "")).toEqual(["android", "ios"]);
    const plan = publish.outputs.plan as string;
    const buildNumber = (JSON.parse(plan) as { buildNumber: number }).buildNumber;

    for (const target of ["android", "ios"]) {
      const job = publishJob.sibling(merged);
      const stamp = await job.action("stamp", { target, plan });
      expect(stamp.ok, stamp.error).toBe(true);
      // What the generated build step passes to flutter build.
      expect(stamp.outputs).toMatchObject({
        "marketing-version": "1.5.0",
        "build-number": String(buildNumber),
      });
      expect(versionLine(read(job.dir, "pubspec.yaml"))).toBe(`version: 1.5.0+${buildNumber}`);
      await job.ok(["mark", "--target", target, "--plan", plan]);
    }

    const finalize = await publishJob
      .sibling(merged)
      .json<{ result: Record<string, unknown> }>(["finalize", "--plan", plan]);
    expect(finalize.result).toMatchObject({ status: "released", tag: "v1.5.0", missing: [] });
    expect(world.tags().get("v1.5.0")).toBe(merged);

    // A later commit that only bumps the +N by hand is no release.
    world.pushDev("Bump the build number by hand", {
      "pubspec.yaml": read(dev.dir, "pubspec.yaml").replace(
        /^version: (.*)\+\d+$/m,
        "version: $1+13",
      ),
    });
    const again = await world.pushJob("main").actionOk("release");
    expect(again.outputs.mode).toBe("none");
  });
});
