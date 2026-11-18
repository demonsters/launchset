/**
 * Flow test helpers: a temp project with a bare remote, a `FlowContext` for it, and a stateful
 * fake of the GitHub REST API on msw (unhandled requests fail the test).
 */

import { execFileSync } from "node:child_process";
import { HttpResponse, http } from "msw";
import { createContext, type FlowContext } from "../../src/flow/context.ts";
import { cloneRepo, repoWithRemote, sh, type TestRepo } from "../git/helpers.ts";
import { REPO, server, TOKEN } from "../github/helpers.ts";

export { server, TOKEN };

export const NOW = new Date("2026-11-18T12:00:00Z");
/** The default `timestamp` build number at NOW. */
export const BUILD = Math.floor((NOW.getTime() - Date.parse("2020-01-01T00:00:00Z")) / 1000);

export const CONFIG = {
  targets: {
    "docker-api": { type: "docker", image: "ghcr.io/acme/api" },
    web: { type: "web" },
    android: { type: "android", source: { kind: "gradle", file: "android/app/build.gradle" } },
    ios: {
      type: "ios",
      source: { kind: "xcconfig", file: "ios/Version.xcconfig" },
      release: "manual",
    },
  },
};

export const gradle = (versionName: string, versionCode = 12) =>
  `android {\n    defaultConfig {\n        applicationId "com.acme.app"\n        versionCode ${versionCode}\n        versionName "${versionName}"\n    }\n}\n`;

export const xcconfig = (version: string, build = 12) =>
  `// Version.xcconfig\nMARKETING_VERSION = ${version}\nCURRENT_PROJECT_VERSION = ${build}\n`;

export const pkg = (version: string) =>
  `${JSON.stringify({ name: "app", private: true, version }, null, 2)}\n`;

export const changesetText = (bump: string, summary: string) =>
  bump === "none" ? "---\nbump: none\n---\n" : `---\nbump: ${bump}\n---\n\n${summary}\n`;

/** Every version file at `version`. */
export function versionFiles(version: string): Record<string, string> {
  return {
    "package.json": pkg(version),
    "android/app/build.gradle": gradle(version),
    "ios/Version.xcconfig": xcconfig(version),
  };
}

export interface Project {
  repo: TestRepo;
  remote: string;
  /** Commit, push, return the sha. */
  push(message: string, files?: Record<string, string>): string;
  /** `git show <ref>:<path>` on the bare remote. */
  remoteFile(ref: string, path: string): string;
  /** Tags on the remote (name → commit). */
  remoteTags(): Map<string, string>;
  /** Branch head on the remote, or undefined. */
  remoteBranch(name: string): string | undefined;
}

/**
 * A project at `version` with launchset config, CHANGELOG.md and version files, pushed to a
 * bare remote. With `released`, `v{version}` is tagged and pushed.
 */
export function setupProject(
  options: { version?: string; released?: boolean; config?: unknown; changelog?: string } = {},
): Project {
  const version = options.version ?? "1.4.0";
  const { repo, remote } = repoWithRemote();
  repo.commit(`Set up ${version}`, {
    "launchset.config.json": `${JSON.stringify(options.config ?? CONFIG, null, 2)}\n`,
    ".launchset/README.md": "# Changesets\n",
    "CHANGELOG.md":
      options.changelog ??
      `# Changelog\n\n## ${version} (2026-01-01)\n\n### Patch changes\n- First release.\n`,
    ...versionFiles(version),
  });
  repo.git("push", "--quiet", "origin", "main");
  if (options.released ?? true) {
    repo.git("tag", `v${version}`);
    repo.git("push", "--quiet", "origin", `v${version}`);
  }
  return projectFor(repo, remote);
}

export function projectFor(repo: TestRepo, remote: string): Project {
  return {
    repo,
    remote,
    push(message, files = {}) {
      const sha = repo.commit(message, files);
      repo.git("push", "--quiet", "origin", "HEAD");
      return sha;
    },
    remoteFile(ref, path) {
      return execShow(remote, ref, path);
    },
    remoteTags() {
      const out = sh(
        remote,
        "for-each-ref",
        "--format=%(refname:strip=2) %(*objectname)%(objectname)",
        "refs/tags",
      );
      const tags = new Map<string, string>();
      for (const line of out.split("\n").filter(Boolean)) {
        const [name, sha] = line.split(" ") as [string, string];
        // Lightweight tags only in these tests: the object is the commit.
        tags.set(name, sha.slice(0, 40));
      }
      return tags;
    },
    remoteBranch(name) {
      try {
        return sh(remote, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`);
      } catch {
        return undefined;
      }
    },
  };
}

/** Exact file text (no trimming) at `ref` in a repo. */
export function execShow(dir: string, ref: string, path: string): string {
  return execFileSync("git", ["show", `${ref}:${path}`], { cwd: dir, encoding: "utf8" });
}

/** Another clone of the remote (e.g. a CI checkout). */
export function ciClone(project: Project): TestRepo {
  return cloneRepo(project.remote);
}

export interface ContextOverrides {
  env?: Record<string, string>;
  event?: { name: string; payload: Record<string, unknown> };
  token?: string | null;
  cwd?: string;
}

/** A FlowContext for `repo` (token + `acme/app`, fixed time, no real env). */
export async function contextFor(
  repo: TestRepo,
  overrides: ContextOverrides = {},
): Promise<FlowContext> {
  const context = await createContext({
    cwd: overrides.cwd ?? repo.dir,
    ...(overrides.token === null ? {} : { token: overrides.token ?? TOKEN }),
    repository: "acme/app",
    env: {
      GITHUB_RUN_ID: "99",
      GITHUB_RUN_NUMBER: "17",
      GITHUB_RUN_ATTEMPT: "1",
      ...overrides.env,
    },
    now: NOW,
  });
  if (overrides.event) context.event = overrides.event;
  return context;
}

// ---------------------------------------------------------------------------
// Fake GitHub

interface FakePr {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  merged_at: string | null;
  merge_commit_sha: string | null;
  updated_at: string;
  user: { login: string; type: string };
  head: { ref: string; sha: string };
  base: { ref: string };
  html_url: string;
}

interface FakeComment {
  id: number;
  issue: number;
  body: string;
  user: { login: string; type: string };
  html_url: string;
}

export interface FakeRelease {
  id: number;
  tag_name: string;
  name: string;
  body: string;
  prerelease: boolean;
  draft: boolean;
  make_latest?: string;
  html_url: string;
}

export interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/** A small in-memory GitHub: PRs, comments, releases, commit → PR lookups. */
export class FakeGitHub {
  prs: FakePr[] = [];
  comments: FakeComment[] = [];
  releases: FakeRelease[] = [];
  /** Commit sha → PR numbers (`GET /commits/{sha}/pulls`). */
  commitPulls = new Map<string, number[]>();
  /** PR number → changed files (`GET /pulls/{n}/files`). */
  prFiles = new Map<number, { filename: string; status: string }[]>();
  /** Respond 403 to comment writes (fork PR with a read-only token). */
  readOnlyComments = false;
  calls: Call[] = [];
  /** Injected failures: the next matching request gets this status. */
  failures: {
    method: string;
    path: string;
    status: number;
    match?: (body: unknown) => boolean;
  }[] = [];
  #id = 1000;
  readonly #remote: string | undefined;

  /** With `remote` (a bare repo), creating a PR checks that its head branch was pushed. */
  constructor(remote?: string) {
    this.#remote = remote;
    server.use(...this.handlers());
  }

  /** Make the next `method` request whose path contains `path` fail with `status`. */
  failNext(
    method: string,
    path: string,
    options: { status?: number; match?: (body: unknown) => boolean } = {},
  ): void {
    this.failures.push({
      method,
      path,
      status: options.status ?? 500,
      ...(options.match ? { match: options.match } : {}),
    });
  }

  /** An open PR (e.g. a release PR left from before). */
  addOpenPr(input: { number: number; title: string; head: string; base?: string }): void {
    this.prs.push({
      number: input.number,
      title: input.title,
      body: "",
      state: "open",
      merged_at: null,
      merge_commit_sha: null,
      updated_at: NOW.toISOString(),
      user: { login: "launchset[bot]", type: "Bot" },
      head: { ref: input.head, sha: "0".repeat(40) },
      base: { ref: input.base ?? "main" },
      html_url: `https://github.com/acme/app/pull/${input.number}`,
    });
  }

  /** A merged PR (e.g. a bot PR) into `base`. */
  addMergedPr(input: {
    number: number;
    title: string;
    login: string;
    mergeSha: string;
    base?: string;
  }): void {
    this.prs.push({
      number: input.number,
      title: input.title,
      body: "",
      state: "closed",
      merged_at: NOW.toISOString(),
      merge_commit_sha: input.mergeSha,
      updated_at: NOW.toISOString(),
      user: { login: input.login, type: input.login.endsWith("[bot]") ? "Bot" : "User" },
      head: { ref: `branch-${input.number}`, sha: input.mergeSha },
      base: { ref: input.base ?? "main" },
      html_url: `https://github.com/acme/app/pull/${input.number}`,
    });
  }

  openPrs(): FakePr[] {
    return this.prs.filter((p) => p.state === "open");
  }

  release(tag: string): FakeRelease | undefined {
    return this.releases.find((r) => r.tag_name === tag);
  }

  callsTo(method: string, pathPart: string): Call[] {
    return this.calls.filter((c) => c.method === method && c.path.includes(pathPart));
  }

  handlers() {
    const record = async (request: Request) => {
      const url = new URL(request.url);
      const path = decodeURIComponent(url.pathname);
      const body =
        request.method === "GET"
          ? undefined
          : await request
              .clone()
              .json()
              .catch(() => undefined);
      const failure = this.failures.findIndex(
        (f) => f.method === request.method && path.includes(f.path) && (f.match?.(body) ?? true),
      );
      if (failure !== -1) {
        const [f] = this.failures.splice(failure, 1);
        this.calls.push({ method: request.method, path, body: "(injected failure)" });
        throw HttpResponse.json({ message: "injected failure" }, { status: f?.status ?? 500 });
      }
      this.calls.push({ method: request.method, path, body });
      return body as Record<string, unknown> | undefined;
    };
    const notFound = () => HttpResponse.json({ message: "Not Found" }, { status: 404 });
    return [
      http.get(`${REPO}/pulls`, async ({ request }) => {
        await record(request);
        const q = new URL(request.url).searchParams;
        let list = [...this.prs];
        const state = q.get("state") ?? "open";
        if (state !== "all") list = list.filter((p) => p.state === state);
        const head = q.get("head");
        if (head) list = list.filter((p) => `acme:${p.head.ref}` === head);
        const base = q.get("base");
        if (base) list = list.filter((p) => p.base.ref === base);
        list.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
        return HttpResponse.json(list);
      }),
      http.post(`${REPO}/pulls`, async ({ request }) => {
        const body = (await record(request)) as {
          head: string;
          base: string;
          title: string;
          body: string;
        };
        if (this.#remote && !branchExists(this.#remote, body.head)) {
          return HttpResponse.json(
            { message: "Validation Failed", errors: [{ field: "head", code: "invalid" }] },
            { status: 422 },
          );
        }
        const number = this.prs.reduce((max, p) => Math.max(max, p.number), 0) + 1;
        const pr: FakePr = {
          number,
          title: body.title,
          body: body.body,
          state: "open",
          merged_at: null,
          merge_commit_sha: null,
          updated_at: NOW.toISOString(),
          user: { login: "launchset[bot]", type: "Bot" },
          head: { ref: body.head, sha: "0".repeat(40) },
          base: { ref: body.base },
          html_url: `https://github.com/acme/app/pull/${number}`,
        };
        this.prs.push(pr);
        return HttpResponse.json(pr, { status: 201 });
      }),
      http.get(`${REPO}/pulls/:number/files`, async ({ request, params }) => {
        await record(request);
        return HttpResponse.json(this.prFiles.get(Number(params.number)) ?? []);
      }),
      http.get(`${REPO}/pulls/:number`, async ({ request, params }) => {
        await record(request);
        const pr = this.prs.find((p) => p.number === Number(params.number));
        return pr ? HttpResponse.json(pr) : notFound();
      }),
      http.patch(`${REPO}/pulls/:number`, async ({ request, params }) => {
        const body = (await record(request)) as Partial<FakePr>;
        const pr = this.prs.find((p) => p.number === Number(params.number));
        if (!pr) return notFound();
        if (body.title !== undefined) pr.title = body.title;
        if (body.body !== undefined) pr.body = body.body;
        if (body.state !== undefined) pr.state = body.state;
        return HttpResponse.json(pr);
      }),
      http.get(`${REPO}/issues/:number/comments`, async ({ request, params }) => {
        await record(request);
        return HttpResponse.json(this.comments.filter((c) => c.issue === Number(params.number)));
      }),
      http.post(`${REPO}/issues/:number/comments`, async ({ request, params }) => {
        const body = (await record(request)) as { body: string };
        if (this.readOnlyComments) {
          return HttpResponse.json(
            { message: "Resource not accessible by integration" },
            { status: 403 },
          );
        }
        const id = ++this.#id;
        const comment: FakeComment = {
          id,
          issue: Number(params.number),
          body: body.body,
          user: { login: "github-actions[bot]", type: "Bot" },
          html_url: `https://github.com/acme/app/pull/${params.number}#issuecomment-${id}`,
        };
        this.comments.push(comment);
        return HttpResponse.json(comment, { status: 201 });
      }),
      http.patch(`${REPO}/issues/comments/:id`, async ({ request, params }) => {
        const body = (await record(request)) as { body: string };
        if (this.readOnlyComments) {
          return HttpResponse.json(
            { message: "Resource not accessible by integration" },
            { status: 403 },
          );
        }
        const comment = this.comments.find((c) => c.id === Number(params.id));
        if (!comment) return notFound();
        comment.body = body.body;
        return HttpResponse.json(comment);
      }),
      http.get(`${REPO}/releases/tags/*`, async ({ request }) => {
        await record(request);
        const tag = decodeURIComponent(
          new URL(request.url).pathname.split("/releases/tags/")[1] ?? "",
        );
        const found = this.release(tag);
        return found ? HttpResponse.json(found) : notFound();
      }),
      http.post(`${REPO}/releases`, async ({ request }) => {
        const body = (await record(request)) as {
          tag_name: string;
          name: string;
          body: string;
          prerelease: boolean;
          make_latest?: string;
        };
        if (this.release(body.tag_name)) {
          return HttpResponse.json(
            {
              message: "Validation Failed",
              errors: [{ resource: "Release", code: "already_exists", field: "tag_name" }],
            },
            { status: 422 },
          );
        }
        const id = ++this.#id;
        const created: FakeRelease = {
          id,
          tag_name: body.tag_name,
          name: body.name,
          body: body.body,
          prerelease: body.prerelease,
          draft: false,
          html_url: `https://github.com/acme/app/releases/tag/${body.tag_name}`,
          ...(body.make_latest !== undefined ? { make_latest: body.make_latest } : {}),
        };
        this.releases.push(created);
        return HttpResponse.json(created, { status: 201 });
      }),
      http.patch(`${REPO}/releases/:id`, async ({ request, params }) => {
        const body = (await record(request)) as Partial<FakeRelease>;
        const found = this.releases.find((r) => r.id === Number(params.id));
        if (!found) return notFound();
        if (body.name !== undefined) found.name = body.name;
        if (body.body !== undefined) found.body = body.body;
        if (body.prerelease !== undefined) found.prerelease = body.prerelease;
        if (body.make_latest !== undefined) found.make_latest = body.make_latest;
        return HttpResponse.json(found);
      }),
      http.get(`${REPO}/commits/:sha/pulls`, async ({ request, params }) => {
        await record(request);
        const numbers = this.commitPulls.get(String(params.sha)) ?? [];
        return HttpResponse.json(this.prs.filter((p) => numbers.includes(p.number)));
      }),
    ];
  }
}

function branchExists(remote: string, branch: string): boolean {
  try {
    sh(remote, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}
