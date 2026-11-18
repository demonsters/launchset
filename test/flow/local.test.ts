import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { add } from "../../src/flow/add.ts";
import { stamp } from "../../src/flow/stamp.ts";
import { verify } from "../../src/flow/verify.ts";
import { version } from "../../src/flow/version.ts";
import { initRepo } from "../git/helpers.ts";
import {
  BUILD,
  changesetText,
  contextFor,
  gradle,
  pkg,
  setupProject,
  versionFiles,
  xcconfig,
} from "./helpers.ts";

/** Deterministic rng: always the first word of each list. */
const first = () => 0;

describe("add", () => {
  it("writes a changeset and prints its path", async () => {
    const project = setupProject();
    const context = await contextFor(project.repo, { token: null });
    const result = await add(context, { bump: "minor", message: "Add offline mode.", rng: first });
    expect(result.lines).toEqual([".launchset/brave-apples-act.md"]);
    expect(readFileSync(`${project.repo.dir}/.launchset/brave-apples-act.md`, "utf8")).toBe(
      "---\nbump: minor\n---\n\nAdd offline mode.\n",
    );
    // The same name is taken now: a new one is picked.
    let calls = 0;
    const second = await add(context, { empty: true, rng: () => (calls++ < 3 ? 0 : 0.5) });
    expect(second.data.path).not.toBe(".launchset/brave-apples-act.md");
    expect(readFileSync(second.data.absolute, "utf8")).toBe("---\nbump: none\n---\n");
  });

  it("rejects a missing summary and an unknown bump", async () => {
    const project = setupProject();
    const context = await contextFor(project.repo, { token: null });
    await expect(add(context, { bump: "patch" })).rejects.toMatchObject({ code: "empty-summary" });
    await expect(add(context, { bump: "huge", message: "x" })).rejects.toMatchObject({
      code: "invalid-bump",
    });
  });
});

describe("version", () => {
  it("--dry-run prints the diff and writes nothing; without it applies the release changes", async () => {
    const project = setupProject();
    const { repo } = project;
    repo.write(".launchset/brave-lions-sing.md", changesetText("minor", "Add offline mode."));
    const context = async () => contextFor(repo, { token: null });

    const dry = await version(await context(), { dryRun: true });
    expect(dry.data.version).toBe("1.5.0");
    expect(dry.data.diff).toContain(
      "diff --git a/package.json b/package.json\nindex dab9a20..f6d93b5 100644\n--- a/package.json\n+++ b/package.json\n",
    );
    expect(dry.data.diff).toContain('-  "version": "1.4.0"\n+  "version": "1.5.0"\n');
    expect(dry.data.diff).toContain('-        versionName "1.4.0"\n+        versionName "1.5.0"\n');
    expect(dry.data.diff).toContain("+## 1.5.0 (2026-11-18)\n");
    expect(dry.data.diff).toContain(
      "diff --git a/.launchset/brave-lions-sing.md b/.launchset/brave-lions-sing.md\ndeleted file mode 100644\n",
    );
    expect(dry.data.diff).not.toContain("a0/");
    expect(repo.git("status", "--porcelain")).toBe("?? .launchset/brave-lions-sing.md");

    const applied = await version(await context());
    expect(applied.data.changed).toEqual([
      { path: "package.json", status: "modified" },
      { path: "android/app/build.gradle", status: "modified" },
      { path: "ios/Version.xcconfig", status: "modified" },
      { path: "CHANGELOG.md", status: "modified" },
      { path: ".launchset/brave-lions-sing.md", status: "deleted" },
    ]);
    expect(readFileSync(`${repo.dir}/package.json`, "utf8")).toBe(pkg("1.5.0"));
    expect(readFileSync(`${repo.dir}/android/app/build.gradle`, "utf8")).toBe(gradle("1.5.0"));
    expect(readFileSync(`${repo.dir}/ios/Version.xcconfig`, "utf8")).toBe(xcconfig("1.5.0"));

    const nothing = await version(await context());
    expect(nothing.data.version).toBeNull();
  });

  it("works with the config in a subdirectory (repo-relative paths)", async () => {
    const repo = initRepo();
    const files: Record<string, string> = {
      "apps/web/launchset.config.json": JSON.stringify({ targets: { web: { type: "web" } } }),
      "apps/web/.launchset/brave-lions-sing.md": changesetText("patch", "Fix it."),
      "apps/web/package.json": pkg("0.3.0"),
    };
    repo.commit("init", files);
    const result = await version(
      await contextFor(repo, { token: null, cwd: `${repo.dir}/apps/web` }),
      {
        dryRun: true,
      },
    );
    expect(result.data.version).toBe("0.3.1");
    expect(result.data.changed.map((c) => c.path)).toEqual([
      "apps/web/package.json",
      "apps/web/CHANGELOG.md",
      "apps/web/.launchset/brave-lions-sing.md",
    ]);
    expect(result.data.diff).toContain("--- /dev/null\n+++ b/apps/web/CHANGELOG.md\n");
  });
});

describe("stamp from flags", () => {
  it("stamps version and build number without a plan", async () => {
    const project = setupProject();
    const context = await contextFor(project.repo, { token: null });
    const result = await stamp(context, { target: "ios", version: "v1.5.0", buildNumber: 42 });
    expect(result.data).toMatchObject({
      marketingVersion: "1.5.0",
      buildNumber: 42,
      channel: "release",
    });
    expect(readFileSync(`${project.repo.dir}/ios/Version.xcconfig`, "utf8")).toBe(
      xcconfig("1.5.0", 42),
    );
    expect(readFileSync(`${project.repo.dir}/package.json`, "utf8")).toBe(pkg("1.5.0"));
    const docker = await stamp(context, {
      target: "docker-api",
      version: "1.5.0-pr.7.3",
      channel: "preview",
    });
    expect(docker.outputs["docker-tags"]).toBe("ghcr.io/acme/api:1.5.0-pr.7.3");
    await expect(stamp(context, { target: "ios" })).rejects.toMatchObject({ code: "missing-plan" });
  });
});

describe("verify", () => {
  it("outputs already-published from the target's checks", async () => {
    const project = setupProject({
      config: {
        targets: {
          web: { type: "web" },
          npm: { type: "custom", verify: ["npm"] },
        },
      },
    });
    project.repo.commit("versions", versionFiles("1.4.0"));
    const context = await contextFor(project.repo, { token: null });
    const plan = JSON.stringify({
      schemaVersion: 1,
      mode: "publish",
      channel: "release",
      version: "1.4.0",
      baseVersion: "1.4.0",
      buildNumber: BUILD,
      releaseSha: project.repo.head(),
      branch: "main",
      maintenance: false,
      distTag: "latest",
      matrix: ["web", "npm"],
      targets: {
        web: {
          name: "web",
          type: "web",
          release: "auto",
          marketingVersion: "1.4.0",
          buildNumber: BUILD,
        },
        npm: {
          name: "npm",
          type: "custom",
          release: "auto",
          marketingVersion: "1.4.0",
          buildNumber: BUILD,
        },
      },
      createdAt: "2026-11-18T12:00:00.000Z",
    });
    const web = await verify(context, { target: "web", plan });
    expect(web.outputs["already-published"]).toBe("false");
    const fetch = async () => Response.json({ name: "app", versions: { "1.4.0": {} } });
    const npm = await verify(context, {
      target: "npm",
      plan,
      fetch: fetch as typeof globalThis.fetch,
    });
    expect(npm.outputs["already-published"]).toBe("true");
    const failing = async () => new Response("nope", { status: 500 });
    await expect(
      verify(context, { target: "npm", plan, fetch: failing as typeof globalThis.fetch }),
    ).rejects.toMatchObject({ code: "verify-failed" });
  });
});
