/**
 * Scenario 1 (spec 14, end to end): the whole lifecycle of a repo that uses launchset, driven
 * the way CI drives it: init -> add -> release PR -> merge -> publish plan -> per-target build
 * jobs (stamp, verify, mark) in their own checkouts -> finalize -> nothing left to do.
 */

import { describe, expect, it } from "vitest";
import { setupApp } from "./app.ts";
import { type Job, read, World } from "./helpers.ts";

const CHANGELOG_150 = [
  "## 1.5.0 (2026-11-18)",
  "",
  "### Minor changes",
  "- Add offline mode.",
  "",
  "### Patch changes",
  "- Fix the login crash.",
].join("\n");

interface PlanJson {
  mode: string;
  version: string;
  buildNumber: number;
  releaseSha: string;
  matrix: string[];
  tag: string;
}

/** What one build job of the release workflow does, in its own checkout at release-sha. */
async function buildJob(
  releaseJob: Job,
  plan: string,
  target: string,
): Promise<{ job: Job; stamped: string[]; alreadyPublished: boolean }> {
  const { releaseSha } = JSON.parse(plan) as PlanJson;
  const job = releaseJob.sibling(releaseSha);
  const stamp = await job.json<{ files: string[] }>(["stamp", "--target", target, "--plan", plan]);
  const verify = await job.json<{ alreadyPublished: boolean }>([
    "verify",
    "--target",
    target,
    "--plan",
    plan,
  ]);
  return { job, stamped: stamp.files, alreadyPublished: verify.alreadyPublished };
}

describe("full lifecycle", () => {
  it.each(["merge", "squash", "rebase"] as const)(
    "init -> add -> release PR -> %s merge -> publish -> finalize -> none",
    async (method) => {
      const world = new World();
      await setupApp(world);
      const { github } = world;

      // --- a developer adds changesets and pushes to main
      await world.devAddChangeset("minor", "Add offline mode.");
      await world.devAddChangeset("patch", "Fix the login crash.");

      // --- the push runs `release`: pending changesets -> release PR
      const first = world.pushJob("main");
      const pr = await first.actionOk("release");
      expect(pr.outputs.mode).toBe("release-pr");
      expect(pr.outputs.version).toBe("1.5.0");
      expect(pr.outputs["pr-number"]).toBe("1");
      expect(pr.outputs["build-number"]).toBe("");
      expect(github.openPrs()).toHaveLength(1);
      const releasePr = github.openPrs()[0];
      expect(releasePr).toMatchObject({
        title: "Release v1.5.0",
        head: { ref: "launchset/release/main" },
        base: { ref: "main" },
      });
      expect(releasePr?.body).toContain(CHANGELOG_150);
      expect(releasePr?.body).toContain("`ios`: never shipped");

      // The release commit: exactly the version changes, no build numbers.
      const mainBefore = world.remoteHead("main");
      const releaseCommit = world.remoteHead("launchset/release/main");
      expect(world.git("rev-parse", `${releaseCommit}^`)).toBe(mainBefore);
      const changesets = world
        .git("ls-tree", "--name-only", "-r", mainBefore, ".launchset")
        .split("\n")
        .filter((p) => p !== ".launchset/README.md");
      expect(changesets).toHaveLength(2);
      expect(world.changedFiles(releaseCommit)).toEqual(
        [
          ...changesets.map((p) => `D\t${p}`),
          "M\tCHANGELOG.md",
          "M\tandroid/app/build.gradle",
          "M\tios/App/App.xcodeproj/project.pbxproj",
          "M\tpackage-lock.json",
          "M\tpackage.json",
        ].sort(),
      );
      const text = (ref: string, path: string) => world.file(ref, path);
      expect(text(releaseCommit, "package.json")).toBe(
        text(mainBefore, "package.json").replace('"version": "1.4.0"', '"version": "1.5.0"'),
      );
      expect(text(releaseCommit, "package-lock.json")).toBe(
        text(mainBefore, "package-lock.json").replaceAll(
          '"version": "1.4.0"',
          '"version": "1.5.0"',
        ),
      );
      expect(text(releaseCommit, "android/app/build.gradle")).toBe(
        text(mainBefore, "android/app/build.gradle").replace(
          'versionName "1.4.0"',
          'versionName "1.5.0"',
        ),
      );
      expect(text(releaseCommit, "ios/App/App.xcodeproj/project.pbxproj")).toBe(
        text(mainBefore, "ios/App/App.xcodeproj/project.pbxproj").replaceAll(
          "MARKETING_VERSION = 1.4.0;",
          "MARKETING_VERSION = 1.5.0;",
        ),
      );
      // Build numbers are never committed: the placeholders are untouched.
      expect(text(releaseCommit, "android/app/build.gradle")).toContain("versionCode 12\n");
      expect(text(releaseCommit, "ios/App/App.xcodeproj/project.pbxproj")).toContain(
        "CURRENT_PROJECT_VERSION = 12;",
      );
      expect(text(releaseCommit, "CHANGELOG.md")).toBe(`# Changelog\n\n${CHANGELOG_150}\n`);

      // --- review and merge the PR
      // Main moves on before the PR is merged (a PR merged while it was behind the base).
      world.pushDev("Unrelated work while the release PR is open", { "other.txt": "x\n" });
      const merged = world.mergePr(1, { method });
      const publishJob = world.pushJob("main");
      expect(publishJob.repo.head()).toBe(merged);
      const publish = await publishJob.actionOk("release");
      expect(publish.outputs).toMatchObject({
        mode: "publish",
        version: "1.5.0",
        channel: "release",
        "release-sha": merged,
        tag: "v1.5.0",
        "dist-tag": "latest",
      });
      // Only auto targets; the manual iOS target isn't built.
      expect(JSON.parse(publish.outputs.matrix ?? "")).toEqual(["docker", "android", "web"]);
      const plan = publish.outputs.plan as string;
      const planJson = JSON.parse(plan) as PlanJson;
      expect(planJson.buildNumber).toBeGreaterThan(217_000_000);

      // --- one build job per target, each in its own checkout at release-sha
      const android = await buildJob(publishJob, plan, "android");
      expect(android.stamped).toEqual(["android/app/build.gradle"]);
      expect(android.alreadyPublished).toBe(false); // no verify config: never "published"
      const gradle = read(android.job.dir, "android/app/build.gradle");
      expect(gradle).toContain(`versionCode ${planJson.buildNumber}\n`);
      expect(gradle).toContain('versionName "1.5.0"');
      const web = await buildJob(publishJob, plan, "web");
      expect(web.alreadyPublished).toBe(false);
      const docker = await buildJob(publishJob, plan, "docker");
      expect(docker.alreadyPublished).toBe(false);
      // The same steps through the action, as the workflow runs them: the outputs the team's
      // build steps read.
      const dockerStamp = await docker.job.action("stamp", { target: "docker", plan });
      expect(dockerStamp.ok, dockerStamp.error).toBe(true);
      expect(dockerStamp.outputs).toMatchObject({
        version: "1.5.0",
        "build-number": String(planJson.buildNumber),
        channel: "release",
        "dist-tag": "latest",
      });
      expect(dockerStamp.outputs["docker-tags"]).toBe(
        [
          "ghcr.io/acme/app:1.5.0",
          "ghcr.io/acme/app:1.5",
          "ghcr.io/acme/app:1",
          "ghcr.io/acme/app:latest",
        ].join("\n"),
      );
      expect(dockerStamp.outputs["docker-labels"]).toContain(
        `org.opencontainers.image.revision=${merged}`,
      );
      expect(dockerStamp.env).toMatchObject({
        LAUNCHSET_VERSION: "1.5.0",
        LAUNCHSET_CHANNEL: "release",
      });
      const dockerVerify = await docker.job.action("verify", { target: "docker", plan });
      expect(dockerVerify.outputs["already-published"]).toBe("false");

      // Nothing is tagged until a target is marked; `finalize` before that fails.
      expect(world.tagNames("launchset/")).toEqual([]);
      const early = await publishJob.sibling(planJson.releaseSha).cli(["finalize", "--plan", plan]);
      expect(early.code).toBe(1);
      expect(early.stdout + early.stderr).toContain(
        "3 auto targets have no marker for 1.5.0 yet: docker, android and web",
      );
      expect(world.tagNames("v")).toEqual(["v1.4.0"]);

      for (const built of [android, web, docker]) {
        const target = built === android ? "android" : built === web ? "web" : "docker";
        await built.job.ok(["mark", "--target", target, "--plan", plan]);
      }
      // `mark` again (a re-run job) is fine and moves nothing.
      const markAgain = await docker.job.action("mark", { target: "docker", plan });
      expect(markAgain.ok, markAgain.error).toBe(true);
      expect(world.tags().get("launchset/docker@1.5.0")).toBe(merged);
      expect(world.tagNames("launchset/")).toEqual([
        "launchset/android@1.5.0",
        "launchset/docker@1.5.0",
        "launchset/web@1.5.0",
      ]);
      for (const marker of world.tagNames("launchset/")) {
        expect(world.tags().get(marker)).toBe(merged);
      }
      // iOS is manual: no marker, and the release doesn't wait for it.
      expect(world.tagNames("launchset/ios")).toEqual([]);

      // --- the finalize job
      const finalizeJob = publishJob.sibling(planJson.releaseSha);
      const finalize = await finalizeJob.json<{ result: Record<string, unknown> }>([
        "finalize",
        "--plan",
        plan,
      ]);
      expect(finalize.result).toMatchObject({
        status: "released",
        version: "1.5.0",
        tag: "v1.5.0",
        missing: [],
        superseded: [],
      });
      expect(world.tags().get("v1.5.0")).toBe(merged);
      const release = github.release("v1.5.0");
      expect(release).toMatchObject({ name: "v1.5.0", prerelease: false, make_latest: "true" });
      expect(release?.body).toContain(CHANGELOG_150.split("\n").slice(2).join("\n"));
      expect(release?.body).toContain("### Manual targets");
      expect(release?.body).toContain("`ios`: not shipped yet");

      // --- the next push finds nothing to do
      const again = await world.pushJob("main").actionOk("release");
      expect(again.outputs.mode).toBe("none");
      expect(github.openPrs()).toEqual([]);
    },
  );
});
