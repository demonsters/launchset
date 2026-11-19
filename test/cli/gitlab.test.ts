/**
 * The CLI on GitLab: `release --ci` and `preview-plan --ci` write the child pipeline, `plan
 * --gitlab` writes it locally, and `preview-comment` takes a missing plan file as "no plan".
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitLabReference, parseGitLabYaml } from "../../src/templates/gitlab-yaml.ts";
import {
  FakeGitLab,
  type GitLabProject,
  mrEnv,
  pushEnv,
  runnerCheckout,
  setupGitLabProject,
} from "../flow/gitlab-helpers.ts";
import { changesetText } from "../flow/helpers.ts";
import { cli, fixtureRepo } from "./helpers.ts";

const CONFIG = { targets: { web: { type: "web" } } };
const TARGETS = ".launchset-web:\n  image: node:24\n  script:\n    - npm run build\n";
const minor = { ".launchset/brave-lions-sing.md": changesetText("minor", "Add offline mode.") };

const open: GitLabProject[] = [];
afterEach(async () => {
  for (const project of open.splice(0)) await project.git.close();
});

async function project() {
  const created = await setupGitLabProject({ config: CONFIG });
  open.push(created);
  return created;
}

const read = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");
const child = (dir: string, name = "launchset-child.yml") =>
  parseGitLabYaml(read(dir, name)) as Record<string, Record<string, unknown>>;

describe("release --ci on GitLab", () => {
  it("release-pr: writes the nothing-to-build child and prints it to the log", async () => {
    const p = await project();
    const sha = p.push("Offline mode", minor);
    new FakeGitLab();
    const ci = runnerCheckout(p, sha);
    const r = await cli(["release"], {
      cwd: ci.dir,
      env: pushEnv("main", sha, { CI_JOB_NAME: "launchset-release" }),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("mode: release-pr");
    const doc = child(ci.dir);
    expect(Object.keys(doc)).toEqual(["launchset-nothing-to-build"]);
    expect(JSON.stringify(doc)).toContain("The release MR for 1.5.0 is up to date");
    expect(r.stderr).toContain("section_start:");
    expect(r.stderr).toContain("launchset-nothing-to-build:");
    expect(existsSync(join(ci.dir, "plan.json"))).toBe(true);
  });

  it("publish: build jobs for the plan, after checking the targets file", async () => {
    const p = await project();
    const sha = p.push("Offline mode", { ...minor, ".gitlab/launchset-targets.yml": TARGETS });
    new FakeGitLab();
    await cli(["release"], { cwd: runnerCheckout(p, sha).dir, env: pushEnv("main", sha) });
    p.repo.checkout("main");
    p.repo.git("fetch", "--quiet", "origin");
    const merged = p.repo.merge("origin/launchset/release/main", "Merge the release MR");
    p.repo.git("push", "--quiet", "origin", "main");

    const ci = runnerCheckout(p, merged);
    const r = await cli(["release"], {
      cwd: ci.dir,
      env: pushEnv("main", merged, { LAUNCHSET_CHILD_PIPELINE: "out-child.yml" }),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("mode: publish");
    const doc = child(ci.dir, "out-child.yml");
    expect(Object.keys(doc)).toEqual([
      "include",
      ".launchset_cli",
      "build-web",
      "launchset-finalize",
    ]);
    expect(doc["build-web"]?.needs).toEqual([
      { pipeline: "$PARENT_PIPELINE_ID", job: "launchset-release" },
    ]);
    expect(doc["build-web"]?.script).toContainEqual(
      new GitLabReference([".launchset-web", "script"]),
    );
    // The pipeline runs at the release commit: no checkout.
    expect(read(ci.dir, "out-child.yml")).not.toContain("git checkout");
    expect(JSON.parse(read(ci.dir, "plan.json"))).toMatchObject({
      mode: "publish",
      releaseSha: merged,
    });
  });

  it("fails with a hint when the targets file lacks a target's job", async () => {
    const p = await project();
    const sha = p.push("Offline mode", minor);
    new FakeGitLab();
    await cli(["release"], { cwd: runnerCheckout(p, sha).dir, env: pushEnv("main", sha) });
    p.repo.checkout("main");
    p.repo.git("fetch", "--quiet", "origin");
    const merged = p.repo.merge("origin/launchset/release/main", "Merge the release MR");
    p.repo.git("push", "--quiet", "origin", "main");
    const ci = runnerCheckout(p, merged);
    const r = await cli(["release"], { cwd: ci.dir, env: pushEnv("main", merged) });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(".gitlab/launchset-targets.yml doesn't exist");
    expect(r.stderr).toContain("hint:");
    expect(existsSync(join(ci.dir, "launchset-child.yml"))).toBe(false);
  });

  it("writes no child pipeline with --no-ci", async () => {
    const p = await project();
    const sha = p.push("Offline mode", minor);
    new FakeGitLab();
    const ci = runnerCheckout(p, sha);
    const r = await cli(["release", "--no-ci"], { cwd: ci.dir, env: pushEnv("main", sha) });
    expect(r.code).toBe(0);
    expect(existsSync(join(ci.dir, "launchset-child.yml"))).toBe(false);
  });
});

describe("preview-plan --ci and preview-comment on GitLab", () => {
  it("a skipped preview writes the nothing-to-build child, and the comment reports nothing", async () => {
    const p = await project();
    p.repo.checkout("-b", "feature");
    const head = p.push("Feature work", minor);
    p.setMrHead(1, head);
    const gitlab = new FakeGitLab();
    gitlab.addMr({ iid: 1, source: "feature", sha: head });
    const ci = runnerCheckout(p, head);
    const env = mrEnv({ iid: 1, source: "feature", sha: head });

    const planned = await cli(["preview-plan"], { cwd: ci.dir, env });
    expect(planned.code).toBe(0);
    const doc = child(ci.dir);
    expect(Object.keys(doc)).toEqual(["launchset-nothing-to-build"]);
    expect(JSON.stringify(doc)).toContain("have the `launchset:preview` label");
    expect(existsSync(join(ci.dir, "plan.json"))).toBe(false);

    const comment = await cli(["preview-comment", "--plan", "@plan.json"], { cwd: ci.dir, env });
    expect(comment.code).toBe(0);
    expect(comment.stdout).toContain("No preview plan was passed");
    expect(gitlab.notes).toHaveLength(0);
  });

  it("a labeled MR: preview-<target> jobs that need launchset-preview-plan", async () => {
    const p = await project();
    p.repo.checkout("-b", "feature");
    const head = p.push("Feature work", { ...minor, ".gitlab/launchset-targets.yml": TARGETS });
    p.setMrHead(1, head);
    const gitlab = new FakeGitLab();
    gitlab.addMr({ iid: 1, source: "feature", sha: head, labels: ["launchset:preview"] });
    const ci = runnerCheckout(p, head);
    const env = mrEnv({ iid: 1, source: "feature", sha: head, labels: ["launchset:preview"] });
    const r = await cli(["preview-plan"], { cwd: ci.dir, env });
    expect(r.code).toBe(0);
    const doc = child(ci.dir);
    expect(Object.keys(doc)).toEqual(["include", "preview-web"]);
    expect(doc["preview-web"]?.needs).toEqual([
      { pipeline: "$PARENT_PIPELINE_ID", job: "launchset-preview-plan" },
    ]);
  });
});

describe("plan --gitlab", () => {
  it("prints the child pipeline instead of the plan with -", async () => {
    const f = fixtureRepo();
    const r = await cli(["plan", "--gitlab", "-"], { cwd: f.dir });
    expect(r.code).toBe(0);
    const doc = parseGitLabYaml(r.stdout) as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(["launchset-nothing-to-build"]);
    expect(r.stdout).toContain("Nothing to release");
  });

  it("writes launchset-child.yml for a ship plan, at the current commit", async () => {
    const f = fixtureRepo();
    f.repo.commit("Targets", {
      ".gitlab/launchset-targets.yml": ".launchset-ios:\n  tags: [macos]\n  script: [make]\n",
    });
    const r = await cli(["plan", "--target", "ios", "--gitlab"], { cwd: f.dir });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ mode: "ship", matrix: ["ios"] });
    expect(r.stderr).toContain("wrote the child pipeline to");
    const doc = child(f.dir);
    expect(Object.keys(doc)).toEqual([
      "include",
      ".launchset_cli",
      "build-ios",
      "launchset-finalize",
    ]);
    // The ship plan builds the release commit (v1.4.0), one commit behind HEAD.
    expect(read(f.dir, "launchset-child.yml")).toContain("git checkout --quiet --detach");
  });

  it("writes to the given file, and fails without a targets file", async () => {
    const f = fixtureRepo();
    const missing = await cli(["plan", "--target", "ios", "--gitlab", "ci.yml"], { cwd: f.dir });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("launchset-targets.yml doesn't exist");
    expect(existsSync(join(f.dir, "ci.yml"))).toBe(false);

    mkdirSync(join(f.dir, ".gitlab"));
    writeFileSync(
      join(f.dir, ".gitlab/launchset-targets.yml"),
      ["docker-api", "web", "ios"].map((t) => `.launchset-${t}:\n  script: [make]\n`).join(""),
    );
    const preview = await cli(["plan", "--preview", "--run-number", "3", "--gitlab", "p.yml"], {
      cwd: f.dir,
    });
    expect(preview.code).toBe(0);
    expect(Object.keys(child(f.dir, "p.yml"))).toEqual([
      "include",
      "preview-docker-api",
      "preview-web",
      "preview-ios",
    ]);
  });
});
