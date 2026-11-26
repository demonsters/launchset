/**
 * Messy real-world CI files: init must not take a mention for a command, must not retire work
 * without moving it somewhere, and must treat GitHub and GitLab alike. Each case comes from the
 * init heuristics review (after PR #13's echo and desktop-artifact fixes).
 */

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { type InitDetectJson, runInit } from "../../src/init/index.ts";
import {
  commandKinds,
  gitlabCommandKinds,
  publishCommand,
  scriptFileKinds,
} from "../../src/init/machinery.ts";
import { removeSegments } from "../../src/init/retire.ts";
import { runsFile, runsScript, simpleCommands, topLevelCommands } from "../../src/init/shell.ts";
import { options, read, repoFrom } from "./helpers.ts";

const GITHUB = "https://github.com/acme/app.git";
const GITLAB = "https://gitlab.com/acme/app.git";
const WF = ".github/workflows/";

const pkg = (extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ name: "app", version: "1.0.0", private: true, ...extra }, null, 2)}\n`;

function repo(files: Record<string, string>, remote = GITHUB): string {
  return repoFrom({ "package.json": pkg(), ...files }, { remote });
}

async function detect(dir: string): Promise<InitDetectJson> {
  return (await runInit(options(dir, { detect: true, json: true }))).detect as InitDetectJson;
}

function diff(dir: string): string {
  return execFileSync("git", ["diff", "--", ".github", ".gitlab-ci.yml", "package.json"], {
    cwd: dir,
    encoding: "utf8",
  });
}

const customTargets = (json: InitDetectJson) =>
  json.detection.targets.filter((t) => t.type === "custom").map((t) => t.name);

describe("shell commands: run, not mentioned", () => {
  it("reads only the commands a script runs", () => {
    expect(simpleCommands("make build  # then npx semantic-release").map((c) => c.text)).toEqual([
      "make build",
    ]);
    expect(
      simpleCommands("VERSION=$(git describe) sudo -E npx -y semantic-release").map((c) => c.text),
    ).toEqual(["git describe", "semantic-release"]);
    expect(simpleCommands("cat <<EOF\ngit tag -a v1\nEOF\necho done").map((c) => c.text)).toEqual([
      "cat <<EOF",
      "echo done",
    ]);
  });

  it("doesn't take a mention for a command", () => {
    for (const mention of [
      "pnpm build  # was: npx semantic-release --dry-run",
      `grep -q "git tag -a" RELEASING.md`,
      `gh pr comment "$PR" --body "Merged. Run 'npm version patch' to release."`,
      `gh issue comment 1 --body "run npm version patch"`,
      `logger "git tag -a v1"`,
      `tee -a log <<< "git push --tags"`,
      "npm uninstall semantic-release",
      "cat CHANGELOG.md | grep 'standard-version'",
      `echo -e "use git tag -a v1"`,
      `echo "version is \${VERSION}; run git tag -a"`,
      "npm version",
      "npm version --json",
      "npm version patch --git-tag-version=false",
      "git push --delete origin v1.2.3",
      "git push origin :refs/tags/v1.2.3",
    ]) {
      expect(commandKinds(mention), mention).toEqual([]);
    }
  });

  it("still finds real machinery, through runners and wrappers", () => {
    expect(commandKinds("pnpm dlx semantic-release")).toEqual(["release-tool"]);
    expect(commandKinds("bun x semantic-release")).toEqual(["release-tool"]);
    expect(commandKinds("corepack pnpm changeset version")).toEqual(["changesets"]);
    expect(commandKinds("./node_modules/.bin/semantic-release --ci")).toEqual(["release-tool"]);
    expect(commandKinds("if git tag -a v1 -m x; then echo ok; fi")).toEqual(["tag-creation"]);
    expect(commandKinds('printf "%s" "$(git tag -a v1 -m x)"')).toEqual(["tag-creation"]);
    expect(commandKinds("yarn version --new-version 1.2.3")).toEqual(["tag-creation"]);
    expect(commandKinds("git -C app push origin --follow-tags")).toEqual(["tag-creation"]);
    expect(commandKinds('/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $N" Info.plist')).toEqual(
      ["version-writer"],
    );
    expect(commandKinds("xcrun agvtool new-version -all 12")).toEqual(["version-writer"]);
    expect(publishCommand("bundle exec fastlane ios beta")).toBeDefined();
  });

  it("publishing: not dry runs, help or read-only release commands", () => {
    for (const no of [
      "# npm publish",
      "npm publish --dry-run",
      "npm publish --help",
      "gh release view v1",
      "gh release download v1",
      `echo "don't npm publish"`,
      "goreleaser build --snapshot",
    ]) {
      expect(publishCommand(no), no).toBeUndefined();
    }
    for (const yes of [
      "goreleaser release --clean",
      "uv build && uv publish",
      "helm push chart.tgz oci://example",
      "./scripts/deploy.sh production",
      "make deploy",
      "pnpm run release",
      "gh release upload v1 dist/*",
      "rsync -avz dist/ deploy@host:/srv/app",
    ]) {
      expect(publishCommand(yes), yes).toBeDefined();
    }
    expect(gitlabCommandKinds("npm publish --dry-run")).toEqual([]);
  });

  it("a script file runs when executed, not when mentioned", () => {
    expect(runsFile("./scripts/build.sh", "scripts/build.sh")).toBe(true);
    expect(runsFile("bash scripts/build.sh --fast", "scripts/build.sh")).toBe(true);
    expect(runsFile("uv run --locked --group g scripts/x.py", "scripts/x.py")).toBe(true);
    expect(runsFile("shellcheck scripts/build.sh", "scripts/build.sh")).toBe(false);
    expect(runsFile("cat scripts/build.sh", "scripts/build.sh")).toBe(false);
  });

  it("script files: comments, logs and reads aren't machinery", () => {
    const sh = "#!/bin/sh\n# Old flow: git tag -a v$V && git push --tags\npnpm build\n";
    expect(scriptFileKinds(sh, "scripts/build.sh").kinds).toEqual([]);
    const js = [
      'const fs = require("node:fs");',
      'const m = /versionName "(.*)"/.exec(fs.readFileSync("android/app/build.gradle", "utf8"));',
      'fs.writeFileSync("dist/info.json", "{}");',
      'console.log("versionName", m && m[1]);',
      "// execSync('git tag -a v1')",
    ].join("\n");
    expect(scriptFileKinds(js, "scripts/report.js").kinds).toEqual([]);
    expect(scriptFileKinds('execSync("git tag v" + version)\n', "scripts/tag.js").kinds).toEqual([
      "tag-creation",
    ]);
  });
});

describe("1. script files that do more than machinery keep running", () => {
  it("a comment doesn't stop a build script", async () => {
    const dir = repo({
      "scripts/build.sh":
        "#!/bin/sh\nset -e\n# Old flow: git tag -a v$VERSION && git push --tags\npnpm build\n",
      "package.json": pkg({ scripts: { build: "sh scripts/build.sh" } }),
      [`${WF}ci.yml`]:
        "on:\n  push:\n    branches: [main]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ./scripts/build.sh\n",
    });
    expect((await detect(dir)).detection.machinery.map((m) => m.path)).not.toContain(
      "scripts/build.sh",
    );
    await runInit(options(dir, { yes: true }));
    expect(diff(dir)).toBe("");
  });

  it("only the conflicting line goes from a script that also builds", async () => {
    const script = [
      "#!/bin/sh",
      "set -e",
      "pnpm build",
      'git tag -a "v$VERSION" -m "release"',
      "git push --follow-tags",
      "pnpm deploy:site",
      "",
    ].join("\n");
    const dir = repo({
      "scripts/ship.sh": script,
      "package.json": pkg({ scripts: { ship: "sh scripts/ship.sh" } }),
    });
    await runInit(options(dir, { yes: true }));
    expect(JSON.parse(read(dir, "package.json")).scripts.ship).toBe("sh scripts/ship.sh");
    expect(read(dir, "scripts/ship.sh")).toBe(
      [
        "#!/bin/sh",
        "set -e",
        "pnpm build",
        '# launchset: disabled — launchset\'s finalize creates tags and releases: git tag -a "v$VERSION" -m "release"',
        "# launchset: disabled — launchset's finalize creates tags and releases: git push --follow-tags",
        "pnpm deploy:site",
        "",
      ].join("\n"),
    );
  });

  it("a script that only reads and logs a version key keeps running", async () => {
    const dir = repo({
      "scripts/report.js": [
        'const fs = require("node:fs");',
        'const m = /versionName "(.*)"/.exec(fs.readFileSync("build.gradle", "utf8"));',
        'fs.writeFileSync("dist/build-info.json", "{}");',
        'console.log("versionName", m && m[1]);',
        "",
      ].join("\n"),
      "package.json": pkg({ scripts: { build: "vite build && node scripts/report.js" } }),
    });
    await runInit(options(dir, { yes: true }));
    expect(diff(dir)).toBe("");
  });
});

describe("2. mentions in workflow steps", () => {
  it("keeps steps that only mention release commands", async () => {
    const dir = repo({
      [`${WF}ci.yml`]: `on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: |
          pnpm install
          pnpm build   # was: npx semantic-release --dry-run
      - name: Docs mention the tag command
        run: grep -q "git tag -a" RELEASING.md
      - name: Print tool versions
        run: npm version
      - name: Notify
        run: |
          gh pr comment "$PR" --body "Merged. Run 'npm version patch' to release."
`,
    });
    expect((await detect(dir)).detection.machinery).toEqual([]);
    await runInit(options(dir, { yes: true }));
    expect(diff(dir)).toBe("");
  });
});

describe("3. GitLab tag rules are tested against launchset's tags", () => {
  it("leaves a job alone whose tag regex launchset's tags never match", async () => {
    const dir = repo(
      {
        ".gitlab-ci.yml": `stages: [test, deploy]
test:
  stage: test
  script:
    - npm test
helm-chart:
  stage: deploy
  rules:
    - if: $CI_COMMIT_TAG =~ /^helm-/
  script:
    - helm package chart && helm push chart-*.tgz oci://registry.example.com/charts
`,
      },
      GITLAB,
    );
    expect((await detect(dir)).detection.machinery).toEqual([]);
    await runInit(options(dir, { yes: true }));
    expect(read(dir, ".gitlab-ci.yml")).toContain("helm-chart:");
  });
});

describe("4. jobs retired triggers start become targets, whatever they output", () => {
  it("GitHub: goreleaser, a deploy script, an environment, uv publish", async () => {
    const dir = repo({
      [`${WF}release.yml`]: `on:
  push:
    tags: ["v*"]
jobs:
  go:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: goreleaser release --clean
  site:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v5
      - run: ./scripts/sync-site
  pypi:
    runs-on: ubuntu-latest
    steps:
      - run: uv build && uv publish
`,
    });
    expect(customTargets(await detect(dir))).toEqual([
      "release-go",
      "release-site",
      "release-pypi",
    ]);
  });

  it("GitHub: a job that calls a reusable workflow, with the called workflow's steps", async () => {
    const dir = repo({
      [`${WF}release.yml`]: `on:
  push:
    tags: ["v*"]
jobs:
  build:
    uses: ./.github/workflows/build-desktop.yml
    secrets: inherit
`,
      [`${WF}build-desktop.yml`]: `on: workflow_call
jobs:
  build:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v5
      - run: pnpm desktop:mac
`,
    });
    const json = await detect(dir);
    expect(customTargets(json)).toEqual(["release"]);
    await runInit(options(dir, { yes: true }));
    const release = read(dir, ".github/workflows/launchset-release.yml");
    expect(release).toContain("#   run: pnpm desktop:mac");
    expect(release).toContain("called the reusable workflow ./.github/workflows/build-desktop.yml");
  });

  it("GitHub: a release-only job that outputs nothing becomes a warning", async () => {
    const dir = repo({
      [`${WF}release.yml`]: `on:
  push:
    tags: ["v*"]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm test
  notify:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: slackapi/slack-github-action@v2
`,
    });
    const json = await detect(dir);
    expect(customTargets(json)).toEqual([]);
    expect(json.detection.notes.map((n) => n.message)).toEqual(
      expect.arrayContaining([expect.stringContaining('Job "test" runs on release tags')]),
    );
  });

  it("GitLab: a tag-only job with a deploy script becomes a target, not deleted", async () => {
    const dir = repo(
      {
        ".gitlab-ci.yml": `deploy-prod:
  rules:
    - if: $CI_COMMIT_TAG
  script:
    - ./scripts/sync-site production
`,
      },
      GITLAB,
    );
    expect(customTargets(await detect(dir))).toEqual(["prod"]);
  });
});

describe("5. GitHub: tag-gated jobs of a workflow that runs on every push", () => {
  it("become targets before the push trigger skips tags", async () => {
    const dir = repo({
      [`${WF}ci.yml`]: `name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
  publish:
    if: startsWith(github.ref, 'refs/tags/v')
    needs: test
    runs-on: ubuntu-latest
    steps:
      - run: npm publish
`,
    });
    const json = await detect(dir);
    expect(customTargets(json)).toEqual(["ci"]);
    expect(json.detection.targets.find((t) => t.name === "ci")?.reason).toContain(
      "its if: checks for a tag",
    );
  });
});

describe("5b. a tag-gated job that doesn't publish", () => {
  it("is a target, and the push trigger stops firing on tags (no double run)", async () => {
    const dir = repo({
      [`${WF}ci.yml`]: `on: push
jobs:
  site:
    if: github.ref_type == 'tag'
    runs-on: ubuntu-latest
    steps:
      - run: ./scripts/sync-site
`,
    });
    const json = await detect(dir);
    expect(customTargets(json)).toEqual(["ci"]);
    expect(json.detection.machinery.map((m) => m.kinds)).toEqual([["tag-trigger"]]);
    await runInit(options(dir, { yes: true }));
    expect(read(dir, ".github/workflows/ci.yml")).toContain('tags-ignore: ["**"]');
  });
});

describe("6. GitHub: the other jobs of a workflow that builds a Docker target", () => {
  it("still become targets", async () => {
    const dir = repo({
      Dockerfile: "FROM node:24\n",
      [`${WF}release.yml`]: `on:
  push:
    tags: ["v*"]
jobs:
  image:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: ghcr.io/acme/app:\${{ github.ref_name }}
  desktop:
    runs-on: macos-latest
    steps:
      - run: pnpm desktop:mac
      - uses: actions/upload-artifact@v4
        with:
          name: mac
          path: dist
`,
    });
    const json = await detect(dir);
    expect(json.detection.targets.map((t) => [t.name, t.type])).toEqual(
      expect.arrayContaining([
        ["docker", "docker"],
        ["release", "custom"],
      ]),
    );
    expect(json.detection.targets.find((t) => t.name === "release")?.github?.job).toBe("desktop");
  });
});

describe("7. retiring a release tool that publishes to npm", () => {
  it("proposes an npm target (semantic-release on main)", async () => {
    const dir = repoFrom(
      {
        "package.json": `${JSON.stringify({ name: "@acme/lib", version: "1.0.0" }, null, 2)}\n`,
        [`${WF}release.yml`]: `on:
  push:
    branches: [main]
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: npx semantic-release
`,
      },
      { remote: GITHUB },
    );
    const json = await detect(dir);
    expect(json.detection.targets.map((t) => [t.name, t.proposed])).toEqual([
      ["npm", "auto"],
      ["web", "none"],
    ]);
  });

  it("not for a plain npm publish init leaves alone, nor for a private package", async () => {
    const workflow = `on:
  push:
    branches: [main]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: npm publish
`;
    const pub = repoFrom(
      {
        "package.json": `${JSON.stringify({ name: "@acme/lib", version: "1.0.0" }, null, 2)}\n`,
        [`${WF}publish.yml`]: workflow,
      },
      { remote: GITHUB },
    );
    expect(customTargets(await detect(pub))).toEqual([]);
  });
});

describe("8. workflows that run after a retired one", () => {
  it("become targets", async () => {
    const dir = repo({
      [`${WF}release.yml`]: `name: Release
on:
  push:
    tags: ["v*"]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm build
      - uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist
`,
      [`${WF}deploy.yml`]: `on:
  workflow_run:
    workflows: [Release]
    types: [completed]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./scripts/deploy.sh
`,
    });
    const json = await detect(dir);
    expect(customTargets(json)).toEqual(["deploy", "release"]);
    expect(json.detection.targets.find((t) => t.name === "deploy")?.reason).toContain(
      "runs after Release",
    );
  });
});

describe("9. copied steps keep their own if and say what's missing", () => {
  it("ands a step's if with the target's, and notes matrix, env and defaults", async () => {
    const dir = repo({
      [`${WF}desktop.yml`]: `on:
  push:
    tags: ["v*"]
jobs:
  build:
    strategy:
      matrix:
        os: [macos-latest, windows-latest]
    runs-on: \${{ matrix.os }}
    env:
      APP_ENV: production
    defaults:
      run:
        working-directory: apps/desktop
    steps:
      - uses: actions/checkout@v5
      - run: pnpm build
      - if: runner.os == 'macOS'
        run: pnpm notarize
      - uses: actions/upload-artifact@v4
        with:
          name: desktop
          path: dist
`,
    });
    await runInit(options(dir, { yes: true }));
    const release = read(dir, ".github/workflows/launchset-release.yml");
    expect(() => parseYaml(release)).not.toThrow();
    expect(release).toContain(
      "# - if: matrix.target == 'desktop' && steps.verify.outputs.already-published != 'true' && (runner.os == 'macOS')",
    );
    expect(release).toContain("#   run: pnpm notarize");
    expect(release).toContain("That job set env `APP_ENV`");
    expect(release).toContain("`apps/desktop` (defaults.run.working-directory)");
    expect(release).toContain("That job ran a matrix (matrix.os)");
  });
});

describe("10. GitLab: a regex in only: that matches release tags", () => {
  it("is a tag rule, and the job becomes a target", async () => {
    const dir = repo(
      {
        ".gitlab-ci.yml": `publish:
  only:
    - /^v\\d+\\.\\d+\\.\\d+$/
  script:
    - npm publish
`,
      },
      GITLAB,
    );
    const json = await detect(dir);
    expect(json.detection.machinery.map((m) => m.kinds)).toEqual([
      ["tag-trigger", "package-publish"],
    ]);
    expect(customTargets(json)).toEqual(["publish"]);
  });
});

describe("11. package.json scripts are read as shell, not split at every &&", () => {
  const ci = (cmd: string) => `on:
  push:
    branches: [main]
jobs:
  ship:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: ${cmd}
`;
  const scripts = (s: Record<string, string>) => pkg({ scripts: s });
  const scriptsOf = (dir: string) =>
    (JSON.parse(read(dir, "package.json")) as { scripts?: Record<string, string> }).scripts;

  it("splits at top-level operators only", () => {
    expect(topLevelCommands("sh -c 'git tag v1 && git push --tags'")).toEqual({
      parts: ["sh -c 'git tag v1 && git push --tags'"],
      ops: [],
    });
    expect(topLevelCommands('tsc; semantic-release || echo "a && b" | tee log 2>&1')).toEqual({
      parts: ["tsc", "semantic-release", 'echo "a && b"', "tee log 2>&1"],
      ops: [";", "||", "|"],
    });
    expect(
      topLevelCommands("(cd app && git tag v1) && echo $(git describe && true)").parts,
    ).toEqual(["(cd app && git tag v1)", "echo $(git describe && true)"]);
    expect(removeSegments("tsc; semantic-release", ["semantic-release"])).toBe("tsc");
    expect(removeSegments("a && git tag v1; c", ["git tag v1"])).toBe("a; c");
    expect(removeSegments("a && git tag v1 && c", ["git tag v1"])).toBe("a && c");
  });

  it("a sh -c script stays whole, and goes when it only tags", async () => {
    const dir = repo({
      "package.json": scripts({
        build: "tsc",
        release: "sh -c 'git tag v$npm_package_version && git push --tags'",
      }),
    });
    await runInit(options(dir, { yes: true }));
    expect(scriptsOf(dir)).toEqual({ build: "tsc" });
  });

  it("keeps the build in `tsc; semantic-release`", async () => {
    const dir = repo({ "package.json": scripts({ release: "tsc; semantic-release" }) });
    await runInit(options(dir, { yes: true }));
    expect(scriptsOf(dir)).toEqual({ release: "tsc" });
  });

  it("leaves a script alone where no clean edit exists", async () => {
    const files = {
      "package.json": scripts({
        a: "pnpm build && git tag v1 || true",
        b: "sh -c 'pnpm build && git tag v1'",
        c: "(pnpm build && git tag v1)",
      }),
    };
    const json = await detect(repo(files));
    const items = json.detection.machinery.filter((m) => m.path === "package.json");
    expect(items).toHaveLength(3);
    for (const item of items) expect(item.actions).not.toContain("disable");
    const dir = repo(files);
    await runInit(options(dir, { yes: true }));
    expect(scriptsOf(dir)).toEqual({
      a: "pnpm build && git tag v1 || true",
      b: "sh -c 'pnpm build && git tag v1'",
      c: "(pnpm build && git tag v1)",
    });
  });

  it("finds scripts run by name", () => {
    expect(runsScript("npm run ship", "ship")).toBe(true);
    expect(runsScript("pnpm --filter app ship", "ship")).toBe(true);
    expect(runsScript("yarn ship --verbose", "ship")).toBe(true);
    expect(runsScript("npm -w app run-script ship", "ship")).toBe(true);
    expect(runsScript("npm ship", "ship")).toBe(false);
    expect(runsScript("npm test", "test")).toBe(true);
    expect(runsScript('echo "npm run ship"', "ship")).toBe(false);
  });

  it("lists what still runs a removed script by name", async () => {
    const dir = repo({
      "package.json": scripts({
        build: "tsc",
        ship: "semantic-release",
        release: "npm run build && npm run ship",
      }),
      [`${WF}release.yml`]: ci("npm run ship"),
    });
    const result = await runInit(options(dir, { yes: true }));
    expect(scriptsOf(dir)).toEqual({ build: "tsc", release: "npm run build && npm run ship" });
    const follow = result.manualSteps.filter((s) => s.includes('the script "ship"'));
    expect(follow).toEqual([
      expect.stringMatching(/^package\.json:\d+: the script "release" runs the script "ship"/),
      expect.stringMatching(/^\.github\/workflows\/release\.yml:9: step 2 in job "ship" runs/),
    ]);
  });

  it("also when the removed script ran a release script file", async () => {
    const dir = repo({
      "package.json": scripts({ release: "node scripts/release.mjs" }),
      "scripts/release.mjs":
        'import { execSync } from "node:child_process";\nexecSync("git push --tags");\n',
      [`${WF}release.yml`]: ci("npm run release"),
    });
    const result = await runInit(options(dir, { yes: true }));
    expect(scriptsOf(dir)).toEqual({});
    expect(result.manualSteps).toContainEqual(
      expect.stringMatching(
        /^\.github\/workflows\/release\.yml:9: step 2 in job "ship" runs the script "release"/,
      ),
    );
  });
});

describe("12. commands run through sh -c and fastlane run", () => {
  it("reads the script of sh -c", () => {
    expect(commandKinds('bash -c "git tag v1 && git push --tags"')).toEqual(["tag-creation"]);
    expect(commandKinds("sh -ec 'npx semantic-release'")).toEqual(["release-tool"]);
    expect(commandKinds("bash -e -o pipefail -c 'pnpm build\ngit tag v1'")).toEqual([
      "tag-creation",
    ]);
    expect(commandKinds("bash -c 'echo \"git tag v1\"'")).toEqual([]);
    expect(commandKinds("bash scripts/tag.sh")).toEqual([]);
    expect(runsFile('bash -c "./scripts/build.sh --fast"', "scripts/build.sh")).toBe(true);
  });

  it("finds a workflow step that tags through bash -c", async () => {
    const dir = repo({
      [`${WF}tag.yml`]: `on:
  push:
    branches: [main]
jobs:
  tag:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: bash -c "git tag v1 && git push --tags"
`,
    });
    expect((await detect(dir)).detection.machinery.map((m) => m.kinds)).toEqual([["tag-creation"]]);
  });

  it("fastlane's version actions from the command line", () => {
    expect(commandKinds("bundle exec fastlane run increment_build_number")).toEqual([
      "version-writer",
    ]);
    expect(commandKinds("fastlane run set_info_plist_value key:CFBundleVersion value:3")).toEqual([
      "version-writer",
    ]);
    expect(
      commandKinds("fastlane run increment_build_number build_number:$LAUNCHSET_BUILD_NUMBER"),
    ).toEqual([]);
    expect(commandKinds("fastlane run upload_to_testflight")).toEqual([]);
  });
});

describe("13. each step's shell decides how init edits it", () => {
  const job = (head: string, run: string, extra = "") => `on:
  push:
    branches: [main]
${extra}jobs:
  build:
${head}    steps:
      - uses: actions/checkout@v7
      - run: |
${run
  .split("\n")
  .map((l) => `          ${l}`)
  .join("\n")}
`;
  const inBlock = "pnpm build\nif ($env:CI) {\n  git tag v1\n}";

  it("Windows runners run pwsh: a no-op is $null, not :", async () => {
    const dir = repo({ [`${WF}ci.yml`]: job("    runs-on: windows-latest\n", inBlock) });
    await runInit(options(dir, { yes: true }));
    const text = read(dir, `${WF}ci.yml`);
    expect(text).toContain("            $null # launchset: disabled — ");
    expect(text).not.toMatch(/^\s*: # launchset/m);
  });

  it("defaults.run.shell: bash wins over the runner", async () => {
    const dir = repo({
      [`${WF}ci.yml`]: job(
        "    runs-on: windows-latest\n    defaults:\n      run:\n        shell: bash\n",
        'pnpm build\nif [ -n "$CI" ]; then\n  git tag v1\nfi',
      ),
    });
    await runInit(options(dir, { yes: true }));
    expect(read(dir, `${WF}ci.yml`)).toContain("            : # launchset: disabled — ");
  });

  it("a matrix of Windows and Linux gets no no-op, only whole lines", async () => {
    const head = `    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
    runs-on: \${{ matrix.os }}
`;
    const chained = repo({ [`${WF}ci.yml`]: job(head, "pnpm build &&\n  git tag v1") });
    const json = await detect(chained);
    expect(json.detection.machinery[0]?.actions).not.toContain("disable");
    const lines = repo({ [`${WF}ci.yml`]: job(head, "pnpm build\ngit tag v1") });
    await runInit(options(lines, { yes: true }));
    expect(read(lines, `${WF}ci.yml`)).not.toContain("git tag v1");
    expect(read(lines, `${WF}ci.yml`)).toContain("pnpm build");
  });

  it("a PowerShell line continuation keeps init's hands off", async () => {
    const dir = repo({
      [`${WF}ci.yml`]: job("    runs-on: windows-latest\n", "pnpm build\ngit tag `\n  v1"),
    });
    expect((await detect(dir)).detection.machinery[0]?.actions).not.toContain("disable");
  });

  it("shell: python is read like a script file, and not edited", async () => {
    const dir = repo({
      [`${WF}ci.yml`]: `on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - shell: python
        run: |
          import subprocess
          subprocess.run(["make", "dist"], check=True)
          subprocess.run("git tag v1 && git push --tags", shell=True, check=True)
`,
    });
    const [item] = (await detect(dir)).detection.machinery;
    expect(item?.kinds).toEqual(["tag-creation"]);
    expect(item?.actions).not.toContain("disable");
    expect(item?.evidence.some((e) => e.line === 12)).toBe(true);
  });

  it("GitLab: a job on Windows runners gets $null too", async () => {
    const dir = repo(
      {
        ".gitlab-ci.yml": `build:
  tags: [windows]
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
  script:
    - |
      pnpm build
      if ($env:CI) {
        git tag v1
      }
`,
      },
      GITLAB,
    );
    await runInit(options(dir, { yes: true }));
    const text = read(dir, ".gitlab-ci.yml");
    expect(text).toContain("        $null # launchset: disabled — ");
    expect(text).toContain("pnpm build");
  });
});

describe("14. review findings on scripts, runners and directories", () => {
  const scriptsOf = (dir: string) =>
    (JSON.parse(read(dir, "package.json")) as { scripts?: Record<string, string> }).scripts;

  it("keeps the operators between the commands that stay", () => {
    expect(
      removeSegments("npm version patch && npm test || npm run recover", ["npm version patch"]),
    ).toBe("npm test || npm run recover");
    expect(removeSegments("a | b && git tag v1 && c", ["git tag v1"])).toBe("a | b && c");
  });

  it("doesn't cut an if, a loop or a case apart", async () => {
    for (const script of [
      "if npm test; then git tag v1; fi; npm run deploy",
      "for t in a b; do git tag $t; done; npm run deploy",
      "case $X in a) git tag v1;; esac; npm run deploy",
    ]) {
      expect(topLevelCommands(script).parts, script).toHaveLength(2);
    }
    const dir = repo({
      "package.json": pkg({
        scripts: { ship: "if npm test; then git tag v1; fi; npm run deploy" },
      }),
    });
    const [item] = (await detect(dir)).detection.machinery;
    expect(item?.actions).not.toContain("disable");
    await runInit(options(dir, { yes: true }));
    expect(scriptsOf(dir)).toEqual({ ship: "if npm test; then git tag v1; fi; npm run deploy" });
  });

  it("a release script file run next to a deploy in one sh -c stays", async () => {
    const dir = repo({
      "package.json": pkg({ scripts: { ship: "sh -c 'bash scripts/tag.sh && npm run deploy'" } }),
      "scripts/tag.sh": "#!/bin/sh\ngit tag v1\ngit push --tags\n",
    });
    const item = (await detect(dir)).detection.machinery.find((m) => m.path === "scripts/tag.sh");
    expect(item?.actions).not.toContain("disable");
    await runInit(options(dir, { yes: true }));
    expect(scriptsOf(dir)).toEqual({ ship: "sh -c 'bash scripts/tag.sh && npm run deploy'" });
  });

  it("a runs-on input may be Windows: no no-op", async () => {
    const dir = repo({
      [`${WF}ci.yml`]: `on:
  workflow_dispatch:
    inputs:
      runner: { type: string }
  push:
    branches: [main]
jobs:
  build:
    runs-on: \${{ inputs.runner }}
    steps:
      - run: |
          pnpm build
          if ($env:CI) {
            git tag v1
          }
`,
    });
    expect((await detect(dir)).detection.machinery[0]?.actions).not.toContain("disable");
  });

  it("finds callers in defaults.run.working-directory", async () => {
    const dir = repo({
      "package.json": pkg({ workspaces: ["packages/*"] }),
      "packages/app/package.json": pkg({ scripts: { ship: "semantic-release" } }),
      [`${WF}ci.yml`]: `on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: packages/app
    steps:
      - run: npm run ship
`,
    });
    const result = await runInit(options(dir, { yes: true }));
    expect(result.manualSteps).toContainEqual(
      expect.stringMatching(/^\.github\/workflows\/ci\.yml:11: .* runs the script "ship"/),
    );
  });

  it("fastlane's marketing version key counts", () => {
    expect(
      commandKinds("fastlane run set_info_plist_value key:CFBundleShortVersionString value:1.2.3"),
    ).toEqual(["version-writer"]);
  });
});
