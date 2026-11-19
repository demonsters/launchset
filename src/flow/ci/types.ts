/**
 * What launchset reads from the CI environment, host-neutral. One adapter per host
 * (`github.ts`) fills it in from that host's variables; flows read only this, never
 * `GITHUB_*` / `CI_*` variables themselves.
 */

import type { ForgeHost } from "../../core/forge-links.ts";
import type { RunInfo } from "../../core/types.ts";

/** A pull request (merge request) of the event. */
export interface EventPr {
  /** The PR number (GitHub `pull_request.number`, else the payload's `number`). */
  number?: number;
  headRef?: string;
  headSha?: string;
  /** Full path of the repository the head branch lives in; undefined when the fork was deleted. */
  headRepo?: string;
  baseRef?: string;
  baseSha?: string;
  /** Full path of the base repository. */
  baseRepo?: string;
  /** Login of the PR's author. */
  author?: string;
  labels: string[];
  /** A fork PR: the head repo is gone (deleted fork) or isn't the base repo. */
  fork: boolean;
  /** The event's action (`opened`, `synchronize`, `labeled`, …). */
  action?: string;
  /** The label of a `labeled`/`unlabeled` event. */
  label?: string;
}

/**
 * What started the run, normalized: `pr` (GitHub `pull_request`), `push`, `dispatch` (GitHub
 * `workflow_dispatch`, a run started by hand), `other` (anything else).
 */
export type EventKind = "pr" | "push" | "dispatch" | "other";

/** The fields of a CI event launchset reads, parsed once. */
export interface EventInfo {
  /** The host's raw event name (`pull_request`, `push`, …), for messages. */
  name: string;
  kind: EventKind;
  /** Set when the event is about a PR. */
  pr?: EventPr;
  /** The event's ref (push and dispatch: `refs/heads/<branch>`). */
  ref?: string;
  /** The pushed commit (push), unless the branch was deleted. */
  sha?: string;
  /** Inputs of a run started by hand, as strings. */
  inputs: Record<string, string>;
}

/** The CI environment of one run, as an adapter read it. Everything is optional outside CI. */
export interface CiEnvironment {
  host: ForgeHost;
  /** True when running in the host's CI (GitHub: `GITHUB_ACTIONS=true`). */
  inCi: boolean;
  /** Web URL of the server, without trailing slash (GitHub: `GITHUB_SERVER_URL`). */
  serverUrl: string;
  /** API URL (GitHub: `GITHUB_API_URL`); undefined for the host's default. */
  apiUrl?: string;
  /** Full repository path (GitHub: `GITHUB_REPOSITORY`). */
  repository?: string;
  /** The token to use (GitHub: `LAUNCHSET_TOKEN`, else `GITHUB_TOKEN`). */
  token?: string;
  /**
   * A read-only fallback token for reads the main token may lack permission for (GitHub: the
   * workflow's `GITHUB_TOKEN`).
   */
  fallbackToken?: string;
  /** The run's event; undefined outside CI. */
  event?: EventInfo;
  /** The run's id, number and attempt (no URL: that needs the repository). */
  run?: RunInfo;
  /** The ref the run is on (GitHub: `GITHUB_REF`, e.g. `refs/heads/main`). */
  ref?: string;
  /** Short name of that ref (GitHub: `GITHUB_REF_NAME`). */
  refName?: string;
  /** The commit the run is for (GitHub: `GITHUB_SHA`). */
  sha?: string;
}

export type Env = Record<string, string | undefined>;
