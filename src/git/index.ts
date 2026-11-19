/**
 * The one wrapper around the `git` binary (spec 13). Every git call launchset makes goes
 * through {@link Git.run}: `execFile` without a shell, stable English messages, no prompts,
 * and errors that name the command (never a token) plus git's stderr and a hint.
 *
 * Paths: every path the API takes or returns is **repo-relative** POSIX (relative to the
 * repository's top level), whatever `cwd` is. Pathspecs are passed as `:(top,literal)<path>`.
 * The launchset config root may be a subdirectory of the repo; convert with
 * {@link Git.toRepoPath} / {@link Git.fromRepoPath}.
 *
 * Authentication: when a token is given, network commands (push, ls-remote, fetch) get the
 * config `http.<server>/.extraheader=` (empty: resets the header actions/checkout persisted
 * for `GITHUB_TOKEN`) followed by `http.<server>/.extraheader=AUTHORIZATION: basic …`, passed
 * through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` environment variables so
 * the token never appears in a process's argv. Nothing is written to the git config or the
 * remote URL. The header authenticates the first request, so it also wins over credentials in
 * the remote URL (a GitLab runner clones with `https://gitlab-ci-token:<job token>@…`). The
 * basic-auth user is `x-access-token` on GitHub and `oauth2` on GitLab (any non-blank user
 * works with a GitLab access token).
 */

import { execFile } from "node:child_process";
import { posix, relative, sep } from "node:path";
import { EXPECTED_ERROR } from "../core/errors.ts";
import { forgeHints, GITLAB_JOB_TOKEN_PUSH, gitPushHints } from "../core/forge-hints.ts";
import { DEFAULT_SERVER_URLS, type ForgeHost } from "../core/forge-links.ts";

/** Identity of commits launchset makes (release PR, changelog backport). */
export const LAUNCHSET_IDENTITY = {
  name: "launchset[bot]",
  email: "launchset[bot]@users.noreply.github.com",
} as const;

export interface GitIdentity {
  name: string;
  email: string;
}

export interface GitOptions {
  /** Directory git runs in (the repo root or any directory inside it). */
  cwd: string;
  /** Token used for network commands (push, fetch, ls-remote). Never printed. */
  token?: string;
  /** `GITHUB_SERVER_URL` / `CI_SERVER_URL`; default the host's public server. */
  serverUrl?: string;
  /** The code host, for the default server and for reading the repository from the remote. */
  host?: ForgeHost;
  /** Remote name; default `origin`. */
  remote?: string;
  /**
   * Identity for commits made by launchset; default {@link LAUNCHSET_IDENTITY}. A function is
   * called once, at the first commit (so commands that never commit never resolve it, e.g. with
   * an API call).
   */
  identity?: GitIdentity | (() => Promise<GitIdentity>);
  /**
   * Files launchset itself writes or receives in this run (absolute paths; the CLI's `--ci`
   * files such as plan.json): {@link Git.isClean} doesn't count them.
   */
  ownFiles?: readonly string[];
}

export interface RunOptions {
  /** Add the token's auth header config (network commands). */
  auth?: boolean;
  /** Exit codes that don't throw (0 always succeeds). */
  okCodes?: number[];
  /** Extra environment variables. */
  env?: Record<string, string>;
  /** Keep stdout exactly as printed (default: trailing newlines trimmed). */
  raw?: boolean;
  /** Text written to git's stdin. */
  input?: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface TagRef {
  name: string;
  /** Commit the tag points to (annotated tags are peeled). */
  sha: string;
}

export type FileStatus = "A" | "M" | "D" | "R";

export interface ChangedFile {
  status: FileStatus;
  /** Repo-relative POSIX path (the new path for renames). */
  path: string;
  /** Old path, for renames. */
  oldPath?: string;
  /** Rename similarity in percent (100 = identical content), for renames. */
  similarity?: number;
}

export interface LogEntry {
  sha: string;
  subject: string;
  author: string;
  authorEmail: string;
}

export type PushResult = "created" | "updated" | "up-to-date";

/** A tree entry from {@link Git.listFiles}. */
export interface TreeFile {
  /** Repo-relative POSIX path. */
  path: string;
  /** Blob id, for {@link Git.readBlobs}. */
  blob: string;
}

/**
 * Why a git command failed, from its output: the token was rejected (`auth`) or lacks access
 * (`forbidden`), a protection rule blocked a push (`protected`), the token may not change
 * workflow files (`workflows`), a commit or ref isn't available (`missing-object`).
 */
export type GitFailureReason =
  | "auth"
  | "forbidden"
  | "protected"
  | "workflows"
  | "missing-object"
  | "other";

/** A git command failed. The message has the command (no secrets) and stderr; `hint` what to do. */
export class GitError extends Error {
  override name = "GitError";
  readonly [EXPECTED_ERROR] = true;
  /** The command as shown in the message, e.g. `git push origin refs/tags/v1.0.0`. */
  readonly command: string;
  readonly stderr: string;
  /** Exit code, or undefined when git couldn't be started. */
  readonly exitCode: number | undefined;
  readonly hint?: string;
  /** What went wrong; classified from `stderr` when not given. */
  readonly reason: GitFailureReason;
  constructor(
    message: string,
    command: string,
    stderr: string,
    exitCode: number | undefined,
    hint?: string,
    reason?: GitFailureReason,
  ) {
    super(message);
    this.command = command;
    this.stderr = stderr;
    this.exitCode = exitCode;
    if (hint !== undefined) this.hint = hint;
    this.reason = reason ?? classifyFailure([], stderr).reason;
  }
}

/**
 * A `--force-with-lease` push was rejected: the remote branch moved since it was read (another
 * run pushed it first).
 */
export class LeaseError extends GitError {
  override name = "LeaseError";
  readonly branch: string;
  constructor(branch: string, command: string, stderr: string, exitCode: number | undefined) {
    super(
      `The remote branch ${branch} changed while it was being rebuilt (\`${command}\` was rejected).`,
      command,
      stderr,
      exitCode,
      "Another run pushed it first; that run's version wins.",
    );
    this.branch = branch;
  }
}

/** `pushTag` was rejected because the remote already has that tag (spec 9.9 reservation). */
export class TagExistsError extends GitError {
  override name = "TagExistsError";
  readonly tag: string;
  constructor(tag: string, command: string, stderr: string, exitCode: number | undefined) {
    super(
      `Tag ${tag} already exists on the remote (\`${command}\` was rejected).`,
      command,
      stderr,
      exitCode,
      "Another run probably pushed it first; pick the next free name and retry.",
    );
    this.tag = tag;
  }
}

/**
 * {@link Git.createAndPushTag}: the push failed, and removing the local tag again failed too.
 * `pushError` is the push failure (possibly a {@link TagExistsError}).
 */
export class TagCleanupError extends GitError {
  override name = "TagCleanupError";
  readonly tag: string;
  readonly pushError: unknown;
  readonly cleanupError: unknown;
  constructor(tag: string, pushError: unknown, cleanupError: unknown) {
    const push = pushError instanceof GitError ? pushError : undefined;
    super(
      `Pushing tag ${tag} failed, and removing the local tag failed too (run \`git tag -d ${tag}\`).`,
      push?.command ?? "",
      push?.stderr ?? "",
      push?.exitCode,
      push?.hint,
      push?.reason,
    );
    this.tag = tag;
    this.pushError = pushError;
    this.cleanupError = cleanupError;
  }
}

const NUL = "\0";
const MAX_BUFFER = 256 * 1024 * 1024;

/** `https://github.com` → `https://github.com/` (the `http.<url>` config key needs the slash). */
export function normalizeServerUrl(
  serverUrl: string | undefined,
  host: ForgeHost = "github",
): string {
  const url = (serverUrl ?? "").trim() || DEFAULT_SERVER_URLS[host];
  return url.endsWith("/") ? url : `${url}/`;
}

/** The basic-auth user git sends with the token: GitHub `x-access-token`, GitLab `oauth2`. */
export const GIT_TOKEN_USERS: Readonly<Record<ForgeHost, string>> = {
  github: "x-access-token",
  gitlab: "oauth2",
};

/**
 * The `AUTHORIZATION` header value git sends for a token: a GitHub installation/App token, or
 * (with `host` `gitlab`) a GitLab access token.
 */
export function basicAuthHeader(token: string, host: ForgeHost = "github"): string {
  return `AUTHORIZATION: basic ${Buffer.from(`${GIT_TOKEN_USERS[host]}:${token}`).toString("base64")}`;
}

/**
 * `GIT_CONFIG_*` variables that add `entries` after the ones already in `baseEnv` (git reads
 * them last, so they win over the repo's config). Nothing is written to `.git/config`.
 */
export function configEnv(
  entries: readonly (readonly [key: string, value: string])[],
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const existing = Number.parseInt(baseEnv.GIT_CONFIG_COUNT ?? "0", 10);
  const start = Number.isInteger(existing) && existing > 0 ? existing : 0;
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(start + entries.length) };
  entries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${start + i}`] = key;
    env[`GIT_CONFIG_VALUE_${start + i}`] = value;
  });
  return env;
}

/**
 * Where launchset points `core.hooksPath`: a path that holds no hooks. launchset runs git in
 * the team's checkout, where hooks installed by husky, simple-git-hooks, lefthook or git-lfs
 * (often by an install step earlier in the same CI job) would run on launchset's pushes,
 * commits and checkouts: tests or lint in a pre-push hook, `npx launchset check --push`
 * failing on npm auth, git-lfs checking locks with the wrong token. None of them has work to
 * do for launchset's commits, tags and branches (they never add LFS objects).
 */
export const NO_HOOKS = process.platform === "win32" ? "NUL" : "/dev/null";

/**
 * Environment variables that make git authenticate to `serverUrl` with `token`: first an
 * empty `http.<url>.extraheader` (resets the multi-valued list, dropping the header that
 * actions/checkout persisted), then the token's header. Entries already configured through
 * `GIT_CONFIG_COUNT` in `baseEnv` are kept; ours are appended after them.
 *
 * With `owner`, the key is `http.<server>/<owner>/.extraheader`, more specific than the
 * `http.<server>/.extraheader` actions/checkout writes. That matters for git-lfs: it ignores
 * the empty-value reset and would send the checkout's (read-only) header first, so its
 * pre-push lock check fails with "must have push access". Like git, it uses only the most
 * specific matching key, and `<owner>/` matches both the push URL and the LFS URL
 * (`<owner>/<repo>.git/info/lfs`). `owner` may be a nested namespace (`group/sub`, GitLab):
 * each segment is encoded. `host` picks the basic-auth user ({@link GIT_TOKEN_USERS}).
 */
export function authConfigEnv(
  token: string,
  serverUrl?: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  owner?: string,
  host: ForgeHost = "github",
): Record<string, string> {
  const scope = owner ? `${owner.split("/").map(encodeURIComponent).join("/")}/` : "";
  const key = `http.${normalizeServerUrl(serverUrl, host)}${scope}.extraheader`;
  return configEnv(
    [
      [key, ""],
      [key, basicAuthHeader(token, host)],
    ],
    baseEnv,
  );
}

/**
 * The `http.<url>` scope of a GitLab remote: its https/http URL without credentials, query and
 * the project's own path segment, e.g. `https://gitlab.acme.dev:8443/group/sub/` for
 * `https://gitlab-ci-token:…@gitlab.acme.dev:8443/group/sub/app.git`. Like `<owner>/` on
 * GitHub it matches the push URL and the LFS URL (`…/app.git/info/lfs`), and it follows the
 * remote even when the runner clones from another host name or a relative URL root than
 * `CI_SERVER_URL`. Undefined for ssh and local remotes (the header doesn't apply to them).
 */
export function remoteAuthScope(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return undefined;
  return `${parsed.protocol}//${parsed.host}/${segments.slice(0, -1).join("/")}/`;
}

/** A literal pathspec for a repo-relative path. */
export function topPathspec(path: string): string {
  return `:(top,literal)${path}`;
}

/**
 * The full repository path of a remote URL on `host` (default GitHub), or undefined when the
 * URL isn't a repository on a known server: https/http (userinfo is dropped, never returned),
 * `ssh://git@host:port/path`, scp-like `git@host:path`. GitHub paths are `owner/repo`; GitLab
 * paths may nest (`group/sub/project`). Known servers: `github.com` or `gitlab.com`, and
 * `serverUrl`'s host.
 */
export function parseRepoFromRemote(
  url: string,
  serverUrl?: string,
  host: ForgeHost = "github",
): string | undefined {
  const gitlab = host === "gitlab";
  const known = new Set([DEFAULT_SERVER_URLS[host].replace(/^https:\/\//, "")]);
  /** A self-managed GitLab's relative URL root (`/gitlab/`), which isn't part of the path. */
  let root = "/";
  if (serverUrl?.trim()) {
    try {
      const server = new URL(normalizeServerUrl(serverUrl, host));
      known.add(server.host.toLowerCase());
      // GitLab's ssh port differs from its web port, so its bare host name counts too.
      if (gitlab) known.add(server.hostname.toLowerCase());
      if (gitlab) root = server.pathname.endsWith("/") ? server.pathname : `${server.pathname}/`;
    } catch {
      // An unparsable server URL only means we recognise the public host alone.
    }
  }
  const trimmed = url.trim();
  let remoteHost: string;
  let path: string;
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(trimmed);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    remoteHost = scp[1] ?? "";
    path = scp[2] ?? "";
  } else {
    try {
      const parsed = new URL(trimmed);
      if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) return undefined;
      remoteHost = gitlab && parsed.protocol === "ssh:" ? parsed.hostname : parsed.host;
      path = parsed.pathname;
    } catch {
      return undefined;
    }
  }
  if (!known.has(remoteHost.toLowerCase())) return undefined;
  if (gitlab) {
    if (root !== "/" && `/${path.replace(/^\/+/, "")}`.startsWith(root)) {
      path = `/${path.replace(/^\/+/, "")}`.slice(root.length);
    }
    const match = /^\/?(.+?)(?:\.git)?\/*$/.exec(path);
    const segments = match?.[1]?.split("/") ?? [];
    return segments.length >= 2 && segments.every(Boolean) ? segments.join("/") : undefined;
  }
  const match = /^\/?([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(path);
  if (!match) return undefined;
  return `${match[1]}/${match[2]}`;
}

function assertRefName(kind: string, name: string): void {
  if (!name || name.startsWith("-") || /[\s~^:?*[\\]|\.\.|@\{/.test(name)) {
    throw new GitError(
      `Invalid ${kind} name "${name}".`,
      "",
      "",
      undefined,
      "Ref names can't start with '-' or contain spaces, '..', '~', '^', ':', '?', '*', '[', '\\' or '@{'.",
    );
  }
}

/** What {@link classifyFailure} knows about the run, for host-specific hints. */
export interface FailureContext {
  /** Default GitHub. */
  host?: ForgeHost;
  /** A token was given for network commands (GitLab: else git used the clone URL's job token). */
  hasToken?: boolean;
}

/** GitLab's wording for pushes a protected branch or tag blocks. */
function gitlabProtected(s: string): boolean {
  return (
    s.includes("protected branch") ||
    s.includes("protected tag") ||
    s.includes("not allowed to create this tag") ||
    s.includes("not allowed to create tag") ||
    s.includes("not allowed to force push") ||
    s.includes("not allowed to delete")
  );
}

/** The reason and a hint for common git failures in CI. */
function classifyFailure(
  args: string[],
  stderr: string,
  context: FailureContext = {},
): { reason: GitFailureReason; hint?: string } {
  const s = stderr.toLowerCase();
  const host = context.host ?? "github";
  const gitlab = host === "gitlab";
  const push = gitPushHints(host);
  const hints = forgeHints(host);
  // On GitLab, a push without LAUNCHSET_TOKEN used the runner's job token from the clone URL.
  const jobToken = gitlab && context.hasToken === false;
  if (
    !gitlab &&
    (s.includes("without `workflows` permission") || s.includes("without workflows permission"))
  ) {
    return { reason: "workflows", hint: push.workflows };
  }
  if (
    gitlab
      ? gitlabProtected(s)
      : s.includes("gh006") || s.includes("protected branch") || s.includes("gh013")
  ) {
    return { reason: "protected", hint: push.protected };
  }
  if (gitlab && s.includes("pre-receive hook declined")) {
    return { reason: "protected", hint: push.declined };
  }
  if (
    s.includes("authentication failed") ||
    s.includes("could not read username") ||
    s.includes("returned error: 401") ||
    (gitlab && s.includes("http basic: access denied"))
  ) {
    return { reason: "auth", hint: jobToken ? GITLAB_JOB_TOKEN_PUSH : push.auth };
  }
  if (
    s.includes("returned error: 403") ||
    s.includes("permission to") ||
    s.includes("denied") ||
    (gitlab && (s.includes("not allowed to push") || s.includes("not allowed to upload")))
  ) {
    return { reason: "forbidden", hint: jobToken ? GITLAB_JOB_TOKEN_PUSH : push.forbidden };
  }
  if (
    s.includes("shallow") ||
    s.includes("unknown revision") ||
    s.includes("bad revision") ||
    s.includes("not a valid object name") ||
    s.includes("bad object")
  ) {
    return { reason: "missing-object", hint: hints.missingObject };
  }
  if (s.includes("not a git repository")) {
    return { reason: "other", hint: hints.notARepository };
  }
  if (args.includes("commit") && (s.includes("nothing to commit") || s.includes("nothing added"))) {
    return { reason: "other", hint: "There were no changes to commit." };
  }
  return { reason: "other" };
}

export class Git {
  readonly cwd: string;
  readonly remote: string;
  readonly serverUrl: string;
  readonly host: ForgeHost;
  readonly #identity: GitIdentity | (() => Promise<GitIdentity>);
  #resolvedIdentity: Promise<GitIdentity> | undefined;
  readonly #token: string | undefined;
  readonly #secrets: string[];
  readonly #ownFiles: readonly string[];
  #prefix: Promise<string> | undefined;
  #remoteUrl: string | undefined;

  constructor(options: GitOptions) {
    this.cwd = options.cwd;
    this.remote = options.remote ?? "origin";
    this.host = options.host ?? "github";
    this.serverUrl = normalizeServerUrl(options.serverUrl, this.host);
    this.#identity = options.identity ?? LAUNCHSET_IDENTITY;
    this.#token = options.token || undefined;
    this.#ownFiles = options.ownFiles ?? [];
    this.#secrets = [];
    if (this.#token) {
      this.#secrets.push(
        this.#token,
        basicAuthHeader(this.#token, this.host).slice("AUTHORIZATION: basic ".length),
      );
    }
  }

  /** The identity of launchset's commits (resolved once when given as a function). */
  async identity(): Promise<GitIdentity> {
    const identity = this.#identity;
    if (typeof identity !== "function") return identity;
    this.#resolvedIdentity ??= identity();
    return this.#resolvedIdentity;
  }

  /** True when a token was given (network commands authenticate with it). */
  get hasToken(): boolean {
    return this.#token !== undefined;
  }

  /** Replace every secret in `text` with `***`. */
  mask(text: string): string {
    let out = text;
    for (const secret of this.#secrets) out = out.split(secret).join("***");
    // Credentials embedded in URLs (https://user:pass@host) are never shown either.
    return out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1***@");
  }

  /** Run git and return everything; throws only when git can't be started. */
  async exec(args: string[], options: RunOptions = {}): Promise<RunResult> {
    const scope = options.auth && this.#token ? await this.#authScope() : undefined;
    const result = await this.#spawn(args, options, scope);
    return { ...result, stdout: result.stdout.toString("utf8") };
  }

  /**
   * Where the auth header applies (see {@link authConfigEnv}): GitHub `<server>` and the
   * remote's owner; GitLab the remote's own URL up to the project's namespace
   * ({@link remoteAuthScope}), else `<server>` and the namespace of the parsed repository.
   */
  async #authScope(): Promise<{ serverUrl: string; owner?: string }> {
    if (this.host === "gitlab") {
      const url = await this.#tryRemoteUrl();
      const scope = url === undefined ? undefined : remoteAuthScope(url);
      if (scope) return { serverUrl: scope };
      const namespace = (await this.repoFromRemote())?.split("/").slice(0, -1).join("/");
      return namespace
        ? { serverUrl: this.serverUrl, owner: namespace }
        : { serverUrl: this.serverUrl };
    }
    const owner = (await this.repoFromRemote())?.split("/")[0];
    return owner ? { serverUrl: this.serverUrl, owner } : { serverUrl: this.serverUrl };
  }

  /** Run git; stdout as bytes. Throws only when git can't be started. */
  #spawn(
    args: string[],
    options: RunOptions,
    /** Where the auth header applies (see {@link authConfigEnv}); undefined: no auth. */
    scope?: { serverUrl: string; owner?: string },
  ): Promise<{ stdout: Buffer; stderr: string; code: number }> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      LC_ALL: "C",
      LANGUAGE: "C",
      ...options.env,
    };
    // No hooks for launchset's own git work (see NO_HOOKS).
    Object.assign(env, configEnv([["core.hooksPath", NO_HOOKS]], env));
    if (options.auth && this.#token) {
      const { serverUrl, owner } = scope ?? { serverUrl: this.serverUrl };
      Object.assign(env, authConfigEnv(this.#token, serverUrl, env, owner, this.host));
    }
    const command = this.mask(`git ${args.join(" ")}`);
    return new Promise((resolve, reject) => {
      const child = execFile(
        "git",
        args,
        { cwd: this.cwd, env, maxBuffer: MAX_BUFFER, encoding: "buffer" },
        (error, stdout, stderrBytes) => {
          const stderr = stderrBytes?.toString("utf8") ?? "";
          if (error && typeof error.code !== "number") {
            const hint =
              error.code === "ENOENT"
                ? "Check that git is installed and on PATH, and that the working directory exists."
                : undefined;
            const message = `Could not run \`${command}\` in ${this.cwd}: ${this.mask(error.message)}`;
            reject(new GitError(message, command, stderr, undefined, hint));
            return;
          }
          const code = error ? (error.code as number) : 0;
          resolve({ stdout: stdout ?? Buffer.alloc(0), stderr, code });
        },
      );
      if (options.input !== undefined) child.stdin?.end(options.input);
    });
  }

  /** Run git and return stdout (trailing newlines trimmed unless `raw`). Throws {@link GitError}. */
  async run(args: string[], options: RunOptions = {}): Promise<string> {
    const result = await this.exec(args, options);
    if (result.code !== 0 && !(options.okCodes ?? []).includes(result.code)) {
      throw this.error(args, result);
    }
    return options.raw ? result.stdout : result.stdout.replace(/\n+$/, "");
  }

  /** Build a {@link GitError} for a failed command. */
  error(args: string[], result: RunResult, hint?: string): GitError {
    const command = this.mask(`git ${args.join(" ")}`);
    const stderr = this.mask(result.stderr.trim() || result.stdout.trim());
    const failure = classifyFailure(args, result.stderr || result.stdout, {
      host: this.host,
      hasToken: this.hasToken,
    });
    const finalHint = hint ?? failure.hint;
    const message = `\`${command}\` failed (exit code ${result.code}) in ${this.cwd}${stderr ? `: ${stderr}` : "."}`;
    return new GitError(message, command, stderr, result.code, finalHint, failure.reason);
  }

  // --- paths --------------------------------------------------------------------------

  /** `cwd` relative to the repo's top level, e.g. `apps/mobile/`, or `""` at the top. */
  async prefix(): Promise<string> {
    this.#prefix ??= this.run(["rev-parse", "--show-prefix"]);
    try {
      return await this.#prefix;
    } catch (error) {
      this.#prefix = undefined;
      throw error;
    }
  }

  /** Absolute path of the repo's top level. */
  async topLevel(): Promise<string> {
    return this.run(["rev-parse", "--show-toplevel"]);
  }

  /** Convert a path relative to `cwd` (the launchset config root) to a repo-relative one. */
  async toRepoPath(rootRelative: string): Promise<string> {
    const joined = posix.normalize(posix.join(await this.prefix(), rootRelative));
    if (joined === "." || joined.startsWith("../") || joined === "..") {
      throw new GitError(
        `Path "${rootRelative}" (relative to ${this.cwd}) is outside the git repository.`,
        "",
        "",
        undefined,
      );
    }
    return joined.replace(/\/$/, "");
  }

  /** Convert a repo-relative path to one relative to `cwd`; undefined when it's outside `cwd`. */
  async fromRepoPath(repoPath: string): Promise<string | undefined> {
    const prefix = await this.prefix();
    if (!prefix) return repoPath;
    return repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : undefined;
  }

  // --- refs and history ---------------------------------------------------------------

  async headSha(): Promise<string> {
    return this.revParse("HEAD");
  }

  /** Current branch name, or undefined on a detached HEAD. */
  async currentBranch(): Promise<string | undefined> {
    const out = await this.run(["symbolic-ref", "--quiet", "--short", "HEAD"], { okCodes: [1] });
    return out || undefined;
  }

  /** The commit sha `ref` points to (tags are peeled). Throws when it doesn't exist. */
  async revParse(ref: string): Promise<string> {
    const sha = await this.tryRevParse(ref);
    if (sha === undefined) {
      throw new GitError(
        `Unknown git ref "${ref}" in ${this.cwd}.`,
        `git rev-parse --verify ${ref}^{commit}`,
        "",
        1,
        classifyFailure([], "unknown revision", { host: this.host }).hint,
        "missing-object",
      );
    }
    return sha;
  }

  /** Like {@link revParse}, but undefined when the ref doesn't exist. */
  async tryRevParse(ref: string): Promise<string | undefined> {
    const out = await this.run(
      ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
      { okCodes: [1] },
    );
    return out || undefined;
  }

  /** True when `ancestor` is an ancestor of (or equal to) `descendant`. */
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const args = ["merge-base", "--is-ancestor", ancestor, descendant];
    const result = await this.exec(args);
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw this.error(args, result);
  }

  /** Parent shas of a commit, first parent first. Empty for a root commit. */
  async parents(sha: string): Promise<string[]> {
    return (await this.commitAndParents(sha)).slice(1);
  }

  /** The commit `ref` points to, then its parents (first parent first). */
  async commitAndParents(ref: string): Promise<string[]> {
    const out = await this.run(["rev-list", "--parents", "-n", "1", "--end-of-options", ref]);
    return out.split(" ").filter(Boolean);
  }

  /** The tree and the parents (first parent first) of a commit. */
  async treeAndParents(sha: string): Promise<{ tree: string; parents: string[] }> {
    const out = await this.run(["show", "-s", "--format=%T %P", "--end-of-options", sha, "--"]);
    const [tree = "", ...parents] = out.split(" ").filter(Boolean);
    return { tree, parents };
  }

  /** The best common ancestor of two commits, or undefined when they have none. */
  async mergeBase(a: string, b: string): Promise<string | undefined> {
    const args = ["merge-base", "--end-of-options", a, b];
    const result = await this.exec(args);
    const sha = result.stdout.trim();
    if (result.code === 0 && sha) return sha;
    if (result.code === 1) return undefined;
    throw this.error(args, result);
  }

  /** Commits on `ref`'s first-parent history, newest first. */
  async firstParentLog(ref: string, options: { limit?: number } = {}): Promise<string[]> {
    const args = ["rev-list", "--first-parent"];
    if (options.limit !== undefined) args.push(`--max-count=${options.limit}`);
    args.push("--end-of-options", ref);
    const out = await this.run(args);
    return out ? out.split("\n") : [];
  }

  /**
   * Commits in `range` (e.g. `v1.4.0..HEAD`, or a single ref for the whole history), newest
   * first. `paths` (repo-relative) limits it to commits that changed them; `ancestryPath`
   * keeps only descendants of the range's bottom.
   */
  async revList(
    range: string,
    options: { firstParent?: boolean; ancestryPath?: boolean; paths?: string[] } = {},
  ): Promise<string[]> {
    const args = ["rev-list"];
    if (options.firstParent) args.push("--first-parent");
    if (options.ancestryPath) args.push("--ancestry-path");
    args.push("--end-of-options", range);
    if (options.paths?.length) args.push("--", ...options.paths.map(topPathspec));
    const out = await this.run(args);
    return out ? out.split("\n") : [];
  }

  /** `git log` of `range` with subject and author, newest first. */
  async logRange(range: string, options: { firstParent?: boolean } = {}): Promise<LogEntry[]> {
    const args = ["log", "-z", "--format=%H%x1f%an%x1f%ae%x1f%s"];
    if (options.firstParent) args.push("--first-parent");
    args.push("--end-of-options", range, "--");
    const out = await this.run(args, { raw: true });
    return out
      .split(NUL)
      .map((record) => record.replace(/^\n/, ""))
      .filter(Boolean)
      .map((record) => {
        const [sha = "", author = "", authorEmail = "", subject = ""] = record.split("\x1f");
        return { sha, subject, author, authorEmail };
      });
  }

  /**
   * Commits that added the repo-relative `path` (newest first), following all parents like
   * plain `git log`. Used to find the commit that added a changeset (spec 12).
   */
  async commitsAddingFile(path: string, ref = "HEAD"): Promise<string[]> {
    const out = await this.run([
      "log",
      "--diff-filter=A",
      "--format=%H",
      "--end-of-options",
      ref,
      "--",
      topPathspec(path),
    ]);
    return out ? out.split("\n") : [];
  }

  /** Committer date of a commit as ISO 8601 (strict). */
  async commitDate(ref: string): Promise<string> {
    return this.run(["show", "-s", "--format=%cI", "--end-of-options", `${ref}^{commit}`, "--"]);
  }

  /** Content of `path` (repo-relative) at commit `sha`, or undefined when it doesn't exist. */
  async showFile(sha: string, path: string): Promise<string | undefined> {
    const listing = await this.run(["ls-tree", "-z", "--full-tree", sha, "--", path], {
      raw: true,
    });
    const entry = listing.split(NUL).find(Boolean);
    if (!entry) return undefined;
    const [meta = "", entryPath] = entry.split("\t");
    const [, type, oid] = meta.split(" ");
    if (type !== "blob" || entryPath !== path || !oid) return undefined;
    return this.run(["cat-file", "blob", oid], { raw: true });
  }

  /** The files (blobs) directly in the repo-relative `dir` at `ref`, sorted by path. */
  async listFiles(ref: string, dir: string): Promise<TreeFile[]> {
    const listing = await this.run(
      ["ls-tree", "-z", "--full-tree", "--end-of-options", ref, "--", `${dir.replace(/\/$/, "")}/`],
      { raw: true },
    );
    const files: TreeFile[] = [];
    for (const entry of listing.split(NUL)) {
      if (!entry) continue;
      const tab = entry.indexOf("\t");
      const [, type, blob] = entry.slice(0, tab).split(" ");
      if (type === "blob" && blob) files.push({ path: entry.slice(tab + 1), blob });
    }
    return files;
  }

  /**
   * Contents of objects (blob ids, or `<commit>:<path>`), read with one `git cat-file --batch`.
   * Objects that don't exist (or aren't blobs) are missing from the map.
   */
  async readBlobs(ids: Iterable<string>): Promise<Map<string, string>> {
    const wanted = [...new Set(ids)];
    const contents = new Map<string, string>();
    if (wanted.length === 0) return contents;
    const args = ["cat-file", "--batch"];
    const result = await this.#spawn(args, { input: `${wanted.join("\n")}\n` });
    if (result.code !== 0) throw this.error(args, { ...result, stdout: "" });
    const out = result.stdout;
    let pos = 0;
    for (const id of wanted) {
      const end = out.indexOf(10, pos);
      if (end === -1) throw new Error(`internal: truncated git cat-file output at ${id}`);
      const header = out.toString("utf8", pos, end);
      pos = end + 1;
      if (header.endsWith(" missing") || header.endsWith(" ambiguous")) continue;
      const [, type = "", size = ""] = header.split(" ");
      const length = Number(size);
      if (!Number.isInteger(length)) throw new Error(`internal: bad git cat-file header ${header}`);
      if (type === "blob") contents.set(id, out.toString("utf8", pos, pos + length));
      pos += length + 1;
    }
    return contents;
  }

  /**
   * Files changed on `head` since it diverged from `base` (`git diff base...head`), with
   * renames detected. Type changes count as `M`.
   */
  async changedFiles(base: string, head: string): Promise<ChangedFile[]> {
    const out = await this.run(
      [
        "diff",
        "--name-status",
        "-z",
        "--find-renames",
        "--no-ext-diff",
        "--no-relative",
        `${base}...${head}`,
        "--",
      ],
      { raw: true },
    );
    const parts = out.split(NUL);
    const files: ChangedFile[] = [];
    for (let i = 0; i < parts.length; ) {
      const code = parts[i++];
      if (!code) continue;
      const letter = code[0];
      if (letter === "R" || letter === "C") {
        const oldPath = parts[i++] ?? "";
        const path = parts[i++] ?? "";
        if (letter === "C") {
          files.push({ status: "A", path });
          continue;
        }
        const score = Number(code.slice(1));
        files.push({
          status: "R",
          path,
          oldPath,
          ...(code.length > 1 && Number.isInteger(score) ? { similarity: score } : {}),
        });
      } else {
        const path = parts[i++] ?? "";
        const status: FileStatus = letter === "A" ? "A" : letter === "D" ? "D" : "M";
        files.push({ status, path });
      }
    }
    return files;
  }

  // --- tags ---------------------------------------------------------------------------

  /** All local tags with the commit each points to, sorted by name. */
  async tags(): Promise<TagRef[]> {
    return this.#forEachTag([]);
  }

  /** Tags whose commit is reachable from `ref`. */
  async tagsMerged(ref: string): Promise<TagRef[]> {
    return this.#forEachTag([`--merged=${ref}`]);
  }

  async #forEachTag(extra: string[]): Promise<TagRef[]> {
    const out = await this.run([
      "for-each-ref",
      "--format=%(refname:strip=2)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)",
      ...extra,
      "refs/tags",
    ]);
    const tags: TagRef[] = [];
    for (const line of out.split("\n")) {
      if (!line) continue;
      const [name = "", objectname = "", type = "", peeled = "", peeledType = ""] = line.split(NUL);
      if (type === "commit") {
        tags.push({ name, sha: objectname });
      } else if (type === "tag" && peeledType === "commit") {
        tags.push({ name, sha: peeled });
      } else if (type === "tag") {
        // A tag of a tag: peel it fully. Tags of trees or blobs aren't commits and are skipped.
        const sha = await this.tryRevParse(`refs/tags/${name}`);
        if (sha) tags.push({ name, sha });
      }
    }
    return tags;
  }

  /** Fetch every tag from the remote, replacing local tags that differ. */
  async fetchTags(): Promise<void> {
    await this.run(["fetch", "--tags", "--force", "--quiet", this.remote], { auth: true });
  }

  /**
   * Fetch `source` from the remote into the local ref `tracking` (forced, no tags). Returns
   * false when the fetch fails; with `required`, throws the {@link GitError} instead.
   */
  async fetchRef(
    source: string,
    tracking: string,
    options: { required?: boolean } = {},
  ): Promise<boolean> {
    assertRefName("ref", source);
    assertRefName("ref", tracking);
    const args = ["fetch", "--quiet", "--no-tags", this.remote, `+${source}:${tracking}`];
    const result = await this.exec(args, { auth: true });
    if (result.code === 0) return true;
    if (options.required) throw this.error(args, result);
    return false;
  }

  /** Create a lightweight local tag. */
  async createTag(name: string, sha: string): Promise<void> {
    assertRefName("tag", name);
    await this.run(["tag", name, sha]);
  }

  async deleteLocalTag(name: string): Promise<void> {
    assertRefName("tag", name);
    await this.run(["tag", "-d", name]);
  }

  /**
   * Push a local tag. When the push fails, the remote is asked whether the tag now exists
   * (independent of git's wording): pointing elsewhere → {@link TagExistsError} (another run
   * pushed it first); pointing to our object → `up-to-date`. Otherwise the push error is
   * thrown.
   */
  async pushTag(name: string): Promise<PushResult> {
    assertRefName("tag", name);
    const ref = `refs/tags/${name}`;
    const args = ["push", "--porcelain", this.remote, `${ref}:${ref}`];
    // Hooks are off anyway (NO_HOOKS). This also tells git-lfs there's nothing to upload,
    // should its hook run: launchset's tags point at commits that are already on the remote.
    const result = await this.exec(args, { auth: true, env: { GIT_LFS_SKIP_PUSH: "1" } });
    const status = this.#pushStatus(result.stdout, ref);
    if (result.code === 0) return status ?? "created";

    const pushError = this.error(args, result);
    const lsArgs = ["ls-remote", "--tags", this.remote, ref];
    const ls = await this.exec(lsArgs, { auth: true });
    if (ls.code !== 0) {
      const lsError = this.error(lsArgs, ls);
      throw new GitError(
        `${pushError.message}\nAlso could not check whether the tag exists on the remote: ${lsError.message}`,
        pushError.command,
        pushError.stderr,
        pushError.exitCode,
        pushError.hint,
        pushError.reason,
      );
    }
    const remote = new Map<string, string>();
    for (const line of ls.stdout.split("\n")) {
      const [sha, refName] = line.trim().split("\t");
      if (sha && refName) remote.set(refName, sha);
    }
    const remoteObject = remote.get(ref);
    if (remoteObject === undefined) throw pushError;
    const ours = await this.run(["rev-parse", "--verify", "--end-of-options", ref]);
    if (remoteObject === ours) return "up-to-date";
    const output = this.mask(`${result.stdout.trim()}\n${result.stderr.trim()}`.trim());
    throw new TagExistsError(name, pushError.command, output, result.code);
  }

  /**
   * Create the local tag `name` at `sha` and push it ({@link pushTag}: `created`, or
   * `up-to-date` when the remote already has it at this commit; {@link TagExistsError} when it
   * has it elsewhere). A failed push removes the local tag again, so it never lingers; when
   * that fails too, a {@link TagCleanupError} carries both errors.
   */
  async createAndPushTag(name: string, sha: string): Promise<PushResult> {
    await this.createTag(name, sha);
    try {
      return await this.pushTag(name);
    } catch (error) {
      try {
        await this.deleteLocalTag(name);
      } catch (cleanup) {
        throw new TagCleanupError(name, error, cleanup);
      }
      throw error;
    }
  }

  /** Parse `git push --porcelain` output for one ref. */
  #pushStatus(stdout: string, ref: string): PushResult | undefined {
    for (const line of stdout.split("\n")) {
      const [flag, refs] = line.split("\t");
      if (!refs?.endsWith(`:${ref}`)) continue;
      if (flag === "=") return "up-to-date";
      if (flag === "*") return "created";
      if (flag === " " || flag === "+") return "updated";
    }
    return undefined;
  }

  // --- branches and commits -----------------------------------------------------------

  /** Check out `ref`: a branch, or (with `detach`) a commit. `force` discards local changes. */
  async checkout(ref: string, options: { detach?: boolean; force?: boolean } = {}): Promise<void> {
    assertRefName("ref", ref);
    const args = ["checkout", "--quiet"];
    if (options.force) args.push("--force");
    if (options.detach) args.push("--detach");
    await this.run([...args, ref]);
  }

  /** Create branch `name` at `sha` without checking it out (no upstream). */
  async createBranch(name: string, sha: string): Promise<void> {
    assertRefName("branch", name);
    assertRefName("commit", sha);
    await this.run(["branch", "--no-track", name, sha]);
  }

  /** Create (or reset) branch `name` at `startPoint` and check it out. */
  async checkoutNewBranch(name: string, startPoint: string): Promise<void> {
    assertRefName("branch", name);
    await this.run(["checkout", "--quiet", "--no-track", "-B", name, startPoint]);
  }

  /**
   * Stage the repo-relative `paths` (new, modified and deleted files) and commit them as
   * launchset. Returns the new commit sha.
   */
  async commitAll(message: string, paths: string[]): Promise<string> {
    if (paths.length) await this.run(["add", "--all", "--", ...paths.map(topPathspec)]);
    return this.#commit(message);
  }

  /**
   * Stage `add` paths, remove `remove` paths (from the index and the working tree), and
   * commit as launchset. Paths are repo-relative. Returns the new commit sha.
   */
  async commit(
    message: string,
    options: { add?: string[]; remove?: string[] } = {},
  ): Promise<string> {
    if (options.remove?.length) {
      await this.run(["rm", "--quiet", "-r", "--", ...options.remove.map(topPathspec)]);
    }
    if (options.add?.length) {
      await this.run(["add", "--all", "--", ...options.add.map(topPathspec)]);
    }
    return this.#commit(message);
  }

  async #commit(message: string): Promise<string> {
    const { name, email } = await this.identity();
    await this.run(
      ["-c", "commit.gpgsign=false", "commit", "--quiet", "--no-verify", "-m", message],
      {
        env: {
          GIT_AUTHOR_NAME: name,
          GIT_AUTHOR_EMAIL: email,
          GIT_COMMITTER_NAME: name,
          GIT_COMMITTER_EMAIL: email,
        },
      },
    );
    return this.headSha();
  }

  /** Push local branch `name` to the remote branch of the same name. */
  /**
   * Push the local branch `name`. `force` overwrites; `expect` (a sha, or `null` for "the
   * remote has no such branch") makes it a `--force-with-lease` push that throws `LeaseError`
   * when the remote branch is no longer at that commit.
   */
  async pushBranch(
    name: string,
    options: { force?: boolean; expect?: string | null } = {},
  ): Promise<PushResult> {
    assertRefName("branch", name);
    const ref = `refs/heads/${name}`;
    const args = ["push", "--porcelain"];
    if (options.expect !== undefined) {
      if (options.expect !== null) assertRefName("commit", options.expect);
      args.push(`--force-with-lease=${ref}:${options.expect ?? ""}`);
    } else if (options.force) {
      args.push("--force");
    }
    args.push(this.remote, `${ref}:${ref}`);
    const result = await this.exec(args, { auth: true });
    if (result.code !== 0) {
      if (
        options.expect !== undefined &&
        /stale info|fetch first/.test(`${result.stdout}\n${result.stderr}`)
      ) {
        throw new LeaseError(name, ["git", ...args].join(" "), result.stderr, result.code);
      }
      throw this.error(args, result);
    }
    return this.#pushStatus(result.stdout, ref) ?? "updated";
  }

  /** Push commit `sha` to the remote ref `ref` (e.g. `refs/heads/release/1.4.x`). */
  async pushRef(sha: string, ref: string, options: { force?: boolean } = {}): Promise<PushResult> {
    assertRefName("commit", sha);
    assertRefName("ref", ref);
    const args = ["push", "--porcelain"];
    if (options.force) args.push("--force");
    args.push(this.remote, `${sha}:${ref}`);
    const result = await this.exec(args, { auth: true });
    if (result.code !== 0) throw this.error(args, result);
    return this.#pushStatus(result.stdout, ref) ?? "updated";
  }

  /** True when the remote has branch `name`. */
  async remoteBranchExists(name: string): Promise<boolean> {
    const args = ["ls-remote", "--exit-code", "--heads", this.remote, `refs/heads/${name}`];
    const result = await this.exec(args, { auth: true });
    if (result.code === 0) return result.stdout.trim().length > 0;
    if (result.code === 2) return false;
    throw this.error(args, result);
  }

  /**
   * True when the working tree and index have no changes (untracked files count, except
   * `ownFiles`).
   */
  async isClean(): Promise<boolean> {
    const excluded: string[] = [];
    for (const file of this.#ownFiles) {
      try {
        const path = await this.toRepoPath(relative(this.cwd, file).split(sep).join("/"));
        excluded.push(`:(top,exclude,literal)${path}`);
      } catch {
        // Outside the repository: git never lists it.
      }
    }
    const pathspecs = excluded.length > 0 ? ["--", ":(top)", ...excluded] : [];
    const out = await this.run(["status", "--porcelain", "-z", ...pathspecs], { raw: true });
    return out.length === 0;
  }

  // --- remote -------------------------------------------------------------------------

  /** The remote's URL. Throws when there is no such remote. Cached once found. */
  async remoteUrl(): Promise<string> {
    if (this.#remoteUrl !== undefined) return this.#remoteUrl;
    const args = ["remote", "get-url", this.remote];
    const result = await this.exec(args);
    if (result.code !== 0) throw this.error(args, result);
    this.#remoteUrl = result.stdout.trim();
    return this.#remoteUrl;
  }

  /** True when the repo has the remote launchset pushes to (`origin`). */
  async hasRemote(): Promise<boolean> {
    return (await this.#tryRemoteUrl()) !== undefined;
  }

  /** Full repository path of the remote when it's a URL on this host, else undefined. */
  async repoFromRemote(): Promise<string | undefined> {
    const url = await this.#tryRemoteUrl();
    return url === undefined ? undefined : parseRepoFromRemote(url, this.serverUrl, this.host);
  }

  /** The remote URL, or undefined without the remote (not cached then: one may be added). */
  async #tryRemoteUrl(): Promise<string | undefined> {
    try {
      return await this.remoteUrl();
    } catch (error) {
      if (error instanceof GitError && error.exitCode !== undefined) return undefined;
      throw error;
    }
  }
}
