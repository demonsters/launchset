import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../../src/core/config/schema.ts";
import { LaunchsetError } from "../../src/core/errors.ts";
import { snapshotTags, validChangesets } from "../../src/core/plan-common.ts";
import { planRelease } from "../../src/core/release.ts";
import type { Plan } from "../../src/core/types.ts";
import { type ActionsEvent, githubEnvironment } from "../../src/flow/ci/github.ts";
import { type FlowContext, silentLogger } from "../../src/flow/context.ts";
import { readChangesetFiles } from "../../src/flow/gather.ts";
import {
  findTargetJob,
  jobStatus,
  MAX_RESERVATION_ATTEMPTS,
  previewComment,
  previewPlan,
} from "../../src/flow/preview.ts";
import { createGitHub } from "../../src/forge/github/index.ts";
import type { Job } from "../../src/forge/types.ts";
import { Git, GitError } from "../../src/git/index.ts";
import { API, REPO, server, TOKEN } from "../forge/helpers.ts";
import { cloneRepo, repoWithRemote, type TestRepo } from "../git/helpers.ts";

const NOW = new Date("2026-11-18T12:00:00Z");
const RUN = {
  id: 100,
  number: 17,
  attempt: 1,
  url: "https://github.com/acme/app/actions/runs/100",
};

const config = resolveConfig({
  targets: {
    "docker-api": { type: "docker", image: "ghcr.io/demonsters/api" },
    web: { type: "web" },
    android: { type: "android", source: { kind: "gradle", file: "android/app/build.gradle" } },
    ios: {
      type: "ios",
      source: { kind: "xcodeproj", file: "ios/App.xcodeproj" },
      release: "manual",
    },
  },
  preview: {
    branches: ["develop", { branch: "next/*", prerelease: "alpha" }, "release/*"],
    targets: ["android", "ios", "docker-api"],
  },
});

const changesetFile = (bump: string, summary: string) => `---\nbump: ${bump}\n---\n\n${summary}\n`;

/** A repo with `main` at 1.4.0 (tagged v1.4.0) and pushed to a bare remote. */
function setup() {
  const { remote, repo } = repoWithRemote();
  repo.version("1.4.0");
  repo.git("tag", "v1.4.0");
  repo.git("push", "--quiet", "origin", "main", "v1.4.0");
  return { remote, repo };
}

/** Create `branch` from the current branch with a minor changeset and push it. */
function branchWithChangeset(repo: TestRepo, branch: string, name = "brave-lions"): string {
  repo.checkout("-b", branch);
  const sha = repo.commit(`feat on ${branch}`, {
    [`.launchset/${name}.md`]: changesetFile("minor", `Add a thing in ${name}`),
  });
  repo.git("push", "--quiet", "origin", branch);
  return sha;
}

function context(
  repo: TestRepo,
  options: {
    cfg?: typeof config;
    event?: ActionsEvent;
    env?: Record<string, string>;
    github?: boolean;
  } = {},
): FlowContext {
  const git = new Git({ cwd: repo.dir, token: TOKEN });
  const ctx: FlowContext = {
    cwd: repo.dir,
    config: options.cfg ?? config,
    configFile: "launchset.config.json",
    git,
    token: TOKEN,
    repository: "acme/app",
    serverUrl: "https://github.com",
    env: options.env ?? {},
    host: "github",
    ci: githubEnvironment(options.env ?? {}, options.event),
    run: RUN,
    now: NOW,
    log: silentLogger,
  };
  if (options.github !== false) {
    ctx.forge = createGitHub({ token: TOKEN, repository: "acme/app", apiUrl: API });
  }
  return ctx;
}

function prEvent(
  headSha: string,
  over: {
    action?: string;
    labels?: string[];
    branch?: string;
    number?: number;
    headRepo?: string | null;
    label?: string;
  } = {},
): ActionsEvent {
  const labels = over.labels ?? ["launchset:preview"];
  const headRepo = over.headRepo === undefined ? "acme/app" : over.headRepo;
  return {
    name: "pull_request",
    payload: {
      action: over.action ?? "synchronize",
      number: over.number ?? 123,
      ...(over.label ? { label: { name: over.label } } : {}),
      repository: { full_name: "acme/app" },
      pull_request: {
        number: over.number ?? 123,
        labels: labels.map((name) => ({ name })),
        head: {
          ref: over.branch ?? "feature/login",
          sha: headSha,
          repo: headRepo === null ? null : { full_name: headRepo },
        },
        base: { ref: "main" },
      },
    },
  };
}

const pushEvent = (branch: string): ActionsEvent => ({
  name: "push",
  payload: { ref: `refs/heads/${branch}` },
});

const dispatchEvent = (branch: string, inputs: Record<string, string> = {}): ActionsEvent => ({
  name: "workflow_dispatch",
  payload: { ref: `refs/heads/${branch}`, inputs },
});

function planOf(result: Awaited<ReturnType<typeof previewPlan>>): Plan {
  if (!result.data.plan) throw new Error(`expected a plan, got: ${result.summary}`);
  return result.data.plan;
}

function remoteTags(repo: TestRepo): string[] {
  return repo
    .git("ls-remote", "--tags", "origin")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t")[1]?.replace("refs/tags/", "") ?? "")
    .sort();
}

describe("PR previews (8.3, 9.7)", () => {
  it("plans {next}-pr.{n}.{run} for the PR head, not the merge commit", async () => {
    const { repo } = setup();
    const head = branchWithChangeset(repo, "feature/login");
    // What actions/checkout checks out for a pull_request event: a merge of head into a moved base.
    repo.checkout("main");
    repo.commit("main moved", { "other.txt": "x\n" });
    repo.checkout("-b", "merge-ref");
    const merge = repo.merge("feature/login");
    expect(merge).not.toBe(head);

    const result = await previewPlan(context(repo, { event: prEvent(head) }));
    const plan = planOf(result);
    expect(result.data.preview).toBe("pr");
    expect(plan.version).toBe("1.5.0-pr.123.17");
    expect(plan.baseVersion).toBe("1.5.0");
    expect(plan.releaseSha).toBe(head);
    expect(plan.branch).toBe("feature/login");
    expect(plan.matrix).toEqual(["docker-api", "android", "ios"]);
    expect(plan.targets.android?.marketingVersion).toBe("1.5.0-pr.123.17");
    expect(plan.targets.ios?.marketingVersion).toBe("1.5.0");
    expect(plan.targets["docker-api"]?.docker?.refs).toEqual([
      "ghcr.io/demonsters/api:1.5.0-pr.123.17",
      "ghcr.io/demonsters/api:pr-123",
    ]);
    expect(plan.run).toEqual(RUN);
    expect(plan.repository).toBe("acme/app");
    expect(plan.tag).toBeUndefined();
    // No side effects: no tag on the remote beyond v1.4.0.
    expect(remoteTags(repo)).toEqual(["v1.4.0"]);

    expect(result.ok).toBe(true);
    expect(result.outputs).toMatchObject({
      matrix: JSON.stringify(["docker-api", "android", "ios"]),
      version: "1.5.0-pr.123.17",
      channel: "preview",
      "release-sha": head,
      "dist-tag": "pr-123",
      "pr-number": "123",
      tag: "",
      skipped: "",
    });
    expect(Number(result.outputs["build-number"])).toBeGreaterThan(200_000_000);
    expect(JSON.parse(result.outputs.plan as string)).toEqual(JSON.parse(JSON.stringify(plan)));
    expect(result.summary).toContain("1.5.0-pr.123.17");
  });

  it("uses a patch bump when the PR has no changesets", async () => {
    const { repo } = setup();
    repo.checkout("-b", "feature/login");
    const head = repo.commit("work", { "a.txt": "a\n" });
    const result = await previewPlan(context(repo, { event: prEvent(head) }));
    expect(planOf(result).version).toBe("1.4.1-pr.123.17");
  });

  it("skips without the label, for forks and for the wrong label event", async () => {
    const { repo } = setup();
    const head = branchWithChangeset(repo, "feature/login");

    const noLabel = await previewPlan(context(repo, { event: prEvent(head, { labels: [] }) }));
    expect(noLabel.data.skip?.code).toBe("no-label");
    expect(noLabel.ok).toBe(true);
    expect(noLabel.outputs).toMatchObject({ matrix: "[]", plan: "", skipped: "no-label" });
    expect(noLabel.summary).toContain("launchset:preview");

    const fork = await previewPlan(
      context(repo, { event: prEvent(head, { headRepo: "someone/app" }) }),
    );
    expect(fork.data.skip?.code).toBe("fork");
    expect(fork.summary).toMatch(/fork/);
    expect(fork.summary).toMatch(/secrets/);

    const deletedFork = await previewPlan(
      context(repo, { event: prEvent(head, { headRepo: null }) }),
    );
    expect(deletedFork.data.skip?.code).toBe("fork");

    const other = await previewPlan(
      context(repo, { event: prEvent(head, { action: "labeled", label: "bug" }) }),
    );
    expect(other.data.skip?.code).toBe("other-label");
    expect(other.outputs.skipped).toBe("other-label");
  });

  it("with rebuildOnPush: false builds only on the labeled event", async () => {
    const { repo } = setup();
    const head = branchWithChangeset(repo, "feature/login");
    const cfg = resolveConfig({
      targets: { web: { type: "web" } },
      preview: { rebuildOnPush: false },
    });
    const pushed = await previewPlan(
      context(repo, { cfg, event: prEvent(head, { action: "synchronize" }) }),
    );
    expect(pushed.data.skip?.code).toBe("not-labeled-event");
    const labeled = await previewPlan(
      context(repo, {
        cfg,
        event: prEvent(head, { action: "labeled", label: "launchset:preview" }),
      }),
    );
    expect(planOf(labeled).version).toBe("1.5.0-pr.123.17");
  });

  it("ignores changesets that don't parse, with a warning in the summary", async () => {
    const { repo } = setup();
    repo.checkout("-b", "feature/login");
    repo.commit("changesets", {
      ".launchset/good.md": changesetFile("minor", "Good"),
      ".launchset/bad.md": "no frontmatter at all\n",
    });
    const head = repo.head();
    const result = await previewPlan(context(repo, { event: prEvent(head) }));
    expect(planOf(result).baseVersion).toBe("1.5.0");
    expect(result.data.invalidChangesets.map((c) => c.path)).toEqual([".launchset/bad.md"]);
    expect(result.summary).toContain(".launchset/bad.md");
  });

  it("fails clearly when the PR head isn't in the checkout", async () => {
    const { repo } = setup();
    const error = await previewPlan(context(repo, { event: prEvent("f".repeat(40)) })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(LaunchsetError);
    expect((error as LaunchsetError).code).toBe("commit-not-found");
    expect((error as LaunchsetError).hint).toContain("fetch-depth");
  });
});

describe("branch previews and manual runs (8.3, 9.7)", () => {
  it("auto-previews a push to a preview branch as {next}-{slug}.{run}", async () => {
    const { repo } = setup();
    repo.checkout("-b", "develop");
    const head = repo.commit("feat", {
      ".launchset/a.md": changesetFile("minor", "Add a"),
    });
    const result = await previewPlan(
      context(repo, { event: pushEvent("develop"), env: { GITHUB_SHA: head } }),
    );
    const plan = planOf(result);
    expect(result.data.preview).toBe("branch");
    expect(plan.version).toBe("1.5.0-develop.17");
    expect(plan.branchSlug).toBe("develop");
    expect(plan.releaseSha).toBe(head);
    expect(plan.distTag).toBe("develop");
    expect(plan.matrix).toEqual(["docker-api", "android", "ios"]);
    expect(plan.targets["docker-api"]?.docker?.tags).toEqual(["1.5.0-develop.17", "develop"]);
    expect(remoteTags(repo)).toEqual(["v1.4.0"]);
  });

  it("skips pushes to maintenance branches and to branches that aren't preview branches", async () => {
    const { repo } = setup();
    repo.checkout("-b", "release/1.4.x");
    const maintenance = await previewPlan(context(repo, { event: pushEvent("release/1.4.x") }));
    expect(maintenance.data.skip?.code).toBe("maintenance-branch");
    expect(maintenance.outputs.matrix).toBe("[]");

    repo.checkout("-b", "random");
    const random = await previewPlan(context(repo, { event: pushEvent("random") }));
    expect(random.data.skip?.code).toBe("no-preview-branch");
  });

  it("builds a manual run on a maintenance branch with the targets input", async () => {
    const { repo } = setup();
    repo.checkout("-b", "release/1.4.x");
    repo.commit("fix", { ".launchset/f.md": changesetFile("patch", "Fix f") });
    const result = await previewPlan(context(repo, { event: dispatchEvent("release/1.4.x") }), {
      targets: ["android"],
    });
    const plan = planOf(result);
    expect(plan.matrix).toEqual(["android"]);
    expect(plan.version).toBe("1.4.1-release-1-4-x.17");
    expect(plan.maintenance).toBe(true);
    expect(result.summary).toContain("maintenance branch");
  });

  it("splits comma-separated targets, accepts all, and falls back to the event input", async () => {
    const { repo } = setup();
    repo.checkout("-b", "any/branch");
    const dispatch = dispatchEvent("any/branch");
    const two = await previewPlan(context(repo, { event: dispatch }), {
      targets: ["ios,  android"],
    });
    expect(planOf(two).matrix).toEqual(["android", "ios"]);

    const all = await previewPlan(context(repo, { event: dispatch }), { targets: ["all"] });
    expect(planOf(all).matrix).toEqual(["docker-api", "web", "android", "ios"]);

    const fromInput = await previewPlan(
      context(repo, { event: dispatchEvent("any/branch", { targets: "web" }) }),
    );
    expect(planOf(fromInput).matrix).toEqual(["web"]);

    const none = await previewPlan(context(repo, { event: dispatch }), { targets: [] });
    expect(planOf(none).matrix).toEqual(["docker-api", "android", "ios"]);
  });

  it("names unknown targets", async () => {
    const { repo } = setup();
    repo.checkout("-b", "any/branch");
    const error = await previewPlan(context(repo, { event: dispatchEvent("any/branch") }), {
      targets: ["nope"],
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LaunchsetError);
    expect((error as LaunchsetError).message).toContain("nope");
  });

  it("rejects events that aren't previews", async () => {
    const { repo } = setup();
    const error = await previewPlan(
      context(repo, { event: { name: "schedule", payload: {} } }),
    ).catch((e: unknown) => e);
    expect((error as LaunchsetError).code).toBe("invalid-event");
    const tag = await previewPlan(
      context(repo, { event: { name: "push", payload: { ref: "refs/tags/v1.0.0" } } }),
    ).catch((e: unknown) => e);
    expect((tag as LaunchsetError).code).toBe("unsupported-ref");
  });

  it("works without an event (the CLI) on the current branch", async () => {
    const { repo } = setup();
    repo.checkout("-b", "feature/cli");
    const result = await previewPlan(context(repo));
    expect(planOf(result).version).toBe("1.4.1-feature-cli.17");
  });

  it("skips when previews are disabled", async () => {
    const { repo } = setup();
    repo.checkout("-b", "develop");
    const off = resolveConfig({ targets: { web: { type: "web" } }, preview: false });
    const result = await previewPlan(context(repo, { cfg: off, event: pushEvent("develop") }));
    expect(result.data.skip?.code).toBe("previews-disabled");
  });
});

describe("prerelease branches (9.9)", () => {
  async function prerelease(repo: TestRepo, branch = "next/login") {
    return previewPlan(context(repo, { event: pushEvent(branch) }));
  }

  it("reserves v1.5.0-alpha.0 before the builds", async () => {
    const { repo } = setup();
    const head = branchWithChangeset(repo, "next/login");
    const result = await prerelease(repo);
    const plan = planOf(result);
    expect(result.data.preview).toBe("prerelease");
    expect(result.data.reservationAttempts).toBe(1);
    expect(plan.version).toBe("1.5.0-alpha.0");
    expect(plan.tag).toBe("v1.5.0-alpha.0");
    expect(plan.channel).toBe("prerelease");
    expect(plan.releaseSha).toBe(head);
    expect(plan.distTag).toBe("alpha");
    expect(plan.preid).toBe("alpha");
    expect(plan.targets.android?.marketingVersion).toBe("1.5.0-alpha.0");
    expect(plan.targets.ios?.marketingVersion).toBe("1.5.0");
    expect(plan.targets["docker-api"]?.docker?.tags).toEqual(["1.5.0-alpha.0", "next-login"]);
    expect(result.outputs).toMatchObject({
      tag: "v1.5.0-alpha.0",
      "dist-tag": "alpha",
      channel: "prerelease",
      version: "1.5.0-alpha.0",
    });
    // The tag is on the remote, at the built commit.
    expect(remoteTags(repo)).toEqual(["v1.4.0", "v1.5.0-alpha.0"]);
    expect(repo.git("ls-remote", "origin", "refs/tags/v1.5.0-alpha.0").split("\t")[0]).toBe(head);
    expect(result.summary).toContain("Reserved tag");
  });

  it("dryRun plans the next tag without pushing it", async () => {
    const { repo } = setup();
    branchWithChangeset(repo, "next/login");
    const result = await previewPlan(context(repo, { event: pushEvent("next/login") }), {
      dryRun: true,
    });
    expect(planOf(result).tag).toBe("v1.5.0-alpha.0");
    expect(result.data.reservationAttempts).toBeUndefined();
    expect(result.summary).toContain("not reserved");
    expect(result.summary).not.toContain("Reserved tag");
    expect(remoteTags(repo)).toEqual(["v1.4.0"]);
    expect(repo.git("tag", "--list", "v1.5.0-alpha.*")).toBe("");
    // The real run afterwards still gets the same number.
    expect(planOf(await prerelease(repo)).tag).toBe("v1.5.0-alpha.0");
  });

  it("numbers the next push alpha.1 and a re-run of the plan job alpha.2", async () => {
    const { repo } = setup();
    branchWithChangeset(repo, "next/login");
    expect(planOf(await prerelease(repo)).tag).toBe("v1.5.0-alpha.0");
    const second = repo.commit("more", { "x.txt": "x\n" });
    repo.git("push", "--quiet", "origin", "next/login");
    const next = planOf(await prerelease(repo));
    expect(next.tag).toBe("v1.5.0-alpha.1");
    expect(next.releaseSha).toBe(second);
    // "Re-run all jobs" runs preview-plan again: the old tag is taken, so a new one is reserved.
    // ("Re-run failed jobs" reuses the plan outputs and never gets here: the tag stays.)
    expect(planOf(await prerelease(repo)).tag).toBe("v1.5.0-alpha.2");
    expect(remoteTags(repo)).toEqual([
      "v1.4.0",
      "v1.5.0-alpha.0",
      "v1.5.0-alpha.1",
      "v1.5.0-alpha.2",
    ]);
  });

  it("retries with the next number when a concurrent run took the tag", async () => {
    const { remote, repo } = setup();
    branchWithChangeset(repo, "next/login");
    expect(planOf(await prerelease(repo)).tag).toBe("v1.5.0-alpha.0");

    // A second run on another commit plans alpha.1 and, between its fetch and its push,
    // a concurrent run pushes v1.5.0-alpha.1 from another clone.
    repo.commit("second push", { "y.txt": "y\n" });
    repo.git("push", "--quiet", "origin", "next/login");
    const other = cloneRepo(remote);
    other.checkout("-b", "other", "origin/next/login");
    const otherSha = other.commit("concurrent work", { "z.txt": "z\n" });
    const ctx = context(repo, { event: pushEvent("next/login") });
    const original = Git.prototype.pushTag.bind(ctx.git);
    let raced = 0;
    const push = vi.spyOn(ctx.git, "pushTag").mockImplementation(async (name) => {
      if (raced++ === 0) {
        other.git("tag", name, otherSha);
        other.git("push", "--quiet", "origin", `refs/tags/${name}`);
      }
      return original(name);
    });
    const result = await previewPlan(ctx);
    expect(push).toHaveBeenCalledTimes(2);
    expect(result.data.reservationAttempts).toBe(2);
    expect(planOf(result).tag).toBe("v1.5.0-alpha.2");
    expect(planOf(result).version).toBe("1.5.0-alpha.2");
    expect(result.outputs.tag).toBe("v1.5.0-alpha.2");
    expect(remoteTags(repo)).toEqual([
      "v1.4.0",
      "v1.5.0-alpha.0",
      "v1.5.0-alpha.1",
      "v1.5.0-alpha.2",
    ]);
    // alpha.1 is the other run's, at its commit; ours is alpha.2 at our commit.
    expect(repo.git("ls-remote", "origin", "refs/tags/v1.5.0-alpha.1").split("\t")[0]).toBe(
      otherSha,
    );
    expect(repo.git("ls-remote", "origin", "refs/tags/v1.5.0-alpha.2").split("\t")[0]).toBe(
      repo.head(),
    );
    // No stray local tag from the lost attempt pointing somewhere else than the remote.
    expect(repo.git("rev-parse", "v1.5.0-alpha.1")).toBe(otherSha);
    expect(result.summary).toContain("2 attempts");
  });

  it("treats a concurrent run that reserved the same tag at the same commit as taken", async () => {
    const { remote, repo } = setup();
    const head = branchWithChangeset(repo, "next/login");
    const other = cloneRepo(remote);
    other.checkout("next/login");
    const ctx = context(repo, { event: pushEvent("next/login") });
    const original = Git.prototype.pushTag.bind(ctx.git);
    let raced = false;
    vi.spyOn(ctx.git, "pushTag").mockImplementation(async (name) => {
      if (!raced) {
        raced = true;
        other.git("tag", name, head);
        other.git("push", "--quiet", "origin", `refs/tags/${name}`);
      }
      return original(name);
    });
    const result = await previewPlan(ctx);
    expect(planOf(result).tag).toBe("v1.5.0-alpha.1");
    expect(result.data.reservationAttempts).toBe(2);
  });

  it("gives up after a bounded number of attempts", async () => {
    const { remote, repo } = setup();
    branchWithChangeset(repo, "next/login");
    const other = cloneRepo(remote);
    const otherSha = other.commit("elsewhere", { "o.txt": "o\n" });
    const ctx = context(repo, { event: pushEvent("next/login") });
    const original = Git.prototype.pushTag.bind(ctx.git);
    const push = vi.spyOn(ctx.git, "pushTag").mockImplementation(async (name) => {
      other.git("tag", name, otherSha);
      other.git("push", "--quiet", "origin", `refs/tags/${name}`);
      return original(name);
    });
    const error = await previewPlan(ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LaunchsetError);
    expect((error as LaunchsetError).code).toBe("tag-reservation-failed");
    expect((error as LaunchsetError).message).toContain("v1.5.0-alpha.0");
    expect(push).toHaveBeenCalledTimes(MAX_RESERVATION_ATTEMPTS);
  });

  it("explains a rejected push and leaves no local tag behind", async () => {
    const { repo } = setup();
    branchWithChangeset(repo, "next/login");
    const ctx = context(repo, { event: pushEvent("next/login") });
    vi.spyOn(ctx.git, "pushTag").mockRejectedValue(
      new GitError(
        "git push failed",
        "git push origin refs/tags/v1.5.0-alpha.0",
        "remote: Permission to acme/app.git denied to github-actions[bot].\nfatal: unable to access: The requested URL returned error: 403",
        128,
      ),
    );
    const error = await previewPlan(ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LaunchsetError);
    expect((error as LaunchsetError).code).toBe("tag-push-denied");
    expect((error as LaunchsetError).hint).toContain("App token");
    expect(repo.git("tag", "--list", "v1.5.0-*")).toBe("");
  });

  it("doesn't count prerelease tags as releases once the branch merges into main", async () => {
    const { repo } = setup();
    branchWithChangeset(repo, "next/login");
    await prerelease(repo);
    repo.commit("more", { "x.txt": "x\n" });
    repo.git("push", "--quiet", "origin", "next/login");
    await prerelease(repo);

    repo.checkout("main");
    const merge = repo.merge("next/login");
    const ctx = context(repo);
    await ctx.git.fetchTags();
    const tags = snapshotTags(await ctx.git.tags(), config);
    expect([...tags.shas.keys()].sort()).toEqual(["v1.4.0", "v1.5.0-alpha.0", "v1.5.0-alpha.1"]);
    const files = await readChangesetFiles(ctx, { ref: merge });
    const decision = planRelease({
      config,
      branch: "main",
      event: { kind: "push" },
      headSha: merge,
      version: "1.4.0",
      headIsReleaseCommit: false,
      tags,
      reachableReleases: ["1.4.0"],
      changesets: validChangesets(files),
      botPrs: [],
      commitsSinceRelease: [],
      now: NOW,
      run: RUN,
      repository: "acme/app",
    });
    // The full release PR for 1.5.0, as if the alphas never existed.
    expect(decision.plan.mode).toBe("release-pr");
    expect(decision.plan.releasePr).toMatchObject({ version: "1.5.0", bump: "minor" });
  });
});

// ---------------------------------------------------------------------------

function job(id: number, name: string, conclusion: string | null): Job {
  return {
    id,
    name,
    status: conclusion === null ? "in_progress" : "completed",
    conclusion,
    url: `https://github.com/acme/app/actions/runs/100/job/${id}`,
  };
}

function rawJob(j: Job) {
  return {
    id: j.id,
    name: j.name,
    status: j.status,
    conclusion: j.conclusion,
    html_url: j.url,
  };
}

function jobsHandler(jobs: Job[]) {
  return http.get(`${REPO}/actions/runs/100/jobs`, () =>
    HttpResponse.json({ total_count: jobs.length, jobs: jobs.map(rawJob) }),
  );
}

describe("job results", () => {
  it("maps conclusions to target statuses", () => {
    expect(jobStatus(job(1, "x", "success"))).toBe("success");
    expect(jobStatus(job(1, "x", "failure"))).toBe("failure");
    expect(jobStatus(job(1, "x", "timed_out"))).toBe("failure");
    expect(jobStatus(job(1, "x", "cancelled"))).toBe("cancelled");
    expect(jobStatus(job(1, "x", "skipped"))).toBe("skipped");
    expect(jobStatus(job(1, "x", null))).toBe("pending");
  });

  it("finds the build job by target name", () => {
    const jobs = [
      job(1, "Plan preview", "success"),
      job(2, "Preview android", "success"),
      job(3, "Preview android-tv", "failure"),
      job(4, "ci / Preview ios", "success"),
      job(5, "Preview comment", null),
    ];
    expect(findTargetJob(jobs, "android")?.id).toBe(2);
    expect(findTargetJob(jobs, "android-tv")?.id).toBe(3);
    expect(findTargetJob(jobs, "ios")?.id).toBe(4);
    expect(findTargetJob(jobs, "web")).toBeUndefined();
  });
});

describe("preview-comment (9.7)", () => {
  const bot = { login: "launchset[bot]", type: "Bot" };

  async function prPlan(repo: TestRepo) {
    const head = branchWithChangeset(repo, "feature/login");
    const result = await previewPlan(context(repo, { event: prEvent(head) }));
    return result.outputs.plan as string;
  }

  it("creates the sticky comment with the per-target results and job links", async () => {
    const { repo } = setup();
    const plan = await prPlan(repo);
    let posted: { body: string } | undefined;
    server.use(
      jobsHandler([
        job(10, "Plan preview", "success"),
        job(11, "Preview docker-api", "failure"),
        job(12, "Preview android", "success"),
        job(13, "Preview ios", "success"),
        job(14, "Preview comment", null),
      ]),
      http.get(`${REPO}/issues/123/comments`, () => HttpResponse.json([])),
      http.post(`${REPO}/issues/123/comments`, async ({ request }) => {
        posted = (await request.json()) as { body: string };
        return HttpResponse.json({ id: 9, html_url: "https://github.com/c/9" }, { status: 201 });
      }),
    );
    const result = await previewComment(context(repo), { plan });
    expect(result.data.kind).toBe("pr");
    expect(result.data.unmatched).toEqual([]);
    expect(result.outputs["comment-url"]).toBe("https://github.com/c/9");
    expect(posted?.body.startsWith("<!-- launchset:preview -->")).toBe(true);
    expect(posted?.body).toContain("1.5.0-pr.123.17");
    expect(posted?.body).toContain(
      "[**failed**](https://github.com/acme/app/actions/runs/100/job/11)",
    );
    expect(posted?.body).toContain(
      "[succeeded](https://github.com/acme/app/actions/runs/100/job/12)",
    );
    expect(posted?.body).toContain("docker-api` failed");
    expect(posted?.body).toContain("ghcr.io/demonsters/api:pr-123");
    expect(result.summary).toContain("1.5.0-pr.123.17");
  });

  it("updates the existing comment and notes targets without a job", async () => {
    const { repo } = setup();
    const plan = await prPlan(repo);
    let patched: { body: string } | undefined;
    server.use(
      jobsHandler([job(12, "Preview android", "success")]),
      http.get(`${REPO}/issues/123/comments`, () =>
        HttpResponse.json([
          {
            id: 77,
            body: "<!-- launchset:preview -->\nold",
            html_url: "https://github.com/c/77",
            user: bot,
          },
        ]),
      ),
      http.patch(`${REPO}/issues/comments/77`, async ({ request }) => {
        patched = (await request.json()) as { body: string };
        return HttpResponse.json({ id: 77, html_url: "https://github.com/c/77" });
      }),
    );
    const result = await previewComment(context(repo), { plan });
    expect(result.data.unmatched).toEqual(["docker-api", "ios"]);
    expect(patched?.body).toContain("No build job found for `docker-api`, `ios`");
    expect(patched?.body).toContain("| `docker-api` | unknown |");
    expect(patched?.body).toContain("| `ios` | unknown |");
    expect(patched?.body).not.toContain("running");
    expect(result.lines[0]).toContain("updated");
  });

  it("still posts the comment when the jobs can't be read, and says so", async () => {
    const { repo } = setup();
    const plan = await prPlan(repo);
    let posted: { body: string } | undefined;
    server.use(
      http.get(`${REPO}/actions/runs/100/jobs`, () =>
        HttpResponse.json({ message: "Resource not accessible by integration" }, { status: 403 }),
      ),
      http.get(`${REPO}/issues/123/comments`, () => HttpResponse.json([])),
      http.post(`${REPO}/issues/123/comments`, async ({ request }) => {
        posted = (await request.json()) as { body: string };
        return HttpResponse.json({ id: 9, html_url: "https://github.com/c/9" }, { status: 201 });
      }),
    );
    const result = await previewComment(context(repo), { plan });
    expect(posted?.body).toContain("Couldn't read the job results");
    expect(posted?.body).toContain("| `android` | unknown |");
    expect(result.summary).toContain("Actions: read");
  });

  it("only comments on PR previews: a branch preview gets the job summary", async () => {
    const { repo } = setup();
    repo.checkout("-b", "develop");
    const head = repo.commit("feat", { ".launchset/a.md": changesetFile("minor", "Add a") });
    const plan = (
      await previewPlan(context(repo, { event: pushEvent("develop"), env: { GITHUB_SHA: head } }))
    ).outputs.plan as string;
    server.use(jobsHandler([job(12, "Preview android", "success")]));
    const result = await previewComment(context(repo), { plan });
    expect(result.data.kind).toBe("branch");
    expect(result.outputs).toEqual({});
    expect(result.summary).toContain("1.5.0-develop.17");
  });

  it("does nothing, loudly in the summary, when there is no plan", async () => {
    const { repo } = setup();
    const result = await previewComment(context(repo), { plan: "" });
    expect(result.ok).toBe(true);
    expect(result.data.kind).toBe("none");
    expect(result.summary).toContain("No preview plan");
  });

  it("rejects a release plan and needs a GitHub token", async () => {
    const { repo } = setup();
    const plan = await prPlan(repo);
    const release = JSON.stringify({ ...JSON.parse(plan), mode: "publish" });
    const wrong = await previewComment(context(repo), { plan: release }).catch((e: unknown) => e);
    expect((wrong as LaunchsetError).code).toBe("invalid-plan");
    const noToken = await previewComment(context(repo, { github: false }), { plan }).catch(
      (e: unknown) => e,
    );
    expect((noToken as LaunchsetError).code).toBe("no-github-token");
    const missing = await previewComment(context(repo), { plan: "{}" }).catch((e: unknown) => e);
    expect((missing as LaunchsetError).code).toBe("invalid-plan");
  });

  describe("prerelease branches", () => {
    async function prereleasePlan(repo: TestRepo): Promise<string> {
      // `main` has a pending changeset the branch inherits; the branch adds its own.
      repo.commit("pending on main", {
        ".launchset/on-main.md": changesetFile("patch", "Already on main"),
      });
      repo.git("push", "--quiet", "origin", "main");
      branchWithChangeset(repo, "next/login", "only-on-branch");
      const result = await previewPlan(context(repo, { event: pushEvent("next/login") }));
      return result.outputs.plan as string;
    }

    it("creates a pre-release (never latest) listing only the branch's changesets", async () => {
      const { repo } = setup();
      const plan = await prereleasePlan(repo);
      let created: Record<string, unknown> | undefined;
      server.use(
        jobsHandler([
          job(12, "Preview android", "success"),
          job(13, "Preview ios", "failure"),
          job(14, "Preview docker-api", "success"),
        ]),
        http.get(`${REPO}/releases/tags/v1.5.0-alpha.0`, () =>
          HttpResponse.json({ message: "Not Found" }, { status: 404 }),
        ),
        http.post(`${REPO}/releases`, async ({ request }) => {
          created = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(
            {
              id: 5,
              tag_name: "v1.5.0-alpha.0",
              name: "v1.5.0-alpha.0",
              body: created.body,
              prerelease: true,
              draft: false,
              html_url: "https://github.com/acme/app/releases/tag/v1.5.0-alpha.0",
            },
            { status: 201 },
          );
        }),
      );
      const result = await previewComment(context(repo), { plan });
      expect(result.data.kind).toBe("prerelease");
      expect(created).toMatchObject({
        tag_name: "v1.5.0-alpha.0",
        name: "v1.5.0-alpha.0",
        prerelease: true,
        make_latest: "false",
        draft: false,
      });
      const body = created?.body as string;
      expect(body).toContain("Add a thing in only-on-branch");
      expect(body).not.toContain("Already on main");
      expect(body).toContain("[**failed**](https://github.com/acme/app/actions/runs/100/job/13)");
      expect(result.outputs["release-url"]).toBe(
        "https://github.com/acme/app/releases/tag/v1.5.0-alpha.0",
      );
    });

    it("updates the pre-release when it exists (a repeated comment job)", async () => {
      const { repo } = setup();
      const plan = await prereleasePlan(repo);
      let patched: Record<string, unknown> | undefined;
      server.use(
        jobsHandler([job(12, "Preview android", "success")]),
        http.get(`${REPO}/releases/tags/v1.5.0-alpha.0`, () =>
          HttpResponse.json({
            id: 7,
            tag_name: "v1.5.0-alpha.0",
            name: "v1.5.0-alpha.0",
            body: "old",
            prerelease: true,
            draft: false,
            html_url: "https://github.com/acme/app/releases/tag/v1.5.0-alpha.0",
          }),
        ),
        http.patch(`${REPO}/releases/7`, async ({ request }) => {
          patched = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({
            id: 7,
            tag_name: "v1.5.0-alpha.0",
            name: "v1.5.0-alpha.0",
            body: patched.body,
            prerelease: true,
            draft: false,
            html_url: "https://github.com/acme/app/releases/tag/v1.5.0-alpha.0",
          });
        }),
      );
      const result = await previewComment(context(repo), { plan });
      expect(patched).toMatchObject({ prerelease: true, make_latest: "false" });
      expect(patched?.body as string).toContain("only-on-branch");
      expect(result.lines[0]).toContain("updated");
    });

    it("lists every pending changeset when the base branch isn't in the checkout", async () => {
      const { repo } = setup();
      const plan = await prereleasePlan(repo);
      repo.git("update-ref", "-d", "refs/remotes/origin/main");
      let created: { body: string } | undefined;
      server.use(
        jobsHandler([]),
        http.get(`${REPO}/releases/tags/v1.5.0-alpha.0`, () =>
          HttpResponse.json({ message: "Not Found" }, { status: 404 }),
        ),
        http.post(`${REPO}/releases`, async ({ request }) => {
          created = (await request.json()) as { body: string };
          return HttpResponse.json(
            {
              id: 5,
              tag_name: "v1.5.0-alpha.0",
              name: "v1.5.0-alpha.0",
              body: created.body,
              prerelease: true,
              draft: false,
              html_url: "https://github.com/acme/app/releases/tag/v1.5.0-alpha.0",
            },
            { status: 201 },
          );
        }),
      );
      await previewComment(context(repo), { plan });
      expect(created?.body).toContain("Already on main");
      expect(created?.body).toContain("only-on-branch");
      expect(created?.body).toContain("fetch-depth: 0");
    });
  });
});
