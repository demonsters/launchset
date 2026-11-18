import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { finalize } from "../../src/flow/finalize.ts";
import { hotfix } from "../../src/flow/hotfix.ts";
import { mark } from "../../src/flow/mark.ts";
import { release } from "../../src/flow/release.ts";
import { ship } from "../../src/flow/ship.ts";
import { stamp } from "../../src/flow/stamp.ts";
import {
  BUILD,
  contextFor,
  execShow,
  FakeGitHub,
  gradle,
  type Project,
  setupProject,
  versionFiles,
  xcconfig,
} from "./helpers.ts";

const SECTION_150 = "## 1.5.0 (2026-11-18)\n\n### Minor changes\n- Add offline mode.\n";

/** Simulate a merged release PR for `version` on the current branch, pushed. */
function releaseCommit(project: Project, version: string, section: string): string {
  const changelog = execShow(project.repo.dir, "HEAD", "CHANGELOG.md");
  const updated = changelog.replace(/\n## /, `\n${section}\n## `);
  return project.push(`Release v${version} (#1)`, {
    ...versionFiles(version),
    "CHANGELOG.md": updated,
  });
}

async function publishPlan(project: Project, env: Record<string, string> = {}) {
  const result = await release(await contextFor(project.repo, { env }));
  expect(result.data.mode).toBe("publish");
  return result.outputs.plan ?? "";
}

async function markAll(project: Project, plan: string, targets: string[]) {
  for (const target of targets) {
    const result = await mark(await contextFor(project.repo), { target, plan });
    expect(result.ok).toBe(true);
  }
}

describe("stamp, mark and finalize", () => {
  it("stamps build numbers, marks every target and creates the release tag and GitHub Release", async () => {
    const project = setupProject();
    const sha = releaseCommit(project, "1.5.0", SECTION_150);
    const github = new FakeGitHub(project.remote);
    const plan = await publishPlan(project);
    const { repo } = project;

    const stamped = await stamp(await contextFor(repo), { target: "android", plan });
    expect(stamped.data.files).toEqual(["android/app/build.gradle"]);
    expect(execShow(repo.dir, "HEAD", "android/app/build.gradle")).toBe(gradle("1.5.0", 12));
    expect(stamped.outputs).toMatchObject({ "build-number": String(BUILD), version: "1.5.0" });
    expect(stamped.env).toEqual({
      LAUNCHSET_VERSION: "1.5.0",
      LAUNCHSET_BUILD_NUMBER: String(BUILD),
      LAUNCHSET_CHANNEL: "release",
    });
    expect(readFileSync(`${repo.dir}/android/app/build.gradle`, "utf8")).toBe(
      gradle("1.5.0", BUILD),
    );
    const docker = await stamp(await contextFor(repo), { target: "docker-api", plan });
    expect(docker.outputs["docker-tags"]).toBe(
      ["1.5.0", "1.5", "1", "latest"].map((t) => `ghcr.io/acme/api:${t}`).join("\n"),
    );
    expect(docker.outputs["docker-labels"]).toContain(`org.opencontainers.image.revision=${sha}`);
    repo.git("checkout", "--quiet", "--", ".");

    await markAll(project, plan, ["docker-api", "web", "android"]);
    const again = await mark(await contextFor(repo), { target: "web", plan });
    expect(again.data.result).toBe("exists");

    const result = await finalize(await contextFor(repo), { plan });
    expect(result.ok).toBe(true);
    expect(result.data.result.status).toBe("released");
    expect(project.remoteTags().get("v1.5.0")).toBe(sha);
    const created = github.callsTo("POST", "/releases")[0]?.body as Record<string, unknown>;
    expect(created).toMatchObject({
      tag_name: "v1.5.0",
      name: "v1.5.0",
      prerelease: false,
      make_latest: "true",
    });
    expect(String(created.body)).toContain("### Minor changes\n- Add offline mode.");
    expect(String(created.body)).toContain("- `ios`: not shipped yet");

    // Idempotent: a re-run changes nothing.
    const rerun = await finalize(await contextFor(repo), { plan });
    expect(rerun.ok).toBe(true);
    expect(rerun.data.executed).toEqual([]);
    expect(github.callsTo("POST", "/releases")).toHaveLength(1);
  });

  it("fails listing the missing auto targets when the release is incomplete", async () => {
    const project = setupProject();
    releaseCommit(project, "1.5.0", SECTION_150);
    const github = new FakeGitHub(project.remote);
    const plan = await publishPlan(project);
    await markAll(project, plan, ["docker-api"]);
    const result = await finalize(await contextFor(project.repo), { plan });
    expect(result.ok).toBe(false);
    expect(result.data.result.missing).toEqual(["web", "android"]);
    expect(result.summary).toContain("`web` and `android`");
    expect(result.lines[0]).toBe("v1.5.0: incomplete (missing: web, android)");
    expect(project.remoteTags().has("v1.5.0")).toBe(false);
    expect(github.releases).toEqual([]);
  });

  it("refuses to mark with a plan that isn't a release plan, and a conflicting marker", async () => {
    const project = setupProject();
    const sha = releaseCommit(project, "1.5.0", SECTION_150);
    new FakeGitHub(project.remote);
    const plan = await publishPlan(project);
    project.repo.git("tag", "launchset/web@1.5.0", `${sha}^`);
    await expect(
      mark(await contextFor(project.repo), { target: "web", plan }),
    ).rejects.toMatchObject({
      code: "tag-conflict",
    });
    const none = JSON.stringify({ ...JSON.parse(plan), mode: "none" });
    await expect(
      mark(await contextFor(project.repo), { target: "web", plan: none }),
    ).rejects.toMatchObject({
      code: "invalid-plan",
    });
  });

  it("supersedes an unfinished older version with a partial tag and a pre-release", async () => {
    const project = setupProject();
    const old = releaseCommit(project, "1.5.0", SECTION_150);
    const github = new FakeGitHub(project.remote);
    const oldPlan = await publishPlan(project);
    await markAll(project, oldPlan, ["docker-api"]);
    const newer = releaseCommit(
      project,
      "1.5.1",
      "## 1.5.1 (2026-11-18)\n\n### Patch changes\n- Fix the login crash.\n",
    );
    const plan = await publishPlan(project);
    await markAll(project, plan, ["docker-api", "web", "android"]);

    const result = await finalize(await contextFor(project.repo), { plan });
    expect(result.ok).toBe(true);
    const tags = project.remoteTags();
    expect(tags.get("v1.5.1")).toBe(newer);
    expect(tags.get("launchset/partial/1.5.0")).toBe(old);
    expect(tags.has("v1.5.0")).toBe(false);
    const partial = github.release("launchset/partial/1.5.0");
    expect(partial).toMatchObject({
      name: "v1.5.0 (partial, superseded by v1.5.1)",
      prerelease: true,
      make_latest: "false",
    });
    expect(partial?.body).toContain("- Shipped: `docker-api`");
    expect(partial?.body).toContain("- Not shipped: `web` and `android`");
    expect(github.release("v1.5.1")).toMatchObject({ make_latest: "true" });

    // The old version's own finalize now reports it as superseded.
    const late = await finalize(await contextFor(project.repo), { plan: oldPlan });
    expect(late.ok).toBe(false);
    expect(late.data.result.status).toBe("superseded");
    expect(late.lines[0]).toBe("1.5.0 was superseded by a newer release: it never gets v1.5.0");
  });

  it("opens the changelog backport PR after a maintenance release", async () => {
    const project = setupProject();
    const { repo } = project;
    releaseCommit(project, "1.5.0", SECTION_150);
    repo.git("tag", "v1.5.0");
    repo.git("push", "--quiet", "origin", "v1.5.0");
    const github = new FakeGitHub(project.remote);

    const created = await hotfix(await contextFor(repo), { line: "1.4" });
    expect(created.data).toMatchObject({ branch: "release/1.4.x", tag: "v1.4.0", pushed: true });
    repo.checkout("release/1.4.x");
    const sha = releaseCommit(
      project,
      "1.4.1",
      "## 1.4.1 (2026-11-18)\n\n### Patch changes\n- Fix the login crash.\n",
    );
    const plan = await publishPlan(project);
    expect(JSON.parse(plan)).toMatchObject({ maintenance: true, distTag: "release-1.4" });
    await markAll(project, plan, ["docker-api", "web", "android"]);

    const result = await finalize(await contextFor(repo), { plan });
    expect(result.ok).toBe(true);
    expect(project.remoteTags().get("v1.4.1")).toBe(sha);
    expect(github.release("v1.4.1")).toMatchObject({ make_latest: "false" });
    expect(project.remoteFile("launchset/changelog/v1.4.1", "CHANGELOG.md")).toBe(
      [
        "# Changelog",
        "",
        "## 1.5.0 (2026-11-18)",
        "",
        "### Minor changes",
        "- Add offline mode.",
        "",
        "## 1.4.1 (2026-11-18)",
        "",
        "### Patch changes",
        "- Fix the login crash.",
        "",
        "## 1.4.0 (2026-01-01)",
        "",
        "### Patch changes",
        "- First release.",
        "",
      ].join("\n"),
    );
    // Only the changelog changed, on top of main.
    const main = project.remoteBranch("main");
    expect(repo.git("rev-parse", "origin/launchset/changelog/v1.4.1^")).toBe(main);
    expect(repo.git("diff", "--name-only", `${main}`, "origin/launchset/changelog/v1.4.1")).toBe(
      "CHANGELOG.md",
    );
    expect(github.openPrs()).toMatchObject([
      {
        title: "Changelog: v1.4.1",
        head: { ref: "launchset/changelog/v1.4.1" },
        base: { ref: "main" },
      },
    ]);
    expect(result.outputs["pr-number"]).toBe(String(github.openPrs()[0]?.number));
    expect(repo.git("symbolic-ref", "--short", "HEAD")).toBe("release/1.4.x");
  });
});

describe("hotfix", () => {
  it("creates the maintenance branch at the latest release of the line, and refuses duplicates", async () => {
    const project = setupProject();
    const { repo } = project;
    const v142 = releaseCommit(
      project,
      "1.4.2",
      "## 1.4.2 (2026-11-18)\n\n### Patch changes\n- x\n",
    );
    repo.git("tag", "v1.4.2");
    releaseCommit(project, "1.4.3", "## 1.4.3 (2026-11-18)\n\n### Patch changes\n- y\n");
    repo.git("tag", "v1.4.3-alpha.0");
    repo.git("push", "--quiet", "origin", "--tags");

    const result = await hotfix(await contextFor(repo), { line: "v1.4" });
    expect(result.data).toMatchObject({ branch: "release/1.4.x", tag: "v1.4.2", sha: v142 });
    expect(project.remoteBranch("release/1.4.x")).toBe(v142);
    expect(repo.git("symbolic-ref", "--short", "HEAD")).toBe("main");

    await expect(hotfix(await contextFor(repo), { line: "1.4" })).rejects.toMatchObject({
      code: "branch-exists",
      message: expect.stringContaining("locally"),
    });
    repo.git("branch", "-D", "release/1.4.x");
    await expect(hotfix(await contextFor(repo), { line: "1.4" })).rejects.toMatchObject({
      code: "branch-exists",
      message: expect.stringContaining("remote"),
    });
    await expect(hotfix(await contextFor(repo), { line: "2.0" })).rejects.toMatchObject({
      code: "no-release-in-line",
    });
    await expect(hotfix(await contextFor(repo), { line: "1" })).rejects.toMatchObject({
      code: "invalid-line",
    });
  });
});

describe("ship by hand", () => {
  it("checks HEAD, stamps the target, then mark --version updates the Release", async () => {
    const project = setupProject();
    const { repo } = project;
    const sha = releaseCommit(project, "1.5.0", SECTION_150);
    const github = new FakeGitHub(project.remote);
    const plan = await publishPlan(project);
    await markAll(project, plan, ["docker-api", "web", "android"]);
    await finalize(await contextFor(repo), { plan });
    project.push("Later work", { "later.txt": "x\n" });

    const local = { token: null } as const;
    await expect(ship(await contextFor(repo, local), { target: "ios" })).rejects.toMatchObject({
      code: "head-not-at-release",
      hint: "Run `git checkout v1.5.0` and try again.",
    });
    await expect(ship(await contextFor(repo, local), { target: "web" })).rejects.toMatchObject({
      code: "ship-auto-target",
    });

    repo.checkout("v1.5.0");
    const shipped = await ship(await contextFor(repo, local), { target: "ios" });
    expect(shipped.data).toMatchObject({
      version: "1.5.0",
      tag: "v1.5.0",
      buildNumber: BUILD,
      shipped: true,
      files: ["ios/Version.xcconfig"],
    });
    expect(readFileSync(`${repo.dir}/ios/Version.xcconfig`, "utf8")).toBe(xcconfig("1.5.0", BUILD));
    repo.git("checkout", "--quiet", "--", ".");

    const marked = await mark(await contextFor(repo), {
      target: "ios",
      version: "v1.5.0",
      buildNumber: BUILD,
    });
    expect(marked.data).toMatchObject({ marker: "launchset/ios@1.5.0", sha, result: "created" });
    expect(project.remoteTags().get("launchset/ios@1.5.0")).toBe(sha);
    expect(github.release("v1.5.0")?.body).toContain(
      `- \`ios\`: shipped 2026-11-18, build ${BUILD}`,
    );
    expect(github.release("v1.5.0")?.body).not.toContain("not shipped yet");

    // Shipping it again: already shipped, nothing stamped.
    const again = await ship(await contextFor(repo, local), { target: "ios" });
    expect(again.data.shipped).toBe(false);

    await expect(
      mark(await contextFor(repo), { target: "ios", version: "1.6.0" }),
    ).rejects.toMatchObject({ code: "not-released" });
  });

  it("refuses the run-number strategy outside CI", async () => {
    const project = setupProject({
      config: {
        targets: {
          web: { type: "web" },
          ios: {
            type: "ios",
            source: { kind: "xcconfig", file: "ios/Version.xcconfig" },
            release: "manual",
            buildNumber: { strategy: "run-number" },
          },
        },
      },
    });
    const context = await contextFor(project.repo, { token: null });
    context.run = undefined;
    await expect(ship(context, { target: "ios" })).rejects.toMatchObject({
      code: "run-number-outside-ci",
    });
  });
});
