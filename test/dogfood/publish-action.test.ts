import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publishAction } from "../../scripts/publish-action.ts";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/publish-action.ts");

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();
}

/** The commit a ref points at in the remote, or "" when it doesn't exist. */
function remoteRef(remote: string, ref: string): string {
  return git(remote, "rev-parse", "--verify", "--quiet", ref) || "";
}

function remoteHas(remote: string, ref: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], {
      cwd: remote,
      env: gitEnv,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

describe("scripts/publish-action.ts", () => {
  let dir: string;
  let remote: string;
  let checkout: string;

  /** What `build-action.ts --out` would write: the bundle changes with the code. */
  function writeFiles(bundle: string): void {
    mkdirSync(join(checkout, "dist"), { recursive: true });
    writeFileSync(join(checkout, "action.yml"), "name: Launchset\n");
    writeFileSync(join(checkout, "dist/index.js"), bundle);
  }

  /** A fresh clone of the remote without tags, like a CI checkout of the action repo. */
  function freshCheckout(): void {
    rmSync(checkout, { recursive: true, force: true });
    git(dir, "clone", "--quiet", "--no-tags", remote, checkout);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "launchset-publish-action-"));
    remote = join(dir, "action-repo.git");
    checkout = join(dir, "checkout");
    git(dir, "init", "--quiet", "--bare", "--initial-branch=main", remote);
    // The repo as the team creates it: one commit (a README), then the first publish.
    const seed = join(dir, "seed");
    git(dir, "init", "--quiet", "--initial-branch=main", seed);
    git(seed, "remote", "add", "origin", remote);
    writeFileSync(join(seed, "README.md"), "# launchset-action\n");
    git(seed, "add", "-A");
    git(seed, "commit", "--quiet", "-m", "Initial commit");
    git(seed, "push", "--quiet", "origin", "main");
    freshCheckout();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("commits, tags the version and the major tag, and pushes all three", async () => {
    writeFiles("bundle 1");
    const logs: string[] = [];
    const result = await publishAction({
      repoDir: checkout,
      version: "1.0.0",
      log: (line) => logs.push(line),
    });

    expect(result).toMatchObject({
      status: "published",
      tag: "v1.0.0",
      majorTag: "v1",
      majorMoved: true,
    });
    expect(remoteRef(remote, "refs/heads/main")).toBe(result.commit);
    expect(remoteRef(remote, "refs/tags/v1.0.0")).toBe(result.commit);
    expect(remoteRef(remote, "refs/tags/v1")).toBe(result.commit);
    expect(git(remote, "show", `${result.commit}:dist/index.js`)).toBe("bundle 1");
    expect(git(remote, "log", "-1", "--format=%an <%ae>|%s", result.commit)).toBe(
      "launchset[bot] <launchset[bot]@users.noreply.github.com>|Release v1.0.0",
    );
    // The commit sits on top of the existing history.
    expect(git(remote, "rev-list", "--count", "main")).toBe("2");
    expect(logs.join("\n")).toContain("Moved v1 to v1.0.0");
  });

  it("does nothing when the tag already holds the same files (re-run)", async () => {
    writeFiles("bundle 1");
    const first = await publishAction({ repoDir: checkout, version: "1.0.0" });

    // A re-run starts from a fresh checkout of the action repo and rebuilds the same bundle.
    freshCheckout();
    writeFiles("bundle 1");
    const second = await publishAction({ repoDir: checkout, version: "1.0.0" });

    expect(second).toMatchObject({
      status: "unchanged",
      tag: "v1.0.0",
      commit: first.commit,
      majorTag: "v1",
      majorMoved: false,
    });
    expect(git(remote, "rev-list", "--count", "main")).toBe("2");
    expect(remoteRef(remote, "refs/heads/main")).toBe(first.commit);
    expect(remoteRef(remote, "refs/tags/v1")).toBe(first.commit);
  });

  it("repairs a missing major tag on a re-run without committing again", async () => {
    writeFiles("bundle 1");
    const first = await publishAction({ repoDir: checkout, version: "1.0.0" });
    git(remote, "tag", "-d", "v1");

    freshCheckout();
    writeFiles("bundle 1");
    const second = await publishAction({ repoDir: checkout, version: "1.0.0" });

    expect(second).toMatchObject({ status: "unchanged", majorMoved: true });
    expect(remoteRef(remote, "refs/tags/v1")).toBe(first.commit);
    expect(git(remote, "rev-list", "--count", "main")).toBe("2");
  });

  it("refuses to rewrite a version that exists with different files", async () => {
    writeFiles("bundle 1");
    const first = await publishAction({ repoDir: checkout, version: "1.0.0" });

    freshCheckout();
    writeFiles("a different bundle");
    await expect(publishAction({ repoDir: checkout, version: "1.0.0" })).rejects.toThrow(
      /v1\.0\.0 already exists in the action repo with different files \(dist\/index\.js\)/,
    );
    expect(remoteRef(remote, "refs/heads/main")).toBe(first.commit);
    expect(remoteRef(remote, "refs/tags/v1.0.0")).toBe(first.commit);
  });

  it("moves the major tag forward for a new version and keeps the old version tag", async () => {
    writeFiles("bundle 1");
    const first = await publishAction({ repoDir: checkout, version: "1.0.0" });

    freshCheckout();
    writeFiles("bundle 2");
    const second = await publishAction({ repoDir: checkout, version: "1.1.0" });

    expect(second).toMatchObject({ status: "published", majorMoved: true });
    expect(second.commit).not.toBe(first.commit);
    expect(remoteRef(remote, "refs/tags/v1")).toBe(second.commit);
    expect(remoteRef(remote, "refs/tags/v1.0.0")).toBe(first.commit);
    expect(remoteRef(remote, "refs/tags/v1.1.0")).toBe(second.commit);
    expect(remoteRef(remote, "refs/heads/main")).toBe(second.commit);
  });

  it("starts a new major tag for a new major version", async () => {
    writeFiles("bundle 1");
    const first = await publishAction({ repoDir: checkout, version: "1.4.0" });

    freshCheckout();
    writeFiles("bundle 2");
    const second = await publishAction({ repoDir: checkout, version: "2.0.0" });

    expect(second).toMatchObject({ majorTag: "v2", majorMoved: true });
    expect(remoteRef(remote, "refs/tags/v1")).toBe(first.commit);
    expect(remoteRef(remote, "refs/tags/v2")).toBe(second.commit);
  });

  it("never moves the major tag backwards (a hotfix of an older release)", async () => {
    writeFiles("bundle 1");
    await publishAction({ repoDir: checkout, version: "1.4.0" });
    freshCheckout();
    writeFiles("bundle 2");
    const newest = await publishAction({ repoDir: checkout, version: "1.5.0" });

    freshCheckout();
    writeFiles("bundle 1 hotfix");
    const hotfix = await publishAction({
      repoDir: checkout,
      version: "1.4.1",
      log: () => {},
    });

    expect(hotfix).toMatchObject({ status: "published", tag: "v1.4.1", majorMoved: false });
    expect(remoteRef(remote, "refs/tags/v1.4.1")).toBe(hotfix.commit);
    expect(remoteRef(remote, "refs/tags/v1")).toBe(newest.commit);
  });

  it("tags a prerelease without a major tag", async () => {
    writeFiles("bundle 1");
    const result = await publishAction({ repoDir: checkout, version: "1.2.0-next.0" });

    expect(result).toMatchObject({ status: "published", majorTag: null, majorMoved: false });
    expect(remoteHas(remote, "refs/tags/v1.2.0-next.0")).toBe(true);
    expect(remoteHas(remote, "refs/tags/v1")).toBe(false);
  });

  it("still commits and tags a version whose files equal the previous release", async () => {
    writeFiles("bundle 1");
    const first = await publishAction({ repoDir: checkout, version: "1.0.0" });

    freshCheckout();
    writeFiles("bundle 1");
    const second = await publishAction({ repoDir: checkout, version: "1.0.1" });

    expect(second.status).toBe("published");
    expect(second.commit).not.toBe(first.commit);
    expect(git(remote, "rev-parse", `${second.commit}^{tree}`)).toBe(
      git(remote, "rev-parse", `${first.commit}^{tree}`),
    );
    expect(remoteRef(remote, "refs/tags/v1")).toBe(second.commit);
  });

  it("removes files from an earlier release that the build no longer writes", async () => {
    writeFiles("bundle 1");
    writeFileSync(join(checkout, "dist/old.js"), "old");
    await publishAction({ repoDir: checkout, version: "1.0.0" });

    freshCheckout();
    // build-action.ts wipes dist/ before writing it again.
    rmSync(join(checkout, "dist"), { recursive: true });
    writeFiles("bundle 2");
    const second = await publishAction({ repoDir: checkout, version: "1.1.0" });

    expect(git(remote, "ls-tree", "-r", "--name-only", second.commit).split("\n")).toEqual([
      "README.md",
      "action.yml",
      "dist/index.js",
    ]);
  });

  it("publishes into an action repo that has no commits yet", async () => {
    const empty = join(dir, "empty.git");
    const emptyCheckout = join(dir, "empty-checkout");
    git(dir, "init", "--quiet", "--bare", "--initial-branch=main", empty);
    git(dir, "init", "--quiet", "--initial-branch=main", emptyCheckout);
    git(emptyCheckout, "remote", "add", "origin", empty);
    writeFileSync(join(emptyCheckout, "action.yml"), "name: Launchset\n");

    const result = await publishAction({ repoDir: emptyCheckout, version: "0.1.0" });

    expect(result).toMatchObject({ status: "published", majorTag: "v0" });
    expect(remoteRef(empty, "refs/heads/main")).toBe(result.commit);
    expect(remoteRef(empty, "refs/tags/v0")).toBe(result.commit);
  });

  it("can commit and tag locally without a remote", async () => {
    const local = join(dir, "local");
    git(dir, "init", "--quiet", "--initial-branch=main", local);
    writeFileSync(join(local, "action.yml"), "name: Launchset\n");

    const result = await publishAction({ repoDir: local, version: "1.0.0", push: false });

    expect(result).toMatchObject({ status: "published", majorTag: "v1" });
    expect(git(local, "rev-parse", "v1")).toBe(result.commit);
    expect(git(local, "rev-parse", "v1.0.0")).toBe(result.commit);
    // Same files again: nothing new.
    const again = await publishAction({ repoDir: local, version: "1.0.0", push: false });
    expect(again).toMatchObject({ status: "unchanged", commit: result.commit });
  });

  it("pushes to the branch it was told to", async () => {
    git(checkout, "checkout", "--quiet", "--detach");
    writeFiles("bundle 1");
    const result = await publishAction({ repoDir: checkout, version: "1.0.0", branch: "main" });
    expect(remoteRef(remote, "refs/heads/main")).toBe(result.commit);
  });

  it("fails on a detached HEAD without --branch, before changing anything", async () => {
    git(checkout, "checkout", "--quiet", "--detach");
    writeFiles("bundle 1");
    await expect(publishAction({ repoDir: checkout, version: "1.0.0" })).rejects.toThrow(
      /detached HEAD/,
    );
    expect(remoteHas(remote, "refs/tags/v1.0.0")).toBe(false);
  });

  it("fails when the push is rejected and leaves the remote alone", async () => {
    writeFiles("bundle 1");
    // Someone else pushed to main in the meantime.
    const other = join(dir, "other");
    git(dir, "clone", "--quiet", remote, other);
    writeFileSync(join(other, "extra.txt"), "x");
    git(other, "add", "-A");
    git(other, "commit", "--quiet", "-m", "Other");
    git(other, "push", "--quiet", "origin", "main");
    const before = remoteRef(remote, "refs/heads/main");

    await expect(publishAction({ repoDir: checkout, version: "1.0.0" })).rejects.toThrow(
      /git push failed/,
    );
    expect(remoteRef(remote, "refs/heads/main")).toBe(before);
    expect(remoteHas(remote, "refs/tags/v1.0.0")).toBe(false);
    expect(remoteHas(remote, "refs/tags/v1")).toBe(false);
  });

  it("rejects versions that aren't plain semver", async () => {
    writeFiles("bundle 1");
    for (const version of ["v1.0.0", "1.0", "latest", ""]) {
      await expect(publishAction({ repoDir: checkout, version })).rejects.toThrow(
        /not a plain version/,
      );
    }
  });

  it("rejects a directory that is not a git checkout", async () => {
    const plain = join(dir, "plain");
    mkdirSync(plain);
    await expect(publishAction({ repoDir: plain, version: "1.0.0", push: false })).rejects.toThrow(
      /not a git checkout/,
    );
  });

  describe("command line", () => {
    function run(args: string[]): { status: number; stdout: string; stderr: string } {
      try {
        const stdout = execFileSync("node", [script, ...args], {
          env: gitEnv,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { status: 0, stdout, stderr: "" };
      } catch (error) {
        const failure = error as { status: number; stdout: string; stderr: string };
        return { status: failure.status, stdout: failure.stdout, stderr: failure.stderr };
      }
    }

    it("publishes, and a second run reports that it is already published", () => {
      writeFiles("bundle 1");
      const first = run(["--repo-dir", checkout, "--version", "1.0.0"]);
      expect(first.status).toBe(0);
      expect(first.stdout).toContain("Published v1.0.0 (v1 moved).");

      const second = run(["--repo-dir", checkout, "--version", "1.0.0"]);
      expect(second.status).toBe(0);
      expect(second.stdout).toContain("Already published v1.0.0 (v1).");
      expect(readFileSync(join(checkout, "dist/index.js"), "utf8")).toBe("bundle 1");
    });

    it("exits 1 with a message for a missing argument and for different content", () => {
      const usage = run(["--repo-dir", checkout]);
      expect(usage.status).toBe(1);
      expect(usage.stderr).toContain("Usage:");

      writeFiles("bundle 1");
      expect(run(["--repo-dir", checkout, "--version", "1.0.0"]).status).toBe(0);
      freshCheckout();
      writeFiles("changed");
      const changed = run(["--repo-dir", checkout, "--version", "1.0.0"]);
      expect(changed.status).toBe(1);
      expect(changed.stderr).toContain("already exists in the action repo with different files");
    });
  });
});
