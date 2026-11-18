/**
 * Smoke test (spec 14): builds the action bundle, copies it next to nothing (a directory
 * without package.json or node_modules, like the public action repo) and runs it on Node 24
 * with the environment the Actions runner provides.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildBundle, writePublishDir } from "../../scripts/build-action.ts";
import { initRepo, tempDir } from "../git/helpers.ts";
import { findNode24, git, runAction } from "./helpers.ts";

const node = findNode24();
if (!node && process.env.CI) {
  throw new Error("The smoke test needs Node 24: set LAUNCHSET_NODE24 to its binary.");
}
const suite = node ? describe : describe.skip;

const CONFIG = `import { defineConfig } from "@demonsters/launchset";

export default defineConfig({
  targets: {
    web: { type: "web" },
    android: { type: "android", source: { kind: "gradle", file: "android/app/build.gradle" } },
  },
});
`;

const gradle = (versionName: string) =>
  `android {\n    defaultConfig {\n        applicationId "com.acme.app"\n        versionCode 12\n        versionName "${versionName}"\n    }\n}\n`;

const pkg = (version: string) => `${JSON.stringify({ name: "app", version }, null, 2)}\n`;

suite("action bundle on Node 24", () => {
  let bundle: string;
  let scratch: string;
  let workspace: string;
  let releaseSha: string;

  beforeAll(async () => {
    // The published layout: dist/index.js in a directory tree without any package.json.
    const build = join(tempDir("build"), "index.js");
    await buildBundle(build);
    const published = join(tempDir("publish"), "launchset-action");
    await writePublishDir(published, build);
    bundle = join(published, "dist/index.js");
    scratch = tempDir("scratch");

    const repo = initRepo();
    workspace = repo.dir;
    repo.commit("Set up 1.4.0", {
      "launchset.config.ts": CONFIG,
      "package.json": pkg("1.4.0"),
      "android/app/build.gradle": gradle("1.4.0"),
      "CHANGELOG.md": "# Changelog\n\n## 1.4.0 (2026-01-01)\n\n### Patch changes\n- First.\n",
      ".launchset/README.md": "# Changesets\n",
    });
    git(workspace, "tag", "v1.4.0");
    // The release commit: the version changed in this commit.
    releaseSha = repo.commit("Release v1.5.0", {
      "package.json": pkg("1.5.0"),
      "android/app/build.gradle": gradle("1.5.0"),
      "CHANGELOG.md":
        "# Changelog\n\n## 1.5.0 (2026-11-18)\n\n### Minor changes\n- Offline mode.\n\n## 1.4.0 (2026-01-01)\n\n### Patch changes\n- First.\n",
    });
  });

  const push = () => ({
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REF_NAME: "main",
    GITHUB_SHA: releaseSha,
    GITHUB_REPOSITORY: "acme/app",
    GITHUB_RUN_ID: "42",
    GITHUB_RUN_NUMBER: "7",
    GITHUB_RUN_ATTEMPT: "1",
  });

  let plan = "";

  it.each([
    ["no package.json", undefined],
    ["a typeless package.json", '{"name":"host"}'],
    ['a "type": "commonjs" package.json', '{"name":"host","type":"commonjs"}'],
  ])("loads with %s above the action folder", (_name, packageJson) => {
    // A consumer's checkout can have any package.json above the folder the runner puts the
    // action in (_actions/demonsters/launchset-action/v1 under the runner's work dir).
    const host = tempDir("host");
    const copy = join(host, "nested/launchset-action");
    mkdirSync(join(copy, "dist"), { recursive: true });
    for (const file of ["dist/index.js", "dist/package.json"]) {
      writeFileSync(join(copy, file), readFileSync(join(dirname(dirname(bundle)), file)));
    }
    if (packageJson) writeFileSync(join(host, "package.json"), packageJson);
    const run = runAction({
      node: node as string,
      bundle: join(copy, "dist/index.js"),
      scratch,
      workspace,
      inputs: { command: "deploy" },
    });
    // The command is unknown on purpose: it proves the bundle loaded and ran, cheaply.
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain('unknown command "deploy"');
    expect(run.status).toBe(1);
  });

  it("runs on Node 24 from the publish layout (no node_modules)", () => {
    expect(execFileSync(node as string, ["--version"], { encoding: "utf8" })).toMatch(/^v24\./);
    const published = dirname(dirname(bundle));
    for (const file of ["action.yml", "README.md", "LICENSE", "dist/index.js"]) {
      expect(existsSync(join(published, file))).toBe(true);
    }
    expect(existsSync(join(published, "package.json"))).toBe(false);
    // The only package.json: it makes dist/index.js an ES module whatever is above it.
    expect(readFileSync(join(published, "dist/package.json"), "utf8")).toBe('{"type":"module"}\n');
    expect(readFileSync(join(published, "LICENSE"), "utf8")).toContain("All rights reserved");
  });

  it("release: a release commit is mode publish with a matrix (loads launchset.config.ts)", () => {
    const run = runAction({
      node: node as string,
      bundle,
      scratch,
      workspace,
      inputs: { command: "release", "working-directory": "." },
      env: push(),
    });
    expect(run.stderr).not.toMatch(/warning|error/i);
    expect(run.stdout).not.toContain("::error");
    expect(run.status).toBe(0);
    expect(run.outputs).toMatchObject({
      mode: "publish",
      version: "1.5.0",
      channel: "release",
      prerelease: "false",
      "release-sha": releaseSha,
      "dist-tag": "latest",
      tag: "v1.5.0",
    });
    expect(JSON.parse(run.outputs.matrix as string)).toEqual(["web", "android"]);
    expect(run.outputs["build-number"]).toMatch(/^\d+$/);
    expect(run.summary).toContain("1.5.0");
    plan = run.outputs.plan as string;
    expect(JSON.parse(plan)).toMatchObject({ mode: "publish", version: "1.5.0" });
  });

  it("stamp: writes the version and build number into the target's files", () => {
    // A build job checks out the release commit; stamp changes files in that checkout only.
    const buildNumber = JSON.parse(plan).targets.android.buildNumber as number;
    const run = runAction({
      node: node as string,
      bundle,
      scratch,
      workspace,
      inputs: { command: "stamp", target: "android", plan },
      env: push(),
    });
    expect(run.status).toBe(0);
    expect(run.outputs).toMatchObject({
      version: "1.5.0",
      "marketing-version": "1.5.0",
      "build-number": String(buildNumber),
      channel: "release",
      prerelease: "false",
      "docker-refs-json": "[]",
    });
    expect(readFileSync(join(workspace, "android/app/build.gradle"), "utf8")).toContain(
      `versionCode ${buildNumber}`,
    );
    expect(run.env).toMatchObject({
      LAUNCHSET_VERSION: "1.5.0",
      LAUNCHSET_BUILD_NUMBER: String(buildNumber),
      LAUNCHSET_CHANNEL: "release",
    });
    expect(run.summary).toContain("android");
    git(workspace, "checkout", "--quiet", "--", ".");
  });

  it("add: writes a changeset and outputs its path", () => {
    const run = runAction({
      node: node as string,
      bundle,
      scratch,
      workspace,
      inputs: { command: "add", bump: "patch", message: "Update the generated files." },
      env: push(),
    });
    expect(run.status).toBe(0);
    const path = run.outputs.path as string;
    expect(path).toMatch(/^\.launchset\/[a-z-]+\.md$/);
    expect(readFileSync(join(workspace, path), "utf8")).toBe(
      "---\nbump: patch\n---\n\nUpdate the generated files.\n",
    );
    expect(run.stdout).toContain(path);
  });

  it("working-directory: resolves against GITHUB_WORKSPACE", () => {
    const parent = tempDir("parent");
    mkdirSync(join(parent, "apps"));
    writeFileSync(join(parent, "x.txt"), "");
    const run = runAction({
      node: node as string,
      bundle,
      scratch,
      workspace: parent,
      inputs: { command: "add", bump: "patch", message: "x", "working-directory": "apps" },
    });
    // No config in apps/: a clear error that names the directory, as a failed step.
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("::error::");
    expect(run.stdout).toContain(join(parent, "apps"));
    expect(run.summary).toContain("launchset add failed");
  });

  it("fails with a clear message for an unknown command", () => {
    const run = runAction({
      node: node as string,
      bundle,
      scratch,
      workspace,
      inputs: { command: "deploy" },
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('unknown command "deploy"');
    expect(run.stdout).toContain("check, release, stamp, verify, mark, finalize");
    expect(run.stdout).not.toContain("    at ");
  });

  it("fails without a stack trace when a required input is missing", () => {
    const run = runAction({
      node: node as string,
      bundle,
      scratch,
      workspace,
      inputs: { command: "stamp", plan },
      env: push(),
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("the target input is required for command stamp");
    expect(run.stdout).not.toContain("    at ");
  });

  it("check: reads the pull request from the event and sets pr-number (no token: no comment)", () => {
    const repo = initRepo();
    repo.commit("Set up", {
      "launchset.config.ts": CONFIG,
      "package.json": pkg("1.4.0"),
      "android/app/build.gradle": gradle("1.4.0"),
      "CHANGELOG.md": "# Changelog\n",
      ".launchset/README.md": "# Changesets\n",
    });
    git(repo.dir, "tag", "v1.4.0");
    const base = repo.head();
    repo.checkout("-b", "feature");
    repo.commit("Offline mode", {
      ".launchset/brave-lions-sing.md": "---\nbump: minor\n---\n\nAdd offline mode.\n",
    });
    const repoInfo = { full_name: "acme/app" };
    const run = runAction({
      node: node as string,
      bundle,
      scratch,
      workspace: repo.dir,
      inputs: { command: "check" },
      env: {
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REF: "refs/pull/7/merge",
        GITHUB_REPOSITORY: "acme/app",
      },
      event: {
        pull_request: {
          number: 7,
          user: { login: "someone" },
          head: { ref: "feature", sha: repo.head(), repo: repoInfo },
          base: { ref: "main", sha: base, repo: repoInfo },
        },
      },
    });
    expect(run.status).toBe(0);
    expect(run.outputs["pr-number"]).toBe("7");
    expect(run.stdout).toContain("launchset check: passed");
    expect(run.stdout).toContain("next version: 1.5.0 (minor)");
    expect(run.summary).toContain("launchset check: passed");
  });

  it("check: a PR without a changeset fails the step and says why", () => {
    const repo = initRepo();
    repo.commit("Set up", {
      "launchset.config.ts": CONFIG,
      "package.json": pkg("1.4.0"),
      "android/app/build.gradle": gradle("1.4.0"),
      "CHANGELOG.md": "# Changelog\n",
      ".launchset/README.md": "# Changesets\n",
    });
    const base = repo.head();
    repo.checkout("-b", "feature");
    repo.commit("No changeset");
    const repoInfo = { full_name: "acme/app" };
    const run = runAction({
      node: node as string,
      bundle,
      scratch,
      workspace: repo.dir,
      inputs: { command: "check" },
      env: { GITHUB_EVENT_NAME: "pull_request", GITHUB_REPOSITORY: "acme/app" },
      event: {
        pull_request: {
          number: 8,
          user: { login: "someone" },
          head: { ref: "feature", sha: repo.head(), repo: repoInfo },
          base: { ref: "main", sha: base, repo: repoInfo },
        },
      },
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("::error::launchset check: failed");
    expect(run.outputs["pr-number"]).toBe("8");
    expect(run.summary).toContain("changeset");
  });
});
