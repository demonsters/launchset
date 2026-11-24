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
 * A CI system. It decides the files `init` writes, how build jobs are named and whether a
 * child pipeline is generated. `actions`: GitHub Actions workflows (Forgejo's and Gitea's CI run
 * these too). `gitlab-ci`: `.gitlab-ci.yml` pipelines. One forge can be used with more than one
 * CI system (Codeberg: Forgejo Actions or Woodpecker), so these are a table of their own.
 */
export type CiSystem = "actions" | "gitlab-ci";

/** The environment variable that says which CI system runs launchset. */
export type CiVariable = "GITHUB_ACTIONS" | "GITLAB_CI";

export interface HostProfile {
  host: ForgeHost;
  /** The product, for messages: `GitHub`, `GitLab`. */
  name: string;
  /** The public server, used when none is configured. */
  defaultServerUrl: string;
  /**
   * The host's own CI system: what `init` sets up, and what runs when the environment names
   * none (a local run) or names one that doesn't serve this host ({@link ciSystemFor}).
   */
  ci: CiSystem;
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
  /** The error code when an API token is needed and missing. */
  noTokenError: string;
}

const GITHUB: HostProfile = {
  host: "github",
  name: "GitHub",
  defaultServerUrl: "https://github.com",
  ci: "actions",
  prSymbol: "#",
  prName: "PR",
  prRef: (n) => `refs/pull/${n}/head`,
  prPath: (n) => `pull/${n}`,
  releaseName: "GitHub Release",
  prereleaseName: "GitHub pre-release",
  releaseOfTag: "Release",
  releaseNoun: "Release",
  prereleaseFlag: true,
  latestFlag: true,
  lowercaseAlerts: false,
  nestedRepositories: false,
  selfManagedRemotes: false,
  gitTokenUser: "x-access-token",
  noTokenError: "no-github-token",
};

const GITLAB: HostProfile = {
  host: "gitlab",
  name: "GitLab",
  defaultServerUrl: "https://gitlab.com",
  ci: "gitlab-ci",
  remoteMatches: (hostname) => hostname.includes("gitlab"),
  prSymbol: "!",
  prName: "MR",
  prRef: (n) => `refs/merge-requests/${n}/head`,
  prPath: (n) => `-/merge_requests/${n}`,
  releaseName: "GitLab release",
  prereleaseName: "GitLab release",
  releaseOfTag: "GitLab release",
  releaseNoun: "release",
  prereleaseFlag: false,
  latestFlag: false,
  lowercaseAlerts: true,
  nestedRepositories: true,
  selfManagedRemotes: true,
  gitTokenUser: "oauth2",
  skipCiPushOption: "ci.skip",
  noTokenError: "no-gitlab-token",
};

/** Every host's profile. A `Record`, so a host added to {@link FORGE_HOSTS} must get one. */
export const HOSTS: Readonly<Record<ForgeHost, HostProfile>> = { github: GITHUB, gitlab: GITLAB };

/** What differs between CI systems. */
export interface CiProfile {
  ci: CiSystem;
  /** The product, for messages: `GitHub Actions`, `GitLab CI`. */
  name: string;
  /**
   * How the environment says this CI runs launchset: `variable` has `value` (`GITLAB_CI` is
   * `true`; Woodpecker would be `CI` = `woodpecker`).
   */
  detect: { variable: CiVariable; value: string };
  /**
   * The hosts this CI runs against, the one it's used with when the environment names no host
   * first.
   */
  hosts: readonly [ForgeHost, ...ForgeHost[]];
  /** The web path of a run, below the repository URL: `actions/runs/7`, `-/pipelines/7`. */
  runPath(id: number): string;
  /**
   * Adding a label to a PR starts a run (GitHub's pull_request `labeled`). Without it, a
   * labelled PR only gets its preview on the next pipeline, or from `launchset preview-sweep`.
   */
  labelEvents: boolean;
  /**
   * The CI's fallback token (GitHub's workflow `GITHUB_TOKEN`) can list a run's jobs, so a
   * failed listing is retried with it. GitLab's `CI_JOB_TOKEN` can't.
   */
  fallbackListsJobs: boolean;
  /** `--ci` (writing plan.json, launchset.env, …) is on unless `--no-ci` says otherwise. */
  ciFilesByDefault: boolean;
  /**
   * A collapsed section of the job log around `content`, with title `title` (GitLab CI's
   * `section_start`/`section_end`). Unset: the CI has none, and `content` is printed plainly.
   */
  logSection?: (id: string, title: string, content: string, now: Date) => string;
}

const ACTIONS: CiProfile = {
  ci: "actions",
  name: "GitHub Actions",
  detect: { variable: "GITHUB_ACTIONS", value: "true" },
  hosts: ["github"],
  runPath: (id) => `actions/runs/${id}`,
  labelEvents: true,
  fallbackListsJobs: true,
  ciFilesByDefault: false,
};

const GITLAB_CI: CiProfile = {
  ci: "gitlab-ci",
  name: "GitLab CI",
  detect: { variable: "GITLAB_CI", value: "true" },
  hosts: ["gitlab"],
  runPath: (id) => `-/pipelines/${id}`,
  labelEvents: false,
  fallbackListsJobs: false,
  ciFilesByDefault: true,
  logSection: (id, title, content, now) => {
    const time = Math.floor(now.getTime() / 1000);
    return `\u001b[0Ksection_start:${time}:${id}[collapsed=true]\r\u001b[0K${title}\n${content}\u001b[0Ksection_end:${time}:${id}\r\u001b[0K\n`;
  },
};

/** Every CI system's profile. A `Record`, so a new {@link CiSystem} must get one. */
export const CI_SYSTEMS: Readonly<Record<CiSystem, CiProfile>> = {
  actions: ACTIONS,
  "gitlab-ci": GITLAB_CI,
};

/**
 * The order CI systems are recognised from the environment. A CI that also sets another CI's
 * variable (Forgejo and Gitea runners may set `GITHUB_ACTIONS` as well) must come before it.
 */
export const CI_DETECTION_ORDER: readonly CiSystem[] = ["gitlab-ci", "actions"];

/** The CI system the environment says runs launchset, if any (ignores `LAUNCHSET_HOST`). */
export function ciFromEnv(env: Readonly<Record<string, string | undefined>>): CiSystem | undefined {
  return CI_DETECTION_ORDER.find((ci) => {
    const { variable, value } = CI_SYSTEMS[ci].detect;
    return env[variable] === value;
  });
}

/**
 * The CI system for a run on `host`: the one the environment names when it serves `host`,
 * else the host's own ({@link HostProfile.ci}).
 */
export function ciSystemFor(
  host: ForgeHost,
  env: Readonly<Record<string, string | undefined>>,
): CiSystem {
  const detected = ciFromEnv(env);
  return detected && CI_SYSTEMS[detected].hosts.includes(host) ? detected : hostProfile(host).ci;
}

/** The profile of CI system `ci`. */
export function ciProfile(ci: CiSystem): CiProfile {
  return CI_SYSTEMS[ci];
}

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
