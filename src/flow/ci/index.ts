/**
 * Which code host launchset runs against, and the CI environment adapter for it (see
 * design/GITLAB.md).
 */

import { LaunchsetError } from "../../core/errors.ts";
import {
  CI_DETECTION_ORDER,
  type CiFlag,
  DEFAULT_HOST,
  FORGE_HOSTS,
  type ForgeHost,
  HOSTS,
  isForgeHost,
} from "../../core/hosts.ts";
import { readGitHubEnvironment } from "./github.ts";
import { gitlabEnvironment } from "./gitlab.ts";
import type { CiEnvironment, Env } from "./types.ts";

export * from "./github.ts";
export * from "./gitlab.ts";
export * from "./types.ts";

/**
 * How the host was found, for messages: `LAUNCHSET_HOST`, the CI flag of the host
 * (`GITLAB_CI`, `GITHUB_ACTIONS`), the origin `remote`, or the `default` host.
 */
export type HostSource = "LAUNCHSET_HOST" | CiFlag | "remote" | "default";

export interface HostDetection {
  host: ForgeHost;
  source: HostSource;
}

/** The host name of a git remote URL (https, ssh, scp-like `git@host:path`), lowercased. */
export function remoteHost(url: string): string | undefined {
  const trimmed = url.trim();
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)/.exec(trimmed);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return scp[1]?.toLowerCase();
  try {
    return new URL(trimmed).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The web server of a git remote, for a GitLab detected from the remote outside CI:
 * `https://host[:port]` for https/http remotes (http stays http), `https://host` for ssh and
 * scp-like remotes (their port is the ssh port). Undefined for local paths and unparsable URLs.
 */
export function serverUrlFromRemote(url: string): string | undefined {
  const trimmed = url.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        return parsed.host ? `${parsed.protocol}//${parsed.host}` : undefined;
      }
      if (parsed.protocol === "ssh:" || parsed.protocol === "git:") {
        return parsed.hostname ? `https://${parsed.hostname}` : undefined;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
  const host = remoteHost(trimmed);
  return host ? `https://${host}` : undefined;
}

/**
 * The host from the environment alone: `LAUNCHSET_HOST` (`github` / `gitlab`, anything else
 * is an error), else `GITLAB_CI=true` → gitlab, else `GITHUB_ACTIONS=true` → github.
 */
export function hostFromEnv(env: Env): HostDetection | undefined {
  const explicit = env.LAUNCHSET_HOST?.trim();
  if (explicit) {
    const host = explicit.toLowerCase();
    if (!isForgeHost(host)) {
      throw new LaunchsetError(
        "invalid-host",
        `LAUNCHSET_HOST is "${explicit}", expected ${FORGE_HOSTS.map((h) => `"${h}"`).join(" or ")}`,
        { hint: "Unset LAUNCHSET_HOST to detect the host from the CI environment and the remote." },
      );
    }
    return { host, source: "LAUNCHSET_HOST" };
  }
  for (const host of CI_DETECTION_ORDER) {
    const flag = HOSTS[host].ciFlag;
    if (env[flag] === "true") return { host, source: flag };
  }
  return undefined;
}

/**
 * The code host: {@link hostFromEnv}, else from the origin remote's host name (one that
 * contains `gitlab`, like `gitlab.com` or `gitlab.acme.dev`, is GitLab), else GitHub.
 * `remoteUrl` is only called when the environment doesn't decide.
 */
export async function detectHost(
  env: Env,
  remoteUrl?: () => Promise<string | undefined>,
): Promise<HostDetection> {
  const fromEnv = hostFromEnv(env);
  if (fromEnv) return fromEnv;
  const url = await remoteUrl?.().catch(() => undefined);
  const hostname = url === undefined ? undefined : remoteHost(url);
  const host = hostname ? hostFromRemoteName(hostname) : undefined;
  if (host) return { host, source: "remote" };
  return { host: DEFAULT_HOST, source: "default" };
}

/** The host a remote's host name says the repo is on (`gitlab.acme.dev`), if any. */
export function hostFromRemoteName(hostname: string): ForgeHost | undefined {
  return FORGE_HOSTS.find((host) => HOSTS[host].remoteMatches?.(hostname));
}

/** The CI environment readers, per host. */
const ENVIRONMENTS: Readonly<
  Record<ForgeHost, (env: Env) => CiEnvironment | Promise<CiEnvironment>>
> = { github: readGitHubEnvironment, gitlab: gitlabEnvironment };

/** Read the CI environment of `host`. */
export async function readCiEnvironment(host: ForgeHost, env: Env): Promise<CiEnvironment> {
  return ENVIRONMENTS[host](env);
}
