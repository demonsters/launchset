/** Temp copies of the init fixture repos, as git repos. Never touches the real repo. */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";
import type { InitOptions, InitOutput } from "../../src/init/index.ts";

const emptyConfig = join(mkdtempSync(join(tmpdir(), "launchset-init-gitcfg-")), "gitconfig");
writeFileSync(emptyConfig, "");
process.env.GIT_CONFIG_GLOBAL = emptyConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"]) {
  delete process.env[key];
}

const dirs: string[] = [dirname(emptyConfig)];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/init");

export function git(cwd: string, ...args: string[]): string {
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

export interface RepoOptions {
  tags?: string[];
  remote?: string;
  git?: boolean;
}

/** Copy a fixture into a temp dir, `git init` it, commit everything and add tags. */
export function fixtureRepo(name: string, options: RepoOptions = {}): string {
  const dir = mkdtempSync(join(tmpdir(), `launchset-init-${name}-`));
  dirs.push(dir);
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  if (options.git === false) return dir;
  git(dir, "init", "--quiet", "--initial-branch=main");
  git(dir, "add", "--all");
  git(dir, "commit", "--quiet", "--no-verify", "-m", "initial");
  for (const tag of options.tags ?? []) git(dir, "tag", tag);
  if (options.remote) git(dir, "remote", "add", "origin", options.remote);
  return dir;
}

export function read(dir: string, path: string): string {
  return readFileSync(join(dir, path), "utf8");
}

export function fixture(name: string, path: string): string {
  return readFileSync(join(FIXTURES, name, path), "utf8");
}

export interface Collected extends InitOutput {
  logs: string[];
  warnings: string[];
  jsons: unknown[];
}

export function collect(): Collected {
  const logs: string[] = [];
  const warnings: string[] = [];
  const jsons: unknown[] = [];
  return {
    logs,
    warnings,
    jsons,
    log: (line) => logs.push(line),
    warn: (line) => warnings.push(line),
    json: (value) => jsons.push(value),
  };
}

export const NOW = new Date("2026-11-18T12:00:00Z");

export function options(cwd: string, extra: Partial<InitOptions> = {}): InitOptions {
  return {
    cwd,
    yes: false,
    decide: {},
    detect: false,
    json: false,
    convertOnly: false,
    interactive: false,
    output: collect(),
    now: NOW,
    actionRef: "demonsters/launchset-action@v1",
    ...extra,
  };
}

/** Every file in a git repo's working tree that changed or is new, relative paths. */
export function status(dir: string): string[] {
  return execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: dir,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .sort();
}

/** A temp git repo with the given files (committed) and tags. */
export function repoFrom(files: Record<string, string>, options: RepoOptions = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "launchset-init-inline-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  if (options.git === false) return dir;
  git(dir, "init", "--quiet", "--initial-branch=main");
  git(dir, "add", "--all");
  git(dir, "commit", "--quiet", "--no-verify", "-m", "initial");
  for (const tag of options.tags ?? []) git(dir, "tag", tag);
  if (options.remote) git(dir, "remote", "add", "origin", options.remote);
  return dir;
}
