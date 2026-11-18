/**
 * Shared context for the I/O layer (src/flow): the loaded config, git, GitHub, the
 * GitHub Actions environment and a logger. The CLI and the action build one of these and
 * call flow functions with it; flow functions never read `process` directly.
 */

import { readFile } from "node:fs/promises";
import { loadConfig } from "../config/load.ts";
import type { ResolvedConfig } from "../core/config/schema.ts";
import { LaunchsetError } from "../core/errors.ts";
import type { RunInfo } from "../core/types.ts";
import { Git } from "../git/index.ts";
import { createGitHub, type GitHub } from "../github/index.ts";

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, debug() {} };

/** The GitHub Actions event, when running in Actions (`GITHUB_EVENT_NAME` / `GITHUB_EVENT_PATH`). */
export interface ActionsEvent {
  name: string;
  /** Parsed event payload, `{}` when unavailable. */
  payload: Record<string, unknown>;
}

export interface FlowContext {
  /** Config root (the directory with `launchset.config.*`; the action's `working-directory`). */
  cwd: string;
  config: ResolvedConfig;
  configFile: string;
  git: Git;
  /** Set when a token and the repository are known. Commands that need it call `requireGitHub`. */
  github?: GitHub;
  token?: string;
  /** `owner/repo`. */
  repository?: string;
  /** `https://github.com` (or the GHES URL), without trailing slash. */
  serverUrl: string;
  env: Record<string, string | undefined>;
  /** GitHub Actions event, when running in Actions. */
  event?: ActionsEvent;
  run?: RunInfo;
  now: Date;
  log: Logger;
}

export interface ContextOptions {
  cwd: string;
  token?: string;
  repository?: string;
  env?: Record<string, string | undefined>;
  now?: Date;
  log?: Logger;
}

function positiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Run info from `GITHUB_RUN_ID` / `GITHUB_RUN_NUMBER` / `GITHUB_RUN_ATTEMPT`. */
export function runInfoFromEnv(
  env: Record<string, string | undefined>,
  serverUrl: string,
  repository: string | undefined,
): RunInfo | undefined {
  const id = positiveInt(env.GITHUB_RUN_ID);
  const number = positiveInt(env.GITHUB_RUN_NUMBER);
  const attempt = positiveInt(env.GITHUB_RUN_ATTEMPT);
  if (id === undefined && number === undefined) return undefined;
  const run: RunInfo = {};
  if (id !== undefined) run.id = id;
  if (number !== undefined) run.number = number;
  if (attempt !== undefined) run.attempt = attempt;
  if (id !== undefined && repository) run.url = `${serverUrl}/${repository}/actions/runs/${id}`;
  return run;
}

async function readEvent(
  env: Record<string, string | undefined>,
): Promise<ActionsEvent | undefined> {
  const name = env.GITHUB_EVENT_NAME;
  if (!name) return undefined;
  let payload: Record<string, unknown> = {};
  if (env.GITHUB_EVENT_PATH) {
    try {
      payload = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8")) as Record<
        string,
        unknown
      >;
    } catch (error) {
      throw new LaunchsetError(
        "invalid-event",
        `Can't read the GitHub event payload at ${env.GITHUB_EVENT_PATH}: ${(error as Error).message}`,
      );
    }
  }
  return { name, payload };
}

/** Load the config and set up git, GitHub and the Actions environment. */
export async function createContext(options: ContextOptions): Promise<FlowContext> {
  const env = options.env ?? process.env;
  const log = options.log ?? silentLogger;
  const { config, file, root } = await loadConfig(options.cwd);
  const serverUrl = (env.GITHUB_SERVER_URL || "https://github.com").replace(/\/+$/, "");
  const token = options.token || env.LAUNCHSET_TOKEN || env.GITHUB_TOKEN || undefined;
  const git = new Git({ cwd: root, ...(token ? { token } : {}), serverUrl });
  let repository = options.repository || env.GITHUB_REPOSITORY || undefined;
  if (!repository) repository = (await git.repoFromRemote().catch(() => undefined)) ?? undefined;
  const github =
    token && repository
      ? createGitHub({
          token,
          repository,
          ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}),
          log,
        })
      : undefined;
  const context: FlowContext = {
    cwd: root,
    config,
    configFile: file,
    git,
    serverUrl,
    env,
    now: options.now ?? new Date(),
    log,
  };
  if (github) context.github = github;
  if (token) context.token = token;
  if (repository) context.repository = repository;
  const event = await readEvent(env);
  if (event) context.event = event;
  const run = runInfoFromEnv(env, serverUrl, repository);
  if (run) context.run = run;
  return context;
}

/** The GitHub client, or a clear error saying a token is needed. */
export function requireGitHub(context: FlowContext, what: string): GitHub {
  if (context.github) return context.github;
  throw new LaunchsetError("no-github-token", `${what} needs a GitHub token and the repository.`, {
    hint: context.repository
      ? "Pass --token or set GITHUB_TOKEN (in workflows: the GitHub App token)."
      : "Pass --token and --repo owner/repo, or set GITHUB_TOKEN and GITHUB_REPOSITORY.",
  });
}

/**
 * Result of a flow command: action outputs, the job summary (markdown), human-readable
 * lines for the terminal, JSON for `--json`, and whether the command failed.
 */
export interface FlowResult<Data = unknown> {
  ok: boolean;
  outputs: Record<string, string>;
  summary: string;
  lines: string[];
  data: Data;
  /**
   * Environment variables for later steps (`LAUNCHSET_VERSION`, `LAUNCHSET_BUILD_NUMBER`,
   * `LAUNCHSET_CHANNEL`, spec 6.5); the action exports them. Set by `stamp` and `ship`.
   */
  env?: Record<string, string>;
}
