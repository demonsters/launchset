/** msw setup for GitHub REST tests. Unhandled requests fail the test. */

import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";

export const API = "https://api.github.com";
export const REPO = `${API}/repos/acme/app`;
export const TOKEN = "ghs_SuperSecretInstallationToken";

export const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** A minimal pulls API object. */
export function rawPr(
  number: number,
  overrides: {
    title?: string;
    body?: string | null;
    state?: "open" | "closed";
    merged_at?: string | null;
    login?: string;
    head?: string;
    base?: string;
    merge_commit_sha?: string | null;
    updated_at?: string;
  } = {},
) {
  return {
    number,
    title: overrides.title ?? `PR ${number}`,
    body: overrides.body === undefined ? `Body ${number}` : overrides.body,
    state: overrides.state ?? "closed",
    merged_at: overrides.merged_at === undefined ? "2026-11-01T10:00:00Z" : overrides.merged_at,
    merge_commit_sha:
      overrides.merge_commit_sha === undefined ? `merge${number}` : overrides.merge_commit_sha,
    updated_at: overrides.updated_at ?? "2026-11-01T10:00:00Z",
    user: { login: overrides.login ?? "someone", type: "User" },
    head: { ref: overrides.head ?? `branch-${number}`, sha: `head${number}` },
    base: { ref: overrides.base ?? "main" },
    html_url: `https://github.com/acme/app/pull/${number}`,
  };
}

/** `Link` header for page `page` of `last`. */
export function linkHeader(url: string, page: number, last: number): Record<string, string> {
  if (page >= last) return {};
  const next = new URL(url);
  next.searchParams.set("page", String(page + 1));
  return { link: `<${next.toString()}>; rel="next"` };
}
