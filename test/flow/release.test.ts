import { describe, expect, it } from "vitest";
import { mark } from "../../src/flow/mark.ts";
import { release } from "../../src/flow/release.ts";
import {
  BUILD,
  changesetText,
  contextFor,
  FakeGitHub,
  gradle,
  type Project,
  pkg,
  setupProject,
  versionFiles,
  xcconfig,
} from "./helpers.ts";

const BRANCH = "launchset/release/main";

/** A project at 1.4.0 (released) with one minor changeset pending on main. */
function withChangeset(): { project: Project; changesetSha: string } {
  const project = setupProject();
  const changesetSha = project.push("Add offline mode", {
    ".launchset/brave-lions-sing.md": changesetText("minor", "Add offline mode."),
  });
  return { project, changesetSha };
}

/** Run the release-pr flow and merge the release branch into main (merge commit or squash). */
async function mergeReleasePr(project: Project, how: "merge" | "squash"): Promise<string> {
  new FakeGitHub(project.remote);
  await release(await contextFor(project.repo));
  const { repo } = project;
  repo.git("fetch", "--quiet", "origin", BRANCH);
  if (how === "merge") {
    repo.git(
      "merge",
      "--no-ff",
      "--quiet",
      "-m",
      "Merge pull request #1 from launchset/release/main",
      "FETCH_HEAD",
    );
  } else {
    repo.git("merge", "--squash", "--quiet", "FETCH_HEAD");
    repo.git("commit", "--quiet", "-m", "Release v1.5.0 (#1)");
  }
  repo.git("push", "--quiet", "origin", "main");
  return repo.head();
}

describe("release: release-pr mode", () => {
  it("leaves the release PR to the newest run when the base branch moved on", async () => {
    const { project } = withChangeset();
    const { repo } = project;
    const github = new FakeGitHub(project.remote);
    const older = repo.head();
    // A newer push lands on main while the run for `older` is still going.
    project.push("Newer work", { "other.txt": "x\n" });
    repo.git("checkout", "--quiet", "--detach", older);
    const result = await release(
      await contextFor(repo, { env: { GITHUB_REF: "refs/heads/main", GITHUB_SHA: older } }),
    );
    expect(result.ok).toBe(true);
    expect(result.outputs.mode).toBe("release-pr");
    expect(result.data.releasePr).toBeUndefined();
    expect(result.data.releasePrSkipped).toContain("has moved on");
    expect(github.openPrs()).toHaveLength(0);
    expect(repo.git("ls-remote", "--heads", "origin", BRANCH)).toBe("");
  });

  it("builds the release branch and PR, updates it, and closes it when nothing is pending", async () => {
    const { project, changesetSha } = withChangeset();
    const { repo } = project;
    const botSha = project.push("Bump lodash from 4.17.20 to 4.17.21 (#6)", {
      "deps.txt": "lodash\n",
    });
    const github = new FakeGitHub(project.remote);
    github.addMergedPr({
      number: 5,
      title: "Offline mode",
      login: "someone",
      mergeSha: changesetSha,
    });
    github.commitPulls.set(changesetSha, [5]);
    github.addMergedPr({
      number: 6,
      title: "Bump lodash from 4.17.20 to 4.17.21",
      login: "dependabot[bot]",
      mergeSha: botSha,
    });
    const mainHead = repo.head();

    const first = await release(await contextFor(repo));
    expect(first.ok).toBe(true);
    expect(first.data.mode).toBe("release-pr");
    expect(first.outputs.mode).toBe("release-pr");
    expect(first.outputs.version).toBe("1.5.0");
    const pr = first.data.releasePr;
    expect(pr).toMatchObject({ action: "created", branch: BRANCH, pushed: true });
    expect(first.outputs["pr-number"]).toBe(String(pr?.number));

    // The commit: one commit on top of main, made by launchset.
    expect(project.remoteBranch(BRANCH)).toBe(pr?.commit);
    expect(repo.git("rev-parse", `${pr?.commit}^`)).toBe(mainHead);
    expect(repo.git("log", "-1", "--format=%an <%ae>|%s", pr?.commit ?? "")).toBe(
      "launchset[bot] <launchset[bot]@users.noreply.github.com>|Release v1.5.0",
    );
    // Version bumped, marketing versions stamped (manual ios too), build numbers untouched.
    expect(project.remoteFile(BRANCH, "package.json")).toBe(pkg("1.5.0"));
    expect(project.remoteFile(BRANCH, "android/app/build.gradle")).toBe(gradle("1.5.0", 12));
    expect(project.remoteFile(BRANCH, "ios/Version.xcconfig")).toBe(xcconfig("1.5.0", 12));
    // Changesets consumed, README kept.
    const files = repo.git("ls-tree", "-r", "--name-only", pr?.commit ?? "", ".launchset/");
    expect(files).toBe(".launchset/README.md");
    expect(project.remoteFile(BRANCH, "CHANGELOG.md")).toBe(
      [
        "# Changelog",
        "",
        "## 1.5.0 (2026-11-18)",
        "",
        "### Minor changes",
        "- Add offline mode. ([#5](https://github.com/acme/app/pull/5), @someone)",
        "",
        "### Dependencies",
        "- Bump lodash from 4.17.20 to 4.17.21 ([#6](https://github.com/acme/app/pull/6))",
        "",
        "## 1.4.0 (2026-01-01)",
        "",
        "### Patch changes",
        "- First release.",
        "",
      ].join("\n"),
    );
    // The PR.
    const opened = github.openPrs();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      number: pr?.number,
      title: "Release v1.5.0",
      head: { ref: BRANCH },
      base: { ref: "main" },
    });
    expect(opened[0]?.body).toContain("Merging this PR releases **v1.5.0** (minor)");
    expect(opened[0]?.body).toContain("### Manual targets");
    // The original checkout is back, clean.
    expect(repo.git("symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(repo.head()).toBe(mainHead);
    expect(repo.git("status", "--porcelain")).toBe("");

    // Second run with another changeset: same PR, branch rebuilt and force-pushed.
    project.push("Fix login", {
      ".launchset/calm-cats-nap.md": changesetText("patch", "Fix the login crash."),
    });
    const second = await release(await contextFor(repo));
    expect(second.data.releasePr).toMatchObject({
      number: pr?.number,
      action: "updated",
      pushed: true,
    });
    expect(second.data.releasePr?.commit).not.toBe(pr?.commit);
    expect(project.remoteBranch(BRANCH)).toBe(second.data.releasePr?.commit);
    expect(repo.git("rev-parse", `${second.data.releasePr?.commit}^`)).toBe(repo.head());
    expect(project.remoteFile(BRANCH, "CHANGELOG.md")).toContain(
      "### Patch changes\n- Fix the login crash.\n",
    );
    expect(github.prs.filter((p) => p.title === "Release v1.5.0")).toHaveLength(1);
    expect(github.callsTo("PATCH", `/pulls/${pr?.number}`)).toHaveLength(1);

    // Third run without changes: nothing pushed, PR unchanged.
    const third = await release(await contextFor(repo));
    expect(third.data.releasePr).toMatchObject({ action: "unchanged", pushed: false });
    expect(project.remoteBranch(BRANCH)).toBe(second.data.releasePr?.commit);

    // Nothing pending anymore (changesets removed, bot PR got a changeset): close the PR.
    github.prFiles.set(6, [{ filename: ".launchset/bot.md", status: "added" }]);
    repo.git("rm", "--quiet", ".launchset/brave-lions-sing.md", ".launchset/calm-cats-nap.md");
    project.push("Drop changesets");
    const fourth = await release(await contextFor(repo));
    expect(fourth.data.mode).toBe("none");
    expect(fourth.data.closedPr?.number).toBe(pr?.number);
    expect(github.openPrs()).toHaveLength(0);
    const close = github.callsTo("POST", `/issues/${pr?.number}/comments`)[0];
    expect((close?.body as { body: string } | undefined)?.body).toContain(
      "no changesets are pending on `main`",
    );
  });

  it("dry run decides without pushing or opening a PR", async () => {
    const { project } = withChangeset();
    const github = new FakeGitHub(project.remote);
    const result = await release(await contextFor(project.repo), { dryRun: true });
    expect(result.data.mode).toBe("release-pr");
    expect(result.data.plan.releasePr?.version).toBe("1.5.0");
    expect(project.remoteBranch(BRANCH)).toBeUndefined();
    expect(github.callsTo("POST", "/pulls")).toHaveLength(0);
  });

  it("refuses to build the release PR with invalid changesets", async () => {
    const project = setupProject();
    project.push("Broken", {
      ".launchset/bad-one-here.md": "---\nbump: huge\n---\n\nx\n",
      ".launchset/brave-lions-sing.md": changesetText("minor", "Add offline mode."),
    });
    new FakeGitHub(project.remote);
    await expect(release(await contextFor(project.repo))).rejects.toMatchObject({
      code: "invalid-changeset",
    });
    expect(project.remoteBranch(BRANCH)).toBeUndefined();
  });

  it("doesn't let an invalid changeset block a publish, and keeps the release PR open", async () => {
    const project = setupProject();
    project.push("Release v1.5.0 (#1)", {
      ...versionFiles("1.5.0"),
      ".launchset/bad-one-here.md": "---\nbump: huge\n---\n\nx\n",
    });
    const github = new FakeGitHub(project.remote);
    const publish = await release(await contextFor(project.repo));
    expect(publish.data.mode).toBe("publish");
    expect(publish.data.warnings.join("\n")).toContain(
      "Ignored the changeset .launchset/bad-one-here.md",
    );
    expect(publish.summary).toContain("bad-one-here.md");

    // Later, with only the broken changeset pending: none, and the release PR stays open.
    github.addOpenPr({ number: 9, title: "Release v1.6.0", head: BRANCH });
    project.push("Other work", { "x.txt": "x\n" });
    const none = await release(await contextFor(project.repo));
    expect(none.data.mode).toBe("none");
    expect(none.data.closedPr).toBeUndefined();
    expect(github.openPrs()).toHaveLength(1);
  });

  it("warns about commits without any changeset in none mode", async () => {
    const project = setupProject();
    project.push("Tweak the README", { "README.md": "more\n" });
    new FakeGitHub(project.remote);
    const result = await release(await contextFor(project.repo));
    expect(result.data.mode).toBe("none");
    expect(result.summary).toContain("1 commit since v1.4.0 and no pending changeset");
    expect(result.lines.join("\n")).toContain("Tweak the README");
  });
});

describe("release: publish mode", () => {
  for (const how of ["merge", "squash"] as const) {
    it(`publishes from the ${how} commit of the release PR`, async () => {
      const { project } = withChangeset();
      const merged = await mergeReleasePr(project, how);
      new FakeGitHub(project.remote);
      const result = await release(await contextFor(project.repo));
      expect(result.data.mode).toBe("publish");
      expect(result.outputs).toMatchObject({
        mode: "publish",
        version: "1.5.0",
        "release-sha": merged,
        channel: "release",
        "build-number": String(BUILD),
        matrix: JSON.stringify(["docker-api", "web", "android"]),
        tag: "v1.5.0",
        "dist-tag": "latest",
      });
      const plan = JSON.parse(result.outputs.plan ?? "{}");
      expect(plan.targets.android).toMatchObject({
        marketingVersion: "1.5.0",
        buildNumber: BUILD,
        marker: "launchset/android@1.5.0",
      });
      expect(plan.targets.ios).toBeUndefined();
    });
  }

  it("retries from the release commit via first-parent search and via markers", async () => {
    const { project } = withChangeset();
    const merged = await mergeReleasePr(project, "merge");
    const { repo } = project;
    // Later work on main, including a merged feature branch.
    project.push("Later work", { "later.txt": "1\n" });
    repo.checkout("-b", "feature");
    repo.commit("Feature work", { "feature.txt": "f\n" });
    repo.checkout("main");
    repo.merge("feature", "Merge feature");
    repo.git("push", "--quiet", "origin", "main");
    new FakeGitHub(project.remote);
    const dispatch = { name: "workflow_dispatch", payload: { inputs: {} } };

    const retry = await release(await contextFor(repo, { event: dispatch }));
    expect(retry.data.mode).toBe("publish");
    expect(retry.outputs["release-sha"]).toBe(merged);
    expect(retry.data.plan.matrix).toEqual(["docker-api", "web", "android"]);

    // docker-api shipped: the marker sits on the release commit; the retry builds the rest.
    await mark(await contextFor(repo), { target: "docker-api", plan: retry.outputs.plan ?? "" });
    expect(project.remoteTags().get("launchset/docker-api@1.5.0")).toBe(merged);
    const again = await release(await contextFor(repo, { event: dispatch }));
    expect(again.outputs["release-sha"]).toBe(merged);
    expect(again.data.plan.matrix).toEqual(["web", "android"]);
  });

  it("does nothing on a dispatch for an already released version", async () => {
    const project = setupProject();
    new FakeGitHub(project.remote);
    const result = await release(
      await contextFor(project.repo, {
        event: { name: "workflow_dispatch", payload: { inputs: {} } },
      }),
    );
    expect(result.data.mode).toBe("none");
    expect(result.data.notices.join("\n")).toContain("v1.4.0 is already released");
  });

  it("ships a manual target from a dispatch with the target input", async () => {
    const project = setupProject();
    new FakeGitHub(project.remote);
    const tagSha = project.repo.head();
    project.push("Later", { "later.txt": "x\n" });
    const result = await release(
      await contextFor(project.repo, {
        event: { name: "workflow_dispatch", payload: { inputs: { target: "ios", version: "" } } },
      }),
    );
    expect(result.outputs).toMatchObject({
      mode: "ship",
      version: "1.4.0",
      "release-sha": tagSha,
      matrix: JSON.stringify(["ios"]),
    });
  });
  it("takes the attempt input of a dispatch for a semver target", async () => {
    const project = setupProject({
      config: {
        preview: { targets: ["web"] },
        targets: {
          web: { type: "web" },
          ios: {
            type: "ios",
            source: { kind: "xcconfig", file: "ios/Version.xcconfig" },
            release: "manual",
            buildNumber: { strategy: "semver" },
          },
        },
      },
    });
    new FakeGitHub(project.remote);
    const dispatch = (inputs: Record<string, string>) =>
      contextFor(project.repo, {
        event: { name: "workflow_dispatch", payload: { inputs: { target: "ios", ...inputs } } },
      });
    const result = await release(await dispatch({ attempt: "4" }));
    expect(result.data.mode).toBe("ship");
    expect(result.data.plan.targets.ios?.buildNumber).toBe(10_400_004);
    // Empty means not given: the run's attempt.
    const plain = await release(await dispatch({ attempt: " " }));
    const runAttempt = plain.data.plan.run?.attempt ?? 1;
    expect(plain.data.plan.targets.ios?.buildNumber).toBe(10_400_000 + runAttempt);
    await expect(release(await dispatch({ attempt: "two" }))).rejects.toMatchObject({
      code: "invalid-build-number",
      message: 'the attempt input must be a whole number from 1 to 99, got "two"',
    });
    await expect(release(await dispatch({ attempt: "0" }))).rejects.toMatchObject({
      code: "invalid-build-number",
    });
  });
});
