/**
 * The run-time side of each code host: how its API client is made, and what `createContext`
 * does differently for it (its CI environment is read by `readCiEnvironment`).
 * What the hosts' behaviour differs in is in `core/hosts.ts`; this table holds the code that
 * talks to them. A `Record`, so a host added there must get an adapter here.
 */

import type { ForgeHost } from "../core/hosts.ts";
import { createGitHub } from "../forge/github/index.ts";
import { createGitLab, fallbackIdentity, serverHostOf } from "../forge/gitlab/index.ts";
import type { Forge } from "../forge/types.ts";
import type { GitIdentity } from "../git/index.ts";
import { type CiEnvironment, type Env, serverUrlFromRemote } from "./ci/index.ts";
import type { Logger } from "./context.ts";

/** What every API client is made from; each host uses the fields it needs. */
export interface ForgeClientInput {
  token: string;
  /** What the token is: `job` is a CI job token (GitLab's `CI_JOB_TOKEN`). */
  tokenKind?: "job";
  repository: string;
  apiUrl?: string;
  serverUrl: string;
  /** The host name for the fallback commit identity ({@link HostAdapter.commitIdentity}). */
  commitHost?: string;
  log: Logger;
}

export interface HostAdapter {
  createForge(input: ForgeClientInput): Forge;
  /**
   * Outside the host's CI, take the server from the origin remote (a self-managed server), on
   * `ci` in place. Unset: the CI environment or the public server decides.
   */
  serverFromRemote?(
    ci: CiEnvironment,
    env: Env,
    remoteUrl: () => Promise<string | undefined>,
  ): Promise<void>;
  /**
   * launchset commits as the token's own user, looked up through the API (push rules may
   * reject unknown authors), with a fallback identity on `host`. Unset: it commits as its bot.
   */
  commitIdentity?: {
    host(env: Env, serverUrl: string): string;
    fallback(host: string): GitIdentity;
  };
}

export const HOST_ADAPTERS: Readonly<Record<ForgeHost, HostAdapter>> = {
  github: {
    createForge: (input) =>
      createGitHub({
        token: input.token,
        repository: input.repository,
        ...(input.apiUrl ? { apiUrl: input.apiUrl } : {}),
        log: input.log,
      }),
  },
  gitlab: {
    createForge: (input) =>
      createGitLab({
        token: input.token,
        ...(input.tokenKind ? { tokenKind: input.tokenKind } : {}),
        repository: input.repository,
        ...(input.apiUrl ? { apiUrl: input.apiUrl } : {}),
        serverUrl: input.serverUrl,
        ...(input.commitHost ? { commitHost: input.commitHost } : {}),
        log: input.log,
      }),
    async serverFromRemote(ci, env, remoteUrl) {
      // Outside GitLab CI (a local `launchset status`), a self-managed server is the remote's.
      if (env.CI_SERVER_URL) return;
      const url = await remoteUrl();
      const fromRemote = url === undefined ? undefined : serverUrlFromRemote(url);
      if (!fromRemote) return;
      ci.serverUrl = fromRemote;
      if (!env.CI_API_V4_URL) ci.apiUrl = `${fromRemote}/api/v4`;
    },
    commitIdentity: {
      host: (env, serverUrl) => env.CI_SERVER_HOST?.trim() || serverHostOf(serverUrl),
      fallback: fallbackIdentity,
    },
  },
};
