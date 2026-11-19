import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import {
  createGitLab,
  GitLabError,
  REQUIRED_TOKEN_SCOPES,
} from "../../../src/forge/gitlab/index.ts";
import { stickyMarker } from "../../../src/forge/types.ts";
import { server } from "../helpers.ts";

const API = "https://gitlab.com/api/v4";
const PROJECT = `${API}/projects/acme%2Fsub%2Fapp`;
const TOKEN = "glpat-SuperSecretToken";
const WEB = "https://gitlab.com/acme/sub/app";

const gl = (extra: Partial<Parameters<typeof createGitLab>[0]> = {}) =>
  createGitLab({ token: TOKEN, repository: "acme/sub/app", ...extra });

/** A minimal merge request API object. */
function rawMr(
  iid: number,
  overrides: {
    state?: "opened" | "closed" | "merged" | "locked";
    description?: string | null;
    merged_at?: string | null;
    merge_commit_sha?: string | null;
    squash_commit_sha?: string | null;
    updated_at?: string;
    username?: string;
    source?: string;
    target?: string;
    source_project_id?: number;
    target_project_id?: number;
  } = {},
) {
  const state = overrides.state ?? "merged";
  return {
    id: 1000 + iid,
    iid,
    title: `MR ${iid}`,
    description: overrides.description === undefined ? `Body ${iid}` : overrides.description,
    state,
    merged_at:
      overrides.merged_at === undefined
        ? state === "merged"
          ? "2026-11-01T10:00:00Z"
          : null
        : overrides.merged_at,
    merge_commit_sha:
      overrides.merge_commit_sha === undefined ? `merge${iid}` : overrides.merge_commit_sha,
    squash_commit_sha: overrides.squash_commit_sha ?? null,
    sha: `head${iid}`,
    updated_at: overrides.updated_at ?? "2026-11-01T10:00:00Z",
    author: { id: 5, username: overrides.username ?? "someone" },
    source_branch: overrides.source ?? `branch-${iid}`,
    target_branch: overrides.target ?? "main",
    source_project_id: overrides.source_project_id ?? 42,
    target_project_id: overrides.target_project_id ?? 42,
    web_url: `${WEB}/-/merge_requests/${iid}`,
  };
}

const note = (
  id: number,
  body: string,
  author: { id?: number; username?: string; bot?: boolean } = {
    id: 7,
    username: "project_42_bot_ab12",
  },
  system = false,
) => ({ id, body, system, author });

/** Next-page headers for page `page` of `last`. */
const pageHeaders = (page: number, last: number): Record<string, string> => ({
  "x-page": String(page),
  "x-next-page": page >= last ? "" : String(page + 1),
});

describe("pull requests", () => {
  it("finds the open MR by source branch, ignoring fork MRs", async () => {
    let query: URLSearchParams | undefined;
    server.use(
      http.get(`${PROJECT}/merge_requests`, ({ request }) => {
        query = new URL(request.url).searchParams;
        return HttpResponse.json([
          rawMr(41, { state: "opened", source: "launchset/release/main", source_project_id: 99 }),
          rawMr(42, { state: "opened", source: "launchset/release/main" }),
        ]);
      }),
    );
    const pr = await gl().findOpenPrByHead("launchset/release/main");
    expect(query?.get("state")).toBe("opened");
    expect(query?.get("source_branch")).toBe("launchset/release/main");
    expect(query?.get("per_page")).toBe("100");
    expect(pr).toEqual({
      number: 42,
      title: "MR 42",
      body: "Body 42",
      state: "open",
      mergedAt: null,
      mergeCommitSha: null,
      updatedAt: "2026-11-01T10:00:00Z",
      author: "someone",
      head: "launchset/release/main",
      headSha: "head42",
      base: "main",
      url: `${WEB}/-/merge_requests/42`,
    });

    server.use(
      http.get(`${PROJECT}/merge_requests`, () =>
        HttpResponse.json([rawMr(41, { state: "opened", source_project_id: 99, source: "x" })]),
      ),
    );
    expect(await gl().findOpenPrByHead("x")).toBeNull();
  });

  it("creates, updates, gets and closes MRs", async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const record = async (request: Request) => {
      calls.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: request.method === "GET" ? undefined : await request.json(),
      });
    };
    server.use(
      http.post(`${PROJECT}/merge_requests`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(rawMr(7, { state: "opened", description: null }), { status: 201 });
      }),
      http.put(`${PROJECT}/merge_requests/7`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(rawMr(7, { state: "closed" }));
      }),
      http.get(`${PROJECT}/merge_requests/7`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(rawMr(7, { state: "locked" }));
      }),
      http.post(`${PROJECT}/merge_requests/7/notes`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(note(1, "x"), { status: 201 });
      }),
    );
    const client = gl();
    const created = await client.createPr({
      head: "launchset/release/main",
      base: "main",
      title: "Release v1.5.0",
      body: "Notes",
    });
    expect(created.number).toBe(7);
    expect(created.body).toBe("");
    expect(created.state).toBe("open");
    await client.updatePr(7, { title: "Release v1.6.0" });
    await client.updatePr(7, { body: "New" });
    expect((await client.getPr(7)).state).toBe("closed");
    await client.closePr(7, "Superseded");
    await client.closePr(7);
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/v4/projects/acme%2Fsub%2Fapp/merge_requests",
        body: {
          source_branch: "launchset/release/main",
          target_branch: "main",
          title: "Release v1.5.0",
          description: "Notes",
        },
      },
      {
        method: "PUT",
        path: expect.stringContaining("/merge_requests/7"),
        body: { title: "Release v1.6.0" },
      },
      {
        method: "PUT",
        path: expect.stringContaining("/merge_requests/7"),
        body: { description: "New" },
      },
      { method: "GET", path: expect.stringContaining("/merge_requests/7"), body: undefined },
      {
        method: "POST",
        path: expect.stringContaining("/merge_requests/7/notes"),
        body: { body: "Superseded" },
      },
      {
        method: "PUT",
        path: expect.stringContaining("/merge_requests/7"),
        body: { state_event: "close" },
      },
      {
        method: "PUT",
        path: expect.stringContaining("/merge_requests/7"),
        body: { state_event: "close" },
      },
    ]);
  });

  it("maps the merge commit: merge, squash, or the head for fast-forward merges", async () => {
    const mrs = [
      rawMr(1),
      rawMr(2, { merge_commit_sha: null, squash_commit_sha: "squash2" }),
      rawMr(3, { merge_commit_sha: null }),
      rawMr(4, { state: "closed", merged_at: null }),
    ];
    server.use(
      http.get(`${PROJECT}/merge_requests/:iid`, ({ params }) =>
        HttpResponse.json(mrs[Number(params.iid) - 1]),
      ),
    );
    const client = gl();
    expect((await client.getPr(1)).mergeCommitSha).toBe("merge1");
    expect((await client.getPr(2)).mergeCommitSha).toBe("squash2");
    expect((await client.getPr(3)).mergeCommitSha).toBe("head3");
    const closed = await client.getPr(4);
    expect(closed.mergeCommitSha).toBeNull();
    expect(closed.mergedAt).toBeNull();
  });
});

describe("sticky comments", () => {
  const marker = stickyMarker("check");
  const NOTES = `${PROJECT}/merge_requests/5/notes`;

  it("creates the note, asking nothing about the user when no note carries the marker", async () => {
    let posted: unknown;
    let query: URLSearchParams | undefined;
    server.use(
      http.get(NOTES, ({ request }) => {
        query = new URL(request.url).searchParams;
        return HttpResponse.json([note(1, "hello", { id: 7 })]);
      }),
      http.post(NOTES, async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json(note(9, "x"), { status: 201 });
      }),
    );
    const result = await gl().upsertStickyComment(5, "check", "Body");
    expect(posted).toEqual({ body: `${marker}\nBody` });
    expect(query?.get("sort")).toBe("asc");
    expect(query?.get("order_by")).toBe("created_at");
    expect(result).toEqual({ id: 9, url: `${WEB}/-/merge_requests/5#note_9`, action: "created" });
  });

  it("updates our own note (matched by the token's user id) and leaves an equal one alone", async () => {
    let userCalls = 0;
    const puts: unknown[] = [];
    server.use(
      http.get(`${API}/user`, () => {
        userCalls++;
        return HttpResponse.json({ id: 7, username: "project_42_bot_ab12", bot: true });
      }),
      http.get(NOTES, () =>
        HttpResponse.json([
          note(1, `${marker}\nquoted by a person`, { id: 3, username: "alice" }),
          note(2, `${marker}\nOld`, { id: 7, username: "renamed-bot" }),
        ]),
      ),
      http.put(`${NOTES}/2`, async ({ request }) => {
        puts.push(await request.json());
        return HttpResponse.json(note(2, "x"));
      }),
    );
    const client = gl();
    expect(await client.upsertStickyComment(5, "check", "New")).toEqual({
      id: 2,
      url: `${WEB}/-/merge_requests/5#note_2`,
      action: "updated",
    });
    expect(puts).toEqual([{ body: `${marker}\nNew` }]);

    server.use(http.get(NOTES, () => HttpResponse.json([note(2, `${marker}\nNew`, { id: 7 })])));
    expect((await client.upsertStickyComment(5, "check", "New")).action).toBe("unchanged");
    expect(userCalls).toBe(1);
  });

  it("never adopts a person's note that quotes the marker, or a system note", async () => {
    const posts: unknown[] = [];
    server.use(
      http.get(`${API}/user`, () => HttpResponse.json({ id: 7, username: "project_42_bot_ab12" })),
      http.get(NOTES, () =>
        HttpResponse.json([
          note(1, `${marker}\nquoted`, { id: 3, username: "alice" }),
          note(2, `${marker}\nsystem`, { id: 7 }, true),
        ]),
      ),
      http.post(NOTES, async ({ request }) => {
        posts.push(await request.json());
        return HttpResponse.json(note(3, "x"), { status: 201 });
      }),
    );
    expect((await gl().upsertStickyComment(5, "check", "Body")).action).toBe("created");
    expect(posts).toHaveLength(1);
  });

  it("falls back to bot detection by name when GET /user is refused", async () => {
    let userCalls = 0;
    server.use(
      http.get(`${API}/user`, () => {
        userCalls++;
        return HttpResponse.json({ message: "403 Forbidden" }, { status: 403 });
      }),
      http.get(NOTES, () =>
        HttpResponse.json([
          note(1, `${marker}\nperson`, { id: 3, username: "alice" }),
          note(2, `${marker}\nlookalike`, { id: 4, username: "project_x_bot" }),
          note(3, `${marker}\nOld`, { id: 8, username: "group_7_bot_ff00" }),
        ]),
      ),
      http.put(`${NOTES}/3`, () => HttpResponse.json(note(3, "x"))),
    );
    const client = gl();
    expect((await client.upsertStickyComment(5, "check", "New")).id).toBe(3);
    await client.upsertStickyComment(5, "check", "Again");
    expect(userCalls).toBe(1);

    server.use(
      http.get(NOTES, () =>
        HttpResponse.json([note(4, `${marker}\nOld`, { id: 9, username: "x", bot: true })]),
      ),
      http.put(`${NOTES}/4`, () => HttpResponse.json(note(4, "x"))),
    );
    expect((await client.upsertStickyComment(5, "check", "New")).id).toBe(4);
  });

  it("pages through the notes and rejects bad ids before any call", async () => {
    server.use(
      http.get(NOTES, ({ request }) => {
        const page = Number(new URL(request.url).searchParams.get("page") ?? 1);
        return HttpResponse.json(
          page === 1 ? [note(1, "a")] : [note(2, `${marker}\nOld`, { id: 7 })],
          { headers: pageHeaders(page, 2) },
        );
      }),
      http.get(`${API}/user`, () => HttpResponse.json({ id: 7 })),
      http.put(`${NOTES}/2`, () => HttpResponse.json(note(2, "x"))),
    );
    expect((await gl().upsertStickyComment(5, "check", "New")).action).toBe("updated");
    await expect(gl().upsertStickyComment(5, "bad id", "x")).rejects.toThrow(
      /Invalid sticky comment id/,
    );
  });
});

describe("releases", () => {
  it("gets a release by tag, URL-encoding the tag; 404 means none", async () => {
    server.use(
      http.get(`${PROJECT}/releases/:tag`, ({ params }) =>
        params.tag === "v1.0.0+build/1"
          ? HttpResponse.json({
              tag_name: "v1.0.0+build/1",
              name: "v1.0.0",
              description: "Notes",
              _links: { self: `${WEB}/-/releases/v1.0.0` },
            })
          : HttpResponse.json({ message: "404 Not Found" }, { status: 404 }),
      ),
    );
    const client = gl();
    expect(await client.getReleaseByTag("v1.0.0+build/1")).toEqual({
      id: 0,
      tag: "v1.0.0+build/1",
      name: "v1.0.0",
      body: "Notes",
      prerelease: false,
      draft: false,
      url: `${WEB}/-/releases/v1.0.0`,
    });
    expect(await client.getReleaseByTag("v9.9.9")).toBeNull();
  });

  it("creates and updates releases by tag; prerelease and makeLatest are ignored", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(`${PROJECT}/releases`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({
          tag_name: "v2.0.0-rc.1",
          name: "v2.0.0-rc.1",
          description: null,
        });
      }),
      http.put(`${PROJECT}/releases/v2.0.0-rc.1`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ tag_name: "v2.0.0-rc.1", name: "Renamed", description: "D" });
      }),
    );
    const client = gl();
    const created = await client.createRelease({
      tag: "v2.0.0-rc.1",
      name: "v2.0.0-rc.1",
      body: "Notes",
      prerelease: true,
      makeLatest: false,
    });
    expect(created.id).toBe(0);
    expect(created.body).toBe("");
    expect(created.url).toBe(`${WEB}/-/releases/v2.0.0-rc.1`);
    const updated = await client.updateRelease(
      { id: 0, tag: "v2.0.0-rc.1" },
      { name: "Renamed", prerelease: false },
    );
    expect(updated.name).toBe("Renamed");
    await client.updateRelease({ id: 0, tag: "v2.0.0-rc.1" }, { body: "D" });
    expect(bodies).toEqual([
      { tag_name: "v2.0.0-rc.1", name: "v2.0.0-rc.1", description: "Notes" },
      { name: "Renamed" },
      { description: "D" },
    ]);
  });
});

describe("lookups", () => {
  it("lists the merged MRs of a commit, across pages", async () => {
    server.use(
      http.get(`${PROJECT}/repository/commits/abc123/merge_requests`, ({ request }) => {
        const page = Number(new URL(request.url).searchParams.get("page") ?? 1);
        return HttpResponse.json(
          page === 1 ? [rawMr(1), rawMr(2, { state: "opened" })] : [rawMr(3)],
          { headers: pageHeaders(page, 2) },
        );
      }),
    );
    const prs = await gl().pullRequestsForCommit("abc123");
    expect(prs.map((p) => p.number)).toEqual([1, 3]);
  });

  it("follows the Link header when x-next-page is absent, but never to another origin", async () => {
    let evilCalled = false;
    server.use(
      http.get(`${PROJECT}/repository/commits/abc/merge_requests`, ({ request }) => {
        const page = new URL(request.url).searchParams.get("page");
        if (page === "2") return HttpResponse.json([rawMr(2)]);
        return HttpResponse.json([rawMr(1)], {
          headers: {
            link: `<${PROJECT}/repository/commits/abc/merge_requests?page=2&per_page=100>; rel="next"`,
          },
        });
      }),
      http.get(`${PROJECT}/repository/commits/def/merge_requests`, () =>
        HttpResponse.json([rawMr(1)], {
          headers: { link: '<https://evil.example/steal>; rel="next"' },
        }),
      ),
      http.get("https://evil.example/steal", () => {
        evilCalled = true;
        return HttpResponse.json([]);
      }),
    );
    expect((await gl().pullRequestsForCommit("abc")).map((p) => p.number)).toEqual([1, 2]);
    expect((await gl().pullRequestsForCommit("def")).map((p) => p.number)).toEqual([1]);
    expect(evilCalled).toBe(false);
  });

  it("lists merged MRs into a branch and stops at the first one older than updatedSince", async () => {
    const queries: URLSearchParams[] = [];
    server.use(
      http.get(`${PROJECT}/merge_requests`, ({ request }) => {
        const query = new URL(request.url).searchParams;
        queries.push(query);
        const page = Number(query.get("page") ?? 1);
        return HttpResponse.json(
          page === 1
            ? [
                rawMr(5, { updated_at: "2026-11-05T00:00:00Z" }),
                rawMr(4, { updated_at: "2026-11-04T00:00:00Z" }),
              ]
            : [
                rawMr(3, { updated_at: "2026-11-01T00:00:00Z" }),
                rawMr(2, { updated_at: "2026-10-01T00:00:00Z" }),
              ],
          { headers: pageHeaders(page, 3) },
        );
      }),
    );
    const client = gl();
    const prs = await client.closedPrsInto("main", { updatedSince: "2026-11-01T00:00:00Z" });
    expect(prs.map((p) => p.number)).toEqual([5, 4, 3]);
    expect(queries).toHaveLength(2); // stopped inside page 2: page 3 never requested
    expect(queries[0]?.get("state")).toBe("merged");
    expect(queries[0]?.get("target_branch")).toBe("main");
    expect(queries[0]?.get("order_by")).toBe("updated_at");
    expect(queries[0]?.get("sort")).toBe("desc");
    expect(queries[0]?.get("updated_after")).toBe("2026-11-01T00:00:00.000Z");

    // A later call that looks back no further is served from the cache.
    const narrower = await client.closedPrsInto("main", { updatedSince: "2026-11-04T00:00:00Z" });
    expect(narrower.map((p) => p.number)).toEqual([5, 4]);
    expect(queries).toHaveLength(2);
    // One that looks back further lists again.
    await client.closedPrsInto("main", { updatedSince: "2026-10-01T00:00:00Z" });
    expect(queries.length).toBeGreaterThan(2);
  });

  it("rejects an unparsable updatedSince", async () => {
    await expect(gl().closedPrsInto("main", { updatedSince: "yesterday" })).rejects.toThrow(
      /Invalid updatedSince/,
    );
  });

  it("maps MR diffs to files", async () => {
    server.use(
      http.get(`${PROJECT}/merge_requests/3/diffs`, () =>
        HttpResponse.json([
          {
            old_path: "a.ts",
            new_path: "a.ts",
            new_file: false,
            renamed_file: false,
            deleted_file: false,
          },
          { old_path: "b.ts", new_path: "b.ts", new_file: true },
          { old_path: "c.ts", new_path: "c.ts", deleted_file: true },
          { old_path: "d.ts", new_path: "e.ts", renamed_file: true },
        ]),
      ),
    );
    expect(await gl().prFiles(3)).toEqual([
      { path: "a.ts", status: "modified" },
      { path: "b.ts", status: "added" },
      { path: "c.ts", status: "removed" },
      { path: "e.ts", status: "renamed", previousPath: "d.ts" },
    ]);
  });
});

describe("jobs", () => {
  const job = (id: number, name: string, status: string) => ({
    id,
    name,
    status,
    web_url: `${WEB}/-/jobs/${id}`,
  });

  it("lists the jobs of the pipeline and of its child pipelines, in GitHub's vocabulary", async () => {
    const jobQueries: string[] = [];
    server.use(
      http.get(`${PROJECT}/pipelines/10/jobs`, ({ request }) => {
        jobQueries.push(new URL(request.url).search);
        return HttpResponse.json([job(1, "launchset", "success")]);
      }),
      http.get(`${PROJECT}/pipelines/10/bridges`, () =>
        HttpResponse.json([
          { id: 50, pipeline: { project_id: 42 }, downstream_pipeline: { id: 11, project_id: 42 } },
          { id: 51, pipeline: { project_id: 42 }, downstream_pipeline: { id: 99, project_id: 77 } },
          { id: 52, pipeline: { project_id: 42 }, downstream_pipeline: null },
        ]),
      ),
      http.get(`${PROJECT}/pipelines/11/jobs`, () =>
        HttpResponse.json([
          job(2, "build-web", "failed"),
          job(3, "build-ios", "running"),
          job(4, "build-android", "pending"),
          job(5, "build-docker", "canceled"),
          job(6, "build-x", "skipped"),
          job(7, "build-y", "manual"),
          job(8, "build-z", "waiting_for_resource"),
        ]),
      ),
    );
    const jobs = await gl().listJobs(10);
    expect(jobQueries[0]).not.toContain("include_retried");
    expect(jobs.map((j) => [j.name, j.status, j.conclusion])).toEqual([
      ["launchset", "completed", "success"],
      ["build-web", "completed", "failure"],
      ["build-ios", "in_progress", null],
      ["build-android", "queued", null],
      ["build-docker", "completed", "cancelled"],
      ["build-x", "completed", "skipped"],
      ["build-y", "completed", "skipped"],
      ["build-z", "queued", null],
    ]);
    expect(jobs[0]).toEqual({
      id: 1,
      name: "launchset",
      status: "completed",
      conclusion: "success",
      url: `${WEB}/-/jobs/1`,
    });
  });
});

describe("errors and auth", () => {
  it("sends PRIVATE-TOKEN, or JOB-TOKEN for a job token, and a User-Agent", async () => {
    const seen: Record<string, string | null>[] = [];
    server.use(
      http.get(`${PROJECT}/merge_requests/1`, ({ request }) => {
        seen.push({
          private: request.headers.get("private-token"),
          job: request.headers.get("job-token"),
          agent: request.headers.get("user-agent"),
        });
        return HttpResponse.json(rawMr(1));
      }),
    );
    await gl().getPr(1);
    await gl({ tokenKind: "job" }).getPr(1);
    expect(seen).toEqual([
      { private: TOKEN, job: null, agent: "launchset" },
      { private: null, job: TOKEN, agent: "launchset" },
    ]);
  });

  it("uses a self-managed API URL and server URL for links", async () => {
    server.use(
      http.put(
        "https://git.acme.dev/gl/api/v4/projects/acme%2Fsub%2Fapp/merge_requests/5/notes/:id",
        () => HttpResponse.json(note(1, "x")),
      ),
      http.get(
        "https://git.acme.dev/gl/api/v4/projects/acme%2Fsub%2Fapp/merge_requests/5/notes",
        () => HttpResponse.json([]),
      ),
      http.post(
        "https://git.acme.dev/gl/api/v4/projects/acme%2Fsub%2Fapp/merge_requests/5/notes",
        () => HttpResponse.json(note(12, "x")),
      ),
    );
    const client = gl({
      apiUrl: "https://git.acme.dev/gl/api/v4/",
      serverUrl: "https://git.acme.dev/gl/",
    });
    expect((await client.upsertStickyComment(5, "x", "b")).url).toBe(
      "https://git.acme.dev/gl/acme/sub/app/-/merge_requests/5#note_12",
    );
  });

  it("validates the token and repository before any call", () => {
    expect(() => createGitLab({ token: "", repository: "a/b" })).toThrow(GitLabError);
    expect(() => createGitLab({ token: TOKEN, repository: "" })).toThrow(/No GitLab project/);
    expect(gl().repository).toBe("acme/sub/app");
  });

  it.each([
    [401, /token is invalid or expired/],
    [403, /`api` scope and at least the Developer role/],
    [404, /acme\/sub\/app exists/],
    [500, /server error/],
  ])("maps a %s to a GitLabError with a hint", async (status, hint) => {
    server.use(
      http.get(`${PROJECT}/merge_requests/1`, () =>
        HttpResponse.json({ message: `${status} Whatever, token ${TOKEN}` }, { status }),
      ),
    );
    const error = await gl()
      .getPr(1)
      .catch((e) => e);
    expect(error).toBeInstanceOf(GitLabError);
    expect(error.status).toBe(status);
    expect(error.endpoint).toBe("GET /projects/acme%2Fsub%2Fapp/merge_requests/1");
    expect(error.message).toContain(
      `GitLab API GET /projects/acme%2Fsub%2Fapp/merge_requests/1 failed (${status})`,
    );
    expect(error.hint).toMatch(hint);
    expect(error.message).not.toContain(TOKEN);
    expect(`${error.message} ${error.hint}`).not.toContain(TOKEN);
  });

  it("explains a 403 for a job token", async () => {
    server.use(
      http.post(`${PROJECT}/merge_requests`, () =>
        HttpResponse.json({ message: "403 Forbidden" }, { status: 403 }),
      ),
    );
    const error = await gl({ tokenKind: "job" })
      .createPr({ head: "a", base: "b", title: "t", body: "" })
      .catch((e) => e);
    expect(error.hint).toContain("CI_JOB_TOKEN can't do this");
    expect(error.hint).toContain("LAUNCHSET_TOKEN");
  });

  it("reads GitLab's error shapes", async () => {
    server.use(
      http.post(`${PROJECT}/merge_requests`, () =>
        HttpResponse.json({ message: { title: ["is too long"] } }, { status: 400 }),
      ),
      http.get(`${PROJECT}/merge_requests/2`, () =>
        HttpResponse.json(
          { error: "invalid_token", error_description: "expired" },
          { status: 401 },
        ),
      ),
    );
    const client = gl();
    await expect(client.createPr({ head: "a", base: "b", title: "t", body: "" })).rejects.toThrow(
      /title is too long/,
    );
    await expect(client.getPr(2)).rejects.toThrow(/invalid_token: expired/);
  });

  it("reports network failures without a status", async () => {
    server.use(http.get(`${PROJECT}/merge_requests/1`, () => HttpResponse.error()));
    const error = await gl()
      .getPr(1)
      .catch((e) => e);
    expect(error).toBeInstanceOf(GitLabError);
    expect(error.status).toBeUndefined();
    expect(error.hint).toContain("Could not reach the GitLab API at https://gitlab.com/api/v4");
  });

  it("masks the token in a custom fetch's failure too", async () => {
    const client = gl({
      fetch: async () => {
        throw new Error(`connect ECONNREFUSED with ${TOKEN}`);
      },
    });
    const error = await client.getPr(1).catch((e) => e);
    expect(error.message).toContain("***");
    expect(error.message).not.toContain(TOKEN);
  });

  it("documents the token it needs", () => {
    expect(REQUIRED_TOKEN_SCOPES.scopes.map((s) => s.name)).toEqual(["api", "write_repository"]);
    expect(REQUIRED_TOKEN_SCOPES.role).toBe("Maintainer");
  });
});
