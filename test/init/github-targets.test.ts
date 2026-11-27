/**
 * Custom targets from GitHub workflows that release tags start, and echo messages that only
 * mention a release command. Both found while adopting launchset in a game repo with a Docker
 * image and an Electron desktop build, each built by its own `v*` tag workflow.
 */

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "../../src/config/load.ts";
import { previewBuildTargets } from "../../src/core/config/schema.ts";
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
    // The preview workflow keeps its placeholder and copied steps: once it's added back to
    // preview.targets, its preview fails until the steps are in, instead of building nothing.
    const preview = read(dir, ".github/workflows/launchset-preview.yml");
    expect(preview).toContain("Build and push docker");
    expect(preview).toContain("- name: Build steps missing (desktop-linux)");
    expect(preview).toContain("#   run: pnpm desktop:linux");
    const { config } = await loadConfig(dir);
    expect([...previewBuildTargets(config)]).toEqual(["docker"]);
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

/** The desktop workflow with `run` as its build step (after `pnpm install`). */
const desktopRunning = (run: string, extra = "") =>
  DESKTOP.replace("      - run: pnpm desktop:linux\n", `${run}\n${extra}`);

/** The game repo with this desktop workflow and these extra files. */
function desktopRepo(workflow: string, files: Record<string, string> = {}): string {
  return repoFrom(
    {
      "package.json": `${JSON.stringify(
        {
          name: "game",
          version: "0.17.0",
          scripts: { "desktop:linux": "electron-builder --linux", dist: "electron-builder" },
          devDependencies: { "electron-builder": "^26.0.0" },
        },
        null,
        2,
      )}\n`,
      Dockerfile: "FROM nginx\n",
      ".github/workflows/desktop-linux.yml": workflow,
      ...files,
    },
    { tags: ["v0.17.0"], remote: "git@github.com:acme/game.git" },
  );
}

async function electronHint(dir: string): Promise<string | undefined> {
  const result = await runInit(options(dir, { yes: true }));
  return result.manualSteps.find((s) => s.includes("run electron-builder"));
}

describe("electron-builder: more ways to run it", () => {
  const desktopPackage = `${JSON.stringify({ name: "desktop", private: true, scripts: { dist: "cross-env NODE_ENV=production electron-builder --linux" } }, null, 2)}\n`;

  it("sees it behind env wrappers, a cd, a working-directory outside the workspaces, pnpm -w and npm start", async () => {
    const cases: [string, Record<string, string>, string][] = [
      [
        "      - run: npx cross-env CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --linux",
        {},
        "`electron-builder --linux`",
      ],
      [
        "      - run: dotenv -e .env.ci -- electron-builder --linux",
        {},
        "`electron-builder --linux`",
      ],
      [
        "      - run: cd desktop && pnpm dist",
        { "desktop/package.json": desktopPackage },
        "`pnpm dist -> electron-builder --linux`",
      ],
      [
        "      - run: pnpm run dist\n        working-directory: ./desktop",
        { "desktop/package.json": desktopPackage },
        "`pnpm run dist -> electron-builder --linux`",
      ],
      [
        "      - run: pnpm -w desktop:linux",
        {},
        "`pnpm -w desktop:linux -> electron-builder --linux`",
      ],
      [
        "      - run: npm start",
        {
          "package.json": `${JSON.stringify({ name: "game", version: "0.17.0", scripts: { start: "electron-builder" } }, null, 2)}\n`,
        },
        "`npm start -> electron-builder`",
      ],
    ];
    for (const [run, files, command] of cases) {
      const hint = await electronHint(desktopRepo(desktopRunning(run), files));
      expect(hint, run).toContain(command);
    }
  });

  it("stays quiet when a token is set on purpose or the config turns publishing off", async () => {
    const quiet = [
      `      - run: pnpm desktop:linux\n        env:\n          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}`,
      `      - run: GH_TOKEN=\${{ secrets.GITHUB_TOKEN }} pnpm desktop:linux`,
      "      - run: electron-builder --linux -c.publish=null",
      "      - run: pnpm desktop:linux -- --publish never",
    ];
    for (const run of quiet) {
      expect(await electronHint(desktopRepo(desktopRunning(run))), run).toBeUndefined();
    }
    // A job-level token too.
    const jobEnv = desktopRunning("      - run: pnpm desktop:linux").replace(
      "    runs-on: ubuntu-latest\n",
      `    runs-on: ubuntu-latest\n    env:\n      GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}\n`,
    );
    expect(await electronHint(desktopRepo(jobEnv))).toBeUndefined();
  });

  it("doesn't take other npm or bun commands for scripts", async () => {
    for (const run of ["      - run: npm install electron-builder", "      - run: bun install"]) {
      expect(await electronHint(desktopRepo(desktopRunning(run))), run).toBeUndefined();
    }
  });
});

describe("previews: kept files and nothing to preview", () => {
  it("reads a kept preview workflow: a target with steps there stays in previews", async () => {
    const kept = `name: Launchset preview
on: { pull_request: { types: [labeled] } }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Build desktop
        if: matrix.target == 'desktop-linux'
        run: pnpm desktop:linux
`;
    const dir = repoFrom(
      {
        "package.json": `${JSON.stringify({ name: "game", version: "0.17.0" }, null, 2)}\n`,
        Dockerfile: "FROM nginx\n",
        ".github/workflows/desktop-linux.yml": DESKTOP,
        ".github/workflows/docker-image.yml": DOCKER,
        ".github/workflows/launchset-preview.yml": kept,
      },
      { tags: ["v0.17.0"], remote: "git@github.com:acme/game.git" },
    );
    const result = await runInit(options(dir, { yes: true }));
    expect(read(dir, ".github/workflows/launchset-preview.yml")).toBe(kept);
    // docker isn't in the kept file either: nothing builds it there.
    expect(read(dir, "launchset.config.ts")).toContain('preview: { targets: ["desktop-linux"] },');
    expect(result.manualSteps.join("\n")).toContain(
      'Previews build only desktop-linux: docker has only the "build steps missing" placeholder',
    );
  });

  it("previews nothing yet when every target only has the placeholder", async () => {
    const dir = repoFrom(
      { "package.json": `${JSON.stringify({ name: "site", version: "1.0.0" }, null, 2)}\n` },
      { tags: ["v1.0.0"], remote: "git@github.com:acme/site.git" },
    );
    const result = await runInit(options(dir, { yes: true, decide: { "target.web": "auto" } }));
    expect(read(dir, "launchset.config.ts")).toContain("preview: { targets: [] },");
    const { config } = await loadConfig(dir);
    expect([...previewBuildTargets(config)]).toEqual([]);
    expect(result.manualSteps.join("\n")).toContain("Previews build no target yet: web has only");
    // The placeholder stays in the preview workflow for when it's added back.
    expect(read(dir, ".github/workflows/launchset-preview.yml")).toContain(
      "- name: Build steps missing (web)",
    );
  });
});

describe("baseline with a kept tag workflow", () => {
  it("says the kept workflow runs for the baseline tag too", async () => {
    const dir = repoFrom(
      {
        "package.json": `${JSON.stringify({ name: "game", version: "1.0.1" }, null, 2)}\n`,
        Dockerfile: "FROM nginx\n",
        ".github/workflows/docker-image.yml": DOCKER,
      },
      { tags: ["v1.0.0"], remote: "git@github.com:acme/game.git" },
    );
    const json = await detect(dir);
    const id = json.detection.machinery.find((m) => m.kinds.includes("tag-trigger"))?.id;
    expect(id).toBeDefined();
    const result = await runInit(
      options(dir, { yes: true, baseline: true, decide: { [id as string]: "keep" } }),
    );
    expect(result.manualSteps.find((s) => s.startsWith("After the merge"))).toContain(
      "You kept .github/workflows/docker-image.yml, which still runs on tags: it runs for v1.0.1 too when the release workflow creates it.",
    );
  });
});
