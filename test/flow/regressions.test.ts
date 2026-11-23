/**
 * Regression tests from the flow review: release-commit detection, failure injection and
 * re-runs, CI-like checkouts (detached release-sha, shallow), subdirectory configs, the PR
 * check's diff range, checkout checks, and cleanup after failed pushes.
 */

import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { check } from "../../src/flow/check.ts";
import { finalize } from "../../src/flow/finalize.ts";
import { hotfix } from "../../src/flow/hotfix.ts";
import { mark } from "../../src/flow/mark.ts";
import { previewPlan } from "../../src/flow/preview.ts";
import { release } from "../../src/flow/release.ts";
import { stamp } from "../../src/flow/stamp.ts";
import { Git } from "../../src/git/index.ts";
import { cli } from "../cli/helpers.ts";
import { cloneRepo, initRepo, sh, TestRepo, tempDir } from "../git/helpers.ts";
import {
  changesetText,
  ciClone,
  contextFor,
  execShow,
  FakeGitHub,
  type Project,
  pkg,
  projectFor,
  setupProject,
  TOKEN,
  versionFiles,
} from "./helpers.ts";

const BRANCH = "launchset/release/main";
const SECTION_150 = "## 1.5.0 (2026-11-18)\n\n### Minor changes\n- Add offline mode.\n";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A merged release PR for `version`, as one commit on the current branch, pushed. */
function releaseCommit(project: Project, version: string, section: string): string {
  const changelog = execShow(project.repo.dir, "HEAD", "CHANGELOG.md");
  return project.push(`Release v${version} (#1)`, {
    ...versionFiles(version),
    "CHANGELOG.md": changelog.replace(/\n## /, `\n${section}\n## `),
  });
}

async function publishPlan(project: Project): Promise<string> {
  const result = await release(await contextFor(project.repo));
  expect(result.data.mode).toBe("publish");
  return result.outputs.plan ?? "";
}

async function markAll(repo: TestRepo, plan: string, targets: string[]): Promise<void> {
  for (const target of targets) await mark(await contextFor(repo), { target, plan });
}

/** Reject every push to the remote (a pre-receive hook); returns a function that removes it. */
function rejectPushes(remote: string): () => void {
  const hook = join(remote, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\necho 'rejected by test hook' >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  return () => rmSync(hook);
}

describe("release commit detection", () => {
  function pendingMinor(): Project {
    const project = setupProject();
    project.push("Add offline mode", {
      ".launchset/brave-lions-sing.md": changesetText("minor", "Add offline mode."),
    });
    return project;
  }

  it("publishes the merge commit of a release PR merged while behind main", async () => {
    const project = pendingMinor();
    new FakeGitHub(project.remote);
    await release(await contextFor(project.repo));
    project.push("Unrelated work after the release PR was built", { "other.txt": "x\n" });
    const { repo } = project;
    repo.git("fetch", "--quiet", "origin", BRANCH);
    const merged = repo.merge("FETCH_HEAD", "Merge pull request #1");
    repo.git("push", "--quiet", "origin", "main");
    const result = await release(await contextFor(repo));
    expect(result.data.mode).toBe("publish");
    expect(result.outputs["release-sha"]).toBe(merged);
  });

  it("publishes the rebased commit of a rebase merge", async () => {
    const project = pendingMinor();
    new FakeGitHub(project.remote);
    await release(await contextFor(project.repo));
    project.push("Unrelated work", { "other.txt": "x\n" });
    const { repo } = project;
    repo.git("fetch", "--quiet", "origin", BRANCH);
    repo.git("cherry-pick", "FETCH_HEAD");
    const rebased = repo.head();
    repo.git("push", "--quiet", "origin", "main");
    const result = await release(await contextFor(repo));
    expect(result.data.mode).toBe("publish");
    expect(result.outputs["release-sha"]).toBe(rebased);
  });

  it("doesn't publish a pushed `git pull` merge after the release commit", async () => {
    const project = setupProject();
    // A developer's clone, with local work on the old main.
    const dev = cloneRepo(project.remote);
    dev.commit("Local work", { "local.txt": "l\n" });
    const releaseSha = releaseCommit(project, "1.5.0", SECTION_150);
    new FakeGitHub(project.remote);
    const plan = await publishPlan(project);
    await markAll(project.repo, plan, ["docker-api"]);

    // `git pull` (merge) and push: the merge's first parent still has 1.4.0.
    dev.git("pull", "--quiet", "--no-rebase", "--no-edit", "origin", "main");
    dev.git("push", "--quiet", "origin", "main");
    const pulled = dev.head();
    expect(execShow(dev.dir, `${pulled}^1`, "package.json")).toBe(pkg("1.4.0"));
    const push = await release(await contextFor(dev));
    expect(push.data.mode).not.toBe("publish");

    // A retry from there still builds the real release commit.
    const retry = await release(
      await contextFor(dev, { event: { name: "workflow_dispatch", payload: { inputs: {} } } }),
    );
    expect(retry.data.mode).toBe("publish");
    expect(retry.outputs["release-sha"]).toBe(releaseSha);
    expect(retry.data.plan.matrix).toEqual(["web", "android"]);
  });
});

describe("failures and re-runs", () => {
  it("finalize converges after the tag was pushed but the Release creation failed", async () => {
    const project = setupProject();
    const sha = releaseCommit(project, "1.5.0", SECTION_150);
    const github = new FakeGitHub(project.remote);
    const plan = await publishPlan(project);
    await markAll(project.repo, plan, ["docker-api", "web", "android"]);
    github.failNext("POST", "/releases");
    await expect(finalize(await contextFor(project.repo), { plan })).rejects.toThrow(
      /injected failure/,
    );
    expect(project.remoteTags().get("v1.5.0")).toBe(sha);
    expect(github.releases).toEqual([]);

    const rerun = await finalize(await contextFor(project.repo), { plan });
    expect(rerun.ok).toBe(true);
    // The tag is there already: only the Release is created.
    expect(rerun.data.executed.map((e) => e.action.kind)).toEqual(["create-release"]);
    expect(github.release("v1.5.0")).toMatchObject({ make_latest: "true" });
    // A third run: the Release exists, nothing is created twice (the fake answers 422).
    const third = await finalize(await contextFor(project.repo), { plan });
    expect(third.data.executed).toEqual([]);
  });

  it("finalize creates a missing partial pre-release on a re-run", async () => {
    const project = setupProject();
    const old = releaseCommit(project, "1.5.0", SECTION_150);
    const github = new FakeGitHub(project.remote);
    const oldPlan = await publishPlan(project);
    await markAll(project.repo, oldPlan, ["docker-api"]);
    releaseCommit(project, "1.5.1", "## 1.5.1 (2026-11-18)\n\n### Patch changes\n- Fix.\n");
    const plan = await publishPlan(project);
    await markAll(project.repo, plan, ["docker-api", "web", "android"]);
    github.failNext("POST", "/releases", {
      match: (body) => (body as { tag_name?: string })?.tag_name === "launchset/partial/1.5.0",
    });
    await expect(finalize(await contextFor(project.repo), { plan })).rejects.toThrow(
      /injected failure/,
    );
    expect(project.remoteTags().get("launchset/partial/1.5.0")).toBe(old);
    expect(github.release("launchset/partial/1.5.0")).toBeUndefined();

    const rerun = await finalize(await contextFor(project.repo), { plan });
    expect(rerun.ok).toBe(true);
    expect(github.release("launchset/partial/1.5.0")).toMatchObject({ prerelease: true });
    expect(github.releases.filter((r) => r.tag_name === "v1.5.1")).toHaveLength(1);
  });

  it("release creates the PR on a re-run after the branch was pushed but PR creation failed", async () => {
    const project = setupProject();
    project.push("Add offline mode", {
      ".launchset/brave-lions-sing.md": changesetText("minor", "Add offline mode."),
    });
    const github = new FakeGitHub(project.remote);
    github.failNext("POST", "/pulls");
    await expect(release(await contextFor(project.repo))).rejects.toThrow(/injected failure/);
    const pushed = project.remoteBranch(BRANCH);
    expect(pushed).toBeDefined();
    expect(github.openPrs()).toEqual([]);

    const rerun = await release(await contextFor(project.repo));
    expect(rerun.data.releasePr).toMatchObject({ action: "created", pushed: false });
    expect(project.remoteBranch(BRANCH)).toBe(pushed);
    expect(github.openPrs()).toHaveLength(1);
  });

  it("refuses to open a PR whose head branch wasn't pushed (fake GitHub checks it)", async () => {
    const project = setupProject();
    const github = new FakeGitHub(project.remote);
    const context = await contextFor(project.repo);
    await expect(
      context.forge?.createPr({ head: "nope", base: "main", title: "x", body: "" }),
    ).rejects.toMatchObject({ status: 422 });
    expect(github.prs).toEqual([]);
  });

  it("a failed marker push leaves no local tag behind, and a re-run works", async () => {
    const project = setupProject();
    releaseCommit(project, "1.5.0", SECTION_150);
    new FakeGitHub(project.remote);
    const plan = await publishPlan(project);
    const allow = rejectPushes(project.remote);
    await expect(mark(await contextFor(project.repo), { target: "web", plan })).rejects.toThrow(
      /rejected by test hook/,
    );
    expect(project.repo.git("tag", "--list", "launchset/web@1.5.0")).toBe("");
    allow();
    const rerun = await mark(await contextFor(project.repo), { target: "web", plan });
    expect(rerun.data.result).toBe("created");
  });

  it("a failed hotfix push creates no local branch, and a re-run works", async () => {
    const project = setupProject();
    const allow = rejectPushes(project.remote);
    await expect(hotfix(await contextFor(project.repo), { line: "1.4" })).rejects.toThrow(
      /rejected by test hook/,
    );
    expect(project.repo.git("branch", "--list", "release/1.4.x")).toBe("");
    allow();
    const rerun = await hotfix(await contextFor(project.repo), { line: "1.4" });
    expect(rerun.data.pushed).toBe(true);
    expect(project.remoteBranch("release/1.4.x")).toBe(rerun.data.sha);
  });

  it("a failed prerelease tag reservation keeps the push error when cleanup fails too", async () => {
    const project = setupProject({
      config: {
        targets: { web: { type: "web" } },
        preview: { branches: [{ branch: "next/*", prerelease: "alpha" }] },
      },
    });
    const { repo } = project;
    repo.checkout("-b", "next/login");
    project.push("Login", { ".launchset/brave-lions-sing.md": changesetText("minor", "Login.") });
    new FakeGitHub(project.remote);
    const allow = rejectPushes(project.remote);
    vi.spyOn(Git.prototype, "deleteLocalTag").mockRejectedValue(new Error("disk on fire"));
    const context = await contextFor(repo, {
      event: { name: "push", payload: { ref: "refs/heads/next/login", after: repo.head() } },
    });
    const error = await previewPlan(context).catch((e: Error) => e);
    allow();
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("rejected by test hook");
    expect((error as Error).message).toContain("disk on fire");
  });
});

describe("CI-like checkouts", () => {
  it("finalizes and opens the backport from a detached release-sha clone", async () => {
    const project = setupProject();
    const { repo } = project;
    releaseCommit(project, "1.5.0", SECTION_150);
    repo.git("tag", "v1.5.0");
    repo.git("push", "--quiet", "origin", "v1.5.0");
    const github = new FakeGitHub(project.remote);
    await hotfix(await contextFor(repo), { line: "1.4" });
    repo.checkout("release/1.4.x");
    const sha = releaseCommit(
      project,
      "1.4.1",
      "## 1.4.1 (2026-11-18)\n\n### Patch changes\n- Fix the login crash.\n",
    );
    const plan = await publishPlan(project);

    // The build jobs: a fresh clone, detached at release-sha.
    const ci = ciClone(project);
    ci.git("checkout", "--quiet", "--detach", sha);
    const env = { GITHUB_ACTIONS: "true" };
    for (const target of ["docker-api", "web", "android"]) {
      await mark(await contextFor(ci, { env }), { target, plan });
    }
    const result = await finalize(await contextFor(ci, { env }), { plan });
    expect(result.ok).toBe(true);
    expect(project.remoteTags().get("v1.4.1")).toBe(sha);
    const backport = project.remoteBranch("launchset/changelog/v1.4.1");
    expect(backport).toBeDefined();
    expect(project.remoteFile("launchset/changelog/v1.4.1", "CHANGELOG.md")).toContain(
      "- Add offline mode.\n\n## 1.4.1 (2026-11-18)\n",
    );
    expect(github.openPrs().map((p) => p.title)).toEqual(["Changelog: v1.4.1"]);
    expect(ci.head()).toBe(sha);
    expect(ci.git("status", "--porcelain")).toBe("");

    // A re-run rebuilds the same backport commit: nothing is force-pushed.
    const rerun = await finalize(await contextFor(ci, { env }), { plan });
    expect(rerun.ok).toBe(true);
    expect(project.remoteBranch("launchset/changelog/v1.4.1")).toBe(backport);
    expect(github.openPrs()).toHaveLength(1);
  });

  it("finalize --ci opens the backport with plan.json (an artifact) in the checkout", async () => {
    // On GitLab the child's finalize job gets plan.json as an artifact: an untracked file that
    // must not count as an uncommitted change when the backport branch is built.
    const project = setupProject();
    const { repo } = project;
    releaseCommit(project, "1.5.0", SECTION_150);
    repo.git("tag", "v1.5.0");
    repo.git("push", "--quiet", "origin", "v1.5.0");
    const github = new FakeGitHub(project.remote);
    await hotfix(await contextFor(repo), { line: "1.4" });
    repo.checkout("release/1.4.x");
    const sha = releaseCommit(
      project,
      "1.4.1",
      "## 1.4.1 (2026-11-18)\n\n### Patch changes\n- Fix.\n",
    );
    const plan = await publishPlan(project);
    const ci = ciClone(project);
    ci.git("checkout", "--quiet", "--detach", sha);
    await markAll(ci, plan, ["docker-api", "web", "android"]);
    writeFileSync(join(ci.dir, "plan.json"), plan);
    const r = await cli(
      ["finalize", "--plan", "@plan.json", "--ci", "--repo", "acme/app", "--token", TOKEN],
      { cwd: ci.dir },
    );
    expect(r.stderr).not.toContain("clean working tree");
    expect(r.code).toBe(0);
    expect(project.remoteBranch("launchset/changelog/v1.4.1")).toBeDefined();
    expect(github.openPrs().map((p) => p.title)).toEqual(["Changelog: v1.4.1"]);
  });

  it("marks from a shallow clone of the release commit", async () => {
    const project = setupProject();
    const sha = releaseCommit(project, "1.5.0", SECTION_150);
    new FakeGitHub(project.remote);
    const plan = await publishPlan(project);
    const dir = tempDir("shallow");
    sh(dir, "clone", "--quiet", "--depth", "1", `file://${project.remote}`, ".");
    const shallow = new TestRepo(dir);
    expect(shallow.git("rev-parse", "--is-shallow-repository")).toBe("true");
    const result = await mark(await contextFor(shallow, { env: { GITHUB_ACTIONS: "true" } }), {
      target: "web",
      plan,
    });
    expect(result.data.result).toBe("created");
    expect(project.remoteTags().get("launchset/web@1.5.0")).toBe(sha);
  });

  it("stamp, verify and mark check that HEAD is the plan's release-sha", async () => {
    const project = setupProject();
    releaseCommit(project, "1.5.0", SECTION_150);
    new FakeGitHub(project.remote);
    const plan = await publishPlan(project);
    project.push("Later", { "later.txt": "x\n" });
    const env = { GITHUB_ACTIONS: "true" };
    await expect(
      stamp(await contextFor(project.repo, { env }), { target: "web", plan }),
    ).rejects.toMatchObject({
      code: "wrong-checkout",
      hint: expect.stringContaining("release-sha"),
    });
    await expect(
      mark(await contextFor(project.repo, { env }), { target: "web", plan }),
    ).rejects.toMatchObject({ code: "wrong-checkout" });
    expect(project.remoteTags().has("launchset/web@1.5.0")).toBe(false);
    // Locally only a warning.
    const local = await stamp(await contextFor(project.repo), { target: "web", plan });
    expect(local.lines.join("\n")).toContain("warning: stamp runs at");
    expect(local.summary).toContain("> [!WARNING]");
  });
});

describe("config in a subdirectory", () => {
  function subdirProject(): Project {
    const { remote, repo } = (() => {
      const remote = tempDir("remote");
      sh(remote, "init", "--quiet", "--bare", "-b", "main");
      const repo = initRepo();
      repo.git("remote", "add", "origin", remote);
      return { remote, repo };
    })();
    repo.commit("init", {
      "README.md": "monorepo\n",
      "apps/web/launchset.config.json": JSON.stringify({ targets: { web: { type: "web" } } }),
      "apps/web/package.json": pkg("0.3.0"),
      "apps/web/CHANGELOG.md": "# Changelog\n",
      "apps/web/.launchset/README.md": "# Changesets\n",
    });
    repo.git("tag", "v0.3.0");
    repo.git("push", "--quiet", "origin", "main", "v0.3.0");
    return projectFor(repo, remote);
  }

  it("builds the release PR with repo-relative paths", async () => {
    const project = subdirProject();
    project.push("Fix", {
      "apps/web/.launchset/brave-lions-sing.md": changesetText("patch", "Fix it."),
    });
    const github = new FakeGitHub(project.remote);
    const cwd = `${project.repo.dir}/apps/web`;
    const result = await release(await contextFor(project.repo, { cwd }));
    expect(result.data.releasePr?.action).toBe("created");
    expect(project.remoteFile(BRANCH, "apps/web/package.json")).toBe(pkg("0.3.1"));
    expect(project.remoteFile(BRANCH, "apps/web/CHANGELOG.md")).toBe(
      "# Changelog\n\n## 0.3.1 (2026-11-18)\n\n### Patch changes\n- Fix it.\n",
    );
    expect(sh(project.remote, "ls-tree", "-r", "--name-only", BRANCH)).not.toContain(
      "brave-lions-sing",
    );
    expect(github.openPrs()[0]?.title).toBe("Release v0.3.1");
    expect(readFileSync(`${cwd}/package.json`, "utf8")).toBe(pkg("0.3.0"));
  });

  it("runs the PR check with repo-relative changeset paths", async () => {
    const project = subdirProject();
    const base = project.repo.head();
    project.repo.checkout("-b", "feature");
    project.repo.commit("Fix", {
      "apps/web/.launchset/brave-lions-sing.md": changesetText("patch", "Fix it."),
    });
    new FakeGitHub(project.remote);
    const cwd = `${project.repo.dir}/apps/web`;
    const repoInfo = { full_name: "acme/app" };
    const result = await check(
      await contextFor(project.repo, {
        cwd,
        event: {
          name: "pull_request",
          payload: {
            pull_request: {
              number: 3,
              user: { login: "someone" },
              head: { ref: "feature", sha: project.repo.head(), repo: repoInfo },
              base: { ref: "main", sha: base, repo: repoInfo },
            },
          },
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.data.result.prChangesets.map((c) => c.path)).toEqual([
      "apps/web/.launchset/brave-lions-sing.md",
    ]);
  });
});

describe("PR check diff range", () => {
  it("diffs the PR head against the current base, not the merge commit and a stale base.sha", async () => {
    const project = setupProject();
    const { repo } = project;
    const staleBase = repo.head();
    repo.checkout("-b", "feature");
    const head = repo.commit("Work without a changeset", { "src.txt": "x\n" });
    repo.git("push", "--quiet", "origin", "feature");
    // Main moves on with someone else's changeset.
    repo.checkout("main");
    project.push("Other PR", {
      ".launchset/calm-cats-nap.md": changesetText("patch", "Someone else's fix."),
    });
    // actions/checkout of refs/pull/N/merge: a merge of the head into the current base.
    repo.git("checkout", "--quiet", "--detach", "main");
    repo.git("merge", "--quiet", "--no-ff", "-m", "Merge feature into main", "feature");
    new FakeGitHub(project.remote);
    const repoInfo = { full_name: "acme/app" };
    const result = await check(
      await contextFor(repo, {
        event: {
          name: "pull_request",
          payload: {
            pull_request: {
              number: 7,
              user: { login: "someone" },
              head: { ref: "feature", sha: head, repo: repoInfo },
              base: { ref: "main", sha: staleBase, repo: repoInfo },
            },
          },
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.data.result.failures.map((f) => f.code)).toEqual(["no-changeset"]);
  });

  it("describes the merge result: changesets the base already released don't count", async () => {
    const project = setupProject();
    const { repo } = project;
    project.push("Pending minor", {
      ".launchset/big-dogs-run.md": changesetText("minor", "A feature."),
    });
    repo.checkout("-b", "feature");
    const head = repo.commit("Fix with a changeset", {
      ".launchset/small-cats-nap.md": changesetText("patch", "A fix."),
    });
    repo.git("push", "--quiet", "origin", "feature");
    // Main releases 1.5.0 meanwhile: the minor changeset is consumed.
    repo.checkout("main");
    repo.git("rm", "--quiet", ".launchset/big-dogs-run.md");
    project.push("Release v1.5.0", versionFiles("1.5.0"));
    repo.git("tag", "v1.5.0");
    repo.git("push", "--quiet", "origin", "v1.5.0");
    // actions/checkout of refs/pull/N/merge.
    repo.git("checkout", "--quiet", "--detach", "main");
    repo.git("merge", "--quiet", "--no-ff", "-m", "Merge feature into main", "feature");
    new FakeGitHub(project.remote);
    const repoInfo = { full_name: "acme/app" };
    const result = await check(
      await contextFor(repo, {
        event: {
          name: "pull_request",
          payload: {
            pull_request: {
              number: 8,
              user: { login: "someone" },
              head: { ref: "feature", sha: head, repo: repoInfo },
              base: { ref: "main", sha: head, repo: repoInfo },
            },
          },
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.data.result.bump).toBe("patch");
    expect(result.data.result.nextVersion).toBe("1.5.1");
  });
});

describe("preview-plan", () => {
  it("skips a fork PR before reading the repo (head commit missing, no fetch)", async () => {
    const repo = initRepo();
    repo.commit("init", {
      "launchset.config.json": JSON.stringify({ targets: { web: { type: "web" } } }),
      "package.json": pkg("1.0.0"),
    });
    const context = await contextFor(repo, {
      token: null,
      event: {
        name: "pull_request",
        payload: {
          action: "labeled",
          repository: { full_name: "acme/app" },
          pull_request: {
            number: 5,
            labels: [{ name: "launchset:preview" }],
            head: { ref: "feature", sha: "f".repeat(40), repo: { full_name: "evil/app" } },
            base: { ref: "main", sha: repo.head(), repo: { full_name: "acme/app" } },
          },
        },
      },
    });
    const result = await previewPlan(context);
    expect(result.data.outcome).toBe("skip");
    expect(result.data.skip?.code).toBe("fork");
  });

  it("works without a remote (no tag fetch)", async () => {
    const repo = initRepo();
    repo.commit("init", {
      "launchset.config.json": JSON.stringify({ targets: { web: { type: "web" } } }),
      "package.json": pkg("1.0.0"),
    });
    repo.checkout("-b", "feature");
    const context = await contextFor(repo, { token: null });
    const result = await previewPlan(context, { fetch: false });
    expect(result.data.outcome).toBe("plan");
    expect(result.data.plan?.version).toBe("1.0.1-feature.17");
  });
});
