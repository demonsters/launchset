import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  authConfigEnv,
  basicAuthHeader,
  Git,
  GitError,
  LAUNCHSET_IDENTITY,
  LeaseError,
  normalizeServerUrl,
  parseGitHubRepo,
  TagExistsError,
} from "../../src/git/index.ts";
import { cloneRepo, initRepo, repoWithRemote, sh, tempDir } from "./helpers.ts";

describe("refs and history", () => {
  it("reads HEAD, branch, refs and ancestry", async () => {
    const repo = initRepo();
    const a = repo.commit("a");
    const b = repo.commit("b");
    const git = new Git({ cwd: repo.dir });
    expect(await git.headSha()).toBe(b);
    expect(await git.currentBranch()).toBe("main");
    expect(await git.revParse("HEAD~1")).toBe(a);
    expect(await git.tryRevParse("nope")).toBeUndefined();
    await expect(git.revParse("nope")).rejects.toThrow(/Unknown git ref "nope"/);
    expect(await git.isAncestor(a, b)).toBe(true);
    expect(await git.isAncestor(b, a)).toBe(false);
    await expect(git.isAncestor("nope", b)).rejects.toBeInstanceOf(GitError);
    expect(await git.parents(b)).toEqual([a]);
    expect(await git.parents(a)).toEqual([]);

    repo.checkout("--detach", "HEAD~1");
    expect(await git.currentBranch()).toBeUndefined();
  });

  it("lists first-parent history, ranges and log entries", async () => {
    const repo = initRepo();
    const a = repo.commit("a");
    repo.checkout("-b", "feature");
    const f = repo.commit("feature: one");
    repo.checkout("main");
    const b = repo.commit("b");
    const m = repo.merge("feature", "Merge feature; with `odd` chars | ok");
    const git = new Git({ cwd: repo.dir });

    expect(await git.firstParentLog("HEAD")).toEqual([m, b, a]);
    expect(await git.firstParentLog("HEAD", { limit: 2 })).toEqual([m, b]);
    expect(await git.revList(`${a}..HEAD`)).toHaveLength(3);
    expect(await git.revList(`${a}..HEAD`, { firstParent: true })).toEqual([m, b]);
    expect(await git.revList(`${a}..HEAD`)).toContain(f);

    const log = await git.logRange(`${a}..HEAD`, { firstParent: true });
    expect(log).toEqual([
      {
        sha: m,
        subject: "Merge feature; with `odd` chars | ok",
        author: "Test",
        authorEmail: "test@example.com",
      },
      { sha: b, subject: "b", author: "Test", authorEmail: "test@example.com" },
    ]);
    expect((await git.logRange(`${a}..HEAD`)).map((e) => e.sha)).toContain(f);
    expect(await git.logRange("HEAD..HEAD")).toEqual([]);
  });

  it("shows a file at a commit, undefined when missing", async () => {
    const repo = initRepo();
    const a = repo.commit("a", { "pkg/package.json": '{"version":"1.0.0"}\n' });
    const b = repo.commit("b", {
      "pkg/package.json": '{"version":"1.1.0"}\n',
      "pkg/sub/x.txt": "x",
    });
    const git = new Git({ cwd: join(repo.dir, "pkg") });
    expect(await git.showFile(a, "pkg/package.json")).toBe('{"version":"1.0.0"}\n');
    expect(await git.showFile(b, "pkg/package.json")).toBe('{"version":"1.1.0"}\n');
    expect(await git.showFile(a, "pkg/sub/x.txt")).toBeUndefined();
    expect(await git.showFile(b, "pkg/sub")).toBeUndefined();
    expect(await git.showFile(b, "package.json")).toBeUndefined();
    await expect(git.showFile("0".repeat(40), "pkg/package.json")).rejects.toBeInstanceOf(GitError);
  });

  it("lists the files of a directory and reads their blobs in one batch", async () => {
    const repo = initRepo();
    const a = repo.commit("a", {
      "pkg/.launchset/one.md": "---\nbump: patch\n---\n\nFix ünïcode ✓\n",
      "pkg/.launchset/two.md": "",
      "pkg/.launchset/nested/three.md": "x",
    });
    const git = new Git({ cwd: join(repo.dir, "pkg") });
    const files = await git.listFiles(a, "pkg/.launchset");
    expect(files.map((f) => f.path)).toEqual(["pkg/.launchset/one.md", "pkg/.launchset/two.md"]);
    const blobs = await git.readBlobs([...files.map((f) => f.blob), "0".repeat(40)]);
    expect(blobs.get(files[0]?.blob ?? "")).toBe("---\nbump: patch\n---\n\nFix ünïcode ✓\n");
    expect(blobs.get(files[1]?.blob ?? "")).toBe("");
    expect(blobs.has("0".repeat(40))).toBe(false);
    // `<commit>:<path>` names work too; a tree isn't a blob.
    const byPath = await git.readBlobs([
      `${a}:pkg/.launchset/two.md`,
      `${a}:pkg/.launchset/nested`,
    ]);
    expect([...byPath.keys()]).toEqual([`${a}:pkg/.launchset/two.md`]);
    expect(await git.readBlobs([])).toEqual(new Map());
    expect(await git.listFiles(a, "pkg/missing")).toEqual([]);
  });

  it("reads trees and parents, and merge bases", async () => {
    const repo = initRepo();
    const a = repo.commit("a");
    const b = repo.commit("b");
    repo.checkout("--orphan", "other");
    const c = repo.commit("c");
    const git = new Git({ cwd: repo.dir });
    expect(await git.treeAndParents(b)).toEqual({
      tree: repo.git("rev-parse", `${b}^{tree}`),
      parents: [a],
    });
    expect((await git.treeAndParents(a)).parents).toEqual([]);
    expect(await git.mergeBase(a, b)).toBe(a);
    expect(await git.mergeBase(b, c)).toBeUndefined();
  });

  it("lists changed files against the merge base, with statuses", async () => {
    const repo = initRepo();
    repo.commit("base", {
      "keep.txt": "keep\n",
      "edit.txt": "one\n",
      "gone.txt": "bye\n",
      "old-name.txt": "a\nb\nc\nd\n",
    });
    repo.checkout("-b", "feature");
    repo.write("edit.txt", "two\n");
    repo.write("new file.txt", "new\n");
    repo.git("rm", "--quiet", "gone.txt");
    repo.git("mv", "old-name.txt", "new-name.txt");
    repo.commit("feature work");
    repo.checkout("main");
    repo.commit("main moves on", { "main-only.txt": "m\n" });
    const git = new Git({ cwd: repo.dir });

    const files = await git.changedFiles("main", "feature");
    expect(files.sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { status: "M", path: "edit.txt" },
      { status: "D", path: "gone.txt" },
      { status: "A", path: "new file.txt" },
      { status: "R", path: "new-name.txt", oldPath: "old-name.txt", similarity: 100 },
    ]);
    expect(await git.changedFiles("feature", "feature")).toEqual([]);
  });

  it("uses repo-relative paths everywhere when cwd is a subdirectory", async () => {
    const repo = initRepo();
    repo.commit("root", { "README.md": "r\n" });
    const added = repo.commit("add changeset", {
      "apps/mobile/.launchset/a.md": "a\n",
      "apps/mobile/package.json": '{"version":"1.0.0"}\n',
    });
    const bump = repo.commit("bump", { "apps/mobile/package.json": '{"version":"1.1.0"}\n' });
    repo.commit("other", { "apps/web/x.txt": "x" });
    const git = new Git({ cwd: join(repo.dir, "apps", "mobile") });

    expect(await git.prefix()).toBe("apps/mobile/");
    expect(await git.toRepoPath("package.json")).toBe("apps/mobile/package.json");
    expect(await git.toRepoPath("./.launchset/a.md")).toBe("apps/mobile/.launchset/a.md");
    expect(await git.toRepoPath("../web/x.txt")).toBe("apps/web/x.txt");
    await expect(git.toRepoPath("../../../outside")).rejects.toThrow(/outside the git repository/);
    expect(await git.fromRepoPath("apps/mobile/package.json")).toBe("package.json");
    expect(await git.fromRepoPath("apps/web/x.txt")).toBeUndefined();
    expect(await new Git({ cwd: repo.dir }).prefix()).toBe("");
    expect(await new Git({ cwd: repo.dir }).fromRepoPath("a/b")).toBe("a/b");

    expect(await git.revList("HEAD", { paths: ["apps/mobile/package.json"] })).toEqual([
      bump,
      added,
    ]);
    expect(await git.revList("HEAD", { paths: ["package.json"] })).toEqual([]);
    expect(await git.commitsAddingFile("apps/mobile/.launchset/a.md")).toEqual([added]);
    expect(await git.commitsAddingFile(".launchset/a.md")).toEqual([]);
    expect(await git.showFile(bump, "apps/mobile/package.json")).toBe('{"version":"1.1.0"}\n');

    // Literal pathspecs: glob characters aren't expanded.
    expect(await git.revList("HEAD", { paths: ["apps/*/package.json"] })).toEqual([]);

    repo.write("apps/mobile/package.json", '{"version":"1.2.0"}\n');
    repo.write("apps/mobile/CHANGELOG.md", "# Changelog\n");
    await git.commit("Release v1.2.0", {
      add: ["apps/mobile/package.json", "apps/mobile/CHANGELOG.md"],
      remove: ["apps/mobile/.launchset/a.md"],
    });
    expect(repo.git("show", "--name-status", "--format=", "HEAD").split("\n").sort()).toEqual([
      "A\tapps/mobile/CHANGELOG.md",
      "D\tapps/mobile/.launchset/a.md",
      "M\tapps/mobile/package.json",
    ]);
    repo.write("apps/web/x.txt", "changed");
    await git.commitAll("web", ["apps/web/x.txt"]);
    expect(await git.isClean()).toBe(true);
    expect(await git.commitDate("HEAD")).toMatch(/^\d{4}-\d\d-\d\dT/);

    // diff.relative in the user's config doesn't change changedFiles' output.
    repo.git("config", "diff.relative", "true");
    expect((await git.changedFiles(bump, "HEAD")).map((f) => f.path).sort()).toEqual([
      "apps/mobile/.launchset/a.md",
      "apps/mobile/CHANGELOG.md",
      "apps/mobile/package.json",
      "apps/web/x.txt",
    ]);
  });

  it("reports clean and dirty working trees", async () => {
    const repo = initRepo();
    repo.commit("a", { "a.txt": "a" });
    const git = new Git({ cwd: repo.dir });
    expect(await git.isClean()).toBe(true);
    repo.write("untracked.txt", "x");
    expect(await git.isClean()).toBe(false);
  });
});

describe("tags", () => {
  it("lists lightweight and annotated tags with peeled shas, and merged tags", async () => {
    const repo = initRepo();
    const a = repo.commit("a");
    repo.git("tag", "v1.0.0");
    repo.git("tag", "-a", "-m", "annotated", "launchset/web@1.0.0");
    repo.git("tag", "-a", "-m", "tag of tag", "nested", "launchset/web@1.0.0");
    repo.checkout("-b", "side");
    const s = repo.commit("side");
    repo.git("tag", "v1.1.0-alpha.0");
    repo.git("tag", "tree-tag", "HEAD^{tree}");
    repo.checkout("main");
    const git = new Git({ cwd: repo.dir });

    expect(await git.tags()).toEqual([
      { name: "launchset/web@1.0.0", sha: a },
      { name: "nested", sha: a },
      { name: "v1.0.0", sha: a },
      { name: "v1.1.0-alpha.0", sha: s },
    ]);
    expect((await git.tagsMerged("main")).map((t) => t.name)).toEqual([
      "launchset/web@1.0.0",
      "nested",
      "v1.0.0",
    ]);
    expect((await git.tagsMerged("side")).map((t) => t.name)).toContain("v1.1.0-alpha.0");
  });

  it("creates, pushes, fetches and deletes tags", async () => {
    const { remote, repo } = repoWithRemote();
    const git = new Git({ cwd: repo.dir });
    const head = repo.head();
    await git.createTag("launchset/api@1.0.0", head);
    expect(await git.pushTag("launchset/api@1.0.0")).toBe("created");
    expect(sh(remote, "rev-parse", "refs/tags/launchset/api@1.0.0")).toBe(head);
    // Pushing the same tag at the same commit again is a no-op.
    expect(await git.pushTag("launchset/api@1.0.0")).toBe("up-to-date");

    await git.deleteLocalTag("launchset/api@1.0.0");
    expect(await git.tags()).toEqual([]);
    const other = cloneRepo(remote);
    other.git("tag", "v2.0.0");
    other.git("push", "--quiet", "origin", "v2.0.0");
    await git.fetchTags();
    expect((await git.tags()).map((t) => t.name)).toEqual(["launchset/api@1.0.0", "v2.0.0"]);

    await expect(git.createTag("-bad", head)).rejects.toThrow(/Invalid tag name/);
    await expect(git.createTag("has space", head)).rejects.toThrow(/Invalid tag name/);
  });

  it("pushes a branch with a lease, and throws LeaseError when another clone moved it", async () => {
    const { remote, repo } = repoWithRemote();
    const git = new Git({ cwd: repo.dir });
    repo.git("checkout", "--quiet", "-b", "launchset/release/main");
    const ours = repo.commit("our rebuild");
    // The branch doesn't exist yet: expect null creates it.
    expect(await git.pushBranch("launchset/release/main", { expect: null })).toBe("created");
    // Another run rebuilds and pushes it.
    const other = cloneRepo(remote);
    other.git(
      "checkout",
      "--quiet",
      "-b",
      "launchset/release/main",
      "origin/launchset/release/main",
    );
    other.commit("newer run's rebuild");
    other.git("push", "--quiet", "--force", "origin", "launchset/release/main");
    // We still expect our old commit there: the lease fails, the newer push stays.
    repo.commit("stale rebuild");
    const error = await git
      .pushBranch("launchset/release/main", { expect: ours })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LeaseError);
    expect(sh(remote, "rev-parse", "refs/heads/launchset/release/main")).toBe(other.head());
  });

  it("throws TagExistsError when another clone pushed the same tag first", async () => {
    const { remote, repo } = repoWithRemote();
    const first = cloneRepo(remote);
    first.commit("first run's commit");
    first.git("push", "--quiet", "origin", "HEAD:main");
    first.git("tag", "v1.5.0-alpha.0");
    first.git("push", "--quiet", "origin", "v1.5.0-alpha.0");

    // The second run reserves the same number at its own (different) commit.
    const sha = repo.commit("second run's commit");
    const git = new Git({ cwd: repo.dir });
    await git.createTag("v1.5.0-alpha.0", sha);
    const error = await git.pushTag("v1.5.0-alpha.0").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TagExistsError);
    expect((error as TagExistsError).tag).toBe("v1.5.0-alpha.0");
    expect((error as TagExistsError).message).toMatch(/already exists on the remote/);

    // Retry with the next number works.
    await git.deleteLocalTag("v1.5.0-alpha.0");
    await git.createTag("v1.5.0-alpha.1", sha);
    expect(await git.pushTag("v1.5.0-alpha.1")).toBe("created");
  });

  it("throws TagExistsError when the remote rejects with 'reference already exists' (lost race)", async () => {
    const { remote, repo } = repoWithRemote();
    const remoteHead = sh(remote, "rev-parse", "main");
    // Simulate a concurrent push landing between ref advertisement and the update.
    const hook = join(remote, "hooks", "pre-receive");
    writeFileSync(
      hook,
      [
        "#!/bin/sh",
        "cat > /dev/null",
        "unset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES",
        `git update-ref refs/tags/v2.0.0-beta.0 ${remoteHead}`,
        "",
      ].join("\n"),
    );
    chmodSync(hook, 0o755);
    const sha = repo.commit("mine");
    const git = new Git({ cwd: repo.dir });
    await git.createTag("v2.0.0-beta.0", sha);
    const error = await git.pushTag("v2.0.0-beta.0").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TagExistsError);
    expect((error as TagExistsError).stderr).toMatch(/reference already exists|already exists/);
  });

  it("detects an existing tag via ls-remote whatever the rejection wording", async () => {
    const { remote, repo } = repoWithRemote();
    const remoteHead = sh(remote, "rev-parse", "main");
    const hook = join(remote, "hooks", "pre-receive");
    // Another run creates the tag meanwhile, and the server answers with unusual wording.
    writeFileSync(
      hook,
      [
        "#!/bin/sh",
        "cat > /dev/null",
        "unset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES",
        `git update-ref refs/tags/v3.0.0-rc.0 ${remoteHead}`,
        "echo 'push declined: something unexpected' >&2",
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(hook, 0o755);
    const git = new Git({ cwd: repo.dir });
    await git.createTag("v3.0.0-rc.0", repo.commit("mine"));
    const error = await git.pushTag("v3.0.0-rc.0").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TagExistsError);
    expect((error as TagExistsError).stderr).toContain("something unexpected");
  });

  it("reports up-to-date when a failed push left the tag at our commit", async () => {
    const { remote, repo } = repoWithRemote();
    const sha = repo.commit("mine");
    repo.git("push", "--quiet", "origin", "HEAD:refs/heads/other");
    const hook = join(remote, "hooks", "pre-receive");
    writeFileSync(
      hook,
      [
        "#!/bin/sh",
        "cat > /dev/null",
        "unset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES",
        `git update-ref refs/tags/v3.1.0 ${sha}`,
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(hook, 0o755);
    const git = new Git({ cwd: repo.dir });
    await git.createTag("v3.1.0", sha);
    expect(await git.pushTag("v3.1.0")).toBe("up-to-date");
  });

  it("creates and pushes a tag, removing the local tag when the push fails", async () => {
    const { remote, repo } = repoWithRemote();
    const git = new Git({ cwd: repo.dir });
    expect(await git.createAndPushTag("v1.0.0", repo.head())).toBe("created");
    expect(sh(remote, "rev-parse", "refs/tags/v1.0.0")).toBe(repo.head());
    const other = cloneRepo(remote);
    const elsewhere = other.commit("elsewhere");
    other.git("tag", "v1.1.0", elsewhere);
    other.git("push", "--quiet", "origin", "refs/tags/v1.1.0");
    await expect(git.createAndPushTag("v1.1.0", repo.head())).rejects.toBeInstanceOf(
      TagExistsError,
    );
    expect(repo.git("tag", "--list", "v1.1.0")).toBe("");
  });

  it("throws a plain GitError for other push failures", async () => {
    const { remote, repo } = repoWithRemote();
    const hook = join(remote, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'GH013: Repository rule violations found' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const git = new Git({ cwd: repo.dir });
    await git.createTag("v1.0.0", repo.head());
    const error = await git.pushTag("v1.0.0").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error).not.toBeInstanceOf(TagExistsError);
    expect((error as GitError).message).toMatch(/git push --porcelain origin refs\/tags\/v1.0.0/);
    expect((error as GitError).hint).toMatch(/ruleset/);
    expect((error as GitError).reason).toBe("protected");
  });
});

describe("branches and commits", () => {
  it("commits as launchset without a configured git user", async () => {
    const { repo } = repoWithRemote();
    repo.commit("add changesets", {
      ".launchset/a.md": "a",
      ".launchset/b.md": "b",
      "package.json": "{}",
    });
    const git = new Git({ cwd: repo.dir });
    await git.checkoutNewBranch("launchset/release/main", "main");
    expect(await git.currentBranch()).toBe("launchset/release/main");

    repo.write("package.json", '{"version":"1.1.0"}');
    repo.write("CHANGELOG.md", "# Changelog\n");
    const sha = await git.commit("Release v1.1.0", {
      add: ["package.json", "CHANGELOG.md"],
      remove: [".launchset/a.md", ".launchset/b.md"],
    });
    expect(sha).toBe(repo.head());
    expect(repo.git("log", "-1", "--format=%an <%ae>|%cn <%ce>|%s")).toBe(
      `${LAUNCHSET_IDENTITY.name} <${LAUNCHSET_IDENTITY.email}>|${LAUNCHSET_IDENTITY.name} <${LAUNCHSET_IDENTITY.email}>|Release v1.1.0`,
    );
    expect(repo.git("show", "--name-status", "--format=", "HEAD").split("\n").sort()).toEqual([
      "A\tCHANGELOG.md",
      "D\t.launchset/a.md",
      "D\t.launchset/b.md",
      "M\tpackage.json",
    ]);
    expect(await git.isClean()).toBe(true);

    // commitAll stages deletions done on disk too.
    repo.git("rm", "--quiet", "--cached", "CHANGELOG.md");
    repo.write("CHANGELOG.md", "# Changelog\n\n## 1.1.0\n");
    await git.commitAll("Changelog: v1.1.0", ["CHANGELOG.md"]);
    expect(repo.git("show", "HEAD:CHANGELOG.md")).toBe("# Changelog\n\n## 1.1.0");

    await expect(git.commit("nothing")).rejects.toMatchObject({
      hint: expect.stringMatching(/no changes to commit/),
    });
  });

  it("can use a custom identity", async () => {
    const repo = initRepo();
    repo.commit("a");
    const git = new Git({
      cwd: repo.dir,
      identity: { name: "acme-launchset[bot]", email: "1+acme@x" },
    });
    repo.write("x.txt", "x");
    await git.commitAll("x", ["x.txt"]);
    expect(repo.git("log", "-1", "--format=%an <%ae>")).toBe("acme-launchset[bot] <1+acme@x>");
  });

  it("force-pushes the rebuilt release branch and checks remote branches", async () => {
    const { remote, repo } = repoWithRemote();
    const git = new Git({ cwd: repo.dir });
    expect(await git.remoteBranchExists("launchset/release/main")).toBe(false);

    await git.checkoutNewBranch("launchset/release/main", "main");
    repo.write("package.json", '{"version":"1.1.0"}');
    await git.commitAll("Release v1.1.0", ["package.json"]);
    expect(await git.pushBranch("launchset/release/main")).toBe("created");
    expect(await git.remoteBranchExists("launchset/release/main")).toBe(true);

    // Next run: main moved on, the branch is rebuilt from it (not a fast-forward).
    repo.checkout("main");
    repo.commit("feature on main");
    repo.git("push", "--quiet", "origin", "main");
    await git.checkoutNewBranch("launchset/release/main", "main");
    repo.write("package.json", '{"version":"1.2.0"}');
    const rebuilt = await git.commitAll("Release v1.2.0", ["package.json"]);
    await expect(git.pushBranch("launchset/release/main")).rejects.toThrow(
      /rejected|fetch first|non-fast-forward/,
    );
    expect(await git.pushBranch("launchset/release/main", { force: true })).toBe("updated");
    expect(sh(remote, "rev-parse", "refs/heads/launchset/release/main")).toBe(rebuilt);
  });
});

describe("remote", () => {
  it("parses owner/repo from the remote", async () => {
    const repo = initRepo();
    const git = new Git({ cwd: repo.dir });
    expect(await git.repoFromRemote()).toBeUndefined();
    await expect(git.remoteUrl()).rejects.toBeInstanceOf(GitError);
    repo.git("remote", "add", "origin", "https://github.com/demonsters/app.git");
    expect(await git.remoteUrl()).toBe("https://github.com/demonsters/app.git");
    expect(await git.repoFromRemote()).toBe("demonsters/app");
  });

  it.each([
    ["https://github.com/acme/app.git", "acme/app"],
    ["https://github.com/acme/app", "acme/app"],
    ["https://x-access-token:abc@github.com/acme/app.git", "acme/app"],
    ["git@github.com:acme/app.git", "acme/app"],
    ["git@github.com:acme/my.app", "acme/my.app"],
    ["ssh://git@github.com/acme/app.git", "acme/app"],
    ["ssh://git@github.com:22/acme/app.git", undefined],
    ["https://gitlab.com/acme/app.git", undefined],
    ["/tmp/remote.git", undefined],
    ["https://github.com/acme", undefined],
  ])("parseGitHubRepo(%s)", (url, expected) => {
    expect(parseGitHubRepo(url)).toBe(expected);
  });

  it("recognises the GitHub Enterprise server host", () => {
    expect(parseGitHubRepo("https://ghe.acme.com/team/app.git", "https://ghe.acme.com")).toBe(
      "team/app",
    );
    expect(parseGitHubRepo("git@ghe.acme.com:team/app.git", "https://ghe.acme.com/")).toBe(
      "team/app",
    );
  });
});

describe("authentication", () => {
  it("builds the extraheader config env: reset first, then the token, after existing entries", () => {
    const header = `AUTHORIZATION: basic ${Buffer.from("x-access-token:ghs_secret").toString("base64")}`;
    expect(basicAuthHeader("ghs_secret")).toBe(header);
    expect(authConfigEnv("ghs_secret", undefined, {})).toEqual({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_1: header,
    });
    expect(authConfigEnv("ghs_secret", "https://ghe.acme.com", { GIT_CONFIG_COUNT: "1" })).toEqual({
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_1: "http.https://ghe.acme.com/.extraheader",
      GIT_CONFIG_VALUE_1: "",
      GIT_CONFIG_KEY_2: "http.https://ghe.acme.com/.extraheader",
      GIT_CONFIG_VALUE_2: header,
    });
    expect(normalizeServerUrl(undefined)).toBe("https://github.com/");
    expect(normalizeServerUrl("")).toBe("https://github.com/");
    expect(normalizeServerUrl("https://ghe.acme.com/")).toBe("https://ghe.acme.com/");
  });

  it("sends only the App token header, replacing a persisted GITHUB_TOKEN header, and never prints it", async () => {
    const seen: string[][] = [];
    const server = createServer((req: IncomingMessage, res) => {
      const auth: string[] = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i]?.toLowerCase() === "authorization")
          auth.push(req.rawHeaders[i + 1] ?? "");
      }
      seen.push(auth);
      res.statusCode = 403;
      res.end("forbidden");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const serverUrl = `http://127.0.0.1:${port}`;
      const repo = initRepo();
      repo.commit("a");
      repo.git("remote", "add", "origin", `${serverUrl}/acme/app.git`);
      // What actions/checkout persists for GITHUB_TOKEN.
      repo.git("config", `http.${serverUrl}/.extraheader`, "AUTHORIZATION: basic R0lUSFVCX1RPS0VO");

      const token = "ghs_AppInstallationToken123";
      const git = new Git({ cwd: repo.dir, token, serverUrl });
      // Record every git invocation's argv through a wrapper on PATH.
      const bin = tempDir("bin");
      const argvLog = join(bin, "argv.log");
      const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
      writeFileSync(
        join(bin, "git"),
        `#!/bin/sh\nprintf '%s\\n' "$@" >> '${argvLog}'\nexec '${realGit}' "$@"\n`,
      );
      chmodSync(join(bin, "git"), 0o755);
      const oldPath = process.env.PATH;
      process.env.PATH = `${bin}:${oldPath}`;
      let error: unknown;
      try {
        error = await git.remoteBranchExists("main").catch((e: unknown) => e);
      } finally {
        process.env.PATH = oldPath;
      }
      const argv = readFileSync(argvLog, "utf8");
      expect(argv).toContain("ls-remote");
      expect(argv).not.toContain(token);
      expect(argv).not.toContain(Buffer.from(`x-access-token:${token}`).toString("base64"));
      expect(argv).not.toContain("extraheader");
      expect(error).toBeInstanceOf(GitError);
      expect(seen.length).toBeGreaterThan(0);
      for (const headers of seen)
        expect(headers).toEqual([basicAuthHeader(token).slice("AUTHORIZATION: ".length)]);

      const message = String((error as GitError).message);
      expect(message).toMatch(/git ls-remote --exit-code --heads origin refs\/heads\/main/);
      expect(message).not.toContain(token);
      expect(message).not.toContain(Buffer.from(`x-access-token:${token}`).toString("base64"));
      expect((error as GitError).hint).toMatch(/Contents: read & write/);
      // Nothing was written to the config.
      expect(repo.git("config", "--get-all", `http.${serverUrl}/.extraheader`)).toBe(
        "AUTHORIZATION: basic R0lUSFVCX1RPS0VO",
      );
    } finally {
      server.close();
    }
  });

  it("masks tokens and URL credentials", () => {
    const git = new Git({ cwd: "/", token: "tok123" });
    expect(git.mask("a tok123 b https://user:pass@github.com/x")).toBe(
      "a *** b https://***@github.com/x",
    );
    expect(git.hasToken).toBe(true);
    expect(new Git({ cwd: "/" }).hasToken).toBe(false);
  });

  it("explains a missing working directory", async () => {
    const git = new Git({ cwd: "/definitely/not/here" });
    await expect(git.headSha()).rejects.toThrow(/Could not run `git rev-parse/);
  });
});
