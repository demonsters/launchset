import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import {
  createGitHub,
  GitHubError,
  REQUIRED_APP_PERMISSIONS,
  stickyMarker,
} from "../../src/github/index.ts";
import { linkHeader, REPO, rawPr, server, TOKEN } from "./helpers.ts";

const gh = () => createGitHub({ token: TOKEN, repository: "acme/app" });

describe("pull requests", () => {
  it("finds the open release PR by head branch", async () => {
    let query: URLSearchParams | undefined;
    server.use(
      http.get(`${REPO}/pulls`, ({ request }) => {
        query = new URL(request.url).searchParams;
        return HttpResponse.json([
          rawPr(42, { state: "open", merged_at: null, head: "launchset/release/main" }),
        ]);
      }),
    );
    const pr = await gh().findOpenPrByHead("launchset/release/main");
    expect(query?.get("head")).toBe("acme:launchset/release/main");
    expect(query?.get("state")).toBe("open");
    expect(pr).toEqual({
      number: 42,
      title: "PR 42",
      body: "Body 42",
      state: "open",
      mergedAt: null,
      mergeCommitSha: null,
      updatedAt: "2026-11-01T10:00:00Z",
      author: "someone",
      head: "launchset/release/main",
      headSha: "head42",
      base: "main",
      url: "https://github.com/acme/app/pull/42",
    });

    server.use(http.get(`${REPO}/pulls`, () => HttpResponse.json([])));
    expect(await gh().findOpenPrByHead("launchset/release/main")).toBeNull();
  });

  it("creates, updates, gets and closes PRs", async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const record = async (request: Request) => {
      calls.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: request.method === "GET" ? undefined : await request.json(),
      });
    };
    server.use(
      http.post(`${REPO}/pulls`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(
          rawPr(7, { state: "open", merged_at: null, title: "Release v1.5.0" }),
          { status: 201 },
        );
      }),
      http.patch(`${REPO}/pulls/7`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(rawPr(7, { title: "Release v1.6.0", body: null }));
      }),
      http.get(`${REPO}/pulls/7`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(rawPr(7, { merged_at: null }));
      }),
      http.post(`${REPO}/issues/7/comments`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({ id: 1, html_url: "x", body: "" }, { status: 201 });
      }),
    );
    const client = gh();
    const created = await client.createPr({
      head: "launchset/release/main",
      base: "main",
      title: "Release v1.5.0",
      body: "changelog",
    });
    expect(created).toMatchObject({ number: 7, title: "Release v1.5.0", state: "open" });
    const updated = await client.updatePr(7, { title: "Release v1.6.0" });
    expect(updated).toMatchObject({ title: "Release v1.6.0", body: "" });
    expect((await client.getPr(7)).mergedAt).toBeNull();
    await client.closePr(7, "Nothing to release anymore.");

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/repos/acme/app/pulls",
        body: {
          head: "launchset/release/main",
          base: "main",
          title: "Release v1.5.0",
          body: "changelog",
          maintainer_can_modify: false,
        },
      },
      { method: "PATCH", path: "/repos/acme/app/pulls/7", body: { title: "Release v1.6.0" } },
      { method: "GET", path: "/repos/acme/app/pulls/7", body: undefined },
      {
        method: "POST",
        path: "/repos/acme/app/issues/7/comments",
        body: { body: "Nothing to release anymore." },
      },
      { method: "PATCH", path: "/repos/acme/app/pulls/7", body: { state: "closed" } },
    ]);
  });

  it("closes without a comment", async () => {
    const methods: string[] = [];
    server.use(
      http.patch(`${REPO}/pulls/3`, () => {
        methods.push("close");
        return HttpResponse.json(rawPr(3));
      }),
    );
    await gh().closePr(3);
    expect(methods).toEqual(["close"]);
  });
});

describe("sticky comments", () => {
  const marker = stickyMarker("check");
  const comments = (page: number) =>
    Array.from({ length: page === 1 ? 100 : 3 }, (_, i) => ({
      id: page * 1000 + i,
      body: `comment ${i}`,
      html_url: `https://github.com/acme/app/pull/5#issuecomment-${page * 1000 + i}`,
      user: { login: "someone", type: "User" },
    }));

  it("creates the comment with the marker when none exists (all pages searched)", async () => {
    const pages: string[] = [];
    let posted: unknown;
    server.use(
      http.get(`${REPO}/issues/5/comments`, ({ request }) => {
        const page = Number(new URL(request.url).searchParams.get("page") ?? "1");
        pages.push(String(page));
        return HttpResponse.json(comments(page), { headers: linkHeader(request.url, page, 2) });
      }),
      http.post(`${REPO}/issues/5/comments`, async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({ id: 99, html_url: "https://github.com/c/99" }, { status: 201 });
      }),
    );
    const result = await gh().upsertStickyComment(5, "check", "## Changesets\n\nNone yet.");
    expect(pages).toEqual(["1", "2"]);
    expect(posted).toEqual({ body: `${marker}\n## Changesets\n\nNone yet.` });
    expect(result).toEqual({ id: 99, url: "https://github.com/c/99", action: "created" });
  });

  it("updates the marked comment in place, found on page 2", async () => {
    let patched: unknown;
    server.use(
      http.get(`${REPO}/issues/5/comments`, ({ request }) => {
        const page = Number(new URL(request.url).searchParams.get("page") ?? "1");
        const list = comments(page);
        if (page === 2) {
          list[1] = {
            ...list[1],
            body: `${marker}\nold body`,
            user: { login: "launchset[bot]", type: "Bot" },
          } as (typeof list)[number];
          // A comment for another sticky id must not match.
          list[0] = {
            ...list[0],
            body: `${stickyMarker("preview")}\nother`,
          } as (typeof list)[number];
        }
        return HttpResponse.json(list, { headers: linkHeader(request.url, page, 2) });
      }),
      http.patch(`${REPO}/issues/comments/2001`, async ({ request }) => {
        patched = await request.json();
        return HttpResponse.json({ id: 2001, html_url: "https://github.com/c/2001" });
      }),
    );
    const result = await gh().upsertStickyComment(5, "check", "new body");
    expect(patched).toEqual({ body: `${marker}\nnew body` });
    expect(result).toEqual({ id: 2001, url: "https://github.com/c/2001", action: "updated" });
  });

  it("stops at the first page with the marker and leaves an identical comment alone", async () => {
    const pages: number[] = [];
    server.use(
      http.get(`${REPO}/issues/5/comments`, ({ request }) => {
        const page = Number(new URL(request.url).searchParams.get("page") ?? "1");
        pages.push(page);
        const list = comments(page);
        list[0] = {
          ...list[0],
          body: `${marker}\nsame`,
          user: { login: "github-actions[bot]", type: "Bot" },
        } as (typeof list)[number];
        return HttpResponse.json(list, { headers: linkHeader(request.url, page, 3) });
      }),
    );
    const result = await gh().upsertStickyComment(5, "check", "same");
    expect(pages).toEqual([1]);
    expect(result.action).toBe("unchanged");
  });

  it("ignores a marked comment written by a person and creates its own", async () => {
    let posted = false;
    server.use(
      http.get(`${REPO}/issues/5/comments`, () =>
        HttpResponse.json([
          {
            id: 1,
            body: `quoting: ${marker}\nfake`,
            html_url: "https://github.com/c/1",
            user: { login: "mallory", type: "User" },
          },
        ]),
      ),
      http.patch(`${REPO}/issues/comments/1`, () =>
        HttpResponse.json({ message: "must not update" }, { status: 500 }),
      ),
      http.post(`${REPO}/issues/5/comments`, () => {
        posted = true;
        return HttpResponse.json({ id: 2, html_url: "https://github.com/c/2" }, { status: 201 });
      }),
    );
    const result = await gh().upsertStickyComment(5, "check", "real");
    expect(posted).toBe(true);
    expect(result).toEqual({ id: 2, url: "https://github.com/c/2", action: "created" });
  });

  it("rejects ids that would break the marker", async () => {
    await expect(gh().upsertStickyComment(5, "bad -->", "x")).rejects.toThrow(
      /Invalid sticky comment id/,
    );
  });
});

describe("releases", () => {
  const rawRelease = (id: number, tag: string, extra: Record<string, unknown> = {}) => ({
    id,
    tag_name: tag,
    name: tag,
    body: "notes",
    prerelease: false,
    draft: false,
    html_url: `https://github.com/acme/app/releases/tag/${tag}`,
    ...extra,
  });

  it("returns null for a missing release and maps an existing one", async () => {
    server.use(
      http.get(`${REPO}/releases/tags/:tag`, ({ params }) =>
        params.tag === "v1.0.0"
          ? HttpResponse.json(rawRelease(1, "v1.0.0", { body: null }))
          : HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
    );
    expect(await gh().getReleaseByTag("v2.0.0")).toBeNull();
    expect(await gh().getReleaseByTag("v1.0.0")).toEqual({
      id: 1,
      tag: "v1.0.0",
      name: "v1.0.0",
      body: "",
      prerelease: false,
      draft: false,
      url: "https://github.com/acme/app/releases/tag/v1.0.0",
    });
  });

  it("wraps non-404 errors on the release lookup", async () => {
    server.use(
      http.get(`${REPO}/releases/tags/:tag`, () =>
        HttpResponse.json({ message: "boom" }, { status: 500 }),
      ),
    );
    const error = await gh()
      .getReleaseByTag("v1.0.0")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).status).toBe(500);
    expect((error as GitHubError).endpoint).toBe("GET /repos/acme/app/releases/tags/v1.0.0");
  });

  it("creates releases with make_latest true/false", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(`${REPO}/releases`, async ({ request }) => {
        const body = (await request.json()) as { tag_name: string; prerelease: boolean };
        bodies.push(body);
        return HttpResponse.json(
          rawRelease(bodies.length, body.tag_name, { prerelease: body.prerelease }),
          {
            status: 201,
          },
        );
      }),
    );
    const latest = await gh().createRelease({
      tag: "v1.5.0",
      name: "v1.5.0",
      body: "## 1.5.0",
      prerelease: false,
      makeLatest: true,
    });
    const pre = await gh().createRelease({
      tag: "v1.6.0-alpha.0",
      name: "v1.6.0-alpha.0",
      body: "alpha",
      prerelease: true,
      makeLatest: false,
    });
    expect(latest).toMatchObject({ id: 1, tag: "v1.5.0", prerelease: false });
    expect(pre).toMatchObject({ id: 2, prerelease: true });
    expect(bodies).toEqual([
      {
        tag_name: "v1.5.0",
        name: "v1.5.0",
        body: "## 1.5.0",
        prerelease: false,
        draft: false,
        make_latest: "true",
      },
      {
        tag_name: "v1.6.0-alpha.0",
        name: "v1.6.0-alpha.0",
        body: "alpha",
        prerelease: true,
        draft: false,
        make_latest: "false",
      },
    ]);
  });

  it("updates only the given release fields", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.patch(`${REPO}/releases/11`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(rawRelease(11, "v1.4.0", { prerelease: true }));
      }),
    );
    await gh().updateRelease(11, { body: "new notes" });
    await gh().updateRelease(11, { name: "v1.4.0 (partial)", prerelease: true, makeLatest: false });
    expect(bodies).toEqual([
      { body: "new notes" },
      { name: "v1.4.0 (partial)", prerelease: true, make_latest: "false" },
    ]);
  });
});

describe("lookups", () => {
  it("returns only merged PRs associated with a commit", async () => {
    server.use(
      http.get(`${REPO}/commits/abc123/pulls`, () =>
        HttpResponse.json([
          rawPr(1),
          rawPr(2, { state: "open", merged_at: null }),
          rawPr(3, { state: "closed", merged_at: null }),
        ]),
      ),
    );
    expect((await gh().pullRequestsForCommit("abc123")).map((pr) => pr.number)).toEqual([1]);
  });

  it("lists merged PRs into a base, newest update first, stopping before updatedSince", async () => {
    const queries: URLSearchParams[] = [];
    server.use(
      http.get(`${REPO}/pulls`, ({ request }) => {
        const query = new URL(request.url).searchParams;
        queries.push(query);
        const page = Number(query.get("page") ?? "1");
        const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}T12:00:00Z`;
        // Page 1: days 30..21 (one closed without merge), page 2: days 20..11, page 3: 10..1.
        const list = Array.from({ length: 10 }, (_, i) => {
          const d = 30 - (page - 1) * 10 - i;
          return rawPr(d, {
            updated_at: day(d),
            base: "release/1.4.x",
            merged_at: d === 29 ? null : day(d),
          });
        });
        return HttpResponse.json(list, { headers: linkHeader(request.url, page, 3) });
      }),
    );
    const prs = await gh().closedPrsInto("release/1.4.x", { updatedSince: "2026-10-15T00:00:00Z" });
    expect(prs.map((pr) => pr.number)).toEqual([
      30, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15,
    ]);
    expect(prs[0]?.mergeCommitSha).toBe("merge30");
    expect(queries).toHaveLength(2);
    expect(Object.fromEntries(queries[0] ?? [])).toMatchObject({
      state: "closed",
      base: "release/1.4.x",
      sort: "updated",
      direction: "desc",
    });

    queries.length = 0;
    expect(await gh().closedPrsInto("release/1.4.x")).toHaveLength(29);
    expect(queries).toHaveLength(3);
    await expect(gh().closedPrsInto("main", { updatedSince: "yesterday" })).rejects.toThrow(
      /Invalid updatedSince/,
    );
  });

  it("serves later listings of a branch that look back no further from the first one", async () => {
    let requests = 0;
    const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}T12:00:00Z`;
    server.use(
      http.get(`${REPO}/pulls`, () => {
        requests++;
        return HttpResponse.json(
          [30, 20, 10].map((d) => rawPr(d, { updated_at: day(d), merged_at: day(d) })),
        );
      }),
    );
    const client = gh();
    const first = await client.closedPrsInto("main", { updatedSince: "2026-10-05T00:00:00Z" });
    expect(first.map((pr) => pr.number)).toEqual([30, 20, 10]);
    const newer = await client.closedPrsInto("main", { updatedSince: "2026-10-15T00:00:00Z" });
    expect(newer.map((pr) => pr.number)).toEqual([30, 20]);
    expect(requests).toBe(1);
    // Looking back further (or without a bound) lists again.
    await client.closedPrsInto("main");
    expect(requests).toBe(2);
    await client.closedPrsInto("main", { updatedSince: "2026-10-01T00:00:00Z" });
    expect(requests).toBe(2);
  });

  it("lists every PR file across pages", async () => {
    server.use(
      http.get(`${REPO}/pulls/9/files`, ({ request }) => {
        const page = Number(new URL(request.url).searchParams.get("page") ?? "1");
        const files =
          page === 1
            ? Array.from({ length: 100 }, (_, i) => ({
                filename: `src/f${i}.ts`,
                status: "modified",
              }))
            : [
                { filename: ".launchset/new.md", status: "added" },
                { filename: "b.txt", status: "renamed", previous_filename: "a.txt" },
              ];
        return HttpResponse.json(files, { headers: linkHeader(request.url, page, 2) });
      }),
    );
    const files = await gh().prFiles(9);
    expect(files).toHaveLength(102);
    expect(files.slice(-2)).toEqual([
      { path: ".launchset/new.md", status: "added" },
      { path: "b.txt", status: "renamed", previousPath: "a.txt" },
    ]);
  });

  it("lists the jobs of a run's latest attempt", async () => {
    let filter: string | null = null;
    server.use(
      http.get(`${REPO}/actions/runs/555/jobs`, ({ request }) => {
        filter = new URL(request.url).searchParams.get("filter");
        return HttpResponse.json({
          total_count: 2,
          jobs: [
            {
              id: 1,
              name: "build (android)",
              status: "completed",
              conclusion: "success",
              html_url: "https://j/1",
            },
            {
              id: 2,
              name: "build (ios)",
              status: "in_progress",
              conclusion: null,
              html_url: "https://j/2",
            },
          ],
        });
      }),
    );
    expect(await gh().listJobs(555)).toEqual([
      {
        id: 1,
        name: "build (android)",
        status: "completed",
        conclusion: "success",
        url: "https://j/1",
      },
      { id: 2, name: "build (ios)", status: "in_progress", conclusion: null, url: "https://j/2" },
    ]);
    expect(filter).toBe("latest");
  });
});

describe("errors", () => {
  it("403 on a write names the missing App permission and never leaks the token", async () => {
    server.use(
      http.post(`${REPO}/pulls`, () =>
        HttpResponse.json({ message: "Resource not accessible by integration" }, { status: 403 }),
      ),
    );
    const error = await gh()
      .createPr({ head: "x", base: "main", title: "t", body: "b" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    const e = error as GitHubError;
    expect(e.status).toBe(403);
    expect(e.endpoint).toBe("POST /repos/acme/app/pulls");
    expect(e.message).toContain("Resource not accessible by integration");
    expect(e.hint).toContain('"Pull requests: read & write"');
    expect(e.message).not.toContain(TOKEN);
    expect(JSON.stringify({ message: e.message, hint: e.hint, stack: e.stack })).not.toContain(
      TOKEN,
    );
  });

  it("explains 401, rate limits, 404 on writes and 422 details", async () => {
    server.use(
      http.get(`${REPO}/pulls/1`, () =>
        HttpResponse.json({ message: "Bad credentials" }, { status: 401 }),
      ),
      http.get(`${REPO}/pulls/2`, () =>
        HttpResponse.json(
          { message: "API rate limit exceeded" },
          { status: 403, headers: { "x-ratelimit-remaining": "0" } },
        ),
      ),
      http.patch(`${REPO}/releases/3`, () =>
        HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
      http.post(`${REPO}/pulls`, () =>
        HttpResponse.json(
          {
            message: "Validation Failed",
            errors: [
              {
                resource: "PullRequest",
                code: "custom",
                message: "A pull request already exists for acme:x.",
              },
            ],
          },
          { status: 422 },
        ),
      ),
      http.get(`${REPO}/actions/runs/4/jobs`, () =>
        HttpResponse.json({ message: "nope" }, { status: 403 }),
      ),
    );
    const client = gh();
    const err = (p: Promise<unknown>): Promise<GitHubError> =>
      p.then(
        () => {
          throw new Error("expected a failure");
        },
        (e: unknown) => e as GitHubError,
      );
    expect((await err(client.getPr(1))).hint).toMatch(/invalid or expired/);
    expect((await err(client.getPr(2))).hint).toMatch(/rate limit/);
    const notFound = await err(client.updateRelease(3, { body: "x" }));
    expect(notFound.hint).toMatch(/"Contents: read & write"/);
    const invalid = await err(client.createPr({ head: "x", base: "main", title: "t", body: "b" }));
    expect(invalid.status).toBe(422);
    expect(invalid.message).toContain("A pull request already exists for acme:x.");
    expect((await err(client.listJobs(4))).hint).toMatch(/"Actions: read"/);
  });

  it("wraps network failures", async () => {
    server.use(http.get(`${REPO}/pulls/1`, () => HttpResponse.error()));
    const error = await gh()
      .getPr(1)
      .then(
        () => undefined,
        (e: unknown) => e as GitHubError,
      );
    expect(error).toBeInstanceOf(GitHubError);
    expect(error?.status).toBeUndefined();
    expect(error?.hint).toMatch(/Could not reach the GitHub API at https:\/\/api.github.com/);
  });

  it("validates options", () => {
    expect(() => createGitHub({ token: TOKEN, repository: "nope" })).toThrow(
      /expected "owner\/repo"/,
    );
    expect(() => createGitHub({ token: "", repository: "acme/app" })).toThrow(/No GitHub token/);
  });

  it("uses GITHUB_API_URL for GitHub Enterprise", async () => {
    server.use(
      http.get("https://ghe.acme.com/api/v3/repos/acme/app/pulls/1", () =>
        HttpResponse.json(rawPr(1)),
      ),
    );
    const client = createGitHub({
      token: TOKEN,
      repository: "acme/app",
      apiUrl: "https://ghe.acme.com/api/v3/",
    });
    expect((await client.getPr(1)).number).toBe(1);
  });
});

describe("REQUIRED_APP_PERMISSIONS", () => {
  it("lists every permission with a reason", () => {
    expect(REQUIRED_APP_PERMISSIONS.map((p) => `${p.name}: ${p.access}`)).toEqual([
      "Contents: read & write",
      "Pull requests: read & write",
      "Workflows: read & write",
      "Actions: read",
      "Metadata: read",
    ]);
    for (const p of REQUIRED_APP_PERMISSIONS) expect(p.why.length).toBeGreaterThan(20);
  });
});
