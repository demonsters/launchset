/** The GitHub Actions {@link CiEnvironment} adapter: `GITHUB_*` variables and the event payload. */

import { readFile } from "node:fs/promises";
import { LaunchsetError } from "../../core/errors.ts";
import { DEFAULT_SERVER_URLS } from "../../core/forge-links.ts";
import type { RunInfo } from "../../core/types.ts";
import type { CiEnvironment, Env, EventInfo, EventKind, EventPr } from "./types.ts";

/** A GitHub Actions event (`GITHUB_EVENT_NAME` / `GITHUB_EVENT_PATH`). */
export interface ActionsEvent {
  name: string;
  /** Parsed event payload, `{}` when unavailable. */
  payload: Record<string, unknown>;
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

const KINDS: Readonly<Record<string, EventKind>> = {
  pull_request: "pr",
  push: "push",
  workflow_dispatch: "dispatch",
};

/** Parse the fields launchset reads from an Actions event payload. */
export function parseEvent(event: ActionsEvent): EventInfo {
  const { payload } = event;
  const inputs: Record<string, string> = {};
  for (const [key, value] of Object.entries(record(payload.inputs) ?? {})) {
    if (typeof value === "string") inputs[key] = value;
    else if (typeof value === "boolean" || typeof value === "number") inputs[key] = String(value);
  }
  const info: EventInfo = { name: event.name, kind: KINDS[event.name] ?? "other", inputs };
  const pr = parsePr(payload);
  if (pr) info.pr = pr;
  const ref = text(payload.ref);
  if (ref) info.ref = ref;
  const after = text(payload.after);
  if (after && !/^0+$/.test(after)) info.sha = after;
  return info;
}

function positiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Run info from `GITHUB_RUN_ID` / `GITHUB_RUN_NUMBER` / `GITHUB_RUN_ATTEMPT` (no URL). */
export function githubRunInfo(env: Env): RunInfo | undefined {
  const id = positiveInt(env.GITHUB_RUN_ID);
  const number = positiveInt(env.GITHUB_RUN_NUMBER);
  const attempt = positiveInt(env.GITHUB_RUN_ATTEMPT);
  if (id === undefined && number === undefined) return undefined;
  const run: RunInfo = {};
  if (id !== undefined) run.id = id;
  if (number !== undefined) run.number = number;
  if (attempt !== undefined) run.attempt = attempt;
  return run;
}

/** The event of the run (`GITHUB_EVENT_NAME`, payload from `GITHUB_EVENT_PATH`), if any. */
export async function readActionsEvent(env: Env): Promise<ActionsEvent | undefined> {
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

/** The environment from `env` and an already read `event`. */
export function githubEnvironment(env: Env, event?: ActionsEvent): CiEnvironment {
  const ci: CiEnvironment = {
    host: "github",
    inCi: env.GITHUB_ACTIONS === "true",
    serverUrl: (env.GITHUB_SERVER_URL || DEFAULT_SERVER_URLS.github).replace(/\/+$/, ""),
  };
  const set = <K extends keyof CiEnvironment>(key: K, value: CiEnvironment[K] | "" | undefined) => {
    if (value) ci[key] = value;
  };
  set("apiUrl", env.GITHUB_API_URL);
  set("repository", env.GITHUB_REPOSITORY);
  set("token", env.LAUNCHSET_TOKEN || env.GITHUB_TOKEN);
  set("fallbackToken", env.GITHUB_TOKEN);
  set("event", event ? parseEvent(event) : undefined);
  set("run", githubRunInfo(env));
  set("ref", env.GITHUB_REF);
  set("refName", env.GITHUB_REF_NAME);
  set("sha", env.GITHUB_SHA);
  return ci;
}

/** Read the GitHub Actions environment (the event payload file included). */
export async function readGitHubEnvironment(env: Env): Promise<CiEnvironment> {
  return githubEnvironment(env, await readActionsEvent(env));
}
