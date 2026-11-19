/**
 * Shared context for the I/O layer (src/flow): the loaded config, git, the forge client, the
 * CI environment and a logger. The CLI and the action build one of these and call flow
 * functions with it; flow functions never read `process` directly.
 */

import { loadConfig } from "../config/load.ts";
import type { ResolvedConfig } from "../core/config/schema.ts";
import { LaunchsetError } from "../core/errors.ts";
import { forgeHints } from "../core/forge-hints.ts";
import { type ForgeHost, forgeLinks } from "../core/forge-links.ts";
import type { RunInfo } from "../core/types.ts";
import { createGitHub } from "../forge/github/index.ts";
import { createGitLab, fallbackIdentity, serverHostOf } from "../forge/gitlab/index.ts";
import type { Forge } from "../forge/types.ts";
import { Git, type GitIdentity } from "../git/index.ts";
import {
  type CiEnvironment,
  detectHost,
  readCiEnvironment,
  serverUrlFromRemote,
} from "./ci/index.ts";

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, debug() {} };

/** `refs/heads/main` → `main`; anything else → undefined. */
export function branchFromRef(ref: string | undefined): string | undefined {
  return ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined;
}

export interface FlowContext {
  /** Config root (the directory with `launchset.config.*`; the action's `working-directory`). */
  cwd: string;
  config: ResolvedConfig;
  configFile: string;
  git: Git;
  /** The code host (`ci.host`). */
  host: ForgeHost;
  /** Set when a token and the repository are known. Commands that need it call `requireForge`. */
  forge?: Forge;
  /**
   * A read-only fallback client, when its token isn't `token` (on GitHub: the workflow's own
   * `GITHUB_TOKEN` next to the App token), for reads the main token may lack permission for
   * (the run's jobs).
   */
  fallbackForge?: Forge;
  token?: string;
  /** Full repository path (`owner/repo`). */
  repository?: string;
  /** `https://github.com`, `https://gitlab.com` or the self-hosted URL, without trailing slash. */
  serverUrl: string;
  env: Record<string, string | undefined>;
  /** The CI environment (event, ref, sha, run); mostly empty outside CI. */
  ci: CiEnvironment;
  /** The run (from `ci.run`, with its URL, and `ContextOptions.run` applied). */
  run?: RunInfo;
  now: Date;
  log: Logger;
}

export interface ContextOptions {
  cwd: string;
  token?: string;
  repository?: string;
  env?: Record<string, string | undefined>;
  now?: Date;
  log?: Logger;
  /** Overrides the run info from the environment (`plan --run-number`). */
  run?: RunInfo;
  /**
   * Files launchset writes or receives in this run (absolute paths: the CLI's `--ci` files).
   * They don't make the working tree dirty for the commands that need a clean one.
   */
  ownFiles?: readonly string[];
}

/** The origin remote's URL at `root`, or undefined (no repo, no remote). */
async function originUrl(root: string): Promise<string | undefined> {
  return new Git({ cwd: root }).remoteUrl().catch(() => undefined);
}

/** Load the config and set up git, the forge client and the CI environment. */
export async function createContext(options: ContextOptions): Promise<FlowContext> {
  const env = options.env ?? process.env;
  const log = options.log ?? silentLogger;
  const { config, file, root } = await loadConfig(options.cwd);
  let remote: Promise<string | undefined> | undefined;
  const origin = () => (remote ??= originUrl(root));
  const detected = await detectHost(env, origin);
  const { host } = detected;
  const ci = await readCiEnvironment(host, env);
  if (host === "gitlab" && !env.CI_SERVER_URL) {
    // Outside GitLab CI (a local `launchset status`), a self-managed server is the remote's.
    const url = await origin();
    const fromRemote = url === undefined ? undefined : serverUrlFromRemote(url);
    if (fromRemote) {
      ci.serverUrl = fromRemote;
      if (!env.CI_API_V4_URL) ci.apiUrl = `${fromRemote}/api/v4`;
    }
  }
  const { serverUrl } = ci;
  const token = options.token || ci.token || undefined;
  // GitLab: launchset commits as the token's own user (push rules may reject unknown
  // authors), looked up only when something is committed.
  const commitHost = env.CI_SERVER_HOST?.trim() || serverHostOf(serverUrl);
  let commitForge: Forge | undefined;
  const identity =
    host === "gitlab"
      ? async (): Promise<GitIdentity> =>
          (await commitForge?.identity?.()) ?? fallbackIdentity(commitHost)
      : undefined;
  const git = new Git({
    cwd: root,
    ...(token ? { token } : {}),
    serverUrl,
    host,
    ...(identity ? { identity } : {}),
    ...(options.ownFiles?.length ? { ownFiles: options.ownFiles } : {}),
  });
  let repository = options.repository || ci.repository || undefined;
  if (!repository) repository = (await git.repoFromRemote().catch(() => undefined)) ?? undefined;
  const client = (clientToken: string | undefined, kind?: "job") => {
    if (!clientToken || !repository) return undefined;
    if (host === "gitlab") {
      return createGitLab({
        token: clientToken,
        ...(kind ? { tokenKind: kind } : {}),
        repository,
        ...(ci.apiUrl ? { apiUrl: ci.apiUrl } : {}),
        serverUrl,
        commitHost,
        log,
      });
    }
    return createGitHub({
      token: clientToken,
      repository,
      ...(ci.apiUrl ? { apiUrl: ci.apiUrl } : {}),
      log,
    });
  };
  const fallback = () => client(ci.fallbackToken, ci.fallbackTokenKind);
  // Without a token of our own, the fallback (GitLab: CI_JOB_TOKEN) still serves the reads it
  // can do; its writes fail with a hint to set LAUNCHSET_TOKEN.
  const forge = client(token) ?? (token ? undefined : fallback());
  const fallbackForge = token && ci.fallbackToken !== token ? fallback() : undefined;
  commitForge = forge;
  const context: FlowContext = {
    cwd: root,
    config,
    configFile: file,
    git,
    host,
    serverUrl,
    env,
    ci,
    now: options.now ?? new Date(),
    log,
  };
  if (forge) context.forge = forge;
  if (fallbackForge) context.fallbackForge = fallbackForge;
  if (token) context.token = token;
  if (repository) context.repository = repository;
  const fromEnv = ci.run ? { ...ci.run } : undefined;
  if (fromEnv?.id !== undefined && repository) {
    fromEnv.url = forgeLinks({ host, serverUrl, repository }).runUrl(fromEnv.id);
  }
  const run = options.run ? { ...fromEnv, ...options.run } : fromEnv;
  if (run) context.run = run;
  return context;
}

/** The forge client, or a clear error saying a token is needed. */
export function requireForge(context: FlowContext, what: string): Forge {
  if (context.forge) return context.forge;
  const hints = forgeHints(context.host);
  throw new LaunchsetError(
    context.host === "gitlab" ? "no-gitlab-token" : "no-github-token",
    `${what} ${hints.tokenNeeded}`,
    { hint: hints.tokenHint(Boolean(context.repository)) },
  );
}

/**
 * Result of a flow command: action outputs, the job summary (markdown), human-readable
 * lines for the terminal, JSON for `--json`, and whether the command failed.
 */
export interface FlowResult<Data = unknown> {
  ok: boolean;
  outputs: Record<string, string>;
  summary: string;
  lines: string[];
  data: Data;
  /**
   * Environment variables for later steps (`LAUNCHSET_VERSION`, `LAUNCHSET_BUILD_NUMBER`,
   * `LAUNCHSET_CHANNEL`, spec 6.5); the action exports them. Set by `stamp` and `ship`.
   */
  env?: Record<string, string>;
}
