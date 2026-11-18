import { describe, expect, it } from "vitest";
import { type InitDetectJson, runInit } from "../../src/init/index.ts";
import { collect, fixtureRepo, options, status } from "./helpers.ts";

async function detectJson(dir: string): Promise<InitDetectJson> {
  const out = collect();
  const result = await runInit(options(dir, { detect: true, json: true, output: out }));
  expect(out.logs).toEqual([]);
  expect(out.jsons).toHaveLength(1);
  // What's printed is plain JSON (it round-trips).
  const printed = JSON.parse(JSON.stringify(out.jsons[0])) as InitDetectJson;
  expect(printed).toEqual(result.detect);
  return printed;
}

function decision(json: InitDetectJson, id: string) {
  const found = json.decisions.find((d) => d.id === id);
  if (!found) throw new Error(`no decision ${id}: ${json.decisions.map((d) => d.id).join(", ")}`);
  return found;
}

describe("init --detect --json: tag-triggered docker workflow with v-prefixed tags", () => {
  it("finds the image, its v tags, the tag trigger and the k8s pins, and writes nothing", async () => {
    const dir = fixtureRepo("docker-v", { tags: ["v1.3.0"] });
    const json = await detectJson(dir);
    expect(status(dir)).toEqual([]);

    expect(json.schemaVersion).toBe(1);
    expect(json.detection.root).toBe(dir);
    expect(json.detection.git).toMatchObject({ repo: true, branch: "main" });
    expect(json.detection.tags).toEqual([
      { tag: "v1.3.0", version: "1.3.0", format: "v{version}", prerelease: false, counted: true },
    ]);
    expect(json.detection.canonical.version).toBe("1.4.0");

    const docker = json.detection.targets.find((t) => t.type === "docker");
    expect(docker).toMatchObject({
      name: "docker",
      proposed: "auto",
      docker: {
        dockerfile: "Dockerfile",
        context: ".",
        image: "ghcr.io/demonsters/api",
        tags: ["v{version}", "latest"],
        platforms: "linux/amd64,linux/arm64",
      },
    });
    expect(docker?.builtBy[0]).toMatchObject({ path: ".github/workflows/docker.yml", line: 33 });

    expect(json.detection.machinery).toHaveLength(1);
    expect(json.detection.machinery[0]).toMatchObject({
      id: "machinery..github/workflows/docker.yml#1",
      kinds: ["tag-trigger"],
      path: ".github/workflows/docker.yml",
      line: 6,
      actions: ["remove", "disable", "keep"],
    });
    expect(json.detection.machinery[0]?.evidence).toEqual([
      {
        path: ".github/workflows/docker.yml",
        line: 6,
        note: "tag pattern v* matches v1.2.3, v1.2.3-alpha.0",
      },
    ]);

    expect(json.detection.imagePins).toEqual([
      {
        path: "deploy/k8s/api.yaml",
        target: "docker",
        image: "ghcr.io/demonsters/api",
        refs: [{ line: 10, tag: "v1.3.0" }],
      },
      {
        path: "deploy/production/api.yaml",
        target: "docker",
        image: "ghcr.io/demonsters/api",
        refs: [{ line: 10, tag: "v1.2.0" }],
      },
    ]);

    expect(json.decisions.map((d) => d.id)).toEqual([
      "version",
      "tags.release",
      "target.docker",
      "target.web",
      "docker.docker.image",
      "docker.docker.tags",
      "machinery..github/workflows/docker.yml#1",
      "image.deploy/k8s/api.yaml",
      "image.deploy/production/api.yaml",
      "baseline",
      "offset",
      "skill",
    ]);
    expect(decision(json, "docker.docker.tags")).toMatchObject({
      default: "v{version}, latest",
      ask: false,
    });
    expect(decision(json, "docker.docker.image")).toMatchObject({
      default: "ghcr.io/demonsters/api",
      ask: false,
      onlyIf: { id: "target.docker", values: ["auto", "manual"] },
    });
    expect(decision(json, "machinery..github/workflows/docker.yml#1")).toMatchObject({
      default: "disable",
      options: [
        { value: "remove", label: "remove: deletes the workflow file" },
        {
          value: "disable",
          label:
            "disable: removes the push trigger (workflow_dispatch replaces it when no other trigger is left)",
        },
        { value: "keep", label: "keep: leaves it as is" },
      ],
    });
    // Image pins are never aligned without a decision.
    expect(decision(json, "image.deploy/k8s/api.yaml")).toMatchObject({
      default: "leave",
      ask: true,
    });
    expect(decision(json, "target.web")).toMatchObject({ default: "none" });
  });

  it("an unreleased root version gets no baseline by default, with a warning in the question", async () => {
    const dir = fixtureRepo("docker-v", { tags: ["v1.3.0"] });
    const json = await detectJson(dir);
    const baseline = decision(json, "baseline");
    expect(baseline.default).toBe("no");
    expect(baseline.ask).toBe(true);
    expect(baseline.question).toContain("it may never have been built");
    expect(baseline.evidence).toEqual([{ path: "v1.4.0", note: "no tag marks 1.4.0 as released" }]);
  });
});

describe("init --detect --json: Changesets pipeline", () => {
  const tags = ["@demonsters/widgets@0.9.3", "@demonsters/widgets@0.9.4"];

  it("lists the changesets/action step, tag step, scripts and docs with line evidence", async () => {
    const dir = fixtureRepo("changesets", { tags });
    const json = await detectJson(dir);
    expect(status(dir)).toEqual([]);
    const items = json.detection.machinery.map((m) => ({
      id: m.id,
      kinds: m.kinds,
      line: m.line,
      actions: m.actions,
    }));
    expect(items).toEqual([
      {
        id: "machinery..github/workflows/release.yml#1",
        kinds: ["changesets"],
        line: 17,
        actions: ["remove", "disable", "keep"],
      },
      {
        id: "machinery..github/workflows/release.yml#2",
        kinds: ["tag-creation"],
        line: 28,
        actions: ["remove", "disable", "keep"],
      },
      { id: "machinery.CLAUDE.md#1", kinds: ["release-docs"], line: 5, actions: ["keep"] },
      {
        id: "machinery.package.json#1",
        kinds: ["changesets"],
        line: 8,
        actions: ["remove", "disable", "keep"],
      },
      {
        id: "machinery.package.json#2",
        kinds: ["changesets"],
        line: 9,
        actions: ["remove", "disable", "keep"],
      },
    ]);
    const tagStep = json.detection.machinery[1];
    expect(tagStep?.evidence).toEqual([
      { path: ".github/workflows/release.yml", line: 28, note: `runs \`git tag "v\${VERSION}"\`` },
      { path: ".github/workflows/release.yml", line: 29, note: "runs `git push origin --tags`" },
    ]);
    expect(tagStep?.effects.disable).toBe('removes the conflicting commands from step "Tag"');
    // Docs can only be kept: they're listed as manual steps, not decisions.
    expect(json.decisions.some((d) => d.id === "machinery.CLAUDE.md#1")).toBe(false);
    expect(json.detection.changesets).toEqual({
      files: [".changeset/brave-lions-sing.md", ".changeset/fix_button.md"],
      preMode: true,
    });
    expect(json.detection.hooks).toEqual([
      { tool: "husky", path: ".husky/pre-push", installed: false },
    ]);
  });

  it("name@0.9.4 tags mark the version as released: baseline yes by default", async () => {
    const dir = fixtureRepo("changesets", { tags });
    const json = await detectJson(dir);
    expect(json.detection.tags.map((t) => t.format)).toEqual([
      "@demonsters/widgets@{version}",
      "@demonsters/widgets@{version}",
    ]);
    expect(decision(json, "baseline")).toMatchObject({
      default: "yes",
      ask: false,
      evidence: [
        { path: "@demonsters/widgets@0.9.4", note: "existing tag marks 0.9.4 as released" },
      ],
    });
    // Release tags become v{version}; the existing format is offered and worth asking about.
    expect(decision(json, "tags.release")).toMatchObject({
      default: "v{version}",
      ask: true,
      options: [
        { value: "v{version}", label: "v{version} (launchset default, e.g. v1.5.0)" },
        {
          value: "@demonsters/widgets@{version}",
          label: "@demonsters/widgets@{version} (used by existing tags)",
        },
      ],
    });
    // Only a web target: nothing else to build.
    expect(json.detection.targets.map((t) => [t.name, t.proposed])).toEqual([["web", "auto"]]);
  });
});

describe("init --detect --json: Capacitor app with a version-sync script", () => {
  const repo = () =>
    fixtureRepo("capacitor-sync", {
      tags: ["v1.0.0", "v1.0.1"],
      remote: "https://github.com/acme/app.git",
    });

  it("defaults to the highest version (native is ahead of the root) and never lowers", async () => {
    const json = await detectJson(repo());
    expect(json.detection.versions.filter((v) => v.source !== "tag")).toEqual([
      {
        source: "root",
        path: "package.json",
        line: 3,
        key: "version",
        value: "1.0.1",
        plain: "1.0.1",
      },
      {
        source: "native",
        path: "android/app/build.gradle",
        line: 11,
        key: "versionName",
        value: "1.0.2",
        plain: "1.0.2",
      },
      {
        source: "native",
        path: "ios/App/App.xcodeproj/project.pbxproj",
        line: 311,
        key: "MARKETING_VERSION (App, Debug)",
        value: "1.0.1",
        plain: "1.0.1",
      },
      {
        source: "native",
        path: "ios/App/App.xcodeproj/project.pbxproj",
        line: 332,
        key: "MARKETING_VERSION (App, Release)",
        value: "1.0.1",
        plain: "1.0.1",
      },
    ]);
    const version = decision(json, "version");
    expect(version.default).toBe("1.0.2");
    expect(version.ask).toBe(true);
    expect(version.evidence[0]).toEqual({
      path: "android/app/build.gradle",
      line: 11,
      note: "highest version: versionName = 1.0.2",
    });
    expect(version.options.map((o) => o.value)).toEqual(["1.0.2", "1.0.1", "1.0.0"]);
    expect(version.options[2]?.label).toContain("lower: stores reject lower versions");
  });

  it("prefers the capacitor alias, proposes manual for native apps no workflow builds", async () => {
    const json = await detectJson(repo());
    const byName = Object.fromEntries(json.detection.targets.map((t) => [t.name, t]));
    expect(byName.android).toMatchObject({
      source: { kind: "capacitor", dir: "." },
      proposed: "manual",
      buildNumber: 1000199,
    });
    expect(byName.ios).toMatchObject({
      source: { kind: "capacitor", dir: "." },
      proposed: "manual",
      buildNumber: 1000199,
    });
    expect(decision(json, "target.android")).toMatchObject({ default: "manual", ask: true });
    // The image name comes from ${{ github.repository }} and the origin remote; tags from metadata-action.
    expect(byName.docker?.docker).toMatchObject({
      image: "ghcr.io/acme/app",
      tags: ["{version}", "sha-{shortSha}", "latest"],
    });
  });

  it("finds the version-sync script, the tag trigger and latest pushed on branch pushes", async () => {
    const json = await detectJson(repo());
    const items = Object.fromEntries(json.detection.machinery.map((m) => [m.id, m]));
    expect(Object.keys(items)).toEqual([
      "machinery..github/workflows/ci.yml#1",
      "machinery..github/workflows/docker.yml#1",
      "machinery.scripts/sync-version.mjs#1",
    ]);
    expect(items["machinery..github/workflows/ci.yml#1"]).toMatchObject({
      kinds: ["docker-latest"],
      line: 15,
      effects: { disable: 'stops pushing latest from step "Staging image"' },
    });
    expect(items["machinery.scripts/sync-version.mjs#1"]).toMatchObject({
      kinds: ["version-writer"],
      line: 8,
      evidence: [
        { path: "scripts/sync-version.mjs", line: 8, note: "the script itself" },
        { path: "package.json", line: 7, note: 'script "ios:sync" runs it' },
        { path: "package.json", line: 8, note: 'script "android:bundle" runs it' },
      ],
    });
    expect(json.detection.imagePins).toEqual([
      {
        path: "deploy/k8s/app.yaml",
        target: "docker",
        image: "ghcr.io/acme/app",
        refs: [{ line: 4, tag: "0.1.46" }],
      },
    ]);
  });

  it("proposes a build-number offset when existing numbers beat the strategy", async () => {
    const dir = repo();
    const out = collect();
    // Shortly after the epoch the timestamp strategy is still below 1000199.
    const result = await runInit(
      options(dir, {
        detect: true,
        json: true,
        output: out,
        now: new Date("2020-01-02T00:00:00Z"),
      }),
    );
    const json = result.detect as InitDetectJson;
    expect(json.detection.buildNumbers).toEqual({
      highest: { value: 1000199, path: "android/app/build.gradle", line: 10, key: "versionCode" },
      strategyNow: 86400,
      offset: 920000,
    });
    expect(decision(json, "offset")).toMatchObject({ default: "920000", ask: true });
  });
});

describe("init --detect --json: workspace", () => {
  it("searches workspace packages and Dockerfiles, and gives the Expo app.config advice", async () => {
    const dir = fixtureRepo("workspace");
    const json = await detectJson(dir);
    expect(json.detection.workspaces).toEqual(["apps/api", "apps/expo-app", "apps/mobile"]);
    expect(
      json.detection.targets.map((t) => [t.name, t.type, t.source?.kind ?? null, t.proposed]),
    ).toEqual([
      ["api", "docker", null, "auto"],
      ["api-dev", "docker", null, "none"],
      ["expo-app-android", "android", "expo", "manual"],
      ["expo-app-ios", "ios", "expo", "manual"],
      ["mobile-android", "android", "capacitor", "manual"],
      ["mobile-ios", "ios", "capacitor", "manual"],
      ["web", "web", null, "none"],
    ]);
    // The package.json next to the Dockerfile counts for the canonical version.
    expect(json.detection.canonical.version).toBe("2.1.0");
    expect(decision(json, "docker.api.image")).toMatchObject({
      default: "ghcr.io/your-org/platform-api",
      ask: true,
    });
    expect(
      json.detection.notes.some(
        (n) =>
          n.path === "apps/expo-app/app.config.ts" && n.message.includes("LAUNCHSET_BUILD_NUMBER"),
      ),
    ).toBe(true);
    expect(decision(json, "hook")).toMatchObject({ default: "no" });
  });

  it("works outside a git repository", async () => {
    const dir = fixtureRepo("workspace", { git: false });
    const json = await detectJson(dir);
    expect(json.detection.git).toEqual({ repo: false });
    expect(decision(json, "baseline").options).toEqual([
      { value: "no", label: "No (not a git repository with commits)" },
    ]);
  });
});
