/**
 * The GitHub {@link Forge}: a small typed REST client around @octokit/rest (spec 9). Tags and
 * branches are pushed with git (src/git); this client handles PRs, comments, releases and
 * lookups. Every failure is a {@link GitHubError} with status, endpoint and a hint.
 */

import type { Octokit } from "@octokit/rest";
import type { Forge, Logger, PrFileStatus, PullRequest, Release } from "../types.ts";
import { stickyMarker } from "../types.ts";
import { type CallInfo, GitHubError, toGitHubError } from "./errors.ts";

export { GitHubError } from "./errors.ts";
export { REQUIRED_APP_PERMISSIONS } from "./permissions.ts";

export interface GitHubOptions {
  token: string;
  /** `owner/repo` (`GITHUB_REPOSITORY`). */
  repository: string;
  /** `GITHUB_API_URL`; default `https://api.github.com`. */
  apiUrl?: string;
  /** Receives Octokit's warnings (deprecations); default: dropped. */
  log?: Partial<Logger>;
}

type RawPull = {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  updated_at?: string;
  user?: { login?: string } | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  html_url: string;
};

type RawRelease = {
  id: number;
  tag_name: string;
  name?: string | null;
  body?: string | null;
  prerelease: boolean;
  draft: boolean;
  html_url: string;
};

function toPr(raw: RawPull): PullRequest {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    state: raw.state === "open" ? "open" : "closed",
    mergedAt: raw.merged_at ?? null,
    mergeCommitSha: raw.merged_at ? (raw.merge_commit_sha ?? null) : null,
    updatedAt: raw.updated_at ?? "",
    author: raw.user?.login ?? "",
    head: raw.head.ref,
    headSha: raw.head.sha,
    base: raw.base.ref,
    url: raw.html_url,
  };
}

function toRelease(raw: RawRelease): Release {
  return {
    id: raw.id,
    tag: raw.tag_name,
    name: raw.name ?? "",
    body: raw.body ?? "",
    prerelease: raw.prerelease,
    draft: raw.draft,
    url: raw.html_url,
  };
}

const noop = () => {};

export function createGitHub(options: GitHubOptions): Forge {
  const [owner, repo, ...rest] = options.repository.split("/");
  if (!owner || !repo || rest.length) {
    throw new GitHubError(
      `Invalid repository "${options.repository}": expected "owner/repo".`,
      undefined,
      "",
      "Pass GITHUB_REPOSITORY, e.g. demonsters/app.",
    );
  }
  if (!options.token) {
    throw new GitHubError(
      "No GitHub token given.",
      undefined,
      "",
      "Pass the GitHub App token as `token` (or GITHUB_TOKEN / --token for the CLI).",
    );
  }
  const apiUrl = (options.apiUrl || "https://api.github.com").replace(/\/+$/, "");
  const repository = `${owner}/${repo}`;
  const token = options.token;
  // @octokit/rest is loaded on the first call: commands that never talk to GitHub (and
  // `--version`, `--help`) don't pay for it.
  let octokitPromise: Promise<Octokit> | undefined;
  const client = (): Promise<Octokit> =>
    (octokitPromise ??= import("@octokit/rest").then(
      ({ Octokit }) =>
        new Octokit({
          auth: token,
          baseUrl: apiUrl,
          userAgent: "launchset",
          log: {
            debug: noop,
            info: noop,
            warn: options.log?.warn ? (m: string) => options.log?.warn?.(m) : noop,
            error: noop,
          },
        }),
    ));
  const mask = (text: string) => text.split(token).join("***");
  const base = `/repos/${owner}/${repo}`;

  async function call<T>(
    endpoint: string,
    permission: string,
    write: boolean,
    fn: (octokit: Octokit) => Promise<T>,
  ): Promise<T> {
    const octokit = await client();
    try {
      return await fn(octokit);
    } catch (error) {
      const info: CallInfo = { endpoint, permission, write, repository, apiUrl };
      throw toGitHubError(error, info, mask);
    }
  }

  const PR = "Pull requests";

  /** Merged PRs into `baseBranch`, newest update first, down to `since` (ms). */
  const listClosedPrs = (baseBranch: string, since: number | undefined): Promise<PullRequest[]> =>
    call(`GET ${base}/pulls?state=closed&base=${baseBranch}`, PR, false, async (octokit) => {
      const result: PullRequest[] = [];
      for await (const page of octokit.paginate.iterator(octokit.rest.pulls.list, {
        owner,
        repo,
        state: "closed",
        base: baseBranch,
        sort: "updated",
        direction: "desc",
        per_page: 100,
      })) {
        for (const raw of page.data) {
          if (since !== undefined && Date.parse(raw.updated_at) < since) return result;
          if (raw.merged_at) result.push(toPr(raw as RawPull));
        }
      }
      return result;
    });
  const closedListings = new Map<
    string,
    { since: number | undefined; prs: Promise<PullRequest[]> }
  >();

  return {
    repository,

    findOpenPrByHead(branch) {
      return call(`GET ${base}/pulls?head=${owner}:${branch}`, PR, false, async (octokit) => {
        const { data } = await octokit.rest.pulls.list({
          owner,
          repo,
          state: "open",
          head: `${owner}:${branch}`,
          per_page: 100,
        });
        const match = data.find((pr) => pr.head.ref === branch);
        return match ? toPr(match as RawPull) : null;
      });
    },

    createPr({ head, base: baseBranch, title, body }) {
      return call(`POST ${base}/pulls`, PR, true, async (octokit) => {
        const { data } = await octokit.rest.pulls.create({
          owner,
          repo,
          head,
          base: baseBranch,
          title,
          body,
          maintainer_can_modify: false,
        });
        return toPr(data as RawPull);
      });
    },

    updatePr(number, { title, body }) {
      return call(`PATCH ${base}/pulls/${number}`, PR, true, async (octokit) => {
        const { data } = await octokit.rest.pulls.update({
          owner,
          repo,
          pull_number: number,
          ...(title !== undefined ? { title } : {}),
          ...(body !== undefined ? { body } : {}),
        });
        return toPr(data as RawPull);
      });
    },

    async closePr(number, comment) {
      if (comment) {
        await call(`POST ${base}/issues/${number}/comments`, PR, true, (octokit) =>
          octokit.rest.issues.createComment({ owner, repo, issue_number: number, body: comment }),
        );
      }
      await call(`PATCH ${base}/pulls/${number}`, PR, true, (octokit) =>
        octokit.rest.pulls.update({ owner, repo, pull_number: number, state: "closed" }),
      );
    },

    getPr(number) {
      return call(`GET ${base}/pulls/${number}`, PR, false, async (octokit) => {
        const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: number });
        return toPr(data as RawPull);
      });
    },

    async upsertStickyComment(issueNumber, id, body) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
        throw new GitHubError(
          `Invalid sticky comment id "${id}".`,
          undefined,
          "",
          "Use letters, digits, '.', '_' and '-'.",
        );
      }
      const marker = stickyMarker(id);
      const fullBody = `${marker}\n${body}`;
      const existing = await call(
        `GET ${base}/issues/${issueNumber}/comments`,
        PR,
        false,
        async (octokit) => {
          for await (const page of octokit.paginate.iterator(octokit.rest.issues.listComments, {
            owner,
            repo,
            issue_number: issueNumber,
            per_page: 100,
          })) {
            // Only comments written by a bot account (launchset's App or github-actions) are
            // ours; a person quoting the marker must not hijack the sticky comment.
            const found = page.data.find((c) => c.user?.type === "Bot" && c.body?.includes(marker));
            if (found) return found;
          }
          return undefined;
        },
      );
      if (existing) {
        if (existing.body === fullBody) {
          return { id: existing.id, url: existing.html_url, action: "unchanged" };
        }
        const { data } = await call(
          `PATCH ${base}/issues/comments/${existing.id}`,
          PR,
          true,
          (octokit) =>
            octokit.rest.issues.updateComment({
              owner,
              repo,
              comment_id: existing.id,
              body: fullBody,
            }),
        );
        return { id: data.id, url: data.html_url, action: "updated" };
      }
      const { data } = await call(
        `POST ${base}/issues/${issueNumber}/comments`,
        PR,
        true,
        (octokit) =>
          octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: issueNumber,
            body: fullBody,
          }),
      );
      return { id: data.id, url: data.html_url, action: "created" };
    },

    async getReleaseByTag(tag) {
      const endpoint = `GET ${base}/releases/tags/${tag}`;
      const octokit = await client();
      try {
        const { data } = await octokit.rest.repos.getReleaseByTag({ owner, repo, tag });
        return toRelease(data as RawRelease);
      } catch (error) {
        if ((error as { status?: unknown }).status === 404) return null;
        throw toGitHubError(
          error,
          { endpoint, permission: "Contents", write: false, repository, apiUrl },
          mask,
        );
      }
    },

    createRelease({ tag, name, body, prerelease, makeLatest }) {
      return call(`POST ${base}/releases`, "Contents", true, async (octokit) => {
        const { data } = await octokit.rest.repos.createRelease({
          owner,
          repo,
          tag_name: tag,
          name,
          body,
          prerelease,
          draft: false,
          make_latest: makeLatest ? "true" : "false",
        });
        return toRelease(data as RawRelease);
      });
    },

    updateRelease({ id }, { name, body, prerelease, makeLatest }) {
      return call(`PATCH ${base}/releases/${id}`, "Contents", true, async (octokit) => {
        const { data } = await octokit.rest.repos.updateRelease({
          owner,
          repo,
          release_id: id,
          ...(name !== undefined ? { name } : {}),
          ...(body !== undefined ? { body } : {}),
          ...(prerelease !== undefined ? { prerelease } : {}),
          ...(makeLatest !== undefined ? { make_latest: makeLatest ? "true" : "false" } : {}),
        });
        return toRelease(data as RawRelease);
      });
    },

    pullRequestsForCommit(sha) {
      return call(`GET ${base}/commits/${sha}/pulls`, "Contents", false, async (octokit) => {
        const data = await octokit.paginate(
          octokit.rest.repos.listPullRequestsAssociatedWithCommit,
          {
            owner,
            repo,
            commit_sha: sha,
            per_page: 100,
          },
        );
        return data.filter((pr) => pr.merged_at).map((pr) => toPr(pr as RawPull));
      });
    },

    async closedPrsInto(baseBranch, options = {}) {
      const since = options.updatedSince ? Date.parse(options.updatedSince) : undefined;
      if (since !== undefined && Number.isNaN(since)) {
        throw new GitHubError(
          `Invalid updatedSince "${options.updatedSince}".`,
          undefined,
          "",
          "Pass an ISO 8601 time.",
        );
      }
      // One listing per branch serves later calls that look back no further (bot PRs and
      // changelog links of one release PR).
      const cached = closedListings.get(baseBranch);
      if (
        cached &&
        (cached.since === undefined || (since !== undefined && since >= cached.since))
      ) {
        const prs = await cached.prs;
        return prs.filter((pr) => since === undefined || !(Date.parse(pr.updatedAt) < since));
      }
      const prs = listClosedPrs(baseBranch, since);
      closedListings.set(baseBranch, { since, prs });
      prs.catch(() => {
        if (closedListings.get(baseBranch)?.prs === prs) closedListings.delete(baseBranch);
      });
      return [...(await prs)];
    },

    prFiles(number) {
      return call(`GET ${base}/pulls/${number}/files`, PR, false, async (octokit) => {
        const data = await octokit.paginate(octokit.rest.pulls.listFiles, {
          owner,
          repo,
          pull_number: number,
          per_page: 100,
        });
        return data.map((f) => ({
          path: f.filename,
          status: f.status as PrFileStatus,
          ...(f.previous_filename ? { previousPath: f.previous_filename } : {}),
        }));
      });
    },

    listJobs(runId) {
      return call(`GET ${base}/actions/runs/${runId}/jobs`, "Actions", false, async (octokit) => {
        const data = await octokit.paginate(octokit.rest.actions.listJobsForWorkflowRun, {
          owner,
          repo,
          run_id: runId,
          filter: "latest",
          per_page: 100,
        });
        return data.map((job) => ({
          id: job.id,
          name: job.name,
          status: job.status,
          conclusion: job.conclusion ?? null,
          url: job.html_url ?? "",
        }));
      });
    },
  };
}
