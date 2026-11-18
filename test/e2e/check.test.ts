/**
 * The PR check (spec 9.2) as the check workflow runs it, and `check --push` (spec 11): a PR
 * with and without a changeset, the sticky comment, bots, the release PR, maintenance
 * branches, hand-edited version files, and the pre-push warning.
 */

import { describe, expect, it } from "vitest";
import { addConfig, setupApp } from "./app.ts";
import { type Job, World } from "./helpers.ts";

const MARKER = "<!-- launchset:check -->";

/** A PR branch from main with one plain commit and no changeset. */
function devPlainBranch(
  world: World,
  name: string,
  files: Record<string, string> = { "feature.txt": "x\n" },
  base = "main",
): string {
  world.dev.git("fetch", "--quiet", "--tags", "origin");
  world.dev.git("checkout", "--quiet", "-B", name, `origin/${base}`);
  const sha = world.dev.commit(`Work on ${name}`, files);
  world.dev.git("push", "--quiet", "origin", `HEAD:refs/heads/${name}`);
  return sha;
}

function prJob(
  world: World,
  head: string,
  number: number,
  extra: { author?: string; base?: string; fork?: boolean } = {},
): Job {
  return world.prJob(head, {
    number,
    action: "synchronize",
    ...(extra.author ? { author: extra.author } : {}),
    ...(extra.base ? { baseRef: extra.base } : {}),
    ...(extra.fork ? { fork: extra.fork } : {}),
  });
}

describe("PR check", () => {
  it("fails without a changeset, passes once one is added, keeping one sticky comment", async () => {
    const world = new World();
    await setupApp(world);
    devPlainBranch(world, "feature/search");
    world.github.addOpenPr({ number: 11, title: "Add search", head: "feature/search" });

    // --- no changeset: the check fails and the comment says how to add one
    const failing = await prJob(world, "feature/search", 11).action("check");
    expect(failing.ok).toBe(false);
    expect(failing.outputs["pr-number"]).toBe("11");
    expect(failing.result?.lines.join("\n")).toContain("no-changeset");
    let comments = world.commentsOn(11);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body.startsWith(MARKER)).toBe(true);
    expect(comments[0]?.body).toContain("npx @demonsters/launchset add");
    expect(comments[0]?.body).toContain("bump: patch");

    // The CLI says the same thing, with exit code 1.
    const cliRun = await prJob(world, "feature/search", 11).cli(["check", "--no-comment"]);
    expect(cliRun.code).toBe(1);
    expect(cliRun.stdout).toContain("launchset check: failed");
    expect(world.commentsOn(11)).toHaveLength(1);
    expect(world.commentsOn(11)[0]?.body).toBe(comments[0]?.body);

    // --- the developer adds a changeset: passes, the same comment is updated in place
    world.dev.git("checkout", "--quiet", "feature/search");
    await world.devAddChangeset("minor", "Add search to the dashboard.", false);
    world.dev.git("push", "--quiet", "origin", "HEAD:refs/heads/feature/search");
    const passing = await prJob(world, "feature/search", 11).action("check");
    expect(passing.ok, passing.result?.lines.join("\n")).toBe(true);
    comments = world.commentsOn(11);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body.startsWith(MARKER)).toBe(true);
    expect(comments[0]?.body).toContain("1.5.0");
    expect(comments[0]?.body).toContain("Add search to the dashboard.");
    expect(comments[0]?.body).not.toContain("npx @demonsters/launchset add");

    // The CLI exits 0 now.
    expect((await prJob(world, "feature/search", 11).cli(["check", "--no-comment"])).code).toBe(0);
  });

  it("passes for bots and for the release PR, but not for a PR from a fork named like it", async () => {
    const world = new World();
    await setupApp(world);
    // A bot PR without a changeset.
    devPlainBranch(world, "dependabot/npm/react-19", { "lock.txt": "x\n" });
    world.github.addOpenPr({ number: 20, title: "Bump react", head: "dependabot/npm/react-19" });
    const bot = await prJob(world, "dependabot/npm/react-19", 20, {
      author: "dependabot[bot]",
    }).action("check");
    expect(bot.ok).toBe(true);
    expect(world.commentsOn(20)).toHaveLength(1);

    // The release PR launchset opens.
    world.devCheckout("main");
    await world.devAddChangeset("minor", "Add offline mode.");
    const release = await world.pushJob("main").actionOk("release");
    const releasePr = Number(release.outputs["pr-number"]);
    const releaseCheck = await prJob(world, "launchset/release/main", releasePr, {
      author: "launchset[bot]",
    }).action("check");
    expect(releaseCheck.ok, releaseCheck.result?.lines.join("\n")).toBe(true);

    // A fork can name its branch like the release PR's: no exemption.
    const fork = await prJob(world, "launchset/release/main", 30, { fork: true }).action("check");
    expect(fork.ok).toBe(false);
  });

  it("rejects a minor changeset on a maintenance branch, accepts a patch", async () => {
    const world = new World();
    await setupApp(world);
    expect((await world.devCli(["hotfix", "1.4"])).code).toBe(0);

    world.dev.git("fetch", "--quiet", "origin");
    world.dev.git("checkout", "--quiet", "-B", "fix/feature", "origin/release/1.4.x");
    await world.devAddChangeset("minor", "A feature on the old line.", false);
    world.dev.git("push", "--quiet", "origin", "HEAD:refs/heads/fix/feature");
    world.github.addOpenPr({
      number: 40,
      title: "Feature",
      head: "fix/feature",
      base: "release/1.4.x",
    });
    const bad = await prJob(world, "fix/feature", 40, { base: "release/1.4.x" }).action("check");
    expect(bad.ok).toBe(false);
    expect(bad.result?.lines.join("\n")).toContain("maintenance-bump");
    expect(world.commentsOn(40)[0]?.body).toContain("main");

    world.dev.git("checkout", "--quiet", "-B", "fix/patch", "origin/release/1.4.x");
    await world.devAddChangeset("patch", "A fix on the old line.", false);
    world.dev.git("push", "--quiet", "origin", "HEAD:refs/heads/fix/patch");
    world.github.addOpenPr({ number: 41, title: "Fix", head: "fix/patch", base: "release/1.4.x" });
    const good = await prJob(world, "fix/patch", 41, { base: "release/1.4.x" }).action("check");
    expect(good.ok, good.result?.lines.join("\n")).toBe(true);
    expect(world.commentsOn(41)[0]?.body).toContain("1.4.1");
  });

  it("fails on an invalid changeset and on a hand-edited version file", async () => {
    const world = new World();
    await setupApp(world);
    world.github.addOpenPr({ number: 50, title: "Broken", head: "feature/broken" });
    devPlainBranch(world, "feature/broken", {
      ".launchset/oops.md": "---\nbump: huge\n---\n\nNope.\n",
    });
    const invalid = await prJob(world, "feature/broken", 50).action("check");
    expect(invalid.ok).toBe(false);
    expect(invalid.result?.lines.join("\n")).toContain("invalid-changeset");
    expect(invalid.result?.lines.join("\n")).toContain(".launchset/oops.md");

    world.github.addOpenPr({ number: 51, title: "Edited", head: "feature/edited" });
    devPlainBranch(world, "feature/edited", {
      ".launchset/fine.md": "---\nbump: patch\n---\n\nFine.\n",
    });
    world.dev.git("checkout", "--quiet", "feature/edited");
    const gradle = world.file("feature/edited", "android/app/build.gradle");
    world.dev.write(
      "android/app/build.gradle",
      gradle.replace('versionName "1.4.0"', 'versionName "1.4.1"'),
    );
    world.dev.commit("Edit the version by hand");
    world.dev.git("push", "--quiet", "origin", "HEAD:refs/heads/feature/edited");
    const mismatch = await prJob(world, "feature/edited", 51).action("check");
    expect(mismatch.ok).toBe(false);
    const text = mismatch.result?.lines.join("\n") ?? "";
    expect(text).toContain("version-mismatch");
    expect(text).toContain("android/app/build.gradle");
    expect(text).toContain("1.4.1");
  });

  it("checks PRs against the prerelease branch they target", async () => {
    const world = new World();
    await setupApp(world);
    addConfig(world, '  preview: { branches: [{ branch: "next/*", prerelease: "alpha" }] },');
    await world.devBranch("next/new-form", "minor", "Add the new form.");
    devPlainBranch(world, "feature/field", { "field.txt": "x\n" }, "next/new-form");
    world.github.addOpenPr({
      number: 60,
      title: "Field",
      head: "feature/field",
      base: "next/new-form",
    });
    const failing = await prJob(world, "feature/field", 60, { base: "next/new-form" }).action(
      "check",
    );
    // The branch already has a changeset, but this PR adds none.
    expect(failing.ok).toBe(false);
    expect(failing.result?.lines.join("\n")).toContain("no-changeset");
  });
});

describe("check --push", () => {
  it("warns (exit 0) about commits since the last release without a changeset, and never blocks", async () => {
    const world = new World();
    await setupApp(world);
    // The developer's machine, on main: nothing since v1.4.0 yet.
    world.devCheckout("main");
    const clean = await world.devCli(["check", "--push"]);
    expect(clean.code).toBe(0);
    expect(clean.stdout + clean.stderr).not.toContain("won't be released");

    world.dev.commit("Work without a changeset", { "work.txt": "x\n" });
    const warned = await world.devCli(["check", "--push"]);
    expect(warned.code).toBe(0);
    const text = warned.stdout + warned.stderr;
    expect(text).toContain("no pending changeset");
    expect(text).toContain("won't be released");
    expect(text).toContain("Work without a changeset");

    // With a changeset the warning is gone.
    const add = await world.devCli(["add", "--bump", "patch", "--message", "Fix the work."]);
    expect(add.code).toBe(0);
    world.dev.commit("Add the changeset");
    const quiet = await world.devCli(["check", "--push"]);
    expect(quiet.code).toBe(0);
    expect(quiet.stdout + quiet.stderr).not.toContain("won't be released");

    // JSON for hooks and agents.
    const json = await world.devCli(["check", "--push", "--json"]);
    expect(json.code).toBe(0);
    expect(() => JSON.parse(json.stdout)).not.toThrow();
  });
});
