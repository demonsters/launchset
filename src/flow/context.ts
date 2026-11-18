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

/** A pull request from the event payload (`pull_request`). */
export interface EventPr {
  /** `pull_request.number` (else the payload's `number`). */
  number?: number;
  headRef?: string;
  headSha?: string;
  /** `owner/repo` the head branch lives in; undefined when the fork was deleted. */
  headRepo?: string;
  baseRef?: string;
  baseSha?: string;
  /** `owner/repo` of the base branch (`base.repo`, else the payload's `repository`). */
  baseRepo?: string;
  /** Login of the PR's author. */
  author?: string;
  labels: string[];
  /** A fork PR: the head repo is gone (deleted fork) or isn't the base repo. */
  fork: boolean;
  /** The event's `action` (`opened`, `synchronize`, `labeled`, …). */
  action?: string;
  /** The label of a `labeled`/`unlabeled` event. */
  label?: string;
}

/** The fields of an Actions event launchset reads, parsed from the payload once. */
export interface EventInfo {
  name: string;
  /** Set when the payload has a `pull_request`. */
  pr?: EventPr;
  /** The payload's `ref` (push and workflow_dispatch: `refs/heads/<branch>`). */
  ref?: string;
  /** The payload's `after` (push), unless it's all zeros (a deleted branch). */
  sha?: string;
  /** `workflow_dispatch` inputs, as strings. */
  inputs: Record<string, string>;
}

type Json = Record<string, unknown>;

function record(value: unknown): Json | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function parsePr(payload: Json): EventPr | undefined {
  const pr = record(payload.pull_request);
  if (!pr) return undefined;
  const head = record(pr.head);
  const base = record(pr.base);
  const number =
    typeof pr.number === "number"
      ? pr.number
      : typeof payload.number === "number"
        ? payload.number
        : undefined;
  const headRepo = text(record(head?.repo)?.full_name);
  const baseRepo =
    text(record(base?.repo)?.full_name) ?? text(record(payload.repository)?.full_name);
  const labels = Array.isArray(pr.labels)
    ? pr.labels.flatMap((l) => {
        const name = text(record(l)?.name);
        return name ? [name] : [];
      })
    : [];
  return {
    number,
    headRef: text(head?.ref),
    headSha: text(head?.sha),
    headRepo,
    baseRef: text(base?.ref),
    baseSha: text(base?.sha),
    baseRepo,
    author: text(record(pr.user)?.login),
    labels,
    fork: headRepo === undefined || headRepo !== baseRepo,
    action: text(payload.action),
    label: text(record(payload.label)?.name),
  };
}

/** Parse the fields launchset reads from an event payload. */
export function parseEvent(event: ActionsEvent): EventInfo {
  const { payload } = event;
  const inputs: Record<string, string> = {};
  for (const [key, value] of Object.entries(record(payload.inputs) ?? {})) {
    if (typeof value === "string") inputs[key] = value;
    else if (typeof value === "boolean" || typeof value === "number") inputs[key] = String(value);
  }
  const info: EventInfo = { name: event.name, inputs };
  const pr = parsePr(payload);
  if (pr) info.pr = pr;
  const ref = text(payload.ref);
  if (ref) info.ref = ref;
  const after = text(payload.after);
  if (after && !/^0+$/.test(after)) info.sha = after;
  return info;
}

const parsedEvents = new WeakMap<ActionsEvent, EventInfo>();

/** The context's event, parsed (once per event); undefined outside Actions. */
export function eventInfo(context: Pick<FlowContext, "event">): EventInfo | undefined {
  const { event } = context;
  if (!event) return undefined;
  let info = parsedEvents.get(event);
  if (!info) {
    info = parseEvent(event);
    parsedEvents.set(event, info);
  }
  return info;
}

/** `refs/heads/main` → `main`; anything else → undefined. */
export function branchFromRef(ref: string | undefined): string | undefined {
  return ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined;
}

export interface FlowContext {
  /** Config root (the directory with `launchset.config.*`; the action's `working-directory`). */
  cwd: string;
  config: ResolvedConfig;
  configFile: string;
  git: Git;
  /** Set when a token and the repository are known. Commands that need it call `requireGitHub`. */
  github?: GitHub;
  /**
   * A client for the workflow's own `GITHUB_TOKEN`, when that isn't `token` (the App token):
   * a fallback for reads the App may lack permission for (the run's jobs).
   */
  workflowGitHub?: GitHub;
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
  /** Overrides the run info from the environment (`plan --run-number`). */
  run?: RunInfo;
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
  const client = (clientToken: string | undefined) =>
    clientToken && repository
      ? createGitHub({
          token: clientToken,
          repository,
          ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}),
          log,
        })
      : undefined;
  const github = client(token);
  const workflowGitHub = env.GITHUB_TOKEN !== token ? client(env.GITHUB_TOKEN) : undefined;
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
  if (workflowGitHub) context.workflowGitHub = workflowGitHub;
  if (token) context.token = token;
  if (repository) context.repository = repository;
  const event = await readEvent(env);
  if (event) {
    context.event = event;
    eventInfo(context); // parsed once, here; flows read it with eventInfo(context)
  }
  const fromEnv = runInfoFromEnv(env, serverUrl, repository);
  const run = options.run ? { ...fromEnv, ...options.run } : fromEnv;
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
