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
