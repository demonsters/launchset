/** Wrapping Octokit errors into {@link GitHubError}s with a hint (spec 9.1). */

import { ForgeError } from "../errors.ts";
import { permissionLabel } from "./permissions.ts";

/** A GitHub API call failed. The message says which call and why; `hint` what to do. */
export class GitHubError extends ForgeError {
  override name = "GitHubError";
}

/** What a call needs, for hints. */
export interface CallInfo {
  /** Method and path, e.g. `POST /repos/acme/app/pulls`. */
  endpoint: string;
  /** App permission name as on the settings page, e.g. `Pull requests`. */
  permission: string;
  write: boolean;
  /** `owner/repo`. */
  repository: string;
  apiUrl: string;
}

interface OctokitLikeError {
  status?: unknown;
  message?: unknown;
  response?: { data?: unknown; headers?: Record<string, unknown> };
}

function apiMessage(error: OctokitLikeError): string {
  const data = error.response?.data;
  if (data && typeof data === "object") {
    const record = data as { message?: unknown; errors?: unknown };
    const parts: string[] = [];
    if (typeof record.message === "string") parts.push(record.message);
    if (Array.isArray(record.errors)) {
      for (const item of record.errors) {
        if (typeof item === "string") parts.push(item);
        else if (item && typeof item === "object") {
          const e = item as { message?: unknown; code?: unknown; field?: unknown };
          const text =
            typeof e.message === "string"
              ? e.message
              : [e.field, e.code].filter((v) => typeof v === "string").join(" ");
          if (text) parts.push(text);
        }
      }
    }
    if (parts.length) return parts.join("; ");
  }
  if (typeof data === "string" && data.trim()) return data.trim().slice(0, 300);
  return typeof error.message === "string" ? error.message : String(error);
}

function hintFor(status: number | undefined, error: OctokitLikeError, info: CallInfo): string {
  const label = permissionLabel(info.permission, info.write);
  const headers = error.response?.headers ?? {};
  switch (status) {
    case undefined:
      return `Could not reach the GitHub API at ${info.apiUrl}. Check the network and GITHUB_API_URL.`;
    case 401:
      return "The token is invalid or expired. Mint it with actions/create-github-app-token in the same job (installation tokens expire after one hour).";
    case 403:
      if (
        String(headers["x-ratelimit-remaining"]) === "0" ||
        /rate limit/i.test(apiMessage(error))
      ) {
        return "GitHub's API rate limit was reached. Wait for the reset and re-run the job.";
      }
      return `The GitHub App token may lack "${label}" permission, or the App isn't installed on ${info.repository}. With the default GITHUB_TOKEN, grant it in the workflow's \`permissions:\` block.`;
    case 404:
      return info.write
        ? `Not found. The GitHub App token may lack "${label}" permission, or the App isn't installed on ${info.repository} (GitHub answers 404 when a token can't see a resource).`
        : `Not found. Check that ${info.repository} exists and that the token can read it ("${label}").`;
    case 409:
      return "GitHub reported a conflict; the resource changed meanwhile. Re-run the job.";
    case 422:
      return "GitHub rejected the request as invalid; see the details above.";
    default:
      if (status >= 500) return "GitHub had a server error. Re-run the job.";
      return `Unexpected response from GitHub for ${info.endpoint}.`;
  }
}

/** Wrap any error thrown by Octokit. Secrets in `mask` never appear in the message. */
export function toGitHubError(
  error: unknown,
  info: CallInfo,
  mask: (s: string) => string,
): GitHubError {
  if (error instanceof GitHubError) return error;
  const e = (
    error && typeof error === "object" ? error : { message: String(error) }
  ) as OctokitLikeError;
  // Octokit reports network failures (no response at all) as status 500 without `response`.
  const status =
    typeof e.status === "number" && e.status > 0 && e.response !== undefined ? e.status : undefined;
  const hint = hintFor(status, e, info);
  const message = mask(
    `GitHub API ${info.endpoint} failed${status ? ` (${status})` : ""}: ${apiMessage(e)}`,
  );
  return new GitHubError(message, status, info.endpoint, mask(hint), { cause: error });
}
