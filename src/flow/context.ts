/**
 * Shared context for the I/O layer (src/flow): the loaded config, git, the forge client, the
 * CI environment and a logger. The CLI and the action build one of these and call flow
 * functions with it; flow functions never read `process` directly.
 */

import { loadConfig } from "../config/load.ts";
import type { ResolvedConfig } from "../core/config/schema.ts";
import { LaunchsetError } from "../core/errors.ts";
import { type ForgeHost, forgeLinks } from "../core/forge-links.ts";
import type { RunInfo } from "../core/types.ts";
import { createGitHub } from "../forge/github/index.ts";
import type { Forge } from "../forge/types.ts";
import { Git } from "../git/index.ts";
import { type CiEnvironment, detectHost, readCiEnvironment } from "./ci/index.ts";

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
  /** `https://github.com` (or the GHES URL), without trailing slash. */
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
  const detected = await detectHost(env, () => originUrl(root));
  let host = detected.host;
  if (host === "gitlab" && detected.source === "remote") {
    log.debug(
      "The remote looks like GitLab, but GitLab support is not available yet: using GitHub.",
    );
    host = "github";
  }
  const ci = await readCiEnvironment(host, env);
  const { serverUrl } = ci;
  const token = options.token || ci.token || undefined;
  const git = new Git({ cwd: root, ...(token ? { token } : {}), serverUrl });
  let repository = options.repository || ci.repository || undefined;
  if (!repository) repository = (await git.repoFromRemote().catch(() => undefined)) ?? undefined;
  const client = (clientToken: string | undefined) =>
    clientToken && repository
      ? createGitHub({
          token: clientToken,
          repository,
          ...(ci.apiUrl ? { apiUrl: ci.apiUrl } : {}),
          log,
        })
      : undefined;
  const forge = client(token);
  const fallbackForge = ci.fallbackToken !== token ? client(ci.fallbackToken) : undefined;
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
  throw new LaunchsetError("no-github-token", `${what} needs a GitHub token and the repository.`, {
    hint: context.repository
      ? "Pass --token or set GITHUB_TOKEN (in workflows: the GitHub App token)."
      : "Pass --token and --repo owner/repo, or set GITHUB_TOKEN and GITHUB_REPOSITORY.",
  });
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
