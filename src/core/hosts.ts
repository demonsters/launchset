/**
 * The code hosts launchset knows, and what differs between them, in one table. Code that
 * behaves differently per host asks for a trait of the host's {@link HostProfile} (does it
 * have a pre-release flag, which CI system runs its pipelines) instead of comparing host names,
 * so a new host (Forgejo, Gitea) is one more entry here plus its adapters, not another branch in
 * every module. Texts per host live in tables keyed by {@link ForgeHost} too
 * (`forge-hints.ts`), so the compiler lists everything a new host must fill in. Pure.
 *
 * What a new host needs is listed in design/GITLAB.md ("More hosts").
 */

/** Every host launchset knows, for validation and messages. */
export const FORGE_HOSTS = ["github", "gitlab"] as const;

/** The code hosts launchset knows. */
export type ForgeHost = (typeof FORGE_HOSTS)[number];

/** The host when nothing says otherwise (no CI environment, no recognised remote). */
export const DEFAULT_HOST: ForgeHost = "github";

/**
 * The CI system a host's pipelines run on. It decides the files `init` writes, how build jobs
 * are named and whether a child pipeline is generated. `actions`: GitHub Actions workflows
 * (the CI of Forgejo and Gitea runs these too). `gitlab-ci`: `.gitlab-ci.yml` pipelines.
 */
export type CiSystem = "actions" | "gitlab-ci";

/** The environment variable a host's CI sets to `true`. */
export type CiFlag = "GITHUB_ACTIONS" | "GITLAB_CI";

export interface HostProfile {
  host: ForgeHost;
  /** The product, for messages: `GitHub`, `GitLab`. */
  name: string;
  /** The public server, used when none is configured. */
  defaultServerUrl: string;
  ci: CiSystem;
  /** The environment variable the host's CI sets to `true` (`GITHUB_ACTIONS`, `GITLAB_CI`). */
  ciFlag: CiFlag;
  /**
   * True when the origin remote's host name says the repo is on this host (`gitlab.acme.dev`).
   * Unset for the default host, which needs no evidence.
   */
  remoteMatches?: (hostname: string) => boolean;

  /** `#` (`#12`) or `!` (`!12`). */
  prSymbol: string;
  /** `PR` or `MR`. */
  prName: string;
  /** The ref a PR's head can be fetched from: `refs/pull/12/head`, `refs/merge-requests/12/head`. */
  prRef(number: number): string;
  /** The web path of a PR, below the repository URL: `pull/12`, `-/merge_requests/12`. */
  prPath(number: number): string;
  /** The web path of a CI run, below the repository URL: `actions/runs/7`, `-/pipelines/7`. */
  runPath(id: number): string;
  /** `GitHub Release` or `GitLab release`. */
  releaseName: string;
  /** What the release of a prerelease tag is called (`GitHub pre-release`, `GitLab release`). */
  prereleaseName: string;
  /** The release of a tag, after the tag: `the v1.2.0 Release`, `the v1.2.0 GitLab release`. */
  releaseOfTag: string;
  /** A release as a plain noun (`tags and Releases`, `tags and releases`). */
  releaseNoun: string;

  /**
   * Releases have a pre-release flag. Without one (GitLab), the release of a prerelease tag is
   * an ordinary release whose version is a prerelease.
   */
  prereleaseFlag: boolean;
  /**
   * A release can be marked latest (GitHub `make_latest`). Without it the host picks the newest
   * release by date, so launchset creates the release that should be latest last.
   */
  latestFlag: boolean;
  /** Markdown alerts are written lowercase (`> [!note]`, GitLab) instead of `> [!NOTE]`. */
  lowercaseAlerts: boolean;
  /**
   * Adding a label to a PR starts a CI run (GitHub's pull_request `labeled`). Without it, a
   * labelled PR only gets its preview on the next pipeline, or from `launchset preview-sweep`.
   */
  labelEvents: boolean;
  /** Repository paths may nest (`group/sub/project`), not only `owner/repo`. */
  nestedRepositories: boolean;
  /**
   * Remotes of a self-managed server need care: the server may sit below a relative URL root
   * (`https://host/gitlab/`), and its ssh remotes use the bare host name (the ssh port isn't the
   * web port).
   */
  selfManagedRemotes: boolean;
  /** The basic-auth user git sends with the token: GitHub `x-access-token`, GitLab `oauth2`. */
  gitTokenUser: string;
  /**
   * The push option that keeps a tag push from starting a pipeline (GitLab `ci.skip`). Unset:
   * launchset's tag pushes carry no push options.
   */
  skipCiPushOption?: string;
  /**
   * The CI's fallback token (GitHub's workflow `GITHUB_TOKEN`) can list a run's jobs, so a
   * failed listing is retried with it. GitLab's `CI_JOB_TOKEN` can't.
   */
  fallbackListsJobs: boolean;
  /** The error code when an API token is needed and missing. */
  noTokenError: string;
}

const GITHUB: HostProfile = {
  host: "github",
  name: "GitHub",
  defaultServerUrl: "https://github.com",
  ci: "actions",
  ciFlag: "GITHUB_ACTIONS",
  prSymbol: "#",
  prName: "PR",
  prRef: (n) => `refs/pull/${n}/head`,
  prPath: (n) => `pull/${n}`,
  runPath: (id) => `actions/runs/${id}`,
  releaseName: "GitHub Release",
  prereleaseName: "GitHub pre-release",
  releaseOfTag: "Release",
  releaseNoun: "Release",
  prereleaseFlag: true,
  latestFlag: true,
  lowercaseAlerts: false,
  labelEvents: true,
  nestedRepositories: false,
  selfManagedRemotes: false,
  gitTokenUser: "x-access-token",
  fallbackListsJobs: true,
  noTokenError: "no-github-token",
};

const GITLAB: HostProfile = {
  host: "gitlab",
  name: "GitLab",
  defaultServerUrl: "https://gitlab.com",
  ci: "gitlab-ci",
  ciFlag: "GITLAB_CI",
  remoteMatches: (hostname) => hostname.includes("gitlab"),
  prSymbol: "!",
  prName: "MR",
  prRef: (n) => `refs/merge-requests/${n}/head`,
  prPath: (n) => `-/merge_requests/${n}`,
  runPath: (id) => `-/pipelines/${id}`,
  releaseName: "GitLab release",
  prereleaseName: "GitLab release",
  releaseOfTag: "GitLab release",
  releaseNoun: "release",
  prereleaseFlag: false,
  latestFlag: false,
  lowercaseAlerts: true,
  labelEvents: false,
  nestedRepositories: true,
  selfManagedRemotes: true,
  gitTokenUser: "oauth2",
  skipCiPushOption: "ci.skip",
  fallbackListsJobs: false,
  noTokenError: "no-gitlab-token",
};

/** Every host's profile. A `Record`, so a host added to {@link FORGE_HOSTS} must get one. */
export const HOSTS: Readonly<Record<ForgeHost, HostProfile>> = { github: GITHUB, gitlab: GITLAB };

/**
 * The order hosts are recognised from their CI flag. A host whose CI also sets another host's
 * flag (Forgejo and Gitea runners set `GITHUB_ACTIONS` as well) must come before that host.
 */
export const CI_DETECTION_ORDER: readonly ForgeHost[] = ["gitlab", "github"];

/** The profile of `host` (default {@link DEFAULT_HOST}). */
export function hostProfile(host: ForgeHost = DEFAULT_HOST): HostProfile {
  return HOSTS[host];
}

/** True when `value` names a known host. */
export function isForgeHost(value: string): value is ForgeHost {
  return (FORGE_HOSTS as readonly string[]).includes(value);
}

/**
 * The CI system of a host named by a string (an init answer), the default host's for anything
 * unknown.
 */
export function ciOf(host: string): CiSystem {
  return hostProfile(isForgeHost(host) ? host : DEFAULT_HOST).ci;
}
