/**
 * Scenario 6 (spec 9.9): a prerelease branch `next/*` (preid alpha). Two pushes in a row, the
 * second run losing the tag reservation race; GitHub pre-releases from `preview-comment`; and
 * the merge into main giving a normal release PR, with prerelease tags never counting as
 * releases.
 */

import { describe, expect, it } from "vitest";
import { previewPlan } from "../../src/flow/preview.ts";
import { addConfig, setupApp } from "./app.ts";
import { parsePlan, releaseCycle } from "./flow.ts";
import { read, World } from "./helpers.ts";

interface Status {
  lastRelease: { version: string } | null;
  nextVersion: string | null;
  unfinished: unknown[];
}

describe("prerelease branch", () => {
  it("reserves v1.5.0-alpha.0 and .1 under a race, then merges into a normal release", async () => {
    const world = new World();
    await setupApp(world);
    addConfig(world, '  preview: { branches: [{ branch: "next/*", prerelease: "alpha" }] },');
    const { github } = world;

    // --- two pushes to next/new-form; both runs start from the same tag knowledge
    const c1 = await world.devBranch("next/new-form", "minor", "Add the new form.");
    const runA = world.pushJob("next/new-form");
    await world.devAddChangeset("patch", "Polish the new form.", false);
    world.dev.git("push", "--quiet", "origin", "HEAD:refs/heads/next/new-form");
    const c2 = world.dev.head();
    const runB = world.pushJob("next/new-form");
    expect(runA.repo.head()).toBe(c1);
    expect(runB.repo.head()).toBe(c2);
    const tagsBefore = world.tagNames();

    // `launchset plan --preview` is a dry run: it names the next free tag but reserves nothing.
    const dry = await runA.cli(["plan", "--preview"]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(parsePlan(dry.stdout)).toMatchObject({
      version: "1.5.0-alpha.0",
      tag: "v1.5.0-alpha.0",
    });
    expect(world.tagNames()).toEqual(tagsBefore);

    // The workflow's `preview-plan` reserves the tag with a push, before any build starts.
    const a = await runA.actionOk("preview-plan");
    expect(a.logs).toContain("Reserved prerelease tag v1.5.0-alpha.0");
    expect(world.tags().get("v1.5.0-alpha.0")).toBe(c1);

    // B doesn't see A's tag (it fetched tags before A pushed): its push loses, it takes n+1.
    expect(runB.repo.git("tag", "--list", "v1.5.0-alpha.*")).toBe("");
    const logsB: string[] = [];
    const b = await previewPlan(await runB.context(logsB), { fetch: false });
    expect(b.ok).toBe(true);
    expect(logsB).toContain(
      "Prerelease tag v1.5.0-alpha.0 is taken by another run, trying the next number",
    );
    expect(logsB).toContain("Reserved prerelease tag v1.5.0-alpha.1 (attempt 2)");
    expect(world.tags().get("v1.5.0-alpha.1")).toBe(c2);
    expect(world.tagNames()).toEqual([...tagsBefore, "v1.5.0-alpha.0", "v1.5.0-alpha.1"].sort());

    const planA = parsePlan(a.outputs.plan as string);
    const planB = parsePlan(b.outputs.plan as string);
    expect(planA).toMatchObject({
      channel: "prerelease",
      version: "1.5.0-alpha.0",
      releaseSha: c1,
      tag: "v1.5.0-alpha.0",
      distTag: "alpha",
    });
    expect(planB).toMatchObject({
      version: "1.5.0-alpha.1",
      releaseSha: c2,
      tag: "v1.5.0-alpha.1",
    });
    // Docker tags: the version and the branch slug, never latest.
    const dockerTags = (plan: string) =>
      (JSON.parse(plan) as { targets: { docker: { docker: { tags: string[] } } } }).targets.docker
        .docker.tags;
    expect(dockerTags(a.outputs.plan as string)).toEqual(["1.5.0-alpha.0", "next-new-form"]);
    expect(dockerTags(b.outputs.plan as string)).toEqual(["1.5.0-alpha.1", "next-new-form"]);
    // Nothing was committed: next/new-form is where the developer left it, main didn't move.
    expect(world.remoteHead("next/new-form")).toBe(c2);

    // A build job of run A stamps the full prerelease version into Android.
    const buildA = runA.sibling(c1);
    await buildA.ok(["stamp", "--target", "android", "--plan", a.outputs.plan as string]);
    expect(read(buildA.dir, "android/app/build.gradle")).toContain('versionName "1.5.0-alpha.0"');

    // --- preview-comment creates a GitHub pre-release per tag
    world.setJobs(runA.run, [{ name: "Preview docker", conclusion: "success" }]);
    world.setJobs(runB.run, [{ name: "Preview docker", conclusion: "failure" }]);
    const commentA = await runA
      .sibling("main")
      .actionOk("preview-comment", { plan: a.outputs.plan as string });
    const commentB = await runB
      .sibling("main")
      .actionOk("preview-comment", { plan: b.outputs.plan as string });
    expect(commentA.outputs["release-url"]).toContain("v1.5.0-alpha.0");
    expect(commentB.outputs["release-url"]).toContain("v1.5.0-alpha.1");
    const alpha0 = github.release("v1.5.0-alpha.0");
    const alpha1 = github.release("v1.5.0-alpha.1");
    expect(alpha0).toMatchObject({ prerelease: true, make_latest: "false" });
    expect(alpha1).toMatchObject({ prerelease: true, make_latest: "false" });
    // The body lists the changesets that are on the branch at that commit.
    expect(alpha0?.body).toContain("Add the new form.");
    expect(alpha0?.body).not.toContain("Polish the new form.");
    expect(alpha1?.body).toContain("Add the new form.");
    expect(alpha1?.body).toContain("Polish the new form.");
    expect(alpha1?.body).toContain("ghcr.io/acme/app:1.5.0-alpha.1");
    expect(github.releases.filter((r) => !r.prerelease)).toEqual([]);
    expect(github.openPrs()).toEqual([]);

    // --- prerelease tags are not releases
    const beforeMerge = await world.job("main").json<Status>(["status"]);
    expect(beforeMerge.lastRelease?.version).toBe("1.4.0");
    expect(beforeMerge.unfinished).toEqual([]);

    // --- the branch merges into main: a normal release PR with the full changelog
    world.dev.git("fetch", "--quiet", "origin");
    world.dev.git("checkout", "--quiet", "-B", "main", "origin/main");
    world.dev.git(
      "merge",
      "--no-ff",
      "--quiet",
      "-m",
      "Merge next/new-form",
      "origin/next/new-form",
    );
    world.dev.git("push", "--quiet", "origin", "main");
    const onMain = await world.job("main").json<Status>(["status"]);
    expect(onMain.nextVersion).toBe("1.5.0"); // the alpha tags don't take 1.5.0
    expect(onMain.lastRelease?.version).toBe("1.4.0");

    const cycle = await releaseCycle(world);
    expect(cycle.version).toBe("1.5.0");
    const prBody = github.prs.find((p) => p.head.ref === "launchset/release/main")?.body ?? "";
    expect(prBody).toContain("- Add the new form.");
    expect(prBody).toContain("- Polish the new form.");
    expect(world.tags().get("v1.5.0")).toBe(cycle.releaseSha);
    expect(github.release("v1.5.0")).toMatchObject({ prerelease: false, make_latest: "true" });
    const release = github.release("v1.5.0")?.body ?? "";
    expect(release).toContain("### Minor changes\n- Add the new form.");
    expect(release).toContain("### Patch changes\n- Polish the new form.");

    const after = await world.job("main").json<Status>(["status"]);
    expect(after.lastRelease?.version).toBe("1.5.0");
    expect(after.unfinished).toEqual([]);
    // The prerelease tags are still there, untouched.
    expect(world.tags().get("v1.5.0-alpha.0")).toBe(c1);
    expect(world.tags().get("v1.5.0-alpha.1")).toBe(c2);
  });
});
