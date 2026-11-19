/**
 * `launchset init` on GitLab (design/GITLAB.md phase 5): the host decision, the edits to an
 * existing `.gitlab-ci.yml` (include, stage), GitLab release machinery and its retirement, and
 * init end to end on the gitlab-docker and gitlab-fresh fixtures.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { Plan } from "../../src/core/types.ts";
import { guessHost } from "../../src/init/detect.ts";
import {
  addLocalInclude,
  appendBlock,
  missingTargetJobs,
  pickStage,
  workflowBlock,
} from "../../src/init/gitlab-edit.ts";
import {
  gitlabCiOf,
  gitlabDockerBuilds,
  runsOnBranchPush,
  runsOnTags,
} from "../../src/init/gitlab-scan.ts";
import { type InitDetectJson, runInit } from "../../src/init/index.ts";
import { detectMachinery, gitlabCommandKinds } from "../../src/init/machinery.ts";
import { applyRetirement } from "../../src/init/retire.ts";
import { checkTargetsFile, renderChildPipeline } from "../../src/templates/gitlab-child.ts";
import { GitLabReference, parseGitLabYaml } from "../../src/templates/gitlab-yaml.ts";
import { collect, fixtureRepo, options, read, repoFrom, status } from "./helpers.ts";

const tempDir = (files: Record<string, string>) => repoFrom(files, { git: false });

const GITLAB_REMOTE = "git@gitlab.com:acme/shop-api.git";
const LOCAL = ".gitlab/launchset.yml";

function machinery(text: string, extra: { path: string; text: string }[] = []) {
  const gitlabCi = gitlabCiOf([{ path: ".gitlab-ci.yml", text }, ...extra]);
  return detectMachinery({
    workflows: [],
    dockerBuilds: [],
    packages: [],
    scriptFiles: [],
    fastfiles: [],
    docs: [],
    gitlabCi,
  });
}

async function disableAll(files: Record<string, string>) {
  const [root, ...rest] = Object.entries(files);
  const findings = machinery(
    root?.[1] ?? "",
    rest.map(([path, text]) => ({ path, text })),
  );
  const dir = tempDir(files);
  await applyRetirement(
    dir,
    findings
      .filter((f) => f.item.actions.includes("disable"))
      .map((finding) => ({ finding, action: "disable" as const })),
  );
  return { findings, dir, read: (path: string) => readFileSync(join(dir, path), "utf8") };
}

async function detectJson(dir: string): Promise<InitDetectJson> {
  const out = collect();
  const result = await runInit(options(dir, { detect: true, json: true, output: out }));
  return result.detect as InitDetectJson;
}

// ---------------------------------------------------------------------------

describe("host detection", () => {
  const none = { env: {}, gitlabCi: false, githubWorkflows: false };

  it("reads the origin remote first, then the CI files", () => {
    expect(guessHost({ ...none, remoteUrl: GITLAB_REMOTE })).toMatchObject({
      host: "gitlab",
      ask: false,
      gitlabSignals: true,
      remoteHost: "gitlab.com",
      gitlabProject: "acme/shop-api",
    });
    expect(
      guessHost({ ...none, remoteUrl: "https://gitlab.acme.dev/group/sub/app.git" }),
    ).toMatchObject({ host: "gitlab", gitlabProject: "group/sub/app" });
    expect(guessHost({ ...none, remoteUrl: "git@github.com:acme/app.git" })).toMatchObject({
      host: "github",
      gitlabSignals: false,
    });
    expect(guessHost({ ...none, gitlabCi: true })).toMatchObject({ host: "gitlab", ask: false });
    expect(guessHost({ ...none, githubWorkflows: true })).toMatchObject({
      host: "github",
      gitlabSignals: false,
    });
    expect(guessHost(none)).toMatchObject({ host: "github", ask: false, gitlabSignals: false });
  });

  it("asks when the signals disagree", () => {
    expect(guessHost({ ...none, gitlabCi: true, githubWorkflows: true })).toMatchObject({
      host: "github",
      ask: true,
      gitlabSignals: true,
    });
    expect(guessHost({ ...none, remoteUrl: GITLAB_REMOTE, githubWorkflows: true })).toMatchObject({
      host: "gitlab",
      ask: true,
    });
    expect(
      guessHost({ ...none, remoteUrl: "git@github.com:a/b.git", gitlabCi: true }),
    ).toMatchObject({ host: "github", ask: true });
  });

  it("follows GITLAB_CI and LAUNCHSET_HOST", () => {
    expect(guessHost({ ...none, env: { GITLAB_CI: "true" } })).toMatchObject({
      host: "gitlab",
      evidence: [{ path: "GITLAB_CI", note: "GITLAB_CI=true: init runs in GitLab CI" }],
    });
    expect(
      guessHost({ ...none, env: { LAUNCHSET_HOST: "github", GITLAB_CI: "true" } }),
    ).toMatchObject({ host: "github" });
  });

  it("shows the host decision only when something points at GitLab", async () => {
    const github = await detectJson(repoFrom({ "package.json": '{"name":"a","version":"1.0.0"}' }));
    expect(github.decisions.map((d) => d.id)).not.toContain("host");
    const gitlab = await detectJson(
      repoFrom({ "package.json": '{"name":"a","version":"1.0.0"}' }, { remote: GITLAB_REMOTE }),
    );
    expect(gitlab.decisions[0]).toMatchObject({
      id: "host",
      default: "gitlab",
      evidence: [{ path: "origin", note: "the origin remote is on gitlab.com" }],
    });
    expect(gitlab.detection.git.gitlab).toBe("acme/shop-api");
  });
});

describe("include edit", () => {
  const add = (text: string) => {
    const r = addLocalInclude(text, LOCAL);
    if ("error" in r) throw new Error(r.error);
    // Idempotent: a second run changes nothing.
    const again = addLocalInclude(r.text, LOCAL);
    expect(again).toEqual({ text: r.text, changed: false });
    return r.text;
  };

  it("appends to a block list, keeping comments", () => {
    expect(
      add(
        "include:\n  # shared\n  - local: ci/a.yml   # a\n  - ci/b.yml\n\ntest:\n  script: [x]\n",
      ),
    ).toBe(
      `include:\n  # shared\n  - local: ci/a.yml   # a\n  - ci/b.yml\n  - local: ${LOCAL}\n\ntest:\n  script: [x]\n`,
    );
    expect(add("include:\n- a.yml\n")).toBe(`include:\n- a.yml\n- local: ${LOCAL}\n`);
  });

  it("appends to a flow list", () => {
    expect(add("include: [a.yml, { local: b.yml }]\n")).toBe(
      `include: [a.yml, { local: b.yml }, { local: ${LOCAL} }]\n`,
    );
    expect(add("include: []\n")).toBe(`include: [{ local: ${LOCAL} }]\n`);
  });

  it("turns a single string into a list", () => {
    expect(add("include: 'ci/a.yml' # shared\nb:\n  script: x\n")).toBe(
      `include:\n  - 'ci/a.yml' # shared\n  - local: ${LOCAL}\nb:\n  script: x\n`,
    );
  });

  it("turns a single map into a list", () => {
    expect(add("include:\n  local: ci/a.yml\n  rules:\n    - if: $X\nb:\n  script: x\n")).toBe(
      `include:\n  - local: ci/a.yml\n    rules:\n      - if: $X\n  - local: ${LOCAL}\nb:\n  script: x\n`,
    );
    expect(add("include: { local: ci/a.yml }\n")).toBe(
      `include: [{ local: ci/a.yml }, { local: ${LOCAL} }]\n`,
    );
  });

  it("adds an include block when there is none, or fills an empty one", () => {
    expect(add("test:\n  script: x\n")).toBe(
      `test:\n  script: x\n\ninclude:\n  - local: ${LOCAL}\n`,
    );
    expect(add("test:\n  script: x")).toBe(`test:\n  script: x\n\ninclude:\n  - local: ${LOCAL}\n`);
    expect(add("include:\nb:\n  script: x\n")).toBe(
      `include:\n  - local: ${LOCAL}\nb:\n  script: x\n`,
    );
    expect(add("")).toBe(`include:\n  - local: ${LOCAL}\n`);
  });

  it("keeps CRLF line endings", () => {
    expect(add("include:\r\n  - a.yml\r\n")).toBe(
      `include:\r\n  - a.yml\r\n  - local: ${LOCAL}\r\n`,
    );
  });

  it("finds an include that is already there", () => {
    expect(addLocalInclude(`include:\n  - /${LOCAL}\n`, LOCAL)).toMatchObject({ changed: false });
    expect(addLocalInclude(`include: ${LOCAL}\n`, LOCAL)).toMatchObject({ changed: false });
  });

  it("reports what it can't edit", () => {
    expect(addLocalInclude("include: [a\n", LOCAL)).toEqual({ error: "it isn't valid YAML" });
    expect(addLocalInclude("- a\n", LOCAL)).toEqual({ error: "it has no top-level map of keys" });
  });
});

describe("stage", () => {
  it("picks test when listed, else the last regular stage", () => {
    expect(pickStage(["build", "test", "deploy"])).toBe("test");
    expect(pickStage(["build", "deploy", ".post"])).toBe("deploy");
    expect(pickStage([".pre", ".post"])).toBeUndefined();
  });
});

describe("targets file", () => {
  it("lists missing target jobs and appends blocks", () => {
    const text = ".launchset-web:\n  script: [make]\n";
    expect(missingTargetJobs(text, ["web", "api"])).toEqual(["api"]);
    expect(missingTargetJobs("a: [", ["web"])).toMatchObject({ error: expect.any(String) });
    expect(appendBlock("a: 1", "\n# --- api ---\n.launchset-api:\n  script: [x]\n")).toBe(
      "a: 1\n\n# --- api ---\n.launchset-api:\n  script: [x]\n",
    );
  });

  it("extracts the recommended workflow block", () => {
    expect(workflowBlock("# x\n\nworkflow:\n  rules:\n    - if: $A\n\ninclude:\n  - a\n")).toBe(
      "workflow:\n  rules:\n    - if: $A",
    );
  });
});

// ---------------------------------------------------------------------------

describe("GitLab jobs", () => {
  it("knows what starts a job", () => {
    const ci = gitlabCiOf([
      {
        path: ".gitlab-ci.yml",
        text: [
          "tag:\n  rules:\n    - if: $CI_COMMIT_TAG\n  script: [x]",
          "nevertag:\n  rules:\n    - if: $CI_COMMIT_TAG\n      when: never\n    - if: $CI_MERGE_REQUEST_IID\n  script: [x]",
          "main:\n  rules:\n    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH\n  script: [x]",
          "only-tags:\n  only: [tags]\n  script: [x]",
          "only-main:\n  only:\n    refs: [main]\n  script: [x]",
          "always:\n  script: [x]",
          "",
        ].join("\n"),
      },
    ]);
    const job = (name: string) => ci.jobs.get(name) as NonNullable<ReturnType<typeof ci.jobs.get>>;
    const starts = (name: string) => [runsOnTags(ci, job(name)), runsOnBranchPush(ci, job(name))];
    expect(starts("tag")).toEqual([true, false]);
    expect(starts("nevertag")).toEqual([false, false]);
    expect(starts("main")).toEqual([false, true]);
    expect(starts("only-tags")).toEqual([true, false]);
    expect(starts("only-main")).toEqual([false, true]);
    expect(starts("always")).toEqual([false, true]);
  });

  it("classifies GitLab release commands", () => {
    expect(gitlabCommandKinds("npx changeset publish")).toEqual(["changesets"]);
    expect(gitlabCommandKinds("npx semantic-release")).toEqual(["release-tool"]);
    expect(gitlabCommandKinds('glab release create "$CI_COMMIT_TAG"')).toEqual(["tag-creation"]);
    expect(gitlabCommandKinds("release-cli create --name x --tag-name v1")).toEqual([
      "tag-creation",
    ]);
    expect(gitlabCommandKinds("npm publish --access public")).toEqual(["package-publish"]);
    expect(gitlabCommandKinds("pnpm publish")).toEqual(["package-publish"]);
    expect(gitlabCommandKinds("yarn npm publish")).toEqual(["package-publish"]);
    expect(gitlabCommandKinds("npm ci")).toEqual([]);
  });

  it("reads images and release tags from docker commands", () => {
    const ci = gitlabCiOf([
      {
        path: ".gitlab-ci.yml",
        text: "variables:\n  IMAGE: $CI_REGISTRY_IMAGE/api\nrelease:\n  rules:\n    - if: $CI_COMMIT_TAG\n  script:\n    - docker build -f apps/api/Dockerfile -t $IMAGE:$CI_COMMIT_TAG apps/api\n    - docker push $IMAGE:$CI_COMMIT_TAG\n",
      },
    ]);
    const [build] = gitlabDockerBuilds(ci, {
      gitTagPrefix: "v",
      project: { path: "acme/shop", gitlabCom: true },
    });
    expect(build).toMatchObject({
      label: 'job "release"',
      file: "apps/api/Dockerfile",
      context: "apps/api",
      images: ["registry.gitlab.com/acme/shop/api"],
      tags: ["v{version}"],
      release: true,
      pushes: true,
    });
  });
});

describe("GitLab machinery", () => {
  it("removes a tag job and the comment above it, but not a job others extend", async () => {
    const text =
      "build:\n  script: make\n\n# Releases.\n.release:\n  only: [tags]\n  script: make release\nrelease:\n  extends: .release\nship:\n  only: [tags]\n  script: ship\nafter:\n  needs: [ship]\n  script: x\n";
    const { findings, read: file } = await disableAll({ ".gitlab-ci.yml": text });
    expect(findings.map((f) => [f.item.what, f.item.actions])).toEqual([
      ['GitLab job "release" (runs on tags)', ["disable", "keep"]],
      ['GitLab job "ship" (runs on tags)', ["keep"]],
    ]);
    expect(findings[1]?.item.effects.keep).toContain('job "after" needs it');
    expect(file(".gitlab-ci.yml")).toBe(
      "build:\n  script: make\n\n# Releases.\n.release:\n  only: [tags]\n  script: make release\nship:\n  only: [tags]\n  script: ship\nafter:\n  needs: [ship]\n  script: x\n",
    );
  });

  it("comments out the conflicting script lines and keeps the rest of the job", async () => {
    const text =
      "publish:\n  rules:\n    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH\n  script:\n    - npm ci\n    - npx changeset publish   # publish packages\n    - |\n      npm run build\n      npm publish\n";
    const { findings, read: file } = await disableAll({ ".gitlab-ci.yml": text });
    expect(findings[0]?.item).toMatchObject({
      kinds: ["changesets", "package-publish"],
      line: 6,
      effects: {
        disable:
          'comments out the conflicting script line (# launchset: disabled — …), disables the conflicting commands in its script (# launchset: disabled — …) in job "publish"',
      },
    });
    expect(file(".gitlab-ci.yml")).toBe(
      "publish:\n  rules:\n    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH\n  script:\n    - npm ci\n    # launchset: disabled — Changesets is replaced by launchset: - npx changeset publish   # publish packages\n    - |\n      npm run build\n      # launchset: disabled — Changesets is replaced by launchset: npm publish\n",
    );
    expect(parseGitLabYaml(file(".gitlab-ci.yml"))).toEqual({
      publish: {
        rules: [{ if: "$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH" }],
        script: [
          "npm ci",
          "npm run build\n# launchset: disabled — Changesets is replaced by launchset: npm publish\n",
        ],
      },
    });
  });

  it("removes a job that only releases; a template's last line becomes the no-op", async () => {
    const text =
      ".base:\n  script:\n    - npx semantic-release\nrelease:\n  extends: .base\nrel:\n  script:\n    - echo releasing\n  release:\n    tag_name: v1\n    description: x\nkeep:\n  script:\n    - make\n  release:\n    tag_name: v2\n    description: y\n";
    const { findings, read: file } = await disableAll({ ".gitlab-ci.yml": text });
    expect(findings.map((f) => [f.item.what, f.item.kinds, f.item.effects.disable])).toEqual([
      [
        'GitLab template ".base"',
        ["release-tool"],
        'turns script into the no-op ":" (# launchset: disabled — …) in template ".base"',
      ],
      ['GitLab job "rel"', ["tag-creation"], 'removes the job "rel"'],
      ['GitLab job "keep"', ["tag-creation"], 'removes its release: keyword in job "keep"'],
    ]);
    expect(file(".gitlab-ci.yml")).toBe(
      '.base:\n  script:\n    - ":" # launchset: disabled — launchset does the releases now: npx semantic-release\nrelease:\n  extends: .base\nkeep:\n  script:\n    - make\n',
    );
  });

  it("stops pushing latest on branch pushes, not on tags", async () => {
    const text = [
      "main:",
      "  rules:",
      "    - if: $CI_COMMIT_BRANCH",
      "  script:",
      "    - docker buildx build --push -t $IMAGE:$CI_COMMIT_SHA -t $IMAGE:latest .",
      "    - |",
      "      docker buildx build --push \\",
      "        -t $IMAGE:$CI_COMMIT_SHA \\",
      "        -t $IMAGE:latest \\",
      "        .",
      "    - docker tag $IMAGE:$CI_COMMIT_SHA $IMAGE:latest",
      "    - docker push $IMAGE:latest",
      "tags:",
      "  rules:",
      "    - if: $CI_COMMIT_TAG",
      "  script:",
      "    - docker push $IMAGE:latest",
      "",
    ].join("\n");
    const ci = gitlabCiOf([{ path: ".gitlab-ci.yml", text }]);
    const { findings, read: file } = await disableAll({ ".gitlab-ci.yml": text });
    expect(findings.map((f) => [f.item.what, f.item.kinds])).toEqual([
      ['GitLab job "main"', ["docker-latest"]],
      ['GitLab job "tags" (runs on tags)', ["tag-trigger"]],
    ]);
    expect(gitlabDockerBuilds(ci, { gitTagPrefix: "v" })[0]?.latest).toHaveLength(4);
    expect(file(".gitlab-ci.yml")).toBe(
      [
        "main:",
        "  rules:",
        "    - if: $CI_COMMIT_BRANCH",
        "  script:",
        "    - docker buildx build --push -t $IMAGE:$CI_COMMIT_SHA .",
        "    - |",
        "      docker buildx build --push \\",
        "        -t $IMAGE:$CI_COMMIT_SHA \\",
        "        .",
        "    # launchset: disabled — launchset moves latest when a release ships: - docker tag $IMAGE:$CI_COMMIT_SHA $IMAGE:latest",
        "    # launchset: disabled — launchset moves latest when a release ships: - docker push $IMAGE:latest",
        "",
      ].join("\n"),
    );
  });

  it("has no disable for flow-style scripts or a latest tag inside a longer command", () => {
    const flow = machinery("a:\n  script: [npm ci, npm publish]\n");
    expect(flow[0]?.item.actions).toEqual(["keep"]);
    expect(flow[0]?.item.effects.keep).toContain("flow style");
    const chained = machinery("a:\n  script:\n    - docker push $I:latest && echo done\n");
    expect(chained[0]?.item.actions).toEqual(["keep"]);
  });

  it("removes an included file that is all machinery, with its include; hides its jobs on disable", async () => {
    const root = "include:\n  - local: ci/release.yml\n  - ci/other.yml\ntest:\n  script: [make]\n";
    const release =
      "gitlab-release:\n  rules:\n    - if: $CI_COMMIT_TAG\n  script:\n    - glab release create $CI_COMMIT_TAG\n";
    const other = "other:\n  script: [make]\n";
    const files = { ".gitlab-ci.yml": root, "ci/release.yml": release, "ci/other.yml": other };
    const findings = machinery(root, [
      { path: "ci/release.yml", text: release },
      { path: "ci/other.yml", text: other },
    ]);
    expect(findings.map((f) => [f.item.id, f.item.actions])).toEqual([
      ["machinery.ci/release.yml#1", ["remove", "disable", "keep"]],
    ]);
    const removed = tempDir(files);
    const result = await applyRetirement(removed, [
      { finding: findings[0] as never, action: "remove" },
    ]);
    expect(result.changes.map((c) => `${c.action} ${c.path}`)).toEqual([
      "deleted ci/release.yml",
      "updated .gitlab-ci.yml",
    ]);
    expect(existsSync(join(removed, "ci/release.yml"))).toBe(false);
    expect(readFileSync(join(removed, ".gitlab-ci.yml"), "utf8")).toBe(
      "include:\n  - ci/other.yml\ntest:\n  script: [make]\n",
    );
    const { read: file } = await disableAll(files);
    expect(file("ci/release.yml")).toBe(release.replace("gitlab-release:", ".gitlab-release:"));
  });
});

// ---------------------------------------------------------------------------

function plan(matrix: string[]): Plan {
  return {
    schemaVersion: 1,
    mode: "publish",
    channel: "release",
    version: "2.4.0",
    baseVersion: "2.4.0",
    buildNumber: 217000000,
    releaseSha: "a".repeat(40),
    branch: "main",
    maintenance: false,
    distTag: "latest",
    tag: "v2.4.0",
    matrix,
    targets: {},
    createdAt: "2026-11-18T12:00:00.000Z",
  };
}

describe("init --yes on GitLab", () => {
  const repo = () => fixtureRepo("gitlab-docker", { tags: ["v2.3.0"], remote: GITLAB_REMOTE });

  it("detects the host, the stage and the machinery in included files", async () => {
    const json = await detectJson(repo());
    const byId = new Map(json.decisions.map((d) => [d.id, d]));
    expect(json.decisions.map((d) => d.id)).toEqual([
      "host",
      "version",
      "tags.release",
      "target.docker",
      "target.web",
      "docker.docker.image",
      "docker.docker.tags",
      "docker.docker.verify",
      "machinery..gitlab-ci.yml#1",
      "machinery..gitlab-ci.yml#2",
      "machinery.ci/publish.yml#1",
      "machinery.ci/release.yml#1",
      "baseline",
      "offset",
      "skill",
    ]);
    expect(byId.get("host")?.default).toBe("gitlab");
    expect(byId.get("docker.docker.image")?.default).toBe("registry.gitlab.com/acme/shop-api");
    expect(byId.get("docker.docker.tags")?.default).toBe("v{version}");
    expect(json.detection.targets[0]).toMatchObject({
      name: "docker",
      proposed: "auto",
      reason: "an existing GitLab CI job builds this image",
    });
    expect(json.detection.machinery.map((m) => [m.id, m.what, m.kinds])).toEqual([
      ["machinery..gitlab-ci.yml#1", 'GitLab job "build-main"', ["docker-latest"]],
      ["machinery..gitlab-ci.yml#2", 'GitLab job "release-image" (runs on tags)', ["tag-trigger"]],
      ["machinery.ci/publish.yml#1", 'GitLab template ".publish-base"', ["changesets"]],
      [
        "machinery.ci/release.yml#1",
        'GitLab job "gitlab-release" (runs on tags)',
        ["tag-trigger", "tag-creation"],
      ],
    ]);
    expect(json.detection.workflows.map((w) => w.path)).toEqual([
      ".gitlab-ci.yml",
      "ci/publish.yml",
      "ci/release.yml",
    ]);
  });

  it("writes the GitLab files, edits .gitlab-ci.yml minimally and lists the GitLab steps", async () => {
    const dir = repo();
    const result = await runInit(options(dir, { yes: true }));
    expect(status(dir)).toEqual(
      [
        "?? .claude/skills/launchset/SKILL.md",
        "?? .gitlab/launchset-targets.yml",
        "?? .gitlab/launchset.yml",
        "?? .launchset/README.md",
        "?? AGENTS.md",
        "?? CHANGELOG.md",
        "?? launchset.config.ts",
        " M .gitlab-ci.yml",
        " M ci/publish.yml",
        " M ci/release.yml",
      ].sort(),
    );
    // Every GitLab file parses; launchset's jobs go in the last stage (no test stage).
    const jobs = parseGitLabYaml(read(dir, ".gitlab/launchset.yml")) as Record<
      string,
      { stage?: string }
    >;
    expect(jobs[".launchset-cli"]?.stage).toBe("deploy");
    const root = read(dir, ".gitlab-ci.yml");
    expect(parseYaml(root).include).toEqual([
      { local: "ci/publish.yml" },
      "ci/release.yml",
      { local: ".gitlab/launchset.yml" },
    ]);
    // Only the conflicting lines changed; the user's comments and other jobs stay.
    expect(root).toContain("# CI for the shop API.\n");
    expect(root).toContain(
      "    # launchset: disabled — launchset moves latest when a release ships: - docker push $IMAGE:latest\n",
    );
    expect(root).not.toContain("release-image:");
    expect(root).not.toContain("# Release images from v* tags.");
    expect(root.endsWith("$IMAGE:latest\n")).toBe(true);
    expect(read(dir, "ci/release.yml")).toContain(".gitlab-release:\n");
    expect(read(dir, "ci/publish.yml")).toContain(
      '    - ":" # launchset: disabled — Changesets is replaced by launchset: npx changeset publish\n',
    );
    for (const path of [".gitlab-ci.yml", "ci/publish.yml", "ci/release.yml"]) {
      expect(() => parseGitLabYaml(read(dir, path)), path).not.toThrow();
    }

    // The targets file names the jobs that built the image, and the child pipeline renders
    // against it.
    const targets = read(dir, ".gitlab/launchset-targets.yml");
    expect(targets).toContain(
      "# Your job build-main in .gitlab-ci.yml built this image; move its steps here.\n# Your job release-image in .gitlab-ci.yml built this image; move its steps here.\n.launchset-docker:\n",
    );
    expect(checkTargetsFile(targets, ["docker"])).toEqual([]);
    const child = parseGitLabYaml(
      renderChildPipeline({
        plan: plan(["docker"]),
        kind: "release",
        planJob: "launchset-release",
      }),
    ) as Record<string, { extends?: string; script?: unknown[] }>;
    const targetJobs = parseGitLabYaml(targets) as Record<string, { script?: unknown[] }>;
    expect(child["build-docker"]?.extends).toBe(".launchset-docker");
    const reference = child["build-docker"]?.script?.find((s) => s instanceof GitLabReference);
    expect((reference as GitLabReference).path).toEqual([".launchset-docker", "script"]);
    expect(targetJobs[".launchset-docker"]?.script?.length).toBeGreaterThan(0);

    expect(result.manualSteps[1]).toContain("LAUNCHSET_TOKEN");
    expect(result.manualSteps[1]).toContain("api and write_repository");
    expect(result.manualSteps[2]).toContain("NPM_TOKEN");
    expect(result.manualSteps[3]).toContain("protected branches main and release/*.x");
    expect(result.manualSteps[4]).toContain("Minimum role to use pipeline variables");
    expect(result.manualSteps[5]).toBe(
      "Add your build and upload steps for docker to .gitlab/launchset-targets.yml.",
    );
    expect(result.manualSteps[6]).toContain("has no workflow: rules");
    expect(result.manualSteps[6]).toContain("on_new_commit: interruptible");
    expect(result.manualSteps.join("\n")).not.toContain("GitHub App");
    expect(result.manualSteps.join("\n")).not.toContain(".github/workflows");
    const sweep = result.manualSteps.filter((step) => step.includes("LAUNCHSET_PREVIEW_SWEEP"));
    expect(sweep).toHaveLength(1);
    expect(sweep[0]).toMatch(/^Optional: start previews when the launchset:preview label is added/);
    expect(sweep[0]).toContain("Build > Pipeline schedules > New schedule) for the branch main");
    expect(sweep[0]).toContain("*/10 * * * *");
    expect(sweep[0]).toContain('`- if: $LAUNCHSET_PREVIEW_SWEEP == "true"` and `when: never`');
    expect(result.changes.find((c) => c.path === ".gitlab/launchset.yml")?.summary).toBe(
      "launchset's GitLab CI jobs, in stage deploy, the last of stages: in .gitlab-ci.yml, which has no test",
    );
  });

  it("removes an included release file with its include when asked", async () => {
    const dir = repo();
    await runInit(options(dir, { yes: true, decide: { "machinery.ci/release.yml#1": "remove" } }));
    expect(existsSync(join(dir, "ci/release.yml"))).toBe(false);
    expect(parseYaml(read(dir, ".gitlab-ci.yml")).include).toEqual([
      { local: "ci/publish.yml" },
      { local: ".gitlab/launchset.yml" },
    ]);
  });

  it("keeps an existing targets file and adds only the jobs it lacks", async () => {
    const dir = repo();
    const own = "# my jobs\n.launchset-web:\n  script:\n    - make web\n";
    mkdirSync(join(dir, ".gitlab"), { recursive: true });
    writeFileSync(join(dir, ".gitlab/launchset-targets.yml"), own);
    const result = await runInit(options(dir, { yes: true, decide: { "target.web": "auto" } }));
    const text = read(dir, ".gitlab/launchset-targets.yml");
    expect(text.startsWith(own)).toBe(true);
    expect(text).toContain("\n.launchset-docker:\n");
    expect(text.match(/\.launchset-web:/g)).toHaveLength(1);
    expect(result.changes.find((c) => c.path === ".gitlab/launchset-targets.yml")).toEqual({
      path: ".gitlab/launchset-targets.yml",
      action: "updated",
      summary: "kept your jobs; added .launchset-docker (a target it had no job for)",
    });
    expect(checkTargetsFile(text, ["docker", "web"])).toEqual([]);
  });

  it("writes a fresh .gitlab-ci.yml for a GitLab repo without CI, with the instance's registry", async () => {
    const dir = fixtureRepo("gitlab-fresh", {
      remote: "https://gitlab.example.com/team/web-app.git",
    });
    const json = await detectJson(dir);
    expect(json.decisions.find((d) => d.id === "docker.docker.image")).toMatchObject({
      default: "registry.gitlab.example.com/team/web-app",
      ask: true,
    });
    const result = await runInit(options(dir, { yes: true }));
    const root = read(dir, ".gitlab-ci.yml");
    expect(parseYaml(root)).toMatchObject({
      workflow: { auto_cancel: { on_new_commit: "interruptible" } },
      include: [{ local: ".gitlab/launchset.yml" }],
    });
    const targets = read(dir, ".gitlab/launchset-targets.yml");
    expect(targets).toContain("LAUNCHSET_REGISTRY_HOST: registry.gitlab.example.com\n");
    expect(targets).toContain('--password-stdin "$CI_REGISTRY"\n');
    expect(parseGitLabYaml(read(dir, ".gitlab/launchset.yml"))).toMatchObject({
      ".launchset-cli": { stage: "test" },
    });
    expect(result.manualSteps.join("\n")).not.toContain("workflow: rules");
  });

  it("writes GitLab files for a GitHub-looking repo with --decide host=gitlab", async () => {
    const dir = fixtureRepo("docker-v", { tags: ["v1.3.0"] });
    await runInit(options(dir, { yes: true, decide: { host: "gitlab" } }));
    expect(existsSync(join(dir, ".gitlab/launchset.yml"))).toBe(true);
    expect(existsSync(join(dir, ".github/workflows/launchset-release.yml"))).toBe(false);
    expect(parseYaml(read(dir, ".gitlab-ci.yml")).include).toEqual([
      { local: ".gitlab/launchset.yml" },
    ]);
  });
});
