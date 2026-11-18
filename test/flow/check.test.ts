import { describe, expect, it } from "vitest";
import { check } from "../../src/flow/check.ts";
import { status } from "../../src/flow/status.ts";
import {
  changesetText,
  contextFor,
  FakeGitHub,
  gradle,
  type Project,
  setupProject,
} from "./helpers.ts";

const repoInfo = { full_name: "acme/app" };

function prEvent(project: Project, base: string, overrides: Record<string, unknown> = {}) {
  return {
    name: "pull_request",
    payload: {
      pull_request: {
        number: 7,
        user: { login: "someone" },
        head: { ref: "feature", sha: project.repo.head(), repo: repoInfo },
        base: { ref: "main", sha: base, repo: repoInfo },
        ...overrides,
      },
    },
  };
}

/** A feature branch off main; returns main's sha. */
function featureBranch(project: Project): string {
  const base = project.repo.head();
  project.repo.checkout("-b", "feature");
  return base;
}

describe("check (PR)", () => {
  it("passes with a changeset and keeps one sticky comment up to date", async () => {
    const project = setupProject();
    const base = featureBranch(project);
    project.repo.commit("Offline mode", {
      ".launchset/brave-lions-sing.md": changesetText("minor", "Add offline mode."),
    });
    const github = new FakeGitHub(project.remote);
    const first = await check(await contextFor(project.repo, { event: prEvent(project, base) }));
    expect(first.ok).toBe(true);
    expect(first.data.result).toMatchObject({
      reason: "changeset",
      bump: "minor",
      nextVersion: "1.5.0",
    });
    expect(first.data.comment?.action).toBe("created");
    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]?.body).toContain("<!-- launchset:check -->");
    expect(github.comments[0]?.body).toContain("The next release will be **1.5.0** (minor).");

    // A second changeset: the same comment is updated.
    project.repo.commit("Fix", {
      ".launchset/calm-cats-nap.md": changesetText("patch", "Fix it."),
    });
    const second = await check(await contextFor(project.repo, { event: prEvent(project, base) }));
    expect(second.data.comment?.action).toBe("updated");
    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]?.body).toContain("2 changesets found");
  });

  it("fails without a changeset and explains how to add one", async () => {
    const project = setupProject();
    const base = featureBranch(project);
    project.repo.commit("Work", { "src.txt": "x\n" });
    const github = new FakeGitHub(project.remote);
    const result = await check(await contextFor(project.repo, { event: prEvent(project, base) }));
    expect(result.ok).toBe(false);
    expect(result.data.result.failures.map((f) => f.code)).toEqual(["no-changeset"]);
    expect(github.comments[0]?.body).toContain("npx @demonsters/launchset add");
    expect(result.lines[0]).toBe("launchset check: failed");
  });

  it("passes for a bot author and for the release PR, but not a fork's look-alike branch", async () => {
    const project = setupProject();
    const base = featureBranch(project);
    project.repo.commit("Bump lodash", { "deps.txt": "lodash\n" });
    new FakeGitHub(project.remote);
    const bot = await check(
      await contextFor(project.repo, {
        event: prEvent(project, base, { user: { login: "dependabot[bot]" } }),
      }),
    );
    expect(bot.ok).toBe(true);
    expect(bot.data.result.reason).toBe("bot");

    const head = (repo: unknown) => ({
      ref: "launchset/release/main",
      sha: project.repo.head(),
      repo,
    });
    const releasePr = await check(
      await contextFor(project.repo, { event: prEvent(project, base, { head: head(repoInfo) }) }),
    );
    expect(releasePr.ok).toBe(true);
    expect(releasePr.data.result.reason).toBe("release-pr");
    const fork = await check(
      await contextFor(project.repo, {
        event: prEvent(project, base, { head: head({ full_name: "evil/app" }) }),
      }),
    );
    expect(fork.ok).toBe(false);
  });

  it("fails on invalid changesets and version mismatches", async () => {
    const project = setupProject();
    const base = featureBranch(project);
    project.repo.commit("Broken", {
      ".launchset/bad-one-here.md": "---\nbump: huge\n---\n\nx\n",
      "android/app/build.gradle": gradle("1.3.0"),
    });
    new FakeGitHub(project.remote);
    const result = await check(await contextFor(project.repo, { event: prEvent(project, base) }));
    expect(result.ok).toBe(false);
    const codes = result.data.result.failures.map((f) => f.code);
    expect(codes).toContain("invalid-changeset");
    expect(codes).toContain("version-mismatch");
  });

  it("reports a read-only token on a fork PR as a warning, other 403s as errors", async () => {
    const project = setupProject();
    const base = featureBranch(project);
    project.repo.commit("Offline mode", {
      ".launchset/brave-lions-sing.md": changesetText("minor", "Add offline mode."),
    });
    const github = new FakeGitHub(project.remote);
    github.readOnlyComments = true;
    const forkHead = {
      ref: "feature",
      sha: project.repo.head(),
      repo: { full_name: "someone/app" },
    };
    const result = await check(
      await contextFor(project.repo, { event: prEvent(project, base, { head: forkHead }) }),
    );
    expect(result.ok).toBe(true);
    expect(result.data.commentWarning).toContain("read-only");
    expect(result.summary).toContain("> [!WARNING]");

    await expect(
      check(await contextFor(project.repo, { event: prEvent(project, base) })),
    ).rejects.toMatchObject({
      code: "comment-forbidden",
      hint: expect.stringContaining("pull-requests: write"),
    });
  });

  it("runs locally against a base ref without a token", async () => {
    const project = setupProject();
    featureBranch(project);
    project.repo.commit("Offline mode", {
      ".launchset/brave-lions-sing.md": changesetText("patch", "Fix it."),
    });
    const result = await check(await contextFor(project.repo, { token: null }), { base: "main" });
    expect(result.ok).toBe(true);
    expect(result.data.comment).toBeUndefined();
  });

  it("does not count a pure rename of an existing changeset", async () => {
    const project = setupProject();
    project.push("Pending", {
      ".launchset/brave-lions-sing.md": changesetText("minor", "Add offline mode."),
    });
    const base = featureBranch(project);
    project.repo.git("mv", ".launchset/brave-lions-sing.md", ".launchset/calm-cats-nap.md");
    project.repo.commit("Rename");
    new FakeGitHub(project.remote);
    const result = await check(await contextFor(project.repo, { event: prEvent(project, base) }));
    expect(result.ok).toBe(false);
    expect(result.data.result.failures.map((f) => f.code)).toEqual(["no-changeset"]);
  });
});

describe("check --push", () => {
  it("warns about commits without a changeset and never fails", async () => {
    const project = setupProject();
    project.repo.commit("Direct push", { "src.txt": "x\n" });
    const result = await check(await contextFor(project.repo, { token: null }), { push: true });
    expect(result.ok).toBe(true);
    expect(result.data.result.warnings[0]).toContain(
      "1 commit since v1.4.0 and no pending changeset",
    );
    project.repo.write(".launchset/brave-lions-sing.md", changesetText("patch", "Fix it."));
    const covered = await check(await contextFor(project.repo, { token: null }), { push: true });
    expect(covered.data.result.warnings).toEqual([]);
  });
});

describe("status", () => {
  it("shows pending changesets, the next version and manual targets", async () => {
    const project = setupProject();
    project.repo.write(
      ".launchset/brave-lions-sing.md",
      changesetText("minor", "Add offline mode."),
    );
    const result = await status(await contextFor(project.repo, { token: null }));
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      version: "1.4.0",
      bump: "minor",
      nextVersion: "1.5.0",
      lastRelease: { version: "1.4.0", tag: "v1.4.0" },
      consistency: { ok: true },
      manualTargets: [{ target: "ios", lastShipped: null, releasesBehind: 1 }],
    });
    expect(result.lines).toContain("Next version:  1.5.0 (minor)");
  });

  it("--require-changeset fails unless a changeset is new compared with --since", async () => {
    const project = setupProject();
    project.push("Pending", {
      ".launchset/brave-lions-sing.md": changesetText("minor", "Add offline mode."),
    });
    const context = async () => contextFor(project.repo, { token: null });
    const none = await status(await context(), { requireChangeset: true });
    expect(none.ok).toBe(false);
    expect(none.data.requireChangeset).toMatchObject({ since: "origin/main", changesets: [] });
    project.repo.write(".launchset/calm-cats-nap.md", changesetText("patch", "Fix it."));
    const one = await status(await context(), { requireChangeset: true, since: "main" });
    expect(one.ok).toBe(true);
    expect(one.data.requireChangeset?.changesets).toEqual([".launchset/calm-cats-nap.md"]);
  });
});
