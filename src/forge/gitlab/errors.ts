/** Turning failed GitLab API calls into {@link GitLabError}s with a hint. */

import { ForgeError } from "../errors.ts";

/** A GitLab API call failed. The message says which call and why; `hint` what to do. */
export class GitLabError extends ForgeError {
  override name = "GitLabError";
}

/** What a call was, for hints. */
export interface CallInfo {
  /** Method and path, e.g. `POST /projects/acme%2Fapp/merge_requests`. */
  endpoint: string;
  /** Full repository path. */
  repository: string;
  apiUrl: string;
  /** `job` for `CI_JOB_TOKEN`, which can do very little. */
  tokenKind: "private" | "job";
}

/** The `message` / `error` field of a GitLab error body, flattened to one line. */
export function apiMessage(data: unknown, fallback: string): string {
  if (typeof data === "string") return data.trim().slice(0, 300) || fallback;
  if (!data || typeof data !== "object") return fallback;
  const record = data as { message?: unknown; error?: unknown; error_description?: unknown };
  const flatten = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(flatten).join(", ");
    if (value && typeof value === "object") {
      return Object.entries(value)
        .map(([key, v]) => `${key} ${flatten(v)}`)
        .join("; ");
    }
    return "";
  };
  const parts = [record.message, record.error, record.error_description]
    .map(flatten)
    .filter(Boolean);
  return parts.length ? [...new Set(parts)].join(": ").slice(0, 500) : fallback;
}

function hintFor(status: number | undefined, message: string, info: CallInfo): string {
  const job = info.tokenKind === "job";
  switch (status) {
    case undefined:
      return `Could not reach the GitLab API at ${info.apiUrl}. Check the network and CI_API_V4_URL.`;
    case 401:
      return job
        ? "CI_JOB_TOKEN was rejected (the job may have finished). Set LAUNCHSET_TOKEN to a project or group access token."
        : "The token is invalid or expired. LAUNCHSET_TOKEN must be a valid project or group access token with the `api` scope.";
    case 403:
      if (job) {
        return "CI_JOB_TOKEN can't do this (it can only read merge requests and notes). Set LAUNCHSET_TOKEN to a project or group access token.";
      }
      return "The token needs the `api` scope and at least the Developer role (Maintainer to push to protected branches and tags). Check the token's scopes and its role in the project.";
    case 404:
      return `Not found. Check that ${info.repository} exists and that the token has access to it (GitLab answers 404 when a token can't see a resource).`;
    case 409:
      return "GitLab reported a conflict; the resource changed meanwhile. Re-run the job.";
    case 422:
      return "GitLab rejected the request as invalid; see the details above.";
    case 429:
      return "GitLab's API rate limit was reached. Wait a minute and re-run the job.";
    default:
      if (status >= 500) return "GitLab had a server error. Re-run the job.";
      return /\S/.test(message)
        ? `Unexpected response from GitLab for ${info.endpoint}.`
        : "Unexpected response from GitLab.";
  }
}

/**
 * The error for a failed call. `status` is undefined when no response arrived; `data` is the
 * parsed response body. Secrets are removed with `mask` everywhere.
 */
export function toGitLabError(
  failure: { status?: number; data?: unknown; cause?: unknown; networkMessage?: string },
  info: CallInfo,
  mask: (s: string) => string,
): GitLabError {
  const text = apiMessage(failure.data, failure.networkMessage ?? "no details");
  const hint = hintFor(failure.status, text, info);
  const message = mask(
    `GitLab API ${info.endpoint} failed${failure.status ? ` (${failure.status})` : ""}: ${text}`,
  );
  return new GitLabError(message, failure.status, info.endpoint, mask(hint), {
    cause: failure.cause,
  });
}
