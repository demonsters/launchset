/**
 * Scenario 7 (spec 11.1): `init --detect --json` followed by `init --yes --decide ...` on the
 * init fixture repos. The JSON lists the decisions; a non-default answer shows up in the
 * written config and workflows; the written config loads and `status` works afterwards.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cli, type Run } from "../cli/helpers.ts";
import { fixtureRepo, git, read } from "../init/helpers.ts";

interface Decision {
  id: string;
  question: string;
  options: { value: string; label: string }[];
  default: string;
  evidence: { path: string; line?: number; note: string }[];
  ask: boolean;
}

interface Detect {
  schemaVersion: number;
  decisions: Decision[];
  detection: { targets: { name: string; type: string; proposed: string }[] };
}

interface Status {
  version: string;
  consistency: { ok: boolean };
  lastRelease: { version: string } | null;
  pending: { path: string; bump: string }[];
  nextVersion: string | null;
  manualTargets: { target: string; lastShipped: string | null }[];
}

/** What `git status` shows, with the text of every changed or new file. */
function snapshot(dir: string): Record<string, string> {
  const files = git(dir, "ls-files", "--modified", "--others", "--exclude-standard", "--deleted")
    .split("\n")
    .filter(Boolean);
  const out: Record<string, string> = {};
  for (const file of files) {
    try {
      out[file] = readFileSync(join(dir, file), "utf8");
    } catch {
      out[file] = "(deleted)";
    }
  }
  return out;
}

async function detect(dir: string): Promise<Detect> {
  const run = await cli(["init", "--detect", "--json"], { cwd: dir });
  expect(run.code, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as Detect;
}

const decide = (answers: Record<string, string>): string[] =>
  Object.entries(answers).flatMap(([id, value]) => ["--decide", `${id}=${value}`]);

/** Commit what init wrote, like a developer would, then run `status --json`. */
async function statusAfterInit(dir: string): Promise<Status> {
  git(dir, "add", "--all");
  git(dir, "commit", "--quiet", "--no-verify", "-m", "Set up launchset");
  const run = await cli(["status", "--json", "--no-fetch"], { cwd: dir });
  expect(run.code, run.stdout + run.stderr).toBe(0);
  return JSON.parse(run.stdout) as Status;
}

const expectOk = (run: Run) => expect(run.code, run.stdout + run.stderr).toBe(0);

describe("init --detect --json", () => {
  it("writes nothing and lists the decisions with their defaults and evidence", async () => {
    const dir = fixtureRepo("docker-v", { tags: ["v1.3.0"] });
    const found = await detect(dir);
    expect(found.schemaVersion).toBe(1);
    expect(git(dir, "status", "--porcelain")).toBe("");

    expect(found.decisions.map((d) => d.id)).toEqual([
      "version",
      "tags.release",
      "target.docker",
      "target.web",
      "docker.docker.image",
      "docker.docker.tags",
      "docker.docker.verify",
      "machinery..github/workflows/docker.yml#1",
      "image.deploy/k8s/api.yaml",
      "image.deploy/production/api.yaml",
      "baseline",
      "offset",
      "skill",
    ]);
    const byId = new Map(found.decisions.map((d) => [d.id, d]));
    // Every decision: a question, options that contain the default, and where it comes from.
    for (const d of found.decisions) {
      expect(d.question, d.id).not.toBe("");
      expect(
        d.options.map((o) => o.value),
        d.id,
      ).toContain(d.default);
    }
    // The canonical version is the highest found: 1.4.0 in package.json, not the v1.3.0 tag.
    expect(byId.get("version")?.default).toBe("1.4.0");
    expect(byId.get("version")?.evidence.some((e) => e.path === "package.json")).toBe(true);
    expect(byId.get("docker.docker.tags")?.default).toBe("v{version}, latest");
    // The conflicting workflow trigger is evidence at path:line, and disabled by default.
    const machinery = byId.get("machinery..github/workflows/docker.yml#1");
    expect(machinery?.default).toBe("disable");
    expect(machinery?.options.map((o) => o.value)).toEqual(["remove", "disable", "keep"]);
    expect(machinery?.evidence[0]).toMatchObject({ path: ".github/workflows/docker.yml", line: 6 });
    // A tag that is not a launchset tag is not a baseline: no by default.
    expect(byId.get("baseline")?.default).toBe("no");
    expect(found.detection.targets.map((t) => `${t.name}:${t.proposed}`)).toEqual([
      "docker:auto",
      "web:none",
    ]);
    // Detection is deterministic and still writes nothing.
    expect(await detect(dir)).toEqual(found);
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  it("answering every decision with its default is the same as --yes", async () => {
    const a = fixtureRepo("docker-v", { tags: ["v1.3.0"] });
    const b = fixtureRepo("docker-v", { tags: ["v1.3.0"] });
    const found = await detect(b);
    expectOk(await cli(["init", "--yes"], { cwd: a }));
    expectOk(
      await cli(
        [
          "init",
          "--yes",
          ...decide(Object.fromEntries(found.decisions.map((d) => [d.id, d.default]))),
        ],
        { cwd: b },
      ),
    );
    expect(snapshot(b)).toEqual(snapshot(a));
    expect(Object.keys(snapshot(a))).toContain("launchset.config.ts");
  });
});

describe("init --yes --decide", () => {
  it("defaults: docker auto, the tag trigger disabled; the config loads and status works", async () => {
    const dir = fixtureRepo("docker-v", { tags: ["v1.3.0"] });
    expectOk(await cli(["init", "--yes"], { cwd: dir }));
    const config = read(dir, "launchset.config.ts");
    expect(config).toContain(
      'type: "docker",\n      image: "ghcr.io/demonsters/api",\n      tags: ["v{version}", "latest"],\n      verify: ["registry"],\n',
    );
    expect(config).not.toContain("web:");
    // Disabled, not deleted: the push trigger is gone, the workflow stays.
    const workflow = read(dir, ".github/workflows/docker.yml");
    expect(workflow).not.toContain('- "v*"');
    expect(workflow).not.toMatch(/^on:\n {2}push:/m);
    expect(workflow).toContain("on:\n  workflow_dispatch:");
    expect(git(dir, "tag")).toBe("v1.3.0");

    const status = await statusAfterInit(dir);
    expect(status).toMatchObject({
      version: "1.4.0",
      consistency: { ok: true },
      nextVersion: null,
    });
    expect(status.lastRelease).toEqual({ version: "1.3.0", tag: "v1.3.0" });
  });

  it("non-default answers: manual target, tag format, kept workflow, stamped image pin, baseline tag", async () => {
    const dir = fixtureRepo("docker-v", { tags: ["v1.3.0"] });
    const before = read(dir, ".github/workflows/docker.yml");
    const production = read(dir, "deploy/production/api.yaml");
    const run = await cli(
      [
        "init",
        "--yes",
        "--baseline",
        ...decide({
          "target.docker": "manual",
          "target.web": "auto",
          "docker.docker.tags": "v{version}, v{major}.{minor}, latest",
          "machinery..github/workflows/docker.yml#1": "keep",
          "image.deploy/k8s/api.yaml": "stamp",
          skill: "no",
        }),
      ],
      { cwd: dir },
    );
    expectOk(run);

    const config = read(dir, "launchset.config.ts");
    expect(config).toContain('tags: ["v{version}", "v{major}.{minor}", "latest"]');
    expect(config).toContain('{ path: "deploy/k8s/api.yaml", kind: "image" }');
    expect(config).toContain('release: "manual"');
    expect(config).toContain('web: { type: "web" }');
    expect(config).not.toContain("production");
    // `keep`: the conflicting workflow is untouched, and init says what it still does.
    expect(read(dir, ".github/workflows/docker.yml")).toBe(before);
    expect(run.stdout).toContain("Still in place because you chose keep");
    // The pinned manifest follows the release tag; the production overlay is left alone.
    expect(read(dir, "deploy/k8s/api.yaml")).toContain("image: ghcr.io/demonsters/api:v1.4.0");
    expect(read(dir, "deploy/production/api.yaml")).toBe(production);
    // The baseline tag marks 1.4.0 as released; no skill files with skill=no.
    expect(git(dir, "tag").split("\n")).toEqual(["v1.3.0", "v1.4.0"]);
    expect(Object.keys(snapshot(dir))).not.toContain(".claude/skills/launchset/SKILL.md");

    // The generated workflows run the action's commands.
    const release = read(dir, ".github/workflows/launchset-release.yml");
    expect(release).toContain("command: release");
    expect(release).toContain("command: finalize");

    const status = await statusAfterInit(dir);
    expect(status).toMatchObject({ version: "1.4.0", consistency: { ok: true } });
    expect(status.lastRelease).toEqual({ version: "1.4.0", tag: "v1.4.0" });
    expect(status.manualTargets).toEqual([
      { target: "docker", lastShipped: null, releasesBehind: 2 },
    ]);
    // And the next step works: add a changeset, status shows the version it makes.
    const added = await cli(["add", "--bump", "minor", "--message", "Add search."], { cwd: dir });
    expectOk(added);
    const next = JSON.parse(
      (await cli(["status", "--json", "--no-fetch"], { cwd: dir })).stdout,
    ) as Status;
    expect(next.nextVersion).toBe("1.5.0");
    expect(next.pending.map((p) => p.bump)).toEqual(["minor"]);
  });

  it("capacitor app: a native target as auto, a script removed, image name decided", async () => {
    const dir = fixtureRepo("capacitor-sync");
    const found = await detect(dir);
    expect(found.detection.targets.map((t) => `${t.name}:${t.type}:${t.proposed}`)).toEqual([
      "docker:docker:auto",
      "android:android:manual",
      "ios:ios:manual",
      "web:web:none",
    ]);
    expectOk(
      await cli(
        [
          "init",
          "--yes",
          ...decide({
            "target.android": "auto",
            "docker.docker.image": "ghcr.io/acme/app",
            "machinery.scripts/sync-version.mjs#1": "remove",
          }),
        ],
        { cwd: dir },
      ),
    );
    const config = read(dir, "launchset.config.ts");
    expect(config).toContain('image: "ghcr.io/acme/app"');
    expect(config).toMatch(
      /android: \{\s+type: "android",\s+source: \{ kind: "capacitor", dir: "\." \},\s+\}/,
    );
    expect(config).toMatch(/ios: \{[\s\S]*?release: "manual"/);
    // The script that overwrote the build numbers is gone, and nothing calls it.
    expect(git(dir, "status", "--porcelain")).toContain(" D scripts/sync-version.mjs");
    expect(read(dir, "package.json")).not.toContain("sync-version");
    // The staging push of `latest` is disabled, the tag trigger replaced by a manual one.
    expect(read(dir, ".github/workflows/ci.yml")).not.toContain("docker push");
    expect(read(dir, ".github/workflows/docker.yml")).not.toContain("v[0-9]+");
    // Aligned to the highest version (1.0.2), so the consistency check passes.
    const status = await statusAfterInit(dir);
    expect(status).toMatchObject({ version: "1.0.2", consistency: { ok: true } });
    expect(status.manualTargets.map((m) => m.target)).toEqual(["ios"]);
  });

  it("workspace: several targets, a pre-push hook, every file aligned to the highest version", async () => {
    const dir = fixtureRepo("workspace");
    expectOk(
      await cli(["init", "--yes", ...decide({ "target.mobile-android": "auto", hook: "yes" })], {
        cwd: dir,
      }),
    );
    expect(read(dir, "lefthook.yml")).toContain("npx launchset check --push");
    const config = read(dir, "launchset.config.ts");
    for (const target of [
      "api",
      "expo-app-android",
      "expo-app-ios",
      "mobile-android",
      "mobile-ios",
    ]) {
      expect(config).toContain(target);
    }
    expect(config).not.toContain("api-dev");
    // Everything aligned to the highest version found (2.1.0), including the Expo app.json.
    expect(read(dir, "package.json")).toContain('"version": "2.1.0"');
    expect(read(dir, "apps/expo-app/app.json")).toContain('"version": "2.1.0"');
    const status = await statusAfterInit(dir);
    expect(status).toMatchObject({ version: "2.1.0", consistency: { ok: true } });
    expect(status.manualTargets.map((m) => m.target)).toEqual([
      "expo-app-android",
      "expo-app-ios",
      "mobile-ios",
    ]);
  });

  it("never lowers the version unless told to", async () => {
    const dir = fixtureRepo("docker-v", { tags: ["v1.3.0"] });
    expectOk(await cli(["init", "--yes", ...decide({ version: "1.3.0" })], { cwd: dir }));
    // An explicit decision is the confirmation: package.json and its lockfile follow.
    expect(read(dir, "package.json")).toContain('"version": "1.3.0"');
    expect(read(dir, "package-lock.json")).toContain('"version": "1.3.0"');
    expect((await statusAfterInit(dir)).version).toBe("1.3.0");
  });

  it("a Changesets repo: its changesets are converted and its release machinery disabled", async () => {
    const dir = fixtureRepo("changesets");
    expectOk(await cli(["init", "--yes"], { cwd: dir }));
    expect(Object.keys(snapshot(dir))).toEqual(
      expect.arrayContaining([".launchset/brave-lions-sing.md", ".launchset/fair-trains-rush.md"]),
    );
    const status = await statusAfterInit(dir);
    expect(status.pending).toHaveLength(2);
    expect(status.version).toBe("0.9.4");
    expect(status.nextVersion).toBe("0.10.0"); // the highest converted bump is minor
  });
});
