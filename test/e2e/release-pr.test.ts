/**
 * The release PR and the publish workflow in less common situations (spec 9.3, 9.4, 12):
 * the PR following the changesets, bot PRs, changelog links, and retrying a failed target.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setupApp } from "./app.ts";
import { buildJob, parsePlan, releaseCycle } from "./flow.ts";
import { read, World } from "./helpers.ts";

describe("release PR", () => {
  it("follows the changesets: updated in place, unchanged on a re-run, closed when nothing is pending", async () => {
    const world = new World();
    await setupApp(world);
    const { github } = world;

    await world.devAddChangeset("patch", "Fix the footer.");
    const first = await world.pushJob("main").actionOk("release");
    expect(first.outputs).toMatchObject({ mode: "release-pr", version: "1.4.1", "pr-number": "1" });
    const head = world.remoteHead("launchset/release/main");
    expect(github.prs.map((p) => p.title)).toEqual(["Release v1.4.1"]);

    // The same push again: same branch commit (not force-pushed again), same PR.
    const again = await world.pushJob("main").actionOk("release");
    expect(again.outputs["pr-number"]).toBe("1");
    expect(world.remoteHead("launchset/release/main")).toBe(head);
    expect(github.prs).toHaveLength(1);
    expect(again.result?.lines.join("\n")).toContain("release PR #1 unchanged");

    // A bigger change: the same PR now releases 1.5.0, and the branch was rebuilt.
    await world.devAddChangeset("minor", "Add dark mode.");
    const second = await world.pushJob("main").actionOk("release");
    expect(second.outputs).toMatchObject({
      mode: "release-pr",
      version: "1.5.0",
      "pr-number": "1",
    });
    expect(github.prs).toHaveLength(1);
    expect(github.prs[0]?.title).toBe("Release v1.5.0");
    expect(github.prs[0]?.body).toContain("- Add dark mode.");
    expect(github.prs[0]?.body).toContain("- Fix the footer.");
    expect(world.remoteHead("launchset/release/main")).not.toBe(head);
    // Rebuilt from main every time: exactly one commit on top of it.
    expect(world.git("rev-list", "--count", `main..launchset/release/main`)).toBe("1");

    // A `none` changeset never releases.
    world.dev.git("rm", "--quiet", "-r", ".launchset");
    world.dev.write(".launchset/README.md", "# Changesets\n");
    await world.devAddChangeset("none", "Docs only.", false);
    world.dev.git("add", "--all");
    world.dev.commit("Remove the pending changesets");
    world.dev.git("push", "--quiet", "origin", "HEAD");
    const none = await world.pushJob("main").actionOk("release");
    expect(none.outputs.mode).toBe("none");
    // The now useless release PR is closed.
    expect(github.openPrs()).toEqual([]);
    expect(github.prs[0]?.state).toBe("closed");
    expect(none.result?.lines.join("\n")).toContain("closed release PR #1");
  });

  it("turns merged bot PRs into a Dependencies section, even when they are all there is", async () => {
    const world = new World();
    await setupApp(world);
    const { github } = world;

    // Dependabot's PR was merged into main (a squash commit), with no changeset.
    const sha = world.pushDev("Bump react from 18.2.0 to 19.0.0 (#9)", {
      "lockfile.txt": "react 19\n",
    });
    github.addMergedPr({
      number: 9,
      title: "Bump react from 18.2.0 to 19.0.0",
      login: "dependabot[bot]",
      mergeSha: sha,
    });
    const run = await world.pushJob("main").actionOk("release");
    expect(run.outputs).toMatchObject({ mode: "release-pr", version: "1.4.1" });
    const body = github.openPrs()[0]?.body ?? "";
    expect(body).toContain("### Dependencies");
    expect(body).toContain("- Bump react from 18.2.0 to 19.0.0");
    expect(body).toContain("#9");
    // The generated changeset lives in the release PR only: nothing is pushed to main.
    expect(world.git("ls-tree", "--name-only", "main", ".launchset/")).toBe(".launchset/README.md");
    const changelog = world.file("launchset/release/main", "CHANGELOG.md");
    expect(changelog).toContain("### Dependencies\n- Bump react from 18.2.0 to 19.0.0");

    // Rebuilt on every run: not duplicated.
    await world.pushJob("main").actionOk("release");
    const again = world.file("launchset/release/main", "CHANGELOG.md");
    expect(again.match(/Bump react/g)).toHaveLength(1);

    // A human changeset alongside it: both appear.
    await world.devAddChangeset("minor", "Add dark mode.");
    await world.pushJob("main").actionOk("release");
    const both = world.file("launchset/release/main", "CHANGELOG.md");
    expect(both).toContain("### Minor changes\n- Add dark mode.");
    expect(both).toContain("### Dependencies\n- Bump react from 18.2.0 to 19.0.0");
    expect(github.openPrs()[0]?.title).toBe("Release v1.5.0");
  });

  it("links the pull request and its author in the changelog", async () => {
    const world = new World();
    await setupApp(world);
    const { github } = world;

    const added = await world.devAddChangeset("minor", "Add offline mode.");
    // The commit that added the changeset belongs to PR #12 by alice.
    github.addMergedPr({ number: 12, title: "Offline mode", login: "alice", mergeSha: added });
    github.commitPulls.set(added, [12]);
    await world.pushJob("main").actionOk("release");
    const changelog = world.file("launchset/release/main", "CHANGELOG.md");
    expect(changelog).toContain(
      "- Add offline mode. ([#12](https://github.com/acme/app/pull/12), @alice)",
    );
    expect(github.openPrs()[0]?.body).toContain("[#12](https://github.com/acme/app/pull/12)");
  });
});

describe("launchset version", () => {
  it("applies the changesets locally exactly like the release PR commit", async () => {
    const world = new World();
    await setupApp(world);
    await world.devAddChangeset("minor", "Add offline mode.");
    await world.devAddChangeset("patch", "Fix the login crash.");
    await world.pushJob("main").actionOk("release");
    const releaseCommit = world.remoteHead("launchset/release/main");

    // --dry-run shows the diff and writes nothing.
    const dry = await world.devCli(["version", "--dry-run"]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain('-        versionName "1.4.0"');
    expect(dry.stdout).toContain('+        versionName "1.5.0"');
    expect(world.dev.git("status", "--porcelain")).toBe("");

    const run = await world.devCli(["version"]);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const changed = world
      .changedFiles(releaseCommit)
      .map((line) => ({ status: line[0], path: line.slice(2) }));
    expect(changed.length).toBeGreaterThan(5);
    for (const { status, path } of changed) {
      if (status === "D") {
        expect(existsSync(join(world.dev.dir, path)), path).toBe(false);
      } else {
        expect(read(world.dev.dir, path), path).toBe(world.file(releaseCommit, path));
      }
    }
    // Nothing else changed.
    const touched = world.dev.git("diff", "--name-only").split("\n").sort();
    expect(touched).toEqual(changed.map((c) => c.path).sort());
  });
});

describe("nothing to release", () => {
  it("warns about commits since the last release when no changeset is pending", async () => {
    const world = new World();
    await setupApp(world);
    world.pushDev("Rewrite the footer", { "footer.txt": "x\n" });
    world.pushDev("Tweak the header", { "header.txt": "x\n" });
    const run = await world.pushJob("main").actionOk("release");
    expect(run.outputs.mode).toBe("none");
    const text = `${run.result?.summary}\n${run.result?.lines.join("\n")}`;
    expect(text).toContain("2 commits since v1.4.0 and no pending changeset");
    expect(text).toContain("Rewrite the footer");
    expect(world.github.prs).toEqual([]);
    expect(world.tagNames()).toEqual(["v1.4.0"]);
  });
});

describe("retrying a failed target", () => {
  it("a workflow_dispatch builds only the targets without a marker, from the same commit", async () => {
    const world = new World();
    await setupApp(world);
    const { github } = world;
    await world.devAddChangeset("minor", "Add offline mode.");

    // android's job fails: docker and web ship, finalize reports what's missing.
    const cycle = await releaseCycle(world, { mark: ["docker", "web"], finalize: false });
    const failed = await cycle.releaseJob
      .sibling(cycle.releaseSha)
      .cli(["finalize", "--plan", cycle.plan]);
    expect(failed.code).toBe(1);
    expect(failed.stdout + failed.stderr).toContain("android");
    expect(world.tags().has("v1.5.0")).toBe(false);

    // Meanwhile main moved on (an unrelated push): a retry must still build the release commit.
    world.pushDev("Unrelated work after the release", { "work.txt": "x\n" });

    // Build steps refuse to run on any other commit than release-sha (GitHub Actions).
    const wrong = await world
      .job("main")
      .cli(["stamp", "--target", "android", "--plan", cycle.plan]);
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain("release-sha");

    // "Re-run" as workflow_dispatch from main.
    const retryJob = world.dispatchJob("main");
    const retry = await retryJob.actionOk("release");
    expect(retry.outputs.mode).toBe("publish");
    expect(retry.outputs["release-sha"]).toBe(cycle.releaseSha);
    expect(JSON.parse(retry.outputs.matrix ?? "")).toEqual(["android"]);
    const plan = retry.outputs.plan as string;
    expect(parsePlan(plan).version).toBe("1.5.0");

    // The plan reaches the commands as JSON, as a file (`@plan.json`) or as $LAUNCHSET_PLAN.
    const planFile = join(world.scratch, "plan.json");
    writeFileSync(planFile, plan);
    const viaFile = retryJob.sibling(cycle.releaseSha);
    await viaFile.ok(["stamp", "--target", "android", "--plan", `@${planFile}`]);
    const viaEnv = retryJob.sibling(cycle.releaseSha);
    await viaEnv.ok(["stamp", "--target", "android"], { env: { LAUNCHSET_PLAN: plan } });
    for (const job of [viaFile, viaEnv]) {
      expect(read(job.dir, "android/app/build.gradle")).toContain(
        `versionCode ${parsePlan(plan).buildNumber}\n`,
      );
    }

    const build = await buildJob(retryJob, plan, "android");
    expect(build.repo.head()).toBe(cycle.releaseSha);
    await build.ok(["mark", "--target", "android", "--plan", plan]);
    const done = await retryJob
      .sibling(cycle.releaseSha)
      .json<{ result: { status: string } }>(["finalize", "--plan", plan]);
    expect(done.result.status).toBe("released");
    expect(world.tags().get("v1.5.0")).toBe(cycle.releaseSha);
    expect(github.release("v1.5.0")?.make_latest).toBe("true");

    // Dispatching again once released: nothing to do.
    const idle = await world.dispatchJob("main").actionOk("release");
    expect(idle.outputs.mode).not.toBe("publish");
  });
});
