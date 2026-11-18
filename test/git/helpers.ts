/** Temp git repos for tests. Never touches the real repo or the user's git config. */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll } from "vitest";

const emptyConfig = join(mkdtempSync(join(tmpdir(), "launchset-gitcfg-")), "gitconfig");
writeFileSync(emptyConfig, "");
// Isolate from the user's global/system config (signing, hooks, default branch, …).
process.env.GIT_CONFIG_GLOBAL = emptyConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"]) {
  delete process.env[key];
}

const dirs: string[] = [dirname(emptyConfig)];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

let counter = 0;

/** A fresh temp directory, removed after the test file. */
export function tempDir(prefix = "repo"): string {
  const dir = mkdtempSync(join(tmpdir(), `launchset-${prefix}-`));
  dirs.push(dir);
  return dir;
}

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export class TestRepo {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  git(...args: string[]): string {
    return sh(this.dir, ...args);
  }

  write(path: string, content: string): void {
    const full = join(this.dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  /** Write files and commit them; returns the new sha. */
  commit(message: string, files: Record<string, string> = {}): string {
    for (const [path, content] of Object.entries(files)) this.write(path, content);
    this.git("add", "--all");
    if (this.git("status", "--porcelain") === "") {
      // Nothing to commit: add a unique file so every commit has a change.
      this.write(`.noise/${++counter}.txt`, String(counter));
      this.git("add", "--all");
    }
    this.git("commit", "--quiet", "--no-verify", "-m", message);
    return this.head();
  }

  /** Commit a package.json with `version`. */
  version(version: string, message = `version ${version}`): string {
    return this.commit(message, {
      "package.json": `${JSON.stringify({ name: "app", version }, null, 2)}\n`,
    });
  }

  head(): string {
    return this.git("rev-parse", "HEAD");
  }

  checkout(...args: string[]): void {
    this.git("checkout", "--quiet", ...args);
  }

  /** `git merge --no-ff` and return the merge commit. */
  merge(ref: string, message = `Merge ${ref}`): string {
    this.git("merge", "--no-ff", "--quiet", "-m", message, ref);
    return this.head();
  }
}

/** `git init -b main` in a temp dir. */
export function initRepo(): TestRepo {
  const dir = tempDir("repo");
  sh(dir, "init", "--quiet", "-b", "main");
  return new TestRepo(dir);
}

/** A bare remote plus a clone with one commit on main pushed to it. */
export function repoWithRemote(): { remote: string; repo: TestRepo } {
  const remote = tempDir("remote");
  sh(remote, "init", "--quiet", "--bare", "-b", "main");
  const repo = initRepo();
  repo.git("remote", "add", "origin", remote);
  repo.commit("initial", { "README.md": "hi\n" });
  repo.git("push", "--quiet", "origin", "main");
  return { remote, repo };
}

/** Another clone of `remote`. */
export function cloneRepo(remote: string): TestRepo {
  const dir = tempDir("clone");
  sh(dir, "clone", "--quiet", remote, ".");
  return new TestRepo(dir);
}
