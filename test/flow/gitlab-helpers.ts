/**
 * GitLab flow test helpers: a project whose bare remote is served over smart HTTP (`git
 * http-backend`) like a GitLab server, a CI checkout like a runner's (detached HEAD, the job
 * token in the clone URL), the CI_* environment, and a stateful fake of the GitLab REST API on
 * msw (unhandled requests fail the test).
 *
 * The git server judges the first Authorization header only: `oauth2:<LAUNCHSET_TOKEN>` may
 * push, `gitlab-ci-token:<CI_JOB_TOKEN>` (the clone URL's credentials) may only read.
 */

import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { createContext, type FlowContext } from "../../src/flow/context.ts";
import { server } from "../forge/helpers.ts";
import { sh, TestRepo, tempDir } from "../git/helpers.ts";
import { NOW, type Project, projectFor, setupProject } from "./helpers.ts";

export { NOW, server };

/** LAUNCHSET_TOKEN: a project access token. */
export const GL_TOKEN = "glpat-LaunchsetProjectToken";
/** CI_JOB_TOKEN. */
export const JOB_TOKEN = "glcbt-RunnerJobToken";
export const SERVER = "https://gitlab.example.com";
export const API_URL = `${SERVER}/api/v4`;
export const PROJECT_PATH = "acme/app";
export const PROJECT_ID = 42;
const PROJECT = `${API_URL}/projects/acme%2Fapp`;
export const WEB = `${SERVER}/${PROJECT_PATH}`;

/** The project access token's bot user (`GET /user`). */
export const BOT_USER = {
  id: 77,
  username: "project_42_bot_ab12cd",
  name: "launchset",
  email: "project_42_bot_ab12cd@noreply.gitlab.example.com",
};

// ---------------------------------------------------------------------------
// The git server

/** One request to the git server: what it was and who sent it. */
export interface GitRequest {
  /** `upload-pack` (fetch), `receive-pack` (push) or the path. */
  service: string;
  /** Basic-auth user of the first Authorization header, or `""` without one. */
  user: string;
  /** Its password matched: LAUNCHSET_TOKEN for `oauth2`, CI_JOB_TOKEN for `gitlab-ci-token`. */
  valid: boolean;
}

export interface GitServer {
  server: Server;
  /** `http://127.0.0.1:<port>` */
  url: string;
  seen: GitRequest[];
  close(): Promise<void>;
}

function basicUser(header: string | undefined): { user: string; pass: string } | undefined {
  const match = /^basic\s+(.+)$/i.exec(header?.trim() ?? "");
  if (!match?.[1]) return undefined;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon === -1
    ? { user: decoded, pass: "" }
    : { user: decoded.slice(0, colon), pass: decoded.slice(colon + 1) };
}

/** Smart-HTTP git over `root` (repositories at `<root>/<path>.git`), with GitLab's auth rules. */
export async function gitServer(root: string): Promise<GitServer> {
  const seen: GitRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "http://x");
      let first: string | undefined;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i]?.toLowerCase() === "authorization") {
          first = req.rawHeaders[i + 1];
          break;
        }
      }
      const auth = basicUser(first);
      const service =
        url.searchParams.get("service")?.replace(/^git-/, "") ??
        (url.pathname.endsWith("/git-receive-pack")
          ? "receive-pack"
          : url.pathname.endsWith("/git-upload-pack")
            ? "upload-pack"
            : url.pathname);
      const token = auth?.user === "oauth2" && auth.pass === GL_TOKEN;
      const job = auth?.user === "gitlab-ci-token" && auth.pass === JOB_TOKEN;
      seen.push({ service, user: auth?.user ?? "", valid: token || job });
      if (!auth) {
        res.statusCode = 401;
        res.setHeader("WWW-Authenticate", 'Basic realm="GitLab"');
        res.end("HTTP Basic: Access denied\n");
        return;
      }
      if (!token && !job) {
        res.statusCode = 401;
        res.setHeader("WWW-Authenticate", 'Basic realm="GitLab"');
        res.end("HTTP Basic: Access denied. The provided password or token is incorrect.\n");
        return;
      }
      if (service === "receive-pack" && !token) {
        res.statusCode = 403;
        res.end("You are not allowed to push code to this project.\n");
        return;
      }
      const cgi = spawn("git", ["http-backend"], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          REMOTE_USER: auth.user,
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: req.method ?? "GET",
          CONTENT_TYPE: req.headers["content-type"] ?? "",
          CONTENT_LENGTH: String(body.length),
        },
      });
      const out: Buffer[] = [];
      cgi.stdout.on("data", (c: Buffer) => out.push(c));
      cgi.on("close", () => {
        const all = Buffer.concat(out);
        const split = all.indexOf("\r\n\r\n");
        for (const line of all.subarray(0, split).toString().split("\r\n")) {
          const [key = "", ...rest] = line.split(": ");
          if (key.toLowerCase() === "status") res.statusCode = Number.parseInt(rest.join(": "), 10);
          else if (key) res.setHeader(key, rest.join(": "));
        }
        res.end(all.subarray(split + 4));
      });
      // http-backend may exit before it read the request body (EPIPE): its response counts.
      cgi.stdin.on("error", () => {});
      cgi.stdin.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    server,
    url,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// The project and the runner's checkout

export interface GitLabProject extends Project {
  /** The git server; close it after the test. */
  git: GitServer;
  /** The clone URL a runner uses: the job token in the userinfo. */
  cloneUrl: string;
  /** Point `refs/merge-requests/<iid>/head` on the remote at `sha` (GitLab keeps one per MR). */
  setMrHead(iid: number, sha: string): void;
}

/**
 * `setupProject` (version files, config, `v{version}`), with the bare remote at
 * `<root>/acme/app.git` served by {@link gitServer}. The developer's clone still pushes over the
 * file system.
 */
export async function setupGitLabProject(
  options: Parameters<typeof setupProject>[0] = {},
): Promise<GitLabProject> {
  const base = setupProject(options);
  const root = tempDir("gitlab");
  const bare = join(root, "acme", "app.git");
  sh(root, "clone", "--quiet", "--bare", base.remote, bare);
  sh(bare, "config", "http.receivepack", "true");
  base.repo.git("remote", "set-url", "origin", bare);
  const project = projectFor(base.repo, bare);
  const git = await gitServer(root);
  const cloneUrl = `${git.url.replace("http://", `http://gitlab-ci-token:${JOB_TOKEN}@`)}/acme/app.git`;
  return {
    ...project,
    git,
    cloneUrl,
    setMrHead(iid, sha) {
      sh(bare, "update-ref", `refs/merge-requests/${iid}/head`, sha);
    },
  };
}

/**
 * A runner's checkout: a clone of the remote with `HEAD` detached at `sha` and `origin` set to
 * the job-token clone URL (so every later fetch and push goes over HTTP). The clone itself is
 * made over the file system: a synchronous git call over HTTP would block this process's server.
 */
export function runnerCheckout(project: GitLabProject, sha: string): TestRepo {
  // `file://`, not a plain path: a local clone would copy every object, also those only
  // reachable from refs a runner never fetches (refs/merge-requests/*).
  const dir = tempDir("runner");
  sh(dir, "clone", "--quiet", `file://${project.remote}`, ".");
  const repo = new TestRepo(dir);
  repo.git("checkout", "--quiet", "--detach", sha);
  repo.git("remote", "set-url", "origin", project.cloneUrl);
  return repo;
}

/** The CI_* variables of a GitLab job (`GITLAB_CI`, server, project, pipeline, tokens). */
export function gitlabEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string | undefined> = {
    GITLAB_CI: "true",
    CI: "true",
    CI_SERVER_URL: SERVER,
    CI_SERVER_HOST: "gitlab.example.com",
    CI_API_V4_URL: API_URL,
    CI_PROJECT_PATH: PROJECT_PATH,
    CI_PROJECT_ID: String(PROJECT_ID),
    CI_PIPELINE_ID: "500",
    CI_PIPELINE_IID: "17",
    CI_JOB_TOKEN: JOB_TOKEN,
    LAUNCHSET_TOKEN: GL_TOKEN,
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
  );
}

/** A branch pipeline for a push of `sha` to `branch`. */
export function pushEnv(
  branch: string,
  sha: string,
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  return gitlabEnv({
    CI_PIPELINE_SOURCE: "push",
    CI_COMMIT_BRANCH: branch,
    CI_COMMIT_REF_NAME: branch,
    CI_COMMIT_SHA: sha,
    ...overrides,
  });
}

/** A merge request pipeline (plain: `detached`, HEAD is the source head) for MR `iid`. */
export function mrEnv(
  input: { iid: number; source: string; sha: string; target?: string; labels?: string[] },
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  return gitlabEnv({
    CI_PIPELINE_SOURCE: "merge_request_event",
    CI_COMMIT_SHA: input.sha,
    CI_COMMIT_REF_NAME: input.source,
    CI_MERGE_REQUEST_IID: String(input.iid),
    CI_MERGE_REQUEST_EVENT_TYPE: "detached",
    CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: input.source,
    CI_MERGE_REQUEST_TARGET_BRANCH_NAME: input.target ?? "main",
    CI_MERGE_REQUEST_PROJECT_ID: String(PROJECT_ID),
    CI_MERGE_REQUEST_SOURCE_PROJECT_ID: String(PROJECT_ID),
    CI_MERGE_REQUEST_PROJECT_PATH: PROJECT_PATH,
    CI_MERGE_REQUEST_SOURCE_PROJECT_PATH: PROJECT_PATH,
    ...(input.labels?.length ? { CI_MERGE_REQUEST_LABELS: input.labels.join(",") } : {}),
    ...overrides,
  });
}

/** A FlowContext for a runner checkout, from the environment alone (like the CLI in a job). */
export async function gitlabContext(
  repo: TestRepo,
  env: Record<string, string>,
): Promise<FlowContext> {
  return createContext({ cwd: repo.dir, env, now: NOW });
}

/** The commits' author of `ref` on the remote: `name <email>`. */
export function authorOf(project: Project, ref: string): string {
  return execFileSync("git", ["log", "-1", "--format=%an <%ae>|%cn <%ce>", ref], {
    cwd: project.remote,
    encoding: "utf8",
  }).trim();
}

// ---------------------------------------------------------------------------
// Fake GitLab

export interface FakeMr {
  iid: number;
  title: string;
  description: string;
  state: "opened" | "closed" | "merged";
  merged_at: string | null;
  merge_commit_sha: string | null;
  squash_commit_sha: string | null;
  sha: string;
  updated_at: string;
  author: { id: number; username: string };
  source_branch: string;
  target_branch: string;
  source_project_id: number;
  target_project_id: number;
  labels: string[];
  created_at: string;
  web_url: string;
}

/** A pipeline of an MR (`GET/POST /merge_requests/:iid/pipelines`). */
export interface FakePipeline {
  id: number;
  mr: number;
  sha: string;
  ref: string;
  status: string;
  source: string;
  created_at: string;
  web_url: string;
  /** The MR head it ran (a merged results pipeline's `sha` is the merge commit). */
  headSha: string;
}

/** A label event of an MR (`GET /merge_requests/:iid/resource_label_events`). */
export interface FakeLabelEvent {
  id: number;
  action: "add" | "remove";
  created_at: string;
  label: { id: number; name: string } | null;
}

export interface FakeNote {
  id: number;
  mr: number;
  body: string;
  system: boolean;
  author: { id: number; username: string };
}

export interface FakeGlRelease {
  tag_name: string;
  name: string;
  description: string;
}

export interface FakeJob {
  id: number;
  name: string;
  status: string;
  web_url: string;
}

export interface GlCall {
  method: string;
  /** Decoded path below the project (`/merge_requests/1/notes`), or the full path otherwise. */
  path: string;
  /** `token` (PRIVATE-TOKEN), `job` (JOB-TOKEN) or `none`. */
  auth: "token" | "job" | "none";
  body?: unknown;
}

/** Endpoints a job token may call (GitLab's CI_JOB_TOKEN allowlist, the part launchset uses). */
function jobTokenMay(method: string, path: string): boolean {
  if (path.startsWith("/releases")) return true;
  if (method !== "GET") return false;
  return (
    /^\/merge_requests(\/\d+)?$/.test(path) ||
    /^\/merge_requests\/\d+\/notes/.test(path) ||
    /^\/repository\/commits\/[^/]+\/merge_requests$/.test(path)
  );
}

/** A pipeline as the API shows it. */
function pipelineJson(p: FakePipeline) {
  return {
    id: p.id,
    iid: p.id - 1000,
    project_id: PROJECT_ID,
    sha: p.sha,
    ref: p.ref,
    status: p.status,
    source: p.source,
    created_at: p.created_at,
    updated_at: p.created_at,
    web_url: p.web_url,
  };
}

/** A small in-memory GitLab: MRs, notes, releases, pipelines with child pipelines, `/user`. */
export class FakeGitLab {
  mrs: FakeMr[] = [];
  notes: FakeNote[] = [];
  releases: FakeGlRelease[] = [];
  /** Pipeline id → its jobs. */
  jobs = new Map<number, FakeJob[]>();
  /** Pipeline id → child pipeline ids (trigger jobs). */
  children = new Map<number, number[]>();
  /** MR pipelines (the preview sweep). */
  pipelines: FakePipeline[] = [];
  /** MR iid → its label events. */
  labelEvents = new Map<number, FakeLabelEvent[]>();
  /** The server's time for what it creates (pipelines). */
  clock: Date = NOW;
  calls: GlCall[] = [];
  /** `GET /user` fails with this status (a token that may not read it). */
  userStatus: number | undefined;
  /** Injected failures: the next matching request gets this status. */
  failures: { method: string; path: string; status: number }[] = [];
  #id = 2000;

  constructor() {
    server.use(...this.handlers());
  }

  /** Make the next `method` request whose project path contains `path` fail with `status`. */
  failNext(method: string, path: string, status = 500): void {
    this.failures.push({ method, path, status });
  }

  /** An open MR, e.g. a feature MR whose pipeline runs. */
  addMr(input: {
    iid: number;
    source: string;
    sha?: string;
    author?: string;
    labels?: string[];
    createdAt?: string;
    /** A fork MR's source project. */
    sourceProjectId?: number;
  }) {
    const mr: FakeMr = {
      iid: input.iid,
      title: `MR ${input.iid}`,
      description: "",
      state: "opened",
      merged_at: null,
      merge_commit_sha: null,
      squash_commit_sha: null,
      sha: input.sha ?? "0".repeat(40),
      updated_at: NOW.toISOString(),
      author: { id: 5, username: input.author ?? "someone" },
      source_branch: input.source,
      target_branch: "main",
      source_project_id: input.sourceProjectId ?? PROJECT_ID,
      target_project_id: PROJECT_ID,
      labels: input.labels ?? [],
      created_at: input.createdAt ?? NOW.toISOString(),
      web_url: `${WEB}/-/merge_requests/${input.iid}`,
    };
    this.mrs.push(mr);
    return mr;
  }

  /** A label event on MR `iid`: `label` was added (or removed) at `at`. */
  labelEvent(iid: number, label: string, at: Date | string, action: "add" | "remove" = "add") {
    const events = this.labelEvents.get(iid) ?? [];
    events.push({
      id: ++this.#id,
      action,
      created_at: typeof at === "string" ? at : at.toISOString(),
      label: { id: 1, name: label },
    });
    this.labelEvents.set(iid, events);
  }

  /**
   * A pipeline of MR `iid` created at `at`: for the MR head (`sha`, default the MR's head) with
   * ref `refs/merge-requests/<iid>/head`, or as given (`merged: true`: a merged results pipeline,
   * whose sha is a merge commit; `ref`: e.g. a branch pipeline).
   */
  addPipeline(
    iid: number,
    at: Date | string,
    options: { sha?: string; merged?: boolean; ref?: string; source?: string } = {},
  ): FakePipeline {
    const mr = this.mrs.find((m) => m.iid === iid);
    const head = options.sha ?? mr?.sha ?? "0".repeat(40);
    const id = ++this.#id;
    const pipeline: FakePipeline = {
      id,
      mr: iid,
      sha: options.merged ? `merge${id}`.padEnd(40, "0") : head,
      ref: options.ref ?? `refs/merge-requests/${iid}/${options.merged ? "merge" : "head"}`,
      status: "success",
      source: options.source ?? "merge_request_event",
      created_at: typeof at === "string" ? at : at.toISOString(),
      web_url: `${WEB}/-/pipelines/${id}`,
      headSha: head,
    };
    this.pipelines.push(pipeline);
    return pipeline;
  }

  /** GitLab's head pipeline of an MR: its newest pipeline for the MR's head commit. */
  headPipelineOf(mr: FakeMr): FakePipeline | undefined {
    return this.pipelines
      .filter((p) => p.mr === mr.iid && p.headSha === mr.sha)
      .sort((a, b) => b.id - a.id)[0];
  }

  openMrs(): FakeMr[] {
    return this.mrs.filter((m) => m.state === "opened");
  }

  release(tag: string): FakeGlRelease | undefined {
    return this.releases.find((r) => r.tag_name === tag);
  }

  callsTo(method: string, pathPart: string): GlCall[] {
    return this.calls.filter((c) => c.method === method && c.path.includes(pathPart));
  }

  handlers() {
    const forbidden = () => HttpResponse.json({ message: "403 Forbidden" }, { status: 403 });
    const notFound = () => HttpResponse.json({ message: "404 Not found" }, { status: 404 });
    /** Record the call; returns the auth kind and body, or a Response to send instead. */
    const record = async (
      request: Request,
    ): Promise<{ auth: GlCall["auth"]; body: Record<string, unknown> } | Response> => {
      const url = new URL(request.url);
      const raw = url.pathname;
      const projectPrefix = new URL(PROJECT).pathname;
      const path = raw.startsWith(projectPrefix)
        ? decodeURIComponent(raw.slice(projectPrefix.length))
        : decodeURIComponent(raw);
      const auth: GlCall["auth"] =
        request.headers.get("private-token") === GL_TOKEN
          ? "token"
          : request.headers.get("job-token") === JOB_TOKEN
            ? "job"
            : "none";
      const body =
        request.method === "GET"
          ? {}
          : ((await request
              .clone()
              .json()
              .catch(() => ({}))) as Record<string, unknown>);
      this.calls.push({
        method: request.method,
        path,
        auth,
        ...(request.method === "GET" ? {} : { body }),
      });
      if (auth === "none")
        return HttpResponse.json({ message: "401 Unauthorized" }, { status: 401 });
      if (auth === "job" && raw.startsWith(projectPrefix) && !jobTokenMay(request.method, path)) {
        return forbidden();
      }
      const failure = this.failures.findIndex(
        (f) => f.method === request.method && path.includes(f.path),
      );
      if (failure !== -1) {
        const [f] = this.failures.splice(failure, 1);
        return HttpResponse.json({ message: "injected failure" }, { status: f?.status ?? 500 });
      }
      return { auth, body };
    };
    const mrByIid = (iid: unknown) => this.mrs.find((m) => m.iid === Number(iid));
    return [
      http.get(`${API_URL}/user`, async ({ request }) => {
        const r = await record(request);
        if (r instanceof Response) return r;
        if (r.auth === "job") return forbidden();
        if (this.userStatus) {
          return HttpResponse.json({ message: "nope" }, { status: this.userStatus });
        }
        return HttpResponse.json({ ...BOT_USER, bot: true, state: "active" });
      }),
      http.get(`${PROJECT}/merge_requests`, async ({ request }) => {
        const r = await record(request);
        if (r instanceof Response) return r;
        const q = new URL(request.url).searchParams;
        let list = [...this.mrs];
        const state = q.get("state");
        if (state && state !== "all") list = list.filter((m) => m.state === state);
        const source = q.get("source_branch");
        if (source) list = list.filter((m) => m.source_branch === source);
        const target = q.get("target_branch");
        if (target) list = list.filter((m) => m.target_branch === target);
        const labels = q.get("labels");
        if (labels) {
          const wanted = labels.split(",");
          list = list.filter((m) => wanted.every((label) => m.labels.includes(label)));
        }
        list.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
        return HttpResponse.json(list);
      }),
      http.post(`${PROJECT}/merge_requests`, async ({ request }) => {
        const r = await record(request);
        if (r instanceof Response) return r;
        const body = r.body as {
          source_branch: string;
          target_branch: string;
          title: string;
          description?: string;
        };
        const iid = this.mrs.reduce((max, m) => Math.max(max, m.iid), 0) + 1;
        const mr: FakeMr = {
          ...this.addMr({ iid, source: body.source_branch, author: BOT_USER.username }),
          title: body.title,
          description: body.description ?? "",
          target_branch: body.target_branch,
        };
        this.mrs[this.mrs.length - 1] = mr;
        return HttpResponse.json(mr, { status: 201 });
      }),
      http.get(`${PROJECT}/merge_requests/:iid`, async ({ request, params }) => {
        const r = await record(request);
        if (r instanceof Response) return r;
        const mr = mrByIid(params.iid);
        if (!mr) return notFound();
        const head = this.headPipelineOf(mr);
        return HttpResponse.json({ ...mr, head_pipeline: head ? pipelineJson(head) : null });
      }),
      http.get(`${PROJECT}/merge_requests/:iid/pipelines`, async ({ request, params }) => {
        const r = await record(request);
        if (r instanceof Response) return r;
        if (!mrByIid(params.iid)) return notFound();
        return HttpResponse.json(
          this.pipelines
            .filter((p) => p.mr === Number(params.iid))
            .sort((a, b) => b.id - a.id)
            .map(pipelineJson),
        );
      }),
      http.post(`${PROJECT}/merge_requests/:iid/pipelines`, async ({ request, params }) => {
        const r = await record(request);
        if (r instanceof Response) return r;
        const mr = mrByIid(params.iid);
        if (!mr) return notFound();
        const created = this.addPipeline(mr.iid, this.clock);
        created.status = "created";
        return HttpResponse.json(pipelineJson(created), { status: 201 });
      }),
      http.get(
        `${PROJECT}/merge_requests/:iid/resource_label_events`,
        async ({ request, params }) => {
          const r = await record(request);
          if (r instanceof Response) return r;
          if (!mrByIid(params.iid)) return notFound();
          return HttpResponse.json(
            (this.labelEvents.get(Number(params.iid)) ?? []).map((e) => ({
              ...e,
              user: { id: 5, username: "someone" },
              resource_type: "MergeRequest",
              resource_id: 1000 + Number(params.iid),
            })),
          );
        },
      ),
      http.put(`${PROJECT}/merge_requests/:iid`, async ({ request, params }) => {
        const r = await record(request);
        if (r instanceof Response) return r;
        const mr = mrByIid(params.iid);
        if (!mr) return notFound();
        const body = r.body as { title?: string; description?: string; state_event?: string };
        if (body.title !== undefined) mr.title = body.title;
        if (body.description !== undefined) mr.description = body.description;
        if (body.state_event === "close") mr.state = "closed";
        return HttpResponse.json(mr);
      }),
      http.get(`${PROJECT}/merge_requests/:iid/notes`, async ({ request, params }) => {
        const r = await record(request);
        if (r instanceof Response) return r;
        return HttpResponse.json(this.notes.filter((n) => n.mr === Number(params.iid)));
      }),
      http.post(`${PROJECT}/merge_requests/:iid/notes`, async ({ request, params }) => {
        const r = await record(request);
        if (r instanceof Response) return r;
        const note: FakeNote = {
          id: ++this.#id,
          mr: Number(params.iid),
          body: String(r.body.body ?? ""),
          system: false,
          author: { id: BOT_USER.id, username: BOT_USER.username },
        };
        this.notes.push(note);
        return HttpResponse.json(note, { status: 201 });
      }),
      http.put(`${PROJECT}/merge_requests/:iid/notes/:id`, async ({ request, params }) => {
        const r = await record(request);
        if (r instanceof Response) return r;
        const note = this.notes.find((n) => n.id === Number(params.id));
        if (!note) return notFound();
        note.body = String(r.body.body ?? "");
        return HttpResponse.json(note);
      }),
      http.get(`${PROJECT}/merge_requests/:iid/diffs`, async ({ request }) => {
        const r = await record(request);
        if (r instanceof Response) return r;
        return HttpResponse.json([]);
      }),
      http.get(`${PROJECT}/releases/:tag`, async ({ request, params }) => {
        const r = await record(request);
        if (r instanceof Response) return r;
        const found = this.release(decodeURIComponent(String(params.tag)));
        return found ? HttpResponse.json(found) : notFound();
      }),
      http.post(`${PROJECT}/releases`, async ({ request }) => {
        const r = await record(request);
        if (r instanceof Response) return r;
        const body = r.body as { tag_name: string; name?: string; description?: string };
        if (this.release(body.tag_name)) {
          return HttpResponse.json({ message: "Release already exists" }, { status: 409 });
        }
        const created: FakeGlRelease = {
          tag_name: body.tag_name,
          name: body.name ?? body.tag_name,
          description: body.description ?? "",
        };
        this.releases.push(created);
        return HttpResponse.json(created, { status: 201 });
      }),
      http.put(`${PROJECT}/releases/:tag`, async ({ request, params }) => {
        const r = await record(request);
        if (r instanceof Response) return r;
        const found = this.release(decodeURIComponent(String(params.tag)));
        if (!found) return notFound();
        const body = r.body as { name?: string; description?: string };
        if (body.name !== undefined) found.name = body.name;
        if (body.description !== undefined) found.description = body.description;
        return HttpResponse.json(found);
      }),
      http.get(`${PROJECT}/repository/commits/:sha/merge_requests`, async ({ request }) => {
        const r = await record(request);
        if (r instanceof Response) return r;
        return HttpResponse.json([]);
      }),
      http.get(`${PROJECT}/pipelines/:id/jobs`, async ({ request, params }) => {
        const r = await record(request);
        if (r instanceof Response) return r;
        return HttpResponse.json(this.jobs.get(Number(params.id)) ?? []);
      }),
      http.get(`${PROJECT}/pipelines/:id/bridges`, async ({ request, params }) => {
        const r = await record(request);
        if (r instanceof Response) return r;
        const children = this.children.get(Number(params.id)) ?? [];
        return HttpResponse.json(
          children.map((child, i) => ({
            id: 9000 + i,
            name: "build",
            pipeline: { id: Number(params.id), project_id: PROJECT_ID },
            downstream_pipeline: { id: child, project_id: PROJECT_ID },
          })),
        );
      }),
    ];
  }
}
