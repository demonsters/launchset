/**
 * Links and words that differ per code host (GitHub, GitLab): PR / MR URLs and their text,
 * the PR head ref, CI run URLs and what a release is called. Pure.
 */

/** The code hosts launchset knows. */
export type ForgeHost = "github" | "gitlab";

/** Every host, for validation and messages. */
export const FORGE_HOSTS: readonly ForgeHost[] = ["github", "gitlab"];

/** The host's server when none is configured. */
export const DEFAULT_SERVER_URLS: Readonly<Record<ForgeHost, string>> = {
  github: "https://github.com",
  gitlab: "https://gitlab.com",
};

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
}

/** The words of `host` (default GitHub). */
export function forgeWords(host: ForgeHost = "github"): ForgeWords {
  if (host === "gitlab") {
    return {
      host,
      prText: (n) => `!${n}`,
      prRef: (n) => `refs/merge-requests/${n}/head`,
      prName: "MR",
      releaseName: "GitLab release",
      prereleaseName: "GitLab release",
    };
  }
  return {
    host,
    prText: (n) => `#${n}`,
    prRef: (n) => `refs/pull/${n}/head`,
    prName: "PR",
    releaseName: "GitHub Release",
    prereleaseName: "GitHub pre-release",
  };
}

/** Links into `repository` on `host` (default GitHub). */
export function forgeLinks(input: ForgeLinksInput): ForgeLinks {
  const words = forgeWords(input.host);
  const serverUrl = (input.serverUrl || DEFAULT_SERVER_URLS[words.host]).replace(/\/+$/, "");
  const repoUrl = `${serverUrl}/${input.repository}`;
  const gitlab = words.host === "gitlab";
  return {
    ...words,
    serverUrl,
    repository: input.repository,
    prUrl: (n) => (gitlab ? `${repoUrl}/-/merge_requests/${n}` : `${repoUrl}/pull/${n}`),
    runUrl: (id) => (gitlab ? `${repoUrl}/-/pipelines/${id}` : `${repoUrl}/actions/runs/${id}`),
  };
}
