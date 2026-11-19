/**
 * The GitLab {@link Forge}: a small `fetch` client for the REST API v4 (no SDK). Tags and
 * branches are pushed with git (src/git); this client handles merge requests, notes,
 * releases and lookups. Merge requests are addressed by `iid`, which is `PullRequest.number`.
 * Every failure is a {@link GitLabError} with status, endpoint and a hint.
 */

import { forgeLinks } from "../../core/forge-links.ts";
import { cachedClosedPrs } from "../closed-prs.ts";
import type {
  Forge,
  Job,
  Logger,
  PrFile,
  PullRequest,
  Release,
  StickyCommentResult,
} from "../types.ts";
import { stickyMarker } from "../types.ts";
import { type CallInfo, GitLabError, toGitLabError } from "./errors.ts";

export { GitLabError } from "./errors.ts";
export { REQUIRED_TOKEN_SCOPES } from "./permissions.ts";

export interface GitLabOptions {
  /** A project, group or personal access token, or `CI_JOB_TOKEN` with `tokenKind: "job"`. */
  token: string;
  /** `private` (default): sent as `PRIVATE-TOKEN`; `job`: `CI_JOB_TOKEN`, sent as `JOB-TOKEN`. */
  tokenKind?: "private" | "job";
  /** Full project path, e.g. `group/sub/project` (`CI_PROJECT_PATH`). */
  repository: string;
  /** `CI_API_V4_URL`; default `https://gitlab.com/api/v4`. */
  apiUrl?: string;
  /** Web URL of the server (`CI_SERVER_URL`), for links; default derived from `apiUrl`. */
  serverUrl?: string;
  /** Receives warnings; default: dropped. */
  log?: Partial<Logger>;
  /** For tests. */
  fetch?: typeof fetch;
}

type RawMr = {
  iid: number;
  title: string;
  description?: string | null;
  state: string;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  squash_commit_sha?: string | null;
  sha?: string | null;
  updated_at?: string;
  author?: { username?: string } | null;
  source_branch: string;
  target_branch: string;
  source_project_id?: number;
  target_project_id?: number;
  web_url: string;
};

type RawNote = {
  id: number;
  body?: string | null;
  system?: boolean;
  author?: { id?: number; username?: string; bot?: boolean } | null;
};

type RawRelease = {
  tag_name: string;
  name?: string | null;
  description?: string | null;
  _links?: { self?: string };
};

type RawJob = { id: number; name: string; status: string; web_url?: string };

type RawBridge = {
  /** The pipeline the bridge job belongs to. */
  pipeline?: { project_id?: number } | null;
  downstream_pipeline?: { id: number; project_id?: number } | null;
};

type RawDiff = {
  old_path: string;
  new_path: string;
  new_file?: boolean;
  deleted_file?: boolean;
  renamed_file?: boolean;
};

function toPr(raw: RawMr): PullRequest {
  const merged = raw.state === "merged";
  return {
    number: raw.iid,
    title: raw.title,
    body: raw.description ?? "",
    state: raw.state === "opened" ? "open" : "closed",
    mergedAt: raw.merged_at ?? null,
    // Fast-forward merges have neither a merge nor a squash commit: the head is what landed.
    mergeCommitSha: merged
      ? (raw.merge_commit_sha ?? raw.squash_commit_sha ?? raw.sha ?? null)
      : null,
    updatedAt: raw.updated_at ?? "",
    author: raw.author?.username ?? "",
    head: raw.source_branch,
    headSha: raw.sha ?? "",
    base: raw.target_branch,
    url: raw.web_url,
  };
}

/** GitLab's job status in the vocabulary of GitHub's jobs, which `jobStatus` (preview) reads. */
function toJobState(status: string): Pick<Job, "status" | "conclusion"> {
  switch (status) {
    case "success":
      return { status: "completed", conclusion: "success" };
    case "failed":
      return { status: "completed", conclusion: "failure" };
    case "canceled":
    case "canceling":
      return { status: "completed", conclusion: "cancelled" };
    case "skipped":
    case "manual": // a manual job nobody ran
      return { status: "completed", conclusion: "skipped" };
    case "running":
      return { status: "in_progress", conclusion: null };
    default:
      return { status: "queued", conclusion: null };
  }
}

function toFile(raw: RawDiff): PrFile {
  if (raw.deleted_file) return { path: raw.old_path, status: "removed" };
  if (raw.new_file) return { path: raw.new_path, status: "added" };
  if (raw.renamed_file) {
    return { path: raw.new_path, status: "renamed", previousPath: raw.old_path };
  }
  return { path: raw.new_path, status: "modified" };
}

/** Our own bot: a project or group access token's user (`project_123_bot_ab12`). */
const BOT_USERNAME = /^(project|group)_\d+_bot(_|$)/;

type RequestOptions = {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
};

export function createGitLab(options: GitLabOptions): Forge {
  const repository = options.repository?.trim().replace(/^\/+|\/+$/g, "") ?? "";
  if (!repository) {
    throw new GitLabError(
      "No GitLab project given.",
      undefined,
      "",
      "Pass the project's full path, e.g. group/sub/project (CI_PROJECT_PATH).",
    );
  }
  if (!options.token) {
    throw new GitLabError(
      "No GitLab token given.",
      undefined,
      "",
      "Pass a project or group access token as `token` (LAUNCHSET_TOKEN / --token for the CLI).",
    );
  }
  const token = options.token;
  const tokenKind = options.tokenKind ?? "private";
  const apiUrl = (options.apiUrl || "https://gitlab.com/api/v4").replace(/\/+$/, "");
  const serverUrl = (options.serverUrl || apiUrl.replace(/\/api\/v4$/, "")).replace(/\/+$/, "");
  const links = forgeLinks({ host: "gitlab", serverUrl, repository });
  const headers: Record<string, string> = {
    [tokenKind === "job" ? "JOB-TOKEN" : "PRIVATE-TOKEN"]: token,
    "User-Agent": "launchset",
    Accept: "application/json",
  };
  const mask = (text: string) => text.split(token).join("***");
  const project = `/projects/${encodeURIComponent(repository)}`;
  const mrPath = (iid: number) => `${project}/merge_requests/${iid}`;

  function queryString(query: RequestOptions["query"]): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) params.set(key, String(value));
    }
    const text = params.toString();
    return text ? `?${text}` : "";
  }

  /** One request to `url`; `endpoint` (method and path, no query) names it in errors. */
  async function send(
    method: string,
    url: string,
    endpoint: string,
    body?: unknown,
  ): Promise<{ data: unknown; headers: Headers }> {
    const info: CallInfo = { endpoint, repository, apiUrl, tokenKind };
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(url, {
        method,
        headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      const networkMessage = error instanceof Error ? error.message : String(error);
      throw toGitLabError({ cause: error, networkMessage }, info, mask);
    }
    const text = await response.text().catch(() => "");
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      // Not JSON (a proxy's HTML page, say): the text itself is the message.
    }
    if (!response.ok) {
      throw toGitLabError(
        { status: response.status, data, networkMessage: response.statusText },
        info,
        mask,
      );
    }
    return { data, headers: response.headers };
  }

  async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const { data } = await send(
      method,
      `${apiUrl}${path}${queryString(opts.query)}`,
      `${method} ${path}`,
      opts.body,
    );
    return data as T;
  }

  /** Every item of a paginated listing, page by page (offset pagination, 100 per page). */
  async function* pages<T>(path: string, query: RequestOptions["query"] = {}): AsyncGenerator<T[]> {
    const endpoint = `GET ${path}`;
    let url: string | undefined = `${apiUrl}${path}${queryString({ ...query, per_page: 100 })}`;
    while (url) {
      const { data, headers: responseHeaders } = await send("GET", url, endpoint);
      yield Array.isArray(data) ? (data as T[]) : [];
      const nextPage = responseHeaders.get("x-next-page");
      if (nextPage !== null) {
        // Present but empty: the last page.
        url = nextPage
          ? `${apiUrl}${path}${queryString({ ...query, per_page: 100, page: nextPage })}`
          : undefined;
        continue;
      }
      // Without the header, the Link header's next URL, if it stays on the API's origin (the
      // token must never go anywhere else).
      const next = /<([^>]+)>;\s*rel="next"/.exec(responseHeaders.get("link") ?? "")?.[1];
      url =
        next && new URL(next, apiUrl).origin === new URL(apiUrl).origin
          ? new URL(next, apiUrl).href
          : undefined;
    }
  }

  async function all<T>(path: string, query?: RequestOptions["query"]): Promise<T[]> {
    const result: T[] = [];
    for await (const page of pages<T>(path, query)) result.push(...page);
    return result;
  }

  // The token's own user, fetched at most once; null when `GET /user` isn't allowed for the
  // token (job tokens, and not every bot token is documented to).
  let ownUser: Promise<{ id: number } | null> | undefined;
  const whoAmI = () =>
    (ownUser ??= request<{ id?: number }>("GET", "/user").then(
      (user) => (typeof user?.id === "number" ? { id: user.id } : null),
      (error) => {
        options.log?.debug?.(
          `GET /user failed (${(error as Error).message}); matching bot notes by name`,
        );
        return null;
      },
    ));

  /** Merged MRs into `base`, newest update first, down to `since` (ms). */
  async function listMergedMrs(base: string, since: number | undefined): Promise<PullRequest[]> {
    const result: PullRequest[] = [];
    for await (const page of pages<RawMr>(`${project}/merge_requests`, {
      state: "merged",
      target_branch: base,
      order_by: "updated_at",
      sort: "desc",
      ...(since !== undefined ? { updated_after: new Date(since).toISOString() } : {}),
    })) {
      for (const raw of page) {
        if (since !== undefined && Date.parse(raw.updated_at ?? "") < since) return result;
        if (raw.state === "merged") result.push(toPr(raw));
      }
    }
    return result;
  }

  const closedPrsInto = cachedClosedPrs(
    listMergedMrs,
    (value) =>
      new GitLabError(`Invalid updatedSince "${value}".`, undefined, "", "Pass an ISO 8601 time."),
  );

  const toRelease = (raw: RawRelease): Release => ({
    id: 0, // GitLab releases have no numeric id; they're keyed by tag.
    tag: raw.tag_name,
    name: raw.name ?? "",
    body: raw.description ?? "",
    prerelease: false,
    draft: false,
    url:
      raw._links?.self ??
      `${serverUrl}/${repository}/-/releases/${encodeURIComponent(raw.tag_name)}`,
  });
  const releasePath = (tag: string) => `${project}/releases/${encodeURIComponent(tag)}`;

  const jobsOf = async (pipelineId: number): Promise<Job[]> =>
    (await all<RawJob>(`${project}/pipelines/${pipelineId}/jobs`)).map((job) => ({
      id: job.id,
      name: job.name,
      ...toJobState(job.status),
      url: job.web_url ?? "",
    }));

  return {
    repository,

    async findOpenPrByHead(branch) {
      const mrs = await all<RawMr>(`${project}/merge_requests`, {
        state: "opened",
        source_branch: branch,
      });
      // Merge requests from forks with the same branch name aren't ours.
      const match = mrs.find(
        (mr) => mr.source_branch === branch && mr.source_project_id === mr.target_project_id,
      );
      return match ? toPr(match) : null;
    },

    async createPr({ head, base, title, body }) {
      return toPr(
        await request<RawMr>("POST", `${project}/merge_requests`, {
          body: { source_branch: head, target_branch: base, title, description: body },
        }),
      );
    },

    async updatePr(number, { title, body }) {
      return toPr(
        await request<RawMr>("PUT", mrPath(number), {
          body: {
            ...(title !== undefined ? { title } : {}),
            ...(body !== undefined ? { description: body } : {}),
          },
        }),
      );
    },

    async closePr(number, comment) {
      if (comment) await request("POST", `${mrPath(number)}/notes`, { body: { body: comment } });
      await request("PUT", mrPath(number), { body: { state_event: "close" } });
    },

    async getPr(number) {
      return toPr(await request<RawMr>("GET", mrPath(number)));
    },

    async upsertStickyComment(issueNumber, id, body): Promise<StickyCommentResult> {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
        throw new GitLabError(
          `Invalid sticky comment id "${id}".`,
          undefined,
          "",
          "Use letters, digits, '.', '_' and '-'.",
        );
      }
      const marker = stickyMarker(id);
      const fullBody = `${marker}\n${body}`;
      const notePath = `${mrPath(issueNumber)}/notes`;
      const candidates = (
        await all<RawNote>(notePath, { sort: "asc", order_by: "created_at" })
      ).filter((note) => !note.system && note.body?.includes(marker));
      // Only a note written by our own token's user is ours; a person quoting the marker must
      // not hijack the sticky note.
      let existing: RawNote | undefined;
      if (candidates.length) {
        const me = await whoAmI();
        existing = candidates.find((note) =>
          me
            ? note.author?.id === me.id
            : note.author?.bot === true || BOT_USERNAME.test(note.author?.username ?? ""),
        );
      }
      const noteUrl = (noteId: number) => `${links.prUrl(issueNumber)}#note_${noteId}`;
      if (existing) {
        if (existing.body === fullBody) {
          return { id: existing.id, url: noteUrl(existing.id), action: "unchanged" };
        }
        const note = await request<RawNote>("PUT", `${notePath}/${existing.id}`, {
          body: { body: fullBody },
        });
        return { id: note.id, url: noteUrl(note.id), action: "updated" };
      }
      const note = await request<RawNote>("POST", notePath, { body: { body: fullBody } });
      return { id: note.id, url: noteUrl(note.id), action: "created" };
    },

    async getReleaseByTag(tag) {
      try {
        return toRelease(await request<RawRelease>("GET", releasePath(tag)));
      } catch (error) {
        // GitLab answers 404 for a tag without a release.
        if (error instanceof GitLabError && error.status === 404) return null;
        throw error;
      }
    },

    // GitLab releases have no `prerelease` and no `make_latest` (the latest is the one with the
    // newest `released_at`): both are ignored. The tag exists already: git pushed it.
    async createRelease({ tag, name, body }) {
      return toRelease(
        await request<RawRelease>("POST", `${project}/releases`, {
          body: { tag_name: tag, name, description: body },
        }),
      );
    },

    async updateRelease({ tag }, { name, body }) {
      return toRelease(
        await request<RawRelease>("PUT", releasePath(tag), {
          body: {
            ...(name !== undefined ? { name } : {}),
            ...(body !== undefined ? { description: body } : {}),
          },
        }),
      );
    },

    async pullRequestsForCommit(sha) {
      const mrs = await all<RawMr>(
        `${project}/repository/commits/${encodeURIComponent(sha)}/merge_requests`,
      );
      return mrs.filter((mr) => mr.state === "merged").map(toPr);
    },

    closedPrsInto,

    async prFiles(number) {
      return (await all<RawDiff>(`${mrPath(number)}/diffs`)).map(toFile);
    },

    async listJobs(pipelineId) {
      const jobs = await jobsOf(pipelineId);
      // launchset's build jobs run in a generated child pipeline, reached through the trigger
      // jobs ("bridges") of this one; one level is enough. Other projects' pipelines aren't ours.
      const bridges = await all<RawBridge>(`${project}/pipelines/${pipelineId}/bridges`);
      for (const bridge of bridges) {
        const child = bridge.downstream_pipeline;
        if (!child) continue;
        const own = bridge.pipeline?.project_id;
        if (own !== undefined && child.project_id !== undefined && child.project_id !== own)
          continue;
        jobs.push(...(await jobsOf(child.id)));
      }
      return jobs;
    },
  };
}
