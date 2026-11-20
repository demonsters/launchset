/**
 * Links and words that differ per code host (GitHub, GitLab): PR / MR URLs and their text,
 * the PR head ref, CI run URLs and what a release is called, all read from the host's
 * {@link HostProfile}. Pure.
 */

import {
  type CiSystem,
  ciProfile,
  DEFAULT_HOST,
  FORGE_HOSTS,
  type ForgeHost,
  HOSTS,
  hostProfile,
} from "./hosts.ts";

export { FORGE_HOSTS, type ForgeHost };

/** The host's server when none is configured. */
export const DEFAULT_SERVER_URLS: Readonly<Record<ForgeHost, string>> = Object.fromEntries(
  FORGE_HOSTS.map((host) => [host, HOSTS[host].defaultServerUrl]),
) as Record<ForgeHost, string>;

/** Words and refs of a host; no repository needed. */
export interface ForgeWords {
  host: ForgeHost;
  /** `#12` (GitHub) or `!12` (GitLab). */
  prText(number: number): string;
  /** The ref a PR's head can be fetched from: `refs/pull/12/head`, `refs/merge-requests/12/head`. */
  prRef(number: number): string;
  /** `PR` or `MR`. */
  prName: string;
  /** `GitHub Release` or `GitLab release`. */
  releaseName: string;
  /**
   * What the release of a prerelease tag is: `GitHub pre-release`, or `GitLab release` (GitLab
   * has no pre-release flag: it's a release whose version is a prerelease).
   */
  prereleaseName: string;
}

/** {@link ForgeWords} plus URLs into one repository. */
export interface ForgeLinks extends ForgeWords {
  /** Server URL without trailing slash. */
  serverUrl: string;
  /** Full repository path (`owner/repo`, or `group/sub/project` on GitLab). */
  repository: string;
  /** `https://github.com/acme/app/pull/12`, `https://gitlab.com/acme/app/-/merge_requests/12`. */
  prUrl(number: number): string;
  /** `https://github.com/acme/app/actions/runs/7`, `https://gitlab.com/acme/app/-/pipelines/7`. */
  runUrl(id: number): string;
}

export interface ForgeLinksInput {
  /** Default `github`. */
  host?: ForgeHost;
  /** Default the host's public server ({@link DEFAULT_SERVER_URLS}); trailing slashes are dropped. */
  serverUrl?: string;
  repository: string;
  /** The CI system whose run URLs `runUrl` gives (default the host's own). */
  ci?: CiSystem;
}

/** The words of `host` (default GitHub). */
export function forgeWords(host: ForgeHost = DEFAULT_HOST): ForgeWords {
  const profile = hostProfile(host);
  return {
    host,
    prText: (n) => `${profile.prSymbol}${n}`,
    prRef: profile.prRef,
    prName: profile.prName,
    releaseName: profile.releaseName,
    prereleaseName: profile.prereleaseName,
  };
}

/** Links into `repository` on `host` (default GitHub). */
export function forgeLinks(input: ForgeLinksInput): ForgeLinks {
  const words = forgeWords(input.host);
  const profile = hostProfile(words.host);
  const serverUrl = (input.serverUrl || profile.defaultServerUrl).replace(/\/+$/, "");
  const repoUrl = `${serverUrl}/${input.repository}`;
  return {
    ...words,
    serverUrl,
    repository: input.repository,
    prUrl: (n) => `${repoUrl}/${profile.prPath(n)}`,
    runUrl: (id) => `${repoUrl}/${ciProfile(input.ci ?? profile.ci).runPath(id)}`,
  };
}
