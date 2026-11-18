/**
 * End-to-end harness. A `World` is one GitHub repository: a bare remote (git), a `FakeGitHub`
 * (the REST API on msw), a developer clone, and any number of CI "jobs". A `Job` is a fresh
 * checkout of the remote, like `actions/checkout` in one job of a workflow run, with the
 * environment GitHub Actions sets (event payload file, run number, token, ...). Commands run
 * the way CI would run them:
 *
 * - `job.cli(argv)` runs the real CLI (`runCli`) in-process, for what the CLI offers
 *   (init, add, status, plan, stamp, verify, mark, ship, finalize, hotfix, check).
 * - `job.action(command, inputs)` runs what `uses: demonsters/launchset-action` runs
 *   (`dispatch` of action/src/commands.ts on a context built from the same environment),
 *   for what only the action offers (release with side effects, preview-comment).
 */

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpResponse, http } from "msw";
import { dispatch, outputsFor } from "../../action/src/commands.ts";
import type { Command, Inputs } from "../../action/src/inputs.ts";
import type { CliIo } from "../../src/cli/io.ts";
import { runCli } from "../../src/cli/program.ts";
import { isLaunchsetError } from "../../src/core/errors.ts";
import { createContext, type FlowContext, type FlowResult } from "../../src/flow/index.ts";
import { FakeGitHub, projectFor, server, TOKEN } from "../flow/helpers.ts";
import { cloneRepo, repoWithRemote, sh, type TestRepo, tempDir } from "../git/helpers.ts";

export { TOKEN };

export const SLUG = "acme/app";
export const REPO_API = `https://api.github.com/repos/${SLUG}`;
export const START = new Date("2026-11-18T12:00:00Z");
export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** `floor((at - 2020-01-01) / 1s)`: the default `timestamp` build number. */
export function timestampBuild(at: Date): number {
  return Math.floor((at.getTime() - Date.parse("2020-01-01T00:00:00Z")) / 1000);
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ActionRun {
  /** The command succeeded (no thrown error, `result.ok`). */
  ok: boolean;
  outputs: Record<string, string>;
  /** Set when the flow threw. */
  error?: string;
  result?: FlowResult;
  logs: string[];
  /** Variables the action would export (`LAUNCHSET_VERSION`, ...). */
  env: Record<string, string>;
}

export interface JobOptions {
  /** A GitHub event; written to a payload file like the runner does. */
  event?: { name: string; payload?: Record<string, unknown> };
  /** `GITHUB_REF`; default `refs/heads/<current branch>` for push/dispatch events. */
  ref?: string;
  /** `GITHUB_SHA`; default the checkout's HEAD. */
  sha?: string;
  /** Share a workflow run (run number and id) with other jobs. */
  run?: number;
  /** Extra or overriding environment variables (`undefined` removes one). */
  env?: Record<string, string | undefined>;
  /** Run without the GitHub token (a fork PR). */
  noToken?: boolean;
  /**
   * Not in GitHub Actions: a developer's machine (for example a Mac archiving an iOS build).
   * Only the token and the repository are known, like `GITHUB_TOKEN=... launchset mark`.
   */
  local?: boolean;
}

export class Job {
  readonly world: World;
  readonly repo: TestRepo;
  readonly run: number;
  readonly options: JobOptions;

  constructor(world: World, repo: TestRepo, options: JobOptions = {}) {
    this.world = world;
    this.repo = repo;
    this.options = options;
    this.run = options.run ?? world.newRun();
  }

  get dir(): string {
    return this.repo.dir;
  }

  /** Another job of the same workflow run (same event, run number and token), at `checkout`. */
  sibling(checkout: string, options: JobOptions = {}): Job {
    return this.world.job(checkout, { ...this.options, run: this.run, ...options });
  }

  /** The environment GitHub Actions sets for this job. */
  env(): Record<string, string | undefined> {
    const { options } = this;
    if (options.local) {
      return {
        NO_COLOR: "1",
        GITHUB_REPOSITORY: SLUG,
        ...(options.noToken ? {} : { GITHUB_TOKEN: TOKEN }),
        ...options.env,
      };
    }
    const env: Record<string, string | undefined> = {
      NO_COLOR: "1",
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: SLUG,
      GITHUB_RUN_ID: String(1000 + this.run),
      GITHUB_RUN_NUMBER: String(this.run),
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_WORKSPACE: this.dir,
    };
    if (!options.noToken) env.GITHUB_TOKEN = TOKEN;
    const branch = this.repo.git("branch", "--show-current");
    const sha = options.sha ?? this.repo.head();
    env.GITHUB_SHA = sha;
    const name = options.event?.name;
    if (options.ref) {
      env.GITHUB_REF = options.ref;
    } else if (name !== "pull_request" && branch) {
      env.GITHUB_REF = `refs/heads/${branch}`;
    }
    if (env.GITHUB_REF?.startsWith("refs/heads/")) {
      env.GITHUB_REF_NAME = env.GITHUB_REF.slice("refs/heads/".length);
    }
    if (options.event) {
      env.GITHUB_EVENT_NAME = options.event.name;
      const file = join(this.world.scratch, `event-${this.world.nextId()}.json`);
      writeFileSync(
        file,
        JSON.stringify({ repository: { full_name: SLUG }, ...options.event.payload }),
      );
      env.GITHUB_EVENT_PATH = file;
    }
    return { ...env, ...options.env };
  }

  /** Run the CLI in-process in this checkout. */
  async cli(
    argv: string[],
    extra: { env?: Record<string, string | undefined> } = {},
  ): Promise<CliRun> {
    let stdout = "";
    let stderr = "";
    const io: CliIo = {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      env: { ...this.env(), ...extra.env },
      isTTY: false,
      cwd: this.dir,
      now: this.world.tick(),
    };
    const code = await runCli(argv, io);
    return { code, stdout, stderr };
  }

  /** Like `cli`, parsing stdout as JSON; fails with the CLI's output when the command failed. */
  async json<T = Record<string, unknown>>(
    argv: string[],
    extra: { env?: Record<string, string | undefined> } = {},
  ): Promise<T> {
    const run = await this.cli([...argv, "--json"], extra);
    if (run.code !== 0) {
      throw new Error(
        `launchset ${argv.join(" ")} exited ${run.code}\n${run.stdout}\n${run.stderr}`,
      );
    }
    return JSON.parse(run.stdout) as T;
  }

  /** Run the CLI and fail with its output unless it exits 0. */
  async ok(
    argv: string[],
    extra: { env?: Record<string, string | undefined> } = {},
  ): Promise<CliRun> {
    const run = await this.cli(argv, extra);
    if (run.code !== 0) {
      throw new Error(
        `launchset ${argv.join(" ")} exited ${run.code}\n${run.stdout}\n${run.stderr}`,
      );
    }
    return run;
  }

  /** The flow context the action builds: this job's environment, token and a collecting logger. */
  async context(logs: string[] = [], token: string | undefined = TOKEN): Promise<FlowContext> {
    return createContext({
      cwd: this.dir,
      ...(token && !this.options.noToken ? { token } : {}),
      env: this.env(),
      now: this.world.tick(),
      log: {
        info: (m) => logs.push(m),
        warn: (m) => logs.push(`warning: ${m}`),
        debug: () => {},
      },
    });
  }

  /** What `uses: demonsters/launchset-action@v1` does for `command`. */
  async action(command: Command, inputs: Partial<Inputs> = {}): Promise<ActionRun> {
    const full: Inputs = {
      command,
      token: this.options.noToken ? "" : TOKEN,
      target: "",
      bump: "",
      message: "",
      version: "",
      plan: "",
      workingDirectory: ".",
      ...inputs,
    };
    const logs: string[] = [];
    try {
      const context = await this.context(logs, full.token);
      const result = await dispatch(command, full, context);
      return {
        ok: result.ok,
        outputs: outputsFor(command, result, context),
        result,
        logs,
        env: result.env ?? {},
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint = isLaunchsetError(error) && error.hint ? `\n${error.hint}` : "";
      return { ok: false, outputs: {}, error: `${message}${hint}`, logs, env: {} };
    }
  }

  /** Like `action`, failing with the error unless it succeeded. */
  async actionOk(command: Command, inputs: Partial<Inputs> = {}): Promise<ActionRun> {
    const run = await this.action(command, inputs);
    if (!run.ok) {
      throw new Error(
        `action ${command} failed: ${run.error ?? run.result?.lines.join("\n")}\n${run.logs.join("\n")}`,
      );
    }
    return run;
  }
}

export interface PrMergeOptions {
  method?: "merge" | "squash" | "rebase";
}

/** A GitHub repository: remote, fake API, developer clone and CI jobs. */
export class World {
  readonly remote: string;
  readonly dev: TestRepo;
  readonly github: FakeGitHub;
  readonly scratch: string;
  readonly project: ReturnType<typeof projectFor>;
  #run = 40;
  #id = 0;
  #clock = START.getTime();

  constructor() {
    const { remote, repo } = repoWithRemote();
    this.remote = remote;
    this.dev = repo;
    this.github = new FakeGitHub(remote);
    this.scratch = tempDir("scratch");
    this.project = projectFor(repo, remote);
    server.use(this.jobsHandler());
  }

  newRun(): number {
    return ++this.#run;
  }

  nextId(): number {
    return ++this.#id;
  }

  /** The clock moves forward a minute per command, so build numbers keep increasing. */
  tick(): Date {
    this.#clock += 60_000;
    return new Date(this.#clock);
  }

  /** The time of the last command. */
  get now(): Date {
    return new Date(this.#clock);
  }

  /** Copy a fixture directory (test/e2e/fixtures/<name>) into the developer clone. */
  copyFixture(name: string): void {
    cpSync(join(FIXTURES, name), this.dev.dir, { recursive: true });
  }

  /** Copy any directory (for example an init fixture repo) into the developer clone. */
  copyDir(dir: string): void {
    cpSync(dir, this.dev.dir, { recursive: true });
  }

  /** Remove everything but `.git` from the developer clone (to replace the initial README). */
  wipeDev(): void {
    for (const entry of this.dev.git("ls-files").split("\n")) {
      if (entry) rmSync(join(this.dev.dir, entry), { force: true });
    }
  }

  /** Commit what's in the developer clone and push `branch` (default: the current branch). */
  pushDev(message: string, files: Record<string, string> = {}): string {
    const sha = this.dev.commit(message, files);
    this.dev.git("push", "--quiet", "origin", "HEAD");
    return sha;
  }

  /** The developer's own commands (no CI environment, no token unless given). */
  async devCli(argv: string[], env: Record<string, string | undefined> = {}): Promise<CliRun> {
    let stdout = "";
    let stderr = "";
    const io: CliIo = {
      stdout: (t) => {
        stdout += t;
      },
      stderr: (t) => {
        stderr += t;
      },
      env: { NO_COLOR: "1", ...env },
      isTTY: false,
      cwd: this.dev.dir,
      now: this.tick(),
    };
    return { code: await runCli(argv, io), stdout, stderr };
  }

  /** A fresh checkout of the remote at `ref` (a branch, or a sha/tag for a detached HEAD). */
  job(checkout: string, options: JobOptions = {}): Job {
    const repo = cloneRepo(this.remote);
    // Same shape as actions/checkout with fetch-depth 0: all branches and tags are there.
    const isBranch = (() => {
      try {
        repo.git("rev-parse", "--verify", "--quiet", `refs/remotes/origin/${checkout}`);
        return true;
      } catch {
        return false;
      }
    })();
    if (isBranch) repo.git("checkout", "--quiet", "-B", checkout, `origin/${checkout}`);
    else repo.git("checkout", "--quiet", "--detach", checkout);
    return new Job(this, repo, options);
  }

  /** A job for a `push` event of `branch` (checked out at the pushed commit). */
  pushJob(branch: string, options: JobOptions = {}): Job {
    const probe = this.job(branch, options);
    const after = probe.repo.head();
    return new Job(this, probe.repo, {
      ...options,
      run: probe.run,
      sha: after,
      ref: `refs/heads/${branch}`,
      event: {
        name: "push",
        payload: { ref: `refs/heads/${branch}`, after, before: "0".repeat(40) },
      },
    });
  }

  /**
   * A job for a `pull_request` event: like `actions/checkout`, it has the merge of the PR
   * branch into its base checked out (detached), and the PR head commit is reachable.
   */
  prJob(
    headRef: string,
    input: {
      number: number;
      action?: string;
      labels?: string[];
      label?: string;
      baseRef?: string;
      author?: string;
      fork?: boolean;
    },
    options: JobOptions = {},
  ): Job {
    const baseRef = input.baseRef ?? "main";
    const repo = cloneRepo(this.remote);
    const headSha = repo.git("rev-parse", `origin/${headRef}`);
    repo.git("checkout", "--quiet", "--detach", `origin/${baseRef}`);
    repo.git("merge", "--no-ff", "--quiet", "-m", `Merge ${headSha} into ${baseRef}`, headSha);
    return new Job(this, repo, {
      ...options,
      ref: `refs/pull/${input.number}/merge`,
      event: pullRequestEvent({
        action: input.action ?? "synchronize",
        number: input.number,
        headRef,
        headSha,
        baseRef,
        ...(input.labels ? { labels: input.labels } : {}),
        ...(input.label ? { label: input.label } : {}),
        ...(input.author ? { author: input.author } : {}),
        ...(input.fork ? { fork: input.fork } : {}),
      }),
    });
  }

  /** Create a branch from `base` in the developer clone with a changeset and push it. */
  async devBranch(name: string, bump: string, message: string, base = "main"): Promise<string> {
    this.dev.git("fetch", "--quiet", "--tags", "origin");
    this.dev.git("checkout", "--quiet", "-B", name, `origin/${base}`);
    await this.devAddChangeset(bump, message, false);
    this.dev.git("push", "--quiet", "origin", `HEAD:refs/heads/${name}`);
    return this.dev.head();
  }

  /** A job for a `workflow_dispatch` on `branch`. */
  dispatchJob(branch: string, inputs: Record<string, string> = {}, options: JobOptions = {}): Job {
    const probe = this.job(branch, options);
    return new Job(this, probe.repo, {
      ...options,
      run: probe.run,
      ref: `refs/heads/${branch}`,
      event: { name: "workflow_dispatch", payload: { ref: `refs/heads/${branch}`, inputs } },
    });
  }

  /** Branches on the remote's head. */
  remoteHead(branch: string): string {
    return sh(this.remote, "rev-parse", `refs/heads/${branch}`);
  }

  tags(): Map<string, string> {
    return this.project.remoteTags();
  }

  /** The tags on the remote whose name starts with `prefix`, sorted. */
  tagNames(prefix = ""): string[] {
    return [...this.tags().keys()].filter((t) => t.startsWith(prefix)).sort();
  }

  file(ref: string, path: string): string {
    return this.project.remoteFile(ref, path);
  }

  /** `git <args>` in the remote (any ref of the remote can be named). */
  git(...args: string[]): string {
    return sh(this.remote, ...args);
  }

  /** Paths changed by commit `sha` (with the status letters), against its first parent. */
  changedFiles(sha: string): string[] {
    return sh(this.remote, "diff", "--name-status", "--no-renames", `${sha}^1`, sha)
      .split("\n")
      .filter(Boolean)
      .sort();
  }

  /** The open PR with this head branch. */
  prByHead(head: string) {
    return this.github.prs.find((p) => p.head.ref === head && p.state === "open");
  }

  /**
   * Merge a PR the way GitHub does and push the result to its base branch: a merge commit, a
   * squash commit or a rebase (cherry-pick). Returns the commit that landed on the base.
   */
  mergePr(number: number, options: PrMergeOptions = {}): string {
    const pr = this.github.prs.find((p) => p.number === number);
    if (!pr) throw new Error(`no PR #${number}`);
    const { dev } = this;
    dev.git("fetch", "--quiet", "--tags", "origin");
    dev.git("checkout", "--quiet", "-B", pr.base.ref, `origin/${pr.base.ref}`);
    const head = `origin/${pr.head.ref}`;
    const method = options.method ?? "merge";
    if (method === "merge") {
      dev.git(
        "merge",
        "--no-ff",
        "--quiet",
        "-m",
        `Merge pull request #${number} from ${SLUG}/${pr.head.ref}`,
        head,
      );
    } else if (method === "squash") {
      dev.git("merge", "--squash", "--quiet", head);
      dev.git("commit", "--quiet", "--no-verify", "-m", `${pr.title} (#${number})`);
    } else {
      dev.git("cherry-pick", "--allow-empty", head);
    }
    const sha = dev.head();
    dev.git("push", "--quiet", "origin", `HEAD:refs/heads/${pr.base.ref}`);
    pr.state = "closed";
    pr.merged_at = this.now.toISOString();
    pr.merge_commit_sha = sha;
    return sha;
  }

  /** Check a branch out in the developer clone, up to date with the remote. */
  devCheckout(branch: string): void {
    this.dev.git("fetch", "--quiet", "--tags", "origin");
    this.dev.git("checkout", "--quiet", "-B", branch, `origin/${branch}`);
  }

  /** Commit a changeset file as a developer would (via `launchset add`) and push the branch. */
  async devAddChangeset(bump: string, message: string, push = true): Promise<string> {
    const run = await this.devCli(["add", "--bump", bump, "--message", message]);
    if (run.code !== 0) throw new Error(`add failed:\n${run.stdout}\n${run.stderr}`);
    const path = run.stdout
      .trim()
      .split("\n")
      .at(-1)
      ?.match(/\.launchset\/[\w-]+\.md/)?.[0];
    if (!path) throw new Error(`add printed no changeset path:\n${run.stdout}`);
    const sha = this.dev.commit(`Add ${path}`);
    if (push) this.dev.git("push", "--quiet", "origin", "HEAD");
    return sha;
  }

  /** Jobs of any workflow run for `preview-comment` (`GET /actions/runs/:id/jobs`). */
  readonly jobResults = new Map<number, { name: string; conclusion: string | null }[]>();

  setJobs(run: number, jobs: { name: string; conclusion: string | null }[]): void {
    this.jobResults.set(run, jobs);
  }

  jobsHandler() {
    return http.get(`${REPO_API}/actions/runs/:id/jobs`, ({ params }) => {
      const run = Number(params.id) - 1000;
      const jobs = this.jobResults.get(run) ?? [];
      return HttpResponse.json({
        total_count: jobs.length,
        jobs: jobs.map((j, i) => ({
          id: Number(params.id) * 100 + i,
          name: j.name,
          status: j.conclusion === null ? "in_progress" : "completed",
          conclusion: j.conclusion,
          html_url: `https://github.com/${SLUG}/actions/runs/${params.id}/job/${Number(params.id) * 100 + i}`,
        })),
      });
    });
  }

  /** Sticky comments on a PR (or issue) number. */
  commentsOn(number: number) {
    return this.github.comments.filter((c) => c.issue === number);
  }
}

/** Read a file from a checkout. */
export function read(dir: string, path: string): string {
  return readFileSync(join(dir, path), "utf8");
}

export function write(dir: string, path: string, content: string): void {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** A `pull_request` event payload for a PR from `headRef` in this repository. */
export function pullRequestEvent(input: {
  action: string;
  number: number;
  headRef: string;
  headSha: string;
  baseRef?: string;
  labels?: string[];
  author?: string;
  label?: string;
  fork?: boolean;
}): { name: string; payload: Record<string, unknown> } {
  const repo = { full_name: SLUG };
  return {
    name: "pull_request",
    payload: {
      action: input.action,
      number: input.number,
      ...(input.label ? { label: { name: input.label } } : {}),
      pull_request: {
        number: input.number,
        user: { login: input.author ?? "dev" },
        labels: (input.labels ?? []).map((name) => ({ name })),
        head: {
          ref: input.headRef,
          sha: input.headSha,
          repo: input.fork ? { full_name: "someone/app" } : repo,
        },
        base: { ref: input.baseRef ?? "main", repo },
      },
    },
  };
}
