/**
 * Custom targets from GitHub workflows that release tags start, and echo messages that only
 * mention a release command. Both found while adopting launchset in a game repo with a Docker
 * image and an Electron desktop build, each built by its own `v*` tag workflow.
 */

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { type InitDetectJson, runInit } from "../../src/init/index.ts";
import { options, read, repoFrom } from "./helpers.ts";

const DESKTOP = `name: Desktop (Linux)

on:
  push:
    tags:
      - 'v[0-9]+.[0-9]+.[0-9]+'
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          lfs: true

      - run: pnpm install --frozen-lockfile

      - run: pnpm desktop:linux

      - uses: actions/upload-artifact@v7
        with:
          name: app-linux
          path: |
            release/*.AppImage
          if-no-files-found: error
`;

const DOCKER = `name: Docker image

on:
  push:
    tags:
      - 'v[0-9]+.[0-9]+.[0-9]+'
  workflow_dispatch:

permissions:
  contents: read
  packages: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0

      - name: Check the tag is annotated and on main
        if: github.event_name == 'push'
        run: |
          tag="\${GITHUB_REF_NAME}"
          git fetch --force origin "refs/tags/\${tag}:refs/tags/\${tag}"
          if [ "$(git cat-file -t "refs/tags/\${tag}")" != "tag" ]; then
            echo "::error::\${tag} is a lightweight tag; create it with 'git tag -a'."
            exit 1
          fi

      - uses: docker/build-push-action@v7
        with:
          context: .
          push: true
          tags: ghcr.io/acme/game:latest
`;

const CI = `name: CI
on:
  push:
    branches: [main]
    tags: ['v*']
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: pnpm test
`;

function repo(): string {
  return repoFrom(
    {
      "package.json": `${JSON.stringify({ name: "game", version: "0.17.0" }, null, 2)}\n`,
      Dockerfile: "FROM nginx\n",
      ".github/workflows/desktop-linux.yml": DESKTOP,
      ".github/workflows/docker-image.yml": DOCKER,
      ".github/workflows/ci.yml": CI,
    },
    { tags: ["v0.17.0"], remote: "git@github.com:acme/game.git" },
  );
}

async function detect(dir: string): Promise<InitDetectJson> {
  const result = await runInit(options(dir, { detect: true, json: true }));
  return result.detect as InitDetectJson;
}

describe("custom targets from release-tag workflows", () => {
  it("proposes one for a tag job that uploads an artifact, not for Docker or tests", async () => {
    const json = await detect(repo());
    const custom = json.detection.targets.filter((t) => t.type === "custom");
    expect(custom.map((t) => [t.name, t.proposed, t.ask])).toEqual([
      ["desktop-linux", "auto", true],
    ]);
    expect(custom[0]?.builtBy).toEqual([
      {
        path: ".github/workflows/desktop-linux.yml",
        line: 10,
        note: 'job "build" runs on release tags and uploads an artifact',
      },
    ]);
    expect(json.decisions.find((d) => d.id === "target.desktop-linux")).toMatchObject({
      default: "auto",
      ask: true,
    });
  });

  it("doesn't take an echoed `git tag -a` for a tag command", async () => {
    const json = await detect(repo());
    const docker = json.detection.machinery.filter(
      (m) => m.path === ".github/workflows/docker-image.yml",
    );
    expect(docker.map((m) => m.kinds)).toEqual([["tag-trigger"]]);
  });

  it("copies the job's steps, commented out, into the release workflow", async () => {
    const dir = repo();
    await runInit(options(dir, { yes: true }));
    const release = read(dir, ".github/workflows/launchset-release.yml");
    expect(() => parseYaml(release)).not.toThrow();
    const lines = release.split("\n").map((l) => l.trim());
    const at = lines.indexOf("- name: Build steps missing (desktop-linux)");
    expect(at).toBeGreaterThan(0);
    const section = lines.slice(at, at + 40).join("\n");
    expect(section).toContain(
      '# The steps of job "build" in .github/workflows/desktop-linux.yml, which ran on release tags.',
    );
    expect(section).toContain("# That job checked out with `lfs: true`");
    expect(section).toContain("# - if: matrix.target == 'desktop-linux'");
    expect(section).toContain("#   run: pnpm desktop:linux");
    expect(section).toContain("#   uses: actions/upload-artifact@v7");
    expect(section).not.toContain("actions/checkout");
    expect(read(dir, "launchset.config.ts")).toContain('"desktop-linux": {');
    // The tag trigger is gone; the workflow can still be run by hand.
    const desktop = read(dir, ".github/workflows/desktop-linux.yml");
    expect(desktop).not.toContain("tags:");
    expect(desktop).toContain("workflow_dispatch:");
  });
});

/** The game repo with an electron-builder script, as in mascot-mayhem. */
function electronRepo(script = "electron-builder --linux --x64"): string {
  return repoFrom(
    {
      "package.json": `${JSON.stringify(
        {
          name: "game",
          version: "0.17.0",
          scripts: { "desktop:linux": script },
          devDependencies: { "electron-builder": "^26.0.0" },
        },
        null,
        2,
      )}\n`,
      Dockerfile: "FROM nginx\n",
      ".github/workflows/desktop-linux.yml": DESKTOP,
      ".github/workflows/docker-image.yml": DOCKER,
    },
    { tags: ["v0.17.0"], remote: "git@github.com:acme/game.git" },
  );
}

describe("electron-builder in a copied job", () => {
  it("says to pass --publish never, in the copied steps and in what's left to do", async () => {
    const dir = electronRepo();
    const result = await runInit(options(dir, { yes: true }));
    const release = read(dir, ".github/workflows/launchset-release.yml");
    expect(release).toContain(
      "# Its step 3 (.github/workflows/desktop-linux.yml:19) runs electron-builder (`pnpm desktop:linux -> electron-builder --linux --x64`).",
    );
    expect(release).toContain("pass `--publish never` (launchset creates the GitHub Release)");
    expect(result.manualSteps).toContain(
      'desktop-linux: the steps init copied from job "build" run electron-builder (.github/workflows/desktop-linux.yml:19: `pnpm desktop:linux -> electron-builder --linux --x64`). In CI electron-builder publishes to GitHub Releases by itself, also on the branch pushes launchset builds releases from, and fails with "GitHub Personal Access Token is not set" without GH_TOKEN. Pass --publish never to it (launchset creates the GitHub Release), or set GH_TOKEN on purpose if electron-builder should upload the files.',
    );
  });

  it("stays quiet when the command already chooses whether to publish", async () => {
    for (const script of [
      "electron-builder --linux --x64 --publish never",
      "electron-builder -p always --linux",
      "tsc && electron-builder --publish=onTag",
    ]) {
      const dir = electronRepo(script);
      const result = await runInit(options(dir, { yes: true }));
      expect(read(dir, ".github/workflows/launchset-release.yml"), script).not.toContain(
        "runs electron-builder",
      );
      expect(result.manualSteps.join("\n"), script).not.toContain("electron-builder");
    }
  });

  it("follows scripts that call other scripts, and ignores a script that doesn't run it", async () => {
    const chained = electronRepo("pnpm run build && pnpm exec electron-builder --linux");
    const r1 = await runInit(options(chained, { yes: true }));
    expect(r1.manualSteps.join("\n")).toContain("`pnpm desktop:linux -> electron-builder --linux`");
    const other = electronRepo("vite build");
    const r2 = await runInit(options(other, { yes: true }));
    expect(r2.manualSteps.join("\n")).not.toContain("electron-builder");
  });
});

describe("previews of a repo with a copied job", () => {
  it("leave the target with only the placeholder out of preview.targets, and ask for the label", async () => {
    const dir = repo();
    const result = await runInit(options(dir, { yes: true }));
    expect(
      read(dir, "launchset.config.ts"),
    ).toContain(`  // Previews build only the targets with build steps. desktop-linux has only the "build
  // steps missing" placeholder in launchset-release.yml and launchset-preview.yml, which
  // fails on purpose: add it here once its build steps are in (or set targets: "all").
  preview: { targets: ["docker"] },
`);
    // The preview workflow doesn't build it, so the placeholder can't fail a preview.
    const preview = read(dir, ".github/workflows/launchset-preview.yml");
    expect(preview).toContain("Build and push docker");
    expect(preview).not.toContain("Build steps missing (desktop-linux)");
    expect(result.manualSteps).toContain(
      'Previews build only docker: desktop-linux has only the "build steps missing" placeholder, which fails on purpose. Add it to preview.targets in launchset.config.ts once its build steps are in.',
    );
    expect(result.manualSteps).toContain(
      'Create the launchset:preview label if the repo doesn\'t have it (adding it to a PR builds a preview): `gh label create launchset:preview --description "Build a launchset preview"`.',
    );
  });
});

describe("baseline in a repo with tag-triggered workflows", () => {
  it("names the workflows a hand-pushed tag on HEAD would start", async () => {
    const dir = repo();
    const result = await runInit(options(dir, { yes: true, decide: { version: "0.17.0" } }));
    // v0.17.0 exists: no baseline.
    expect(read(dir, "launchset.config.ts")).not.toContain("baseline");

    const unreleased = repoFrom(
      {
        "package.json": `${JSON.stringify({ name: "game", version: "1.0.1" }, null, 2)}\n`,
        Dockerfile: "FROM nginx\n",
        ".github/workflows/desktop-linux.yml": DESKTOP,
        ".github/workflows/docker-image.yml": DOCKER,
      },
      { tags: ["v1.0.0"], remote: "git@github.com:acme/game.git" },
    );
    const r = await runInit(options(unreleased, { yes: true, baseline: true }));
    expect(r.manualSteps.find((s) => s.startsWith("After the merge"))).toBe(
      'After the merge, the first release workflow run on the base branch creates v1.0.1 at the merge commit (baseline: "1.0.1" in launchset.config.ts), so 1.0.1 counts as released without a build. Don\'t create or push v1.0.1 yourself: pushing a tag runs the workflows of the commit it points to, and on HEAD that would start .github/workflows/desktop-linux.yml, .github/workflows/docker-image.yml (they still run on tags there), which would build or publish 1.0.1 again. Once v1.0.1 exists you can remove baseline from the config.',
    );
    expect(result.manualSteps.some((s) => s.startsWith("After the merge"))).toBe(false);
  });
});
