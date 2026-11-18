/**
 * Scenario 4 (spec 9.7): a PR preview. The `launchset:preview` label makes `preview-plan`
 * produce a plan with the preview version and preview Docker tags, without any side effect
 * (no tags, commits, branches, Releases); `preview-comment` keeps one sticky comment.
 */

import { describe, expect, it } from "vitest";
import { addConfig, setupApp } from "./app.ts";
import { type PlanJson, parsePlan } from "./flow.ts";
import { read, World } from "./helpers.ts";

const LABEL = "launchset:preview";
const MARKER = "<!-- launchset:preview -->";

/** Every ref on the remote, with its commit: a snapshot to prove nothing changed. */
const refs = (world: World) => world.git("for-each-ref", "--format=%(refname) %(objectname)");

describe("PR preview", () => {
  it("plans a preview with the label, builds without side effects, keeps one sticky comment", async () => {
    const world = new World();
    await setupApp(world);
    const { github } = world;
    const head = await world.devBranch("feature/login", "minor", "Add login.");
    github.addOpenPr({ number: 7, title: "Add login", head: "feature/login" });
    const before = refs(world);

    // --- preview-plan on the `labeled` event
    const planJob = world.prJob("feature/login", {
      number: 7,
      action: "labeled",
      labels: [LABEL],
      label: LABEL,
    });
    const plan = await planJob.actionOk("preview-plan");
    expect(plan.outputs).toMatchObject({
      channel: "preview",
      prerelease: "false",
      skipped: "",
      "release-sha": head,
    });
    const planText = plan.outputs.plan as string;
    // `launchset plan --preview` shows the same plan (a dry run for humans).
    const dry = await planJob.cli(["plan", "--preview"]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(parsePlan(dry.stdout)).toMatchObject({
      version: plan.outputs.version,
      releaseSha: head,
    });
    const json = JSON.parse(planText) as PlanJson & {
      prNumber: number;
      targets: Record<string, { marketingVersion: string; docker?: { tags: string[] } }>;
    };
    const version = `1.5.0-pr.7.${planJob.run}`;
    expect(json).toMatchObject({
      mode: "preview",
      channel: "preview",
      version,
      baseVersion: "1.5.0",
      releaseSha: head, // the PR head commit, not the merge commit checked out
      prNumber: 7,
      distTag: "pr-7",
    });
    expect(json.matrix).toEqual(["docker", "android", "ios", "web"]);
    expect(json.targets.docker?.docker?.tags).toEqual([version, "pr-7"]);
    // iOS can't carry a prerelease suffix: the plain next version.
    expect(json.targets.ios?.marketingVersion).toBe("1.5.0");
    expect(json.targets.android?.marketingVersion).toBe(version);

    // No side effects: not a tag, branch or commit on the remote, no PR, no Release.
    expect(refs(world)).toBe(before);
    expect(github.releases).toEqual([]);
    expect(github.openPrs().map((p) => p.number)).toEqual([7]);

    // --- the build jobs check out the PR head and stamp their files
    const android = planJob.sibling(head);
    await android.ok(["stamp", "--target", "android", "--plan", planText]);
    const gradle = read(android.dir, "android/app/build.gradle");
    expect(gradle).toContain(`versionName "${version}"`);
    expect(gradle).toContain(`versionCode ${json.buildNumber}\n`);
    const ios = planJob.sibling(head);
    await ios.ok(["stamp", "--target", "ios", "--plan", planText]);
    const pbx = read(ios.dir, "ios/App/App.xcodeproj/project.pbxproj");
    expect(pbx).toContain("MARKETING_VERSION = 1.5.0;");
    expect(pbx).toContain(`CURRENT_PROJECT_VERSION = ${json.buildNumber};`);
    const web = planJob.sibling(head);
    await web.ok(["stamp", "--target", "web", "--plan", planText]);
    expect(read(web.dir, "package.json")).toContain(`"version": "${version}"`);
    // Previews never mark.
    expect((await android.cli(["mark", "--target", "android", "--plan", planText])).code).toBe(1);
    expect(world.tagNames("launchset/")).toEqual([]);

    // --- preview-comment (the final job, `if: always()`)
    world.setJobs(planJob.run, [
      { name: "Plan preview", conclusion: "success" },
      { name: "Preview docker", conclusion: "success" },
      { name: "Preview android", conclusion: "failure" },
      { name: "Preview ios", conclusion: "success" },
      { name: "Preview web", conclusion: "success" },
    ]);
    const comment = await planJob.sibling("main").actionOk("preview-comment", { plan: planText });
    expect(comment.outputs["comment-url"]).toContain("#issuecomment-");
    const comments = world.commentsOn(7);
    expect(comments).toHaveLength(1);
    const body = comments[0]?.body ?? "";
    expect(body.startsWith(MARKER)).toBe(true);
    expect(body).toContain(version);
    expect(body).toContain(`${json.buildNumber}`);
    expect(body).toContain("ghcr.io/acme/app:pr-7");
    expect(body).toContain("[**failed**](");
    expect(body).toContain("[succeeded](");
    expect(refs(world)).toBe(before);

    // --- a new push: a new run, the same comment is updated in place
    await world.devAddChangeset("patch", "Fix the login button.", false);
    world.dev.git("push", "--quiet", "origin", "HEAD:refs/heads/feature/login");
    const second = world.prJob("feature/login", {
      number: 7,
      action: "synchronize",
      labels: [LABEL],
    });
    const plan2 = await second.actionOk("preview-plan");
    const version2 = `1.5.0-pr.7.${second.run}`;
    expect(plan2.outputs.version).toBe(version2);
    expect(second.run).toBeGreaterThan(planJob.run);
    world.setJobs(second.run, [{ name: "Preview docker", conclusion: "success" }]);
    await second
      .sibling("main")
      .actionOk("preview-comment", { plan: plan2.outputs.plan as string });
    expect(world.commentsOn(7)).toHaveLength(1);
    expect(world.commentsOn(7)[0]?.id).toBe(comments[0]?.id);
    expect(world.commentsOn(7)[0]?.body).toContain(version2);
    expect(world.commentsOn(7)[0]?.body).not.toContain(`${version} `);
  });

  it("skips a PR without the label, a fork PR, and a preview comment without a plan", async () => {
    const world = new World();
    await setupApp(world);
    await world.devBranch("feature/plain", "patch", "Fix.");
    world.github.addOpenPr({ number: 8, title: "Fix", head: "feature/plain" });

    const unlabeled = world.prJob("feature/plain", { number: 8, action: "opened" });
    const run = await unlabeled.action("preview-plan");
    expect(run.ok).toBe(true);
    expect(run.outputs.skipped).not.toBe("");
    expect(run.outputs.matrix).toBe("[]");
    expect(run.outputs.plan).toBe("");

    const fork = world.prJob(
      "feature/plain",
      { number: 8, action: "labeled", labels: [LABEL], label: LABEL, fork: true },
      { noToken: true },
    );
    const forked = await fork.action("preview-plan");
    expect(forked.outputs.skipped).not.toBe("");
    expect(forked.outputs.plan).toBe("");

    // The comment job with an empty plan does nothing.
    const comment = await unlabeled.sibling("main").actionOk("preview-comment", { plan: "" });
    expect(comment.outputs["comment-url"] ?? "").toBe("");
    expect(world.commentsOn(8)).toEqual([]);
  });

  it("builds branch previews on push to a configured branch and on dispatch, never on other branches", async () => {
    const world = new World();
    await setupApp(world);
    addConfig(world, '  preview: { branches: ["develop"] },');
    expect((await world.devCli(["hotfix", "1.4"])).code).toBe(0);
    const head = await world.devBranch("develop", "minor", "Add search.");

    const push = world.pushJob("develop");
    const plan = await push.actionOk("preview-plan");
    const version = `1.5.0-develop.${push.run}`;
    expect(plan.outputs).toMatchObject({
      version,
      channel: "preview",
      "release-sha": head,
      "dist-tag": "develop",
      skipped: "",
    });
    const json = JSON.parse(plan.outputs.plan ?? "") as {
      targets: { docker: { docker: { tags: string[] } } };
    };
    expect(json.targets.docker.docker.tags).toEqual([version, "develop"]);
    expect(world.tagNames()).toEqual(["v1.4.0"]);
    // A branch preview has no PR: the result goes to the job summary, not to a comment.
    world.setJobs(push.run, [{ name: "Preview docker", conclusion: "success" }]);
    const comment = await push.sibling("main").actionOk("preview-comment", {
      plan: plan.outputs.plan ?? "",
    });
    expect(comment.result?.summary).toContain(version);
    expect(world.github.comments).toEqual([]);

    // A manual run on any branch, restricted to some targets.
    const dispatch = world.dispatchJob("develop", { targets: "android,web" });
    const manual = await dispatch.actionOk("preview-plan");
    expect(JSON.parse(manual.outputs.matrix ?? "")).toEqual(["android", "web"]);
    expect(manual.outputs.version).toBe(`1.5.0-develop.${dispatch.run}`);

    // Pushes to the base and to maintenance branches are not previewed.
    for (const branch of ["main", "release/1.4.x"]) {
      const skipped = await world.pushJob(branch).actionOk("preview-plan");
      expect(skipped.outputs.skipped, branch).not.toBe("");
      expect(skipped.outputs.plan).toBe("");
    }
    expect(world.tagNames()).toEqual(["v1.4.0"]);
  });
});
