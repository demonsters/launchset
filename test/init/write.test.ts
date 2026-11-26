import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "../../src/config/load.ts";
import { type InitDetectJson, runInit } from "../../src/init/index.ts";
import { packageFile } from "../../src/init/package-files.ts";
import { checkConsistency } from "../../src/platforms/index.ts";
import {
  collect,
  dockerRunRepo,
  fixture,
  fixtureRepo,
  git,
  options,
  read,
  status,
} from "./helpers.ts";

/** Replace `from` (which must occur exactly once) with `to`. */
function edit(text: string, from: string, to: string): string {
  expect(text.split(from)).toHaveLength(2);
  return text.replace(from, to);
}

const README = () => read(packageFile("templates"), "launchset-readme.md");

describe("init --yes: tag-triggered docker workflow", () => {
  const repo = () => fixtureRepo("docker-v", { tags: ["v1.3.0"] });

  it("writes config, workflows, README and CHANGELOG, and disables the tag trigger", async () => {
    const dir = repo();
    const out = collect();
    const result = await runInit(
      options(dir, { yes: true, decide: { "image.deploy/k8s/api.yaml": "stamp" }, output: out }),
    );

    expect(status(dir)).toEqual(
      [
        "?? .claude/skills/launchset/SKILL.md",
        "?? .github/workflows/launchset-check.yml",
        "?? .github/workflows/launchset-preview.yml",
        "?? .github/workflows/launchset-release.yml",
        "?? .launchset/README.md",
        "?? AGENTS.md",
        "?? CHANGELOG.md",
        "?? launchset.config.ts",
        " M .github/workflows/docker.yml",
        " M deploy/k8s/api.yaml",
      ].sort(),
    );

    expect(
      read(dir, "launchset.config.ts"),
    ).toBe(`import { defineConfig } from "@demonsters/launchset";

// launchset configuration, written by \`launchset init\`.
// Options left out use their defaults: see the configuration reference in the launchset docs.
export default defineConfig({
  targets: {
    // Built from Dockerfile (context .).
    // Tags as .github/workflows/docker.yml pushes today.
    // The image files are deploy manifests the release PR updates.
    // verify: a re-run skips the build when the release tag is already pushed.
    docker: {
      type: "docker",
      image: "ghcr.io/demonsters/api",
      tags: ["v{version}", "latest"],
      verify: ["registry"],
      files: [
        { path: "deploy/k8s/api.yaml", kind: "image" },
      ],
    },
  },
});
`);
    const { config } = await loadConfig(dir);
    expect(config.targets.docker).toMatchObject({
      type: "docker",
      image: ["ghcr.io/demonsters/api"],
      tags: { release: ["v{version}", "latest"] },
      files: [{ path: "deploy/k8s/api.yaml", kind: "image" }],
    });
    expect(await checkConsistency(config, dir)).toEqual([]);

    // Only the trigger goes; workflow_dispatch and every other byte stay.
    expect(read(dir, ".github/workflows/docker.yml")).toBe(
      edit(
        fixture("docker-v", ".github/workflows/docker.yml"),
        '  push:\n    tags:\n      - "v*"\n',
        "",
      ),
    );
    // The pinned manifest that was decided "stamp" is aligned; the production one is left alone.
    expect(read(dir, "deploy/k8s/api.yaml")).toBe(
      edit(fixture("docker-v", "deploy/k8s/api.yaml"), "api:v1.3.0", "api:v1.4.0"),
    );
    expect(read(dir, "deploy/production/api.yaml")).toBe(
      fixture("docker-v", "deploy/production/api.yaml"),
    );

    expect(read(dir, ".launchset/README.md")).toBe(README());
    expect(read(dir, "CHANGELOG.md")).toBe("# Changelog\n");
    for (const name of ["check", "release", "preview"]) {
      const text = read(dir, `.github/workflows/launchset-${name}.yml`);
      expect(() => parseYaml(text)).not.toThrow();
      expect(text).toContain("demonsters/launchset-action@v1");
    }
    expect(read(dir, ".claude/skills/launchset/SKILL.md")).toBe(
      read(packageFile("skills", "launchset"), "SKILL.md"),
    );

    // No baseline tag for an unreleased version, with a warning.
    expect(git(dir, "tag")).toBe("v1.3.0");
    expect(out.warnings).toContain(
      "No baseline tag: nothing marks 1.4.0 as released, so launchset treats it as unreleased. If 1.4.0 was released, create v1.4.0 (--baseline).",
    );
    expect(result.changes.find((c) => c.path === ".github/workflows/docker.yml")).toEqual({
      path: ".github/workflows/docker.yml",
      action: "updated",
      summary:
        "disabled workflow trigger on.push.tags: v* (removes the push trigger (workflow_dispatch replaces it when no other trigger is left))",
    });
    expect(
      result.manualSteps.some(
        (s) => s.includes("LAUNCHSET_APP_ID") && s.includes("LAUNCHSET_APP_PRIVATE_KEY"),
      ),
    ).toBe(true);
    // The preview sweep is GitLab's: GitHub reacts to the label itself.
    expect(result.manualSteps.join("\n")).not.toContain("LAUNCHSET_PREVIEW_SWEEP");
    // The human-readable report lists every change.
    for (const c of result.changes) expect(out.logs.some((l) => l.includes(c.path))).toBe(true);
  });

  it("--baseline creates the release tag at HEAD and prints the push command", async () => {
    const dir = repo();
    const result = await runInit(options(dir, { yes: true, baseline: true }));
    expect(git(dir, "tag").split("\n")).toEqual(["v1.3.0", "v1.4.0"]);
    expect(git(dir, "rev-parse", "v1.4.0^{commit}")).toBe(git(dir, "rev-parse", "HEAD"));
    expect(result.changes).toContainEqual(
      expect.objectContaining({ path: "v1.4.0", action: "tagged" }),
    );
    expect(result.manualSteps).toContain("Push the baseline tag: `git push origin v1.4.0`.");
  });

  it("remove deletes the workflow; keep leaves it and says so", async () => {
    const removed = repo();
    await runInit(
      options(removed, {
        yes: true,
        decide: { "machinery..github/workflows/docker.yml#1": "remove" },
      }),
    );
    expect(existsSync(join(removed, ".github/workflows/docker.yml"))).toBe(false);

    const kept = repo();
    const out = collect();
    const result = await runInit(
      options(kept, {
        yes: true,
        decide: { "machinery..github/workflows/docker.yml#1": "keep" },
        output: out,
      }),
    );
    expect(read(kept, ".github/workflows/docker.yml")).toBe(
      fixture("docker-v", ".github/workflows/docker.yml"),
    );
    expect(
      out.warnings.some((w) => w.startsWith("machinery..github/workflows/docker.yml#1 is kept")),
    ).toBe(true);
    expect(
      result.manualSteps.some((s) =>
        s.startsWith("Still in place because you chose keep: workflow trigger on.push.tags: v*"),
      ),
    ).toBe(true);
  });

  it("refuses to run again once a config exists", async () => {
    const dir = repo();
    await runInit(options(dir, { yes: true }));
    await expect(runInit(options(dir, { yes: true }))).rejects.toThrow(
      "launchset.config.ts already exists, so init won't overwrite it.",
    );
  });
});

describe("init --yes: Changesets pipeline", () => {
  const repo = () =>
    fixtureRepo("changesets", { tags: ["@demonsters/widgets@0.9.3", "@demonsters/widgets@0.9.4"] });

  it("disables the Changesets step, the tag commands and scripts; converts changesets; baselines", async () => {
    const dir = repo();
    const out = collect();
    const result = await runInit(options(dir, { yes: true, output: out }));

    expect(read(dir, ".github/workflows/release.yml")).toBe(`name: Release

on:
  push:
    branches:
      - main

concurrency: \${{ github.workflow }}-\${{ github.ref }}

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - name: Tag
        if: steps.changesets.outputs.published == 'true'
        run: |
          echo "Published"
`);
    expect(read(dir, "package.json")).toBe(`{
  "name": "@demonsters/widgets",
  "version": "0.9.4",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "changeset": "changeset",
    "release": "pnpm build"
  },
  "devDependencies": {
    "@changesets/cli": "^2.27.0"
  }
}
`);
    // An existing changelog is never converted or moved.
    expect(read(dir, "CHANGELOG.md")).toBe(fixture("changesets", "CHANGELOG.md"));
    // Docs can't be edited automatically: left alone, listed as a manual step.
    expect(read(dir, "CLAUDE.md")).toBe(fixture("changesets", "CLAUDE.md"));
    expect(result.manualSteps).toContain(
      "Update the release instructions in CLAUDE.md:5 by hand: releases now go through launchset's release PR (no npm version, git tag or changeset commands).",
    );

    expect(read(dir, ".launchset/brave-lions-sing.md")).toBe(
      "---\nbump: minor\n---\n\nAdd a date picker widget.\n",
    );
    expect(read(dir, ".launchset/fair-trains-rush.md")).toBe(
      "---\nbump: patch\n---\n\nFix the button focus ring.\n",
    );
    expect(read(dir, ".changeset/brave-lions-sing.md")).toBe(
      fixture("changesets", ".changeset/brave-lions-sing.md"),
    );
    expect(out.warnings[0]).toContain(".changeset/pre.json (Changesets pre mode) is ignored");
    expect(result.manualSteps).toContain(
      "The .changeset/ folder is no longer used: you can delete it (config.json and README.md were left alone).",
    );

    // name@0.9.4 marks 0.9.4 as released: baseline v0.9.4 at HEAD.
    expect(git(dir, "tag", "--list", "v*")).toBe("v0.9.4");
    // The hook defaults to no.
    expect(read(dir, ".husky/pre-push")).toBe("pnpm test\n");

    const { config } = await loadConfig(dir);
    // changesets/action published the package: an npm target publishes it now.
    expect(Object.keys(config.targets)).toEqual(["npm"]);
    expect(config.targets.npm).toMatchObject({ type: "custom", verify: ["npm"] });
    expect(config.tags.release).toBe("v{version}");
  });

  it("remove deletes whole scripts and workflow files", async () => {
    const dir = repo();
    await runInit(
      options(dir, {
        yes: true,
        decide: {
          "machinery.package.json#2": "remove",
          "machinery..github/workflows/release.yml#1": "remove",
          baseline: "no",
        },
      }),
    );
    expect(existsSync(join(dir, ".github/workflows/release.yml"))).toBe(false);
    const pkg = JSON.parse(read(dir, "package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts).toEqual({ build: "tsc", test: "vitest run", changeset: "changeset" });
    expect(git(dir, "tag", "--list", "v*")).toBe("");
  });

  it("--hook adds launchset check --push to the husky pre-push hook", async () => {
    const dir = repo();
    await runInit(options(dir, { yes: true, hook: true }));
    expect(read(dir, ".husky/pre-push")).toBe(
      "pnpm test\nnpx @demonsters/launchset check --push\n",
    );
  });

  it("keeps a release tag format the repo already uses when decided", async () => {
    const dir = repo();
    await runInit(
      options(dir, { yes: true, decide: { "tags.release": "@demonsters/widgets@{version}" } }),
    );
    expect(
      read(dir, "launchset.config.ts"),
    ).toContain(`  // Release tags keep the format this repo already uses.
  tags: { release: "@demonsters/widgets@{version}" },
`);
    // The existing tag already is the release tag: no baseline needed.
    expect(git(dir, "tag", "--list", "v*")).toBe("");
    const { config } = await loadConfig(dir);
    expect(config.tags.release).toBe("@demonsters/widgets@{version}");
  });
});

describe("init --yes: Capacitor app with a version-sync script", () => {
  const repo = () =>
    fixtureRepo("capacitor-sync", {
      tags: ["v1.0.0", "v1.0.1"],
      remote: "https://github.com/acme/app.git",
    });

  it("raises every file to the highest version and stops the sync script without deleting it", async () => {
    const dir = repo();
    await runInit(options(dir, { yes: true }));

    expect(read(dir, "package.json")).toBe(`{
  "name": "app",
  "version": "1.0.2",
  "private": true,
  "scripts": {
    "build": "vite build",
    "ios:sync": "cap sync ios",
    "android:bundle": "cd android && ./gradlew bundleRelease"
  }
}
`);
    const pbx = fixture("capacitor-sync", "ios/App/App.xcodeproj/project.pbxproj");
    expect(read(dir, "ios/App/App.xcodeproj/project.pbxproj")).toBe(
      pbx.replaceAll("MARKETING_VERSION = 1.0.1;", "MARKETING_VERSION = 1.0.2;"),
    );
    // Already on 1.0.2; build numbers are never committed, so versionCode stays.
    expect(read(dir, "android/app/build.gradle")).toBe(
      fixture("capacitor-sync", "android/app/build.gradle"),
    );
    expect(read(dir, "scripts/sync-version.mjs")).toBe(
      fixture("capacitor-sync", "scripts/sync-version.mjs"),
    );

    expect(read(dir, ".github/workflows/docker.yml")).toBe(
      edit(
        fixture("capacitor-sync", ".github/workflows/docker.yml"),
        '  push:\n    tags: ["v[0-9]+.[0-9]+.[0-9]+"]\n',
        "  workflow_dispatch:\n",
      ),
    );
    expect(read(dir, ".github/workflows/ci.yml")).toBe(
      edit(
        fixture("capacitor-sync", ".github/workflows/ci.yml"),
        "          docker push ghcr.io/acme/app:latest\n",
        "",
      ),
    );
    // The k8s pin is deploy state by default.
    expect(read(dir, "deploy/k8s/app.yaml")).toBe(fixture("capacitor-sync", "deploy/k8s/app.yaml"));

    expect(
      read(dir, "launchset.config.ts"),
    ).toBe(`import { defineConfig } from "@demonsters/launchset";

// launchset configuration, written by \`launchset init\`.
// Options left out use their defaults: see the configuration reference in the launchset docs.
export default defineConfig({
  targets: {
    // Built from Dockerfile (context .).
    // Tags as .github/workflows/docker.yml pushes today.
    // verify: a re-run skips the build when the release tag is already pushed.
    docker: {
      type: "docker",
      image: "ghcr.io/acme/app",
      tags: ["{version}", "sha-{shortSha}", "latest"],
      verify: ["registry"],
    },
    // Shipped on demand: start the release workflow by hand with this target, or run \`launchset ship\`.
    android: {
      type: "android",
      source: { kind: "capacitor", dir: "." },
      release: "manual",
    },
    // Shipped on demand: start the release workflow by hand with this target, or run \`launchset ship\`.
    ios: {
      type: "ios",
      source: { kind: "capacitor", dir: "." },
      release: "manual",
    },
  },
});
`);
    const { config } = await loadConfig(dir);
    expect(await checkConsistency(config, dir)).toEqual([]);
  });

  it("lowers a version only when decided explicitly, with a warning", async () => {
    const dir = repo();
    const out = collect();
    await runInit(options(dir, { yes: true, decide: { version: "1.0.1" }, output: out }));
    expect(read(dir, "android/app/build.gradle")).toBe(
      edit(
        fixture("capacitor-sync", "android/app/build.gradle"),
        'versionName "1.0.2"',
        'versionName "1.0.1"',
      ),
    );
    expect(read(dir, "package.json")).toContain('"version": "1.0.1"');
    expect(out.warnings).toContain(
      "android/app/build.gradle:11 versionName goes down from 1.0.2 to 1.0.1 (decided explicitly).",
    );
    // v1.0.1 exists: no baseline needed and no warning about it.
    expect(out.warnings.some((w) => w.startsWith("No baseline tag"))).toBe(false);
  });

  it("remove deletes the sync script and the places that run it", async () => {
    const dir = repo();
    await runInit(
      options(dir, { yes: true, decide: { "machinery.scripts/sync-version.mjs#1": "remove" } }),
    );
    expect(existsSync(join(dir, "scripts/sync-version.mjs"))).toBe(false);
    expect(read(dir, "package.json")).toContain('"ios:sync": "cap sync ios"');
  });

  it("writes buildNumber.offset when existing build numbers beat the strategy", async () => {
    const dir = repo();
    await runInit(options(dir, { yes: true, now: new Date("2020-01-02T00:00:00Z") }));
    expect(
      read(dir, "launchset.config.ts"),
    ).toContain(`  // Existing build numbers go up to 1000199 (android/app/build.gradle:10); the offset keeps new ones above them.
  buildNumber: { offset: 920000 },
`);
    const { config } = await loadConfig(dir);
    expect(config.buildNumber.offset).toBe(920000);
  });
});

describe("init --yes: docker build run steps with expression build args", () => {
  it("writes the real context, the v tags and registry verify, and no hook", async () => {
    const dir = dockerRunRepo();
    await runInit(options(dir, { yes: true }));

    const config = read(dir, "launchset.config.ts");
    expect(config).toContain(`    // Built from apps/web/Dockerfile (context .).
    // Tags as .github/workflows/docker-image.yml pushes today.
    // verify: a re-run skips the build when the release tag is already pushed.
    "docker-web": {
      type: "docker",
      image: "ghcr.io/demonsters/zing/web",
      tags: ["v{version}"],
      verify: ["registry"],
    },
`);
    expect(config).not.toContain("}}");
    const { config: loaded } = await loadConfig(dir);
    expect(loaded.targets["docker-web"]).toMatchObject({
      tags: { release: ["v{version}"] },
      verify: ["registry"],
    });
    expect(loaded.targets.digests).toMatchObject({ verify: ["registry"] });

    for (const file of ["launchset-release.yml", "launchset-preview.yml"]) {
      const workflow = read(dir, `.github/workflows/${file}`);
      const builds = (
        parseYaml(workflow) as {
          jobs: Record<string, { steps?: { uses?: string; with?: Record<string, string> }[] }>;
        }
      ).jobs;
      const contexts = Object.values(builds)
        .flatMap((job) => job.steps ?? [])
        .filter((step) => step.uses?.startsWith("docker/build-push-action"))
        .map((step) => [step.with?.context, step.with?.file]);
      expect(contexts, file).toEqual([
        [".", "apps/digests/Dockerfile"],
        [".", "apps/web/Dockerfile"],
      ]);
    }

    // No hook was written into the gitignored .husky/, and none of the ignored files changed.
    expect(existsSync(join(dir, ".husky/pre-push"))).toBe(false);
    expect(status(dir).filter((line) => /\.husky|out\//.test(line))).toEqual([]);
  });

  it("leaves registry verify out when decided", async () => {
    const dir = dockerRunRepo();
    await runInit(options(dir, { yes: true, decide: { "docker.digests.verify": "no" } }));
    const { config } = await loadConfig(dir);
    expect(config.targets.digests?.verify).toEqual([]);
    expect(config.targets["docker-web"]?.verify).toEqual(["registry"]);
  });

  it("--hook finds no hook setup to add to", async () => {
    const dir = dockerRunRepo();
    await expect(runInit(options(dir, { yes: true, hook: true }))).rejects.toThrow(
      "--hook: no pre-push hook setup found",
    );
  });
});

describe("init --yes: workspace", () => {
  it("aligns workspace apps, adds the docker package.json, and adds the lefthook pre-push command", async () => {
    const dir = fixtureRepo("workspace");
    await runInit(
      options(dir, {
        yes: true,
        hook: true,
        decide: { "docker.api.image": "ghcr.io/demonsters/api" },
      }),
    );
    expect(read(dir, "lefthook.yml")).toBe(`pre-commit:
  commands:
    lint:
      run: pnpm lint
pre-push:
  commands:
    launchset:
      run: npx @demonsters/launchset check --push
`);
    expect(read(dir, "apps/expo-app/app.json")).toBe(
      edit(
        fixture("workspace", "apps/expo-app/app.json"),
        '"version": "1.9.0"',
        '"version": "2.1.0"',
      ),
    );
    const { config } = await loadConfig(dir);
    expect(Object.keys(config.targets)).toEqual([
      "api",
      "expo-app-android",
      "expo-app-ios",
      "mobile-android",
      "mobile-ios",
    ]);
    expect(config.targets.api?.files).toEqual([
      { path: "apps/api/package.json", kind: "json", key: "version" },
    ]);
    expect(await checkConsistency(config, dir)).toEqual([]);
  });

  it("creates a root package.json when there is none", async () => {
    const dir = fixtureRepo("workspace", { git: false });
    const { rmSync } = await import("node:fs");
    rmSync(join(dir, "package.json"));
    rmSync(join(dir, "pnpm-workspace.yaml"));
    await runInit(
      options(dir, { yes: true, decide: { "docker.api.image": "ghcr.io/demonsters/api" } }),
    );
    const pkg = JSON.parse(read(dir, "package.json")) as Record<string, unknown>;
    expect(pkg.version).toBe("2.1.0");
    expect(pkg.private).toBe(true);
    await loadConfig(dir);
  });
});

describe("init end to end: --detect --json, then --yes --decide", () => {
  it("answers the decisions an agent would ask about and gets a consistent repo", async () => {
    const dir = fixtureRepo("capacitor-sync", {
      tags: ["v1.0.0", "v1.0.1"],
      remote: "https://github.com/acme/app.git",
    });
    const detectOut = collect();
    await runInit(options(dir, { detect: true, json: true, output: detectOut }));
    const json = detectOut.jsons[0] as InitDetectJson;
    expect(status(dir)).toEqual([]);

    // The agent asks the human about the "ask" decisions; here the human picks these answers.
    const human: Record<string, string> = {
      "target.android": "auto",
      "target.ios": "manual",
      "image.deploy/k8s/app.yaml": "stamp",
      baseline: "no",
    };
    const decide: Record<string, string> = {};
    for (const d of json.decisions) if (d.ask) decide[d.id] = human[d.id] ?? d.default;
    expect(Object.keys(decide).sort()).toEqual(
      ["baseline", "image.deploy/k8s/app.yaml", "target.android", "target.ios", "version"].sort(),
    );

    const out = collect();
    const result = await runInit(options(dir, { yes: true, decide, output: out, json: true }));
    expect(out.logs).toEqual([]);
    expect(out.jsons[0]).toMatchObject({ answers: decide });
    expect(result.answers["machinery..github/workflows/docker.yml#1"]).toBe("disable");

    const { config } = await loadConfig(dir);
    expect(config.targets.android?.release).toBe("auto");
    expect(config.targets.ios?.release).toBe("manual");
    expect(config.targets.docker?.files).toEqual([{ path: "deploy/k8s/app.yaml", kind: "image" }]);
    expect(read(dir, "deploy/k8s/app.yaml")).toContain("image: ghcr.io/acme/app:1.0.2");
    expect(await checkConsistency(config, dir)).toEqual([]);
  });
});
