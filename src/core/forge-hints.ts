/**
 * Hints and messages that name a host's CI or token setup (GitHub Actions and the GitHub App,
 * GitLab CI and LAUNCHSET_TOKEN). One place per host, so a GitLab user never reads about
 * `actions/checkout`. Pure. The GitHub texts are the ones launchset always printed.
 */

import type { ForgeHost } from "./forge-links.ts";

/** The per-host texts. Each names where it is used. */
export interface ForgeHints {
  /** `requireForge`: what is missing (`<what> needs …`). */
  tokenNeeded: string;
  /** `requireForge` hint, with and without a known repository. */
  tokenHint(hasRepository: boolean): string;
  /** check: the PR head isn't in the checkout. */
  prHeadMissing: string;
  /** check: the base branch isn't in the checkout. */
  baseMissing: string;
  /** check: no merge base (shallow clone). */
  noMergeBase: string;
  /** preview: the commit to build isn't in the checkout. */
  previewCommitMissing: string;
  /** preview comment: the base branch isn't in the checkout (markdown, in italics). */
  previewCompareNote: string;
  /** git: a commit or ref isn't available locally. */
  missingObject: string;
  /** git: not run inside a checkout. */
  notARepository: string;
  /** release: the release commit can't be found. */
  fullHistoryRetry: string;
  /** release: a tag's commit is unknown. */
  tagsRetry: string;
  /** Build jobs (stamp, verify, mark) don't run at the plan's `release-sha`. */
  planCheckout: string;
  /** The `run-number` build-number strategy outside CI. */
  noRunNumber: string;
  /** `ship` with the `run-number` strategy outside CI. */
  runNumberOutsideCi: string;
  /** A preview outside CI (no run number). */
  previewNeedsRun: string;
  /** A detached HEAD and no branch in the CI environment. */
  noBranch: string;
  /** Prerelease tag push denied. */
  tagPushDenied: string;
  /** preview-comment: the jobs of the run can't be listed. */
  listJobsFailed: string;
  /** preview-comment: how build jobs must be named. */
  previewJobName: string;
  /** The jobs of a run (`workflow run`, `pipeline`), for links. */
  runName: string;
  /** preview: the events a preview runs on. */
  previewEvents: string;
  /** preview: no branch for a push or manual preview. */
  previewNoBranch: string;
}

const GITHUB: ForgeHints = {
  tokenNeeded: "needs a GitHub token and the repository.",
  tokenHint: (hasRepository) =>
    hasRepository
      ? "Pass --token or set GITHUB_TOKEN (in workflows: the GitHub App token)."
      : "Pass --token and --repo owner/repo, or set GITHUB_TOKEN and GITHUB_REPOSITORY.",
  prHeadMissing: "Check out with fetch-depth: 0 (actions/checkout) so the PR head is available.",
  baseMissing: "Check out with fetch-depth: 0 so the base branch is present, or pass --base <ref>.",
  noMergeBase: "Check out with fetch-depth: 0 (a shallow clone cuts the history the check needs).",
  previewCommitMissing:
    "Check out with `fetch-depth: 0` (actions/checkout) so the PR head and the tags are available.",
  previewCompareNote: "Use `fetch-depth: 0` in actions/checkout.",
  missingObject:
    "The commit or ref isn't available locally. In GitHub Actions, check out with `fetch-depth: 0` so the full history and tags are present.",
  notARepository: "Run launchset inside a git checkout (actions/checkout in CI).",
  fullHistoryRetry: "Fetch the full history (actions/checkout with fetch-depth: 0) and try again.",
  tagsRetry: "Fetch the tags (actions/checkout with fetch-depth: 0) and try again.",
  planCheckout:
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template.
    "Check out the plan's commit in this job: actions/checkout with ref: ${{ needs.launchset.outputs.release-sha }} (and fetch-depth: 0).",
  noRunNumber:
    'the "run-number" build-number strategy only works in GitHub Actions: there is no run number here',
  runNumberOutsideCi: "it needs github.run_number",
  previewNeedsRun:
    "Previews are built in GitHub Actions; `launchset plan --preview` needs --run-number outside CI.",
  noBranch: "can't tell which branch this is: HEAD is detached and GITHUB_REF isn't a branch",
  tagPushDenied:
    "Prerelease branches reserve their tag with a push, which needs the GitHub App token (Contents: read & write), not the default GITHUB_TOKEN of a read-only workflow. Pass the App token as `token` and to actions/checkout. If tag rulesets protect the tag, let the launchset App bypass them.",
  listJobsFailed: "The App needs the Actions: read permission.",
  previewJobName: "Preview <target>",
  runName: "workflow run",
  previewEvents: "The preview workflow runs on pull_request, push and workflow_dispatch events.",
  previewNoBranch: "Check out a branch (not a detached HEAD), or run this in GitHub Actions.",
};

/** The LAUNCHSET_TOKEN GitLab needs, for hints. */
const GITLAB_TOKEN =
  "LAUNCHSET_TOKEN: a project or group access token with the api and write_repository scopes, role Maintainer";

const GITLAB: ForgeHints = {
  tokenNeeded: `needs a GitLab token (${GITLAB_TOKEN}) and the project.`,
  tokenHint: (hasRepository) =>
    hasRepository
      ? "Pass --token or set LAUNCHSET_TOKEN (a CI/CD variable, masked; CI_JOB_TOKEN can only read)."
      : "Pass --token and --repo group/project, or set LAUNCHSET_TOKEN and CI_PROJECT_PATH.",
  prHeadMissing:
    'Clone the full history (set GIT_DEPTH: "0" on the job) so the MR head is available.',
  baseMissing:
    'Clone the full history (set GIT_DEPTH: "0" on the job) so the target branch is present, or pass --base <ref>.',
  noMergeBase:
    'Clone the full history: set GIT_DEPTH: "0" on the job (a shallow clone cuts the history the check needs).',
  previewCommitMissing:
    'Clone the full history (set `GIT_DEPTH: "0"` on the job) so the MR head and the tags are available.',
  previewCompareNote: 'Set `GIT_DEPTH: "0"` on the job.',
  missingObject:
    'The commit or ref isn\'t available locally. In GitLab CI, set `GIT_DEPTH: "0"` on the job so the full history and tags are present.',
  notARepository:
    "Run launchset inside a git checkout (in GitLab CI: not with GIT_STRATEGY: none).",
  fullHistoryRetry: 'Fetch the full history (set GIT_DEPTH: "0" on the job) and try again.',
  tagsRetry: 'Fetch the tags (set GIT_DEPTH: "0" on the job) and try again.',
  planCheckout:
    'Check out the plan\'s commit in this job first: git checkout --detach "$LAUNCHSET_RELEASE_SHA" (with GIT_DEPTH: "0"). A child pipeline runs at its parent pipeline\'s commit, which a retry may not build.',
  noRunNumber:
    'the "run-number" build-number strategy only works in CI: there is no pipeline number (CI_PIPELINE_IID) here',
  runNumberOutsideCi: "it needs the pipeline IID, CI_PIPELINE_IID",
  previewNeedsRun:
    "Previews are built in CI (the pipeline IID is the run number); `launchset plan --preview` needs --run-number outside CI.",
  noBranch:
    "can't tell which branch this is: HEAD is detached and CI_COMMIT_BRANCH isn't set (a tag or MR pipeline)",
  tagPushDenied: `Prerelease branches reserve their tag with a push, which needs ${GITLAB_TOKEN}. CI_JOB_TOKEN can't be used: pushes made with it never start pipelines. If the tag is protected, add the token's bot (or Maintainers) to the protected tag's "Allowed to create" list.`,
  listJobsFailed:
    "Listing pipeline jobs needs LAUNCHSET_TOKEN with the api scope (CI_JOB_TOKEN can't list jobs).",
  previewJobName: "preview-<target>",
  runName: "pipeline",
  previewEvents: "The preview job runs in merge request, branch and manual (web, api) pipelines.",
  previewNoBranch: "Check out a branch (not a detached HEAD), or run this in GitLab CI.",
};

/** The hints of `host` (default GitHub). */
export function forgeHints(host: ForgeHost = "github"): ForgeHints {
  return host === "gitlab" ? GITLAB : GITHUB;
}

/** Hints for a failed git push or fetch, by why it failed. */
export interface GitPushHints {
  workflows: string;
  protected: string;
  /** A server hook or push rule declined the push (GitLab), not a protection rule. */
  declined: string;
  auth: string;
  forbidden: string;
}

const GITHUB_PUSH: GitPushHints = {
  workflows:
    'The GitHub App needs the "Workflows: write" repository permission to push commits that change .github/workflows (the release branch is rebuilt from the base branch).',
  protected:
    "A branch protection rule or ruleset blocks this push. Allow the launchset GitHub App to bypass it, or exclude launchset/* branches and tags from the rule.",
  declined:
    "A branch protection rule or ruleset blocks this push. Allow the launchset GitHub App to bypass it, or exclude launchset/* branches and tags from the rule.",
  auth: "The token was rejected. Check that the GitHub App token is passed as `token` and hasn't expired (installation tokens last one hour).",
  forbidden:
    'The token lacks access. The GitHub App needs "Contents: read & write" on this repository and must be installed on it.',
};

const GITLAB_PUSH: GitPushHints = {
  workflows: "",
  protected:
    'A protected branch or tag blocks this push. Give LAUNCHSET_TOKEN the Maintainer role, or add its bot user (or Maintainers) to "Allowed to push and merge" of the protected branch and "Allowed to create" of the protected tag (Settings > Repository). launchset pushes launchset/* branches and its tags.',
  declined:
    "A GitLab push rule or server hook declined this push (see the remote's message). launchset commits as LAUNCHSET_TOKEN's user: allow its email and name in the push rules (Settings > Repository > Push rules).",
  auth: "The token was rejected. LAUNCHSET_TOKEN must be a valid project or group access token with the write_repository scope (check that it hasn't expired or been revoked).",
  forbidden:
    "The token lacks push access. LAUNCHSET_TOKEN needs the write_repository scope and the Maintainer role. CI_JOB_TOKEN can't be used for launchset's pushes: they must start pipelines, and pushes made with CI_JOB_TOKEN never do.",
};

/** Hint for git pushes without LAUNCHSET_TOKEN on GitLab: git used the runner's job token. */
export const GITLAB_JOB_TOKEN_PUSH =
  "No token was given, so git used the runner's CI_JOB_TOKEN from the clone URL. It can't push launchset's branches and tags (and pushes made with it never start pipelines): set LAUNCHSET_TOKEN to a project or group access token with the api and write_repository scopes, role Maintainer.";

/** The git push hints of `host` (default GitHub). */
export function gitPushHints(host: ForgeHost = "github"): GitPushHints {
  return host === "gitlab" ? GITLAB_PUSH : GITHUB_PUSH;
}
