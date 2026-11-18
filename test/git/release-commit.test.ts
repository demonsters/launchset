import { describe, expect, it } from "vitest";
import { Git } from "../../src/git/index.ts";
import {
  type FindReleaseCommitOptions,
  findReleaseCommit,
  headIsReleaseCommit,
  readRootVersion,
  versionReader,
} from "../../src/git/release-commit.ts";
import { initRepo, type TestRepo } from "./helpers.ts";

function setup(repo: TestRepo) {
  const git = new Git({ cwd: repo.dir });
  const read = versionReader(git, "package.json");
  return { git, read };
}

describe.each<[string, FindReleaseCommitOptions]>([
  ["full first-parent walk", {}],
  ["walk narrowed to the version file", { paths: ["package.json"] }],
])("findReleaseCommit (%s)", (_name, options) => {
  it("merge commit: the merge, never the release PR's side-branch commit", async () => {
    const repo = initRepo();
    repo.version("1.0.0");
    repo.commit("feature");
    repo.checkout("-b", "launchset/release/main");
    const side = repo.version("1.1.0", "Release v1.1.0");
    repo.checkout("main");
    const merge = repo.merge("launchset/release/main", "Merge pull request #5");
    const { git, read } = setup(repo);
    expect(await findReleaseCommit(git, "HEAD", read, options)).toBe(merge);
    expect(merge).not.toBe(side);
    expect(await headIsReleaseCommit(git, read)).toBe(true);
  });

  it("squash merge: the squashed commit", async () => {
    const repo = initRepo();
    repo.version("1.0.0");
    repo.commit("feature");
    const squash = repo.commit("Release v1.1.0 (#5)", {
      "package.json": '{"name":"app","version":"1.1.0"}\n',
      "CHANGELOG.md": "## 1.1.0\n",
    });
    const { git, read } = setup(repo);
    expect(await findReleaseCommit(git, "HEAD", read, options)).toBe(squash);
    expect(await headIsReleaseCommit(git, read)).toBe(true);
  });

  it("rebase merge: the rebased commit that changed the version, not the last one", async () => {
    const repo = initRepo();
    repo.version("1.0.0");
    repo.commit("feature");
    // The release PR's commits land one by one; the version changes in the middle.
    repo.commit("Delete changesets", { ".launchset/a.md": "" });
    const bump = repo.version("1.1.0", "Bump version");
    repo.commit("Update changelog", { "CHANGELOG.md": "## 1.1.0\n" });
    const { git, read } = setup(repo);
    expect(await findReleaseCommit(git, "HEAD", read, options)).toBe(bump);
    expect(await headIsReleaseCommit(git, read)).toBe(false);
  });

  it("release PR merged while behind the base branch", async () => {
    const repo = initRepo();
    repo.version("1.0.0");
    repo.checkout("-b", "launchset/release/main");
    repo.version("1.1.0", "Release v1.1.0");
    repo.checkout("main");
    repo.commit("feature landed after the release PR was built");
    repo.commit("another one");
    const merge = repo.merge("launchset/release/main", "Merge pull request #7");
    const { git, read } = setup(repo);
    expect(await findReleaseCommit(git, "HEAD", read, options)).toBe(merge);
  });

  it("local merge whose second parent changes the version: not picked", async () => {
    const repo = initRepo();
    repo.version("1.0.0");
    repo.checkout("-b", "launchset/release/main");
    repo.version("1.1.0", "Release v1.1.0");
    repo.checkout("main");
    const release = repo.merge("launchset/release/main", "Merge pull request #8");
    // An old line with its own version change gets merged in locally, keeping main's tree.
    repo.checkout("-b", "release/1.0.x", "HEAD~1");
    repo.version("1.0.1", "Release v1.0.1");
    repo.version("1.0.2", "Release v1.0.2");
    repo.checkout("main");
    repo.git(
      "merge",
      "--no-ff",
      "--quiet",
      "-s",
      "ours",
      "-m",
      "Merge release/1.0.x",
      "release/1.0.x",
    );
    // And a feature branch that bumped and reverted the version.
    repo.checkout("-b", "feature");
    repo.version("9.9.9", "oops");
    repo.version("1.1.0", "revert oops");
    repo.checkout("main");
    repo.merge("feature", "Merge feature");
    const { git, read } = setup(repo);
    expect(await findReleaseCommit(git, "HEAD", read, options)).toBe(release);
    expect(await headIsReleaseCommit(git, read)).toBe(false);
  });

  it("retry after later commits on top: still the same commit", async () => {
    const repo = initRepo();
    repo.version("1.0.0");
    repo.checkout("-b", "launchset/release/main");
    repo.version("1.1.0");
    repo.checkout("main");
    const release = repo.merge("launchset/release/main");
    repo.commit("later 1");
    repo.checkout("-b", "feature");
    repo.commit("later 2");
    repo.checkout("main");
    repo.merge("feature");
    const { git, read } = setup(repo);
    expect(await findReleaseCommit(git, "HEAD", read, options)).toBe(release);
    expect(await findReleaseCommit(git, "main", read, options)).toBe(release);
  });

  it("root commit counts as a change", async () => {
    const repo = initRepo();
    const root = repo.version("0.1.0");
    const { git, read } = setup(repo);
    expect(await findReleaseCommit(git, "HEAD", read, options)).toBe(root);
    expect(await headIsReleaseCommit(git, read)).toBe(true);
    repo.commit("next");
    expect(await findReleaseCommit(git, "HEAD", read, options)).toBe(root);
  });

  it("version file added later: the commit that added it; no version ever: undefined", async () => {
    const repo = initRepo();
    repo.commit("no package.json yet");
    const { git, read } = setup(repo);
    expect(await findReleaseCommit(git, "HEAD", read, options)).toBeUndefined();
    const added = repo.version("1.0.0");
    repo.commit("more");
    expect(await findReleaseCommit(git, "HEAD", read, options)).toBe(added);
  });

  it("a change to another field of the version file is not a version change", async () => {
    const repo = initRepo();
    const release = repo.version("1.0.0");
    repo.commit("add a script", {
      "package.json": '{"name":"app","version":"1.0.0","scripts":{}}\n',
    });
    const { git, read } = setup(repo);
    expect(await findReleaseCommit(git, "HEAD", read, options)).toBe(release);
  });
});

describe("readRootVersion", () => {
  it("reads the version, undefined when missing, errors on invalid JSON", async () => {
    const repo = initRepo();
    const a = repo.commit("a", { "package.json": '﻿{"version":"2.0.0"}' });
    const b = repo.commit("b", { "package.json": '{"name":"x"}' });
    const c = repo.commit("c", { "package.json": '{"version":2}' });
    const d = repo.commit("d", { "package.json": "{ not json" });
    const git = new Git({ cwd: repo.dir });
    expect(await readRootVersion(git, a, "package.json")).toBe("2.0.0");
    expect(await readRootVersion(git, b, "package.json")).toBeUndefined();
    expect(await readRootVersion(git, c, "package.json")).toBeUndefined();
    expect(await readRootVersion(git, a, "missing.json")).toBeUndefined();
    await expect(readRootVersion(git, d, "package.json")).rejects.toThrow(
      new RegExp(`Could not parse package.json at commit ${d.slice(0, 12)}`),
    );
  });
});
