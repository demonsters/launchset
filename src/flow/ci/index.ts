/**
 * Which code host launchset runs against, and the CI environment adapter for it (see
 * design/GITLAB.md).
 */

import { LaunchsetError } from "../../core/errors.ts";
import { FORGE_HOSTS, type ForgeHost } from "../../core/forge-links.ts";
import { readGitHubEnvironment } from "./github.ts";
import { gitlabEnvironment } from "./gitlab.ts";
import type { CiEnvironment, Env } from "./types.ts";

export * from "./github.ts";
export * from "./gitlab.ts";
export * from "./types.ts";

/** How the host was found, for messages. */
export type HostSource = "LAUNCHSET_HOST" | "GITLAB_CI" | "GITHUB_ACTIONS" | "remote" | "default";

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
    if (!(FORGE_HOSTS as readonly string[]).includes(host)) {
      throw new LaunchsetError(
        "invalid-host",
        `LAUNCHSET_HOST is "${explicit}", expected ${FORGE_HOSTS.map((h) => `"${h}"`).join(" or ")}`,
        { hint: "Unset LAUNCHSET_HOST to detect the host from the CI environment and the remote." },
      );
    }
    return { host: host as ForgeHost, source: "LAUNCHSET_HOST" };
  }
  if (env.GITLAB_CI === "true") return { host: "gitlab", source: "GITLAB_CI" };
  if (env.GITHUB_ACTIONS === "true") return { host: "github", source: "GITHUB_ACTIONS" };
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
  const host = url === undefined ? undefined : remoteHost(url);
  if (host?.includes("gitlab")) return { host: "gitlab", source: "remote" };
  return { host: "github", source: "default" };
}

/** Read the CI environment of `host`. */
export async function readCiEnvironment(host: ForgeHost, env: Env): Promise<CiEnvironment> {
  return host === "gitlab" ? gitlabEnvironment(env) : readGitHubEnvironment(env);
}
