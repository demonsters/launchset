# GitLab support: plan

Status: implemented (all phases), plus the fixes from a trial adoption on GitLab (see
"Trial fixes"); needs a trial on a real GitLab instance (see To verify). The host abstraction
now takes more hosts and CI systems (see "More hosts"). Last updated 2026-11-20.

launchset ran on GitHub only. This plan covers what it takes to also run on GitLab
(gitlab.com and self-managed), in an order that keeps the GitHub path safe at every step.

## Decisions

1. **On GitLab, CI jobs run the CLI; there is no Action.** The GitHub Action
   (`action/src/index.ts`) is a thin wrapper: it reads inputs, calls the same `src/flow`
   functions as the CLI, and reports through `@actions/core`. On GitLab each job runs
   `launchset <command>` in a Node image (or a small launchset image). This needs CLI parity
   first (phase 3), which also makes launchset usable on any other CI.
2. **One pipeline shape: a generated child pipeline.** GitLab fixes a pipeline's jobs before any
   job runs, so a job can't be switched on by another job's output (GitHub's
   `if: needs.launchset.outputs.mode == 'publish'`). The `launchset` job writes `child.yml` with
   only the jobs the plan needs, and the parent triggers it. Nothing to build, no build jobs: no
   "passed" jobs that did nothing. A static mode (every target job always present, exiting
   early) is not built; it can be added later from the same pieces if someone needs it (for
   example a policy that forbids child pipelines).
3. **The build steps live in a file the user owns; launchset generates only the wrapper.**
   `init` writes `.gitlab/launchset-targets.yml` with one hidden job per target
   (`.launchset-<target>`). People and AI edit it as plain GitLab CI YAML. The generated
   `child.yml` includes it and wraps each target's script in `stamp` / `verify` / `mark`.
   Setup complexity is handled by `init` and the adopt skill, not by a simpler pipeline shape.

## Where launchset depends on GitHub

The pure core (`src/core`) is mostly host-neutral: it plans releases and renders markdown, and
only a few URLs and words are GitHub-specific. Every API call already goes through one interface
(`GitHub` in `src/github/index.ts`). The coupling is in seven places:

| Area | Where | What is GitHub-specific |
|---|---|---|
| API client | `src/github/*` | Octokit, PRs, issue comments, Releases, Actions jobs, `owner/repo` |
| CI environment | `src/flow/context.ts` | `GITHUB_*` variables, the event payload (`GITHUB_EVENT_PATH`), `run_number` / `run_attempt` |
| Runtime | `action/` | `@actions/core`: step outputs, exported variables, job summary |
| Git auth | `src/git/index.ts` | `x-access-token:` basic auth, bot email, permission hints, `parseGitHubRepo` |
| Generated CI | `templates/workflows/*`, `src/templates/workflows.ts` | GitHub Actions YAML |
| `init` | `src/init/*`, `src/cli/program.ts` | scans and edits `.github/workflows`, Actions filter patterns, writes to `.github/` |
| Links and words | `core/changelog.ts`, `flow/context.ts`, `flow/check.ts`, `core/plan-common.ts` | `/pull/N`, `/actions/runs/N`, `refs/pull/N/head`, `#N`, alert blocks, "GitHub Release" |

## Mapping GitHub concepts to GitLab

### API (`GitHub` interface → GitLab REST v4)

| Method | GitLab | Notes |
|---|---|---|
| `findOpenPrByHead` | `GET /projects/:id/merge_requests?state=opened&source_branch=` | |
| `createPr` / `updatePr` / `getPr` | `POST` / `PUT` / `GET /projects/:id/merge_requests[/:iid]` | MRs have `id` and `iid`; use `iid` everywhere. |
| `closePr` | `POST .../merge_requests/:iid/notes`, then `PUT ... state_event=close` | |
| `upsertStickyComment` | `GET/POST/PUT .../merge_requests/:iid/notes` | Ours = `author.bot === true` (not `user.type === "Bot"`). Skip `system` notes. |
| `getReleaseByTag` | `GET /projects/:id/releases/:tag_name` | |
| `createRelease` / `updateRelease` | `POST` / `PUT /projects/:id/releases[/:tag_name]` | No `draft`, no `prerelease`, no `make_latest`. Releases are keyed by tag, not id. See "Open decisions". |
| `pullRequestsForCommit` | `GET /projects/:id/repository/commits/:sha/merge_requests` | Also returns merged MRs off the default branch, so the `closedPrsInto` fallback matters less. |
| `closedPrsInto` | `GET /projects/:id/merge_requests?state=merged&target_branch=&order_by=updated_at&updated_after=` | Merge commit is `merge_commit_sha` or `squash_commit_sha`; fast-forward merges have neither (use `sha`). |
| `prFiles` | `GET .../merge_requests/:iid/diffs` (paginated) | Status from `new_file` / `deleted_file` / `renamed_file`. |
| `listJobs` | `GET /projects/:id/pipelines/:id/jobs` | Retried jobs: pass `include_retried=false` (the default) to get the latest attempt. |

The project id is the URL-encoded full path (`group%2Fsub%2Fproject`). Nested groups mean the
repository is not always `owner/repo`; the `owner` / `repo` fields and every split on `/` go.

### CI environment (`GITHUB_*` → `CI_*`)

| launchset reads | GitHub | GitLab |
|---|---|---|
| event kind | `GITHUB_EVENT_NAME` | `CI_PIPELINE_SOURCE` (`push`, `merge_request_event`, `web`, `api`, `trigger`, `schedule`) |
| branch / sha | payload `ref` / `after` | `CI_COMMIT_BRANCH` / `CI_COMMIT_SHA` |
| PR number, head, base | payload `pull_request` | `CI_MERGE_REQUEST_IID`, `CI_MERGE_REQUEST_SOURCE_BRANCH_NAME` / `_SHA`, `CI_MERGE_REQUEST_TARGET_BRANCH_NAME` / `_SHA` |
| PR labels | payload `pull_request.labels` | `CI_MERGE_REQUEST_LABELS` (comma-separated) |
| fork PR | `head.repo != base.repo` | `CI_MERGE_REQUEST_SOURCE_PROJECT_ID != CI_MERGE_REQUEST_PROJECT_ID` |
| PR author | payload `pull_request.user.login` | not in the environment: one API call (`author.username`) |
| dispatch inputs | payload `inputs` | pipeline variables or `spec:inputs` (decided with the templates) |
| run id / number / attempt | `GITHUB_RUN_ID` / `_NUMBER` / `_ATTEMPT` | `CI_PIPELINE_ID` / `CI_PIPELINE_IID` / none |
| server, API, repository | `GITHUB_SERVER_URL`, `GITHUB_API_URL`, `GITHUB_REPOSITORY` | `CI_SERVER_URL`, `CI_API_V4_URL`, `CI_PROJECT_PATH` |
| token | `GITHUB_TOKEN` / App token | `LAUNCHSET_TOKEN` (project or group access token); `CI_JOB_TOKEN` as a read fallback |

### Runtime (`@actions/core` → files)

| GitHub Action | GitLab |
|---|---|
| `uses: demonsters/launchset-action` with `command:` | `script: launchset <command>` |
| `if:` on another job's outputs | a generated child pipeline (decision 2) |
| step outputs | `artifacts:reports:dotenv`. It has tight size and count limits, so the plan goes in a `plan.json` artifact and later jobs pass `--plan @plan.json`. |
| exported variables (`LAUNCHSET_VERSION`, …) | the same dotenv file, read by later jobs through `needs:` |
| job summary | the job log; the preview and check results already go to a sticky MR note |
| `setFailed` | exit code |

### Links and words

| | GitHub | GitLab |
|---|---|---|
| PR / MR link | `/{repo}/pull/N`, text `#N` | `/{repo}/-/merge_requests/N`, text `!N` |
| run link | `/{repo}/actions/runs/N` | `/{repo}/-/pipelines/N` |
| PR head ref | `refs/pull/N/head` | `refs/merge-requests/N/head` |
| release | "GitHub Release" | "GitLab release" (or neutral "release") |
| bot logins | `dependabot[bot]`, `renovate[bot]` | instance-specific usernames (e.g. `renovate-bot`), so `check.bots` defaults differ |

## Phases

Each phase is its own PR and leaves GitHub behaviour unchanged (the existing tests are the guard).

### Phase 1: refactor to a host abstraction (no behaviour change)

- Rename `GitHub` → `Forge` (types: `PullRequest` → `ChangeRequest` or keep the name, `Release`,
  `Job`); move `src/github` → `src/forge/github`. Keep `GitHubError` as the GitHub client's error,
  add a common base class for the error formatting in `src/cli/errors.ts` / `action/src/errors.ts`.
- Drop `owner` / `repo` from the interface; only `repository` (full path) stays.
- Add a per-host URL builder (`prUrl`, `prRef`, `runUrl`, `prText`) and use it in
  `core/changelog.ts`, `flow/context.ts:runInfoFromEnv`, `flow/check.ts`.
- Move the environment parsing in `flow/context.ts` behind a `CiEnvironment` adapter that returns
  the existing `EventInfo` / `RunInfo`. The GitHub adapter is today's code.
- Host detection: `LAUNCHSET_HOST` (`github` / `gitlab`), else `GITLAB_CI=true` → gitlab, else
  `GITHUB_ACTIONS=true` → github, else from the origin remote's host, else github.
- Config: rename `changelog.github` → `changelog.links` (keep `github` as a deprecated alias).

### Phase 2: GitLab client and environment

- `src/forge/gitlab`: a small `fetch`-based client (no SDK; the API surface is small) with
  pagination via `x-next-page` / `Link`, and errors with endpoint, status and a hint naming the
  token scope, like `github/errors.ts`.
- GitLab `CiEnvironment` adapter (table above).
- `parseGitHubRepo` → `parseRepoFromRemote(url, serverUrl)`: accepts nested group paths for GitLab
  hosts.
- Tests: recorded API responses as fixtures, the same way the GitHub client is tested.

### Phase 3: CLI parity, runtime and git auth

- CLI parity with the Action. Today the CLI has `stamp`, `verify`, `mark`, `finalize`, `check`
  and `add`, but not:
  - `release`: decide the mode and update the release PR/MR (`plan` only prints and writes
    nothing);
  - `preview-plan`: plan a preview and reserve the prerelease tag (`plan --preview` is a dry run);
  - `preview-comment`: post the preview results.
  Add them as CLI commands over the same flow functions. Host-neutral, so it can ship before
  any GitLab code.
- `--ci` output mode: write outputs and exported variables to a dotenv file
  (`LAUNCHSET_DOTENV`, default `launchset.env`) and the plan to `plan.json`; print the summary to
  the log. On by default when the host is GitLab and `CI` is set.
- Git auth: `oauth2:<token>` basic auth for GitLab (`x-access-token:` stays for GitHub); GitLab bot
  email from `GET /user` of the token, or `<token-bot-username>@noreply.<host>`.
- Permission and protection hints for GitLab: token scopes `api` + `write_repository`, role
  Maintainer (needed for protected branches and tags), protected-branch "allowed to push".
- Docs: `gitlab-token.md`, the counterpart of `github-app.md`.

### Phase 4: GitLab CI templates (done)

Renderers, written by `init` (phase 5): `renderGitLabCi()` in `src/templates/gitlab.ts`
(templates in `templates/gitlab/`) and `renderChildPipeline()` in `src/templates/gitlab-child.ts`.

- No CI/CD component for now (open decision 4): `init` will write plain YAML files, like the GitHub
  workflows. Each launchset job installs the CLI with npm
  (`npm install --global "$LAUNCHSET_CLI"`, default `@demonsters/launchset@<the version that
  rendered the file>`; `NPM_TOKEN` for the private package; skipped when `launchset` is on the
  PATH). The bundle targets Node 24, so every job that runs launchset needs Node 24+ and npm.
- `.gitlab/launchset.yml` (launchset's jobs, included by `.gitlab-ci.yml`): `launchset-check` (MR
  pipelines into the base, maintenance and prerelease branches; not a fork MR's pipeline that
  runs in the fork, `$CI_PROJECT_ID != $CI_MERGE_REQUEST_PROJECT_ID`, which has no `NPM_TOKEN`
  to install launchset with), `launchset-release` +
  `launchset-build` (trigger) on pushes and `web` / `api` pipelines of the base and maintenance
  branches, `launchset-preview-plan` + `launchset-preview` (trigger) +
  `launchset-preview-comment`. No top-level `workflow:` (it would override the project's).
  launchset's jobs set `cache: []` and the release job `dependencies: []`: files a cache or an
  earlier stage's artifacts put in the checkout would count as uncommitted changes when the
  release branch is built. launchset's own `--ci` files (plan.json from a parent job's
  artifacts, launchset.env, launchset.sh, the child pipeline) never count.
- `.gitlab/launchset-targets.yml` (the user's file): one hidden `.launchset-<target>` job per
  target with image, services, tags, variables, before_script and the build steps (GitLab
  versions of the GitHub snippets). No `rules` in them: a child whose jobs are all ruled out
  fails to start.
- A fresh `.gitlab-ci.yml` for projects without one: the documented `workflow: rules:` that
  switch between branch and MR pipelines (preview and prerelease branches always get branch
  pipelines), `workflow: auto_cancel: on_new_commit: interruptible`, and the include.
- `concurrency` → `resource_group: launchset-release-$CI_COMMIT_REF_SLUG` on the release job.
  GitLab never drops a job waiting for a resource group (GitHub keeps only one waiting run per
  group), so the release-commit pipeline always gets its run. Ordering isn't guaranteed (default
  process mode `unordered`); the release flow already handles out-of-order runs (only the run for
  the branch tip updates the release MR, lease pushes).
- The child pipeline (decisions 2 and 3). The parent:

  ```yaml
  launchset-release:
    extends: .launchset-cli                    # node:24, GIT_DEPTH 0, installs the CLI
    script: [launchset release --ci]           # plan.json, launchset.env, launchset-child.yml
    resource_group: launchset-release-$CI_COMMIT_REF_SLUG
    interruptible: false
    artifacts:
      paths: [plan.json, launchset-child.yml]
      reports: { dotenv: launchset.env }
      expire_in: 30 days
  launchset-build:
    needs: [launchset-release]
    variables: { PARENT_PIPELINE_ID: $CI_PIPELINE_ID }
    trigger:
      include: [{ artifact: launchset-child.yml, job: launchset-release }]
      strategy: mirror                         # GitLab 18.2; the MR shows the child's result
  ```

  The generated child for a plan with only `web` (abridged):

  ```yaml
  include: [{ local: .gitlab/launchset-targets.yml }]      # a literal path
  build-web:
    extends: .launchset-web
    needs: [{ pipeline: $PARENT_PIPELINE_ID, job: launchset-release }]   # gets plan.json
    interruptible: false
    script:
      - cd "$CI_PROJECT_DIR"
      - (install lines)
      - launchset stamp --target web --plan @plan.json --ci
      - . ./launchset.sh
      - launchset verify --target web --plan @plan.json --ci
      - . ./launchset.sh
      - if [ "${LAUNCHSET_ALREADY_PUBLISHED:-}" = "true" ]; then launchset mark --target web --plan @plan.json --ci; exit $?; fi
      - !reference [.launchset-web, script]
      - cd "$CI_PROJECT_DIR"
      - launchset mark --target web --plan @plan.json --ci
  launchset-finalize:
    extends: .launchset_cli
    when: always                               # records partial releases
    needs: [{ pipeline: $PARENT_PIPELINE_ID, job: launchset-release }, { job: build-web, artifacts: false }]
    script: [launchset finalize --plan @plan.json --ci]
  ```

  Every launchset line is its own script item: GitLab runs them with `set -e`, which ignores a
  failure on the left of `&&`. When the plan's release-sha isn't the pipeline's commit (a retry
  of an unfinished release, a merged results pipeline), every child job first runs
  `git checkout --quiet --detach <release-sha>` with `GIT_DEPTH: "0"`; otherwise build jobs keep
  the project's clone depth. Nothing to build (release-pr, none, a skipped preview): the child is
  a single `launchset-nothing-to-build` job (busybox, `GIT_STRATEGY: none`) that echoes why.
  Before writing the child, launchset checks that the targets file defines `.launchset-<target>`
  with a `script` (or `extends`) for every target it builds, checks the `gitlab.include` files
  (hidden jobs, `variables` and `default` only), and warns about `needs`, `rules`, `when`,
  `only`, `except` and `stage` on a target job or its templates. A target with `gitlab.shell:
  powershell` gets the same lines in PowerShell, a target with `after` gets optional `needs` on
  the other targets' jobs, and the `gitlab.include` files are included before the targets file.
- Debuggability: in `--ci` mode on GitLab, `release` and `preview-plan` always write
  `launchset-child.yml` (`LAUNCHSET_CHILD_PIPELINE`), print it to the job log (a collapsed
  section) and keep it as an artifact; `launchset plan --gitlab [file|-]` writes it locally.
- Manual targets and previews: the same child pipeline from a different plan. Run pipeline with
  `LAUNCHSET_TARGET` / `LAUNCHSET_RELEASE_VERSION` / `LAUNCHSET_FORCE` ships a manual target;
  `LAUNCHSET_PREVIEW=true` (+ `LAUNCHSET_TARGET`) builds a preview of any branch.
- Previews in MR pipelines: the plan job runs automatically when the MR has `preview.label`
  (`CI_MERGE_REQUEST_LABELS`), and is a manual job (`allow_failure: true`,
  `LAUNCHSET_PREVIEW_MANUAL=true`) otherwise; with `rebuildOnPush: false` every MR gets the manual
  job. Never for fork MRs. Pushes to `preview.branches` build automatically.
- `preview-comment --plan @plan.json` treats a missing file as "no plan" (a skipped preview
  writes none).

### Phase 5: `init`, docs, skills (done)

`init` (5a) and the docs and skills (5b) are done.

- Ask for or detect the host (remote URL, `.gitlab-ci.yml` present).
- Scan `.gitlab-ci.yml` (and its local `include:` files) for release machinery: jobs with
  `only: tags`, `rules: - if: $CI_COMMIT_TAG`, `changeset` commands, `release:` keywords,
  `glab release create`, docker pushes of `latest` on branch pushes (spec 11.1 already lists
  `.gitlab-ci.yml`; it isn't implemented).
- Retire machinery in GitLab CI YAML with the same minimal-edit approach as `retire.ts`.
- Write `.gitlab-ci.yml` (or add an `include:` to an existing one) instead of `.github/workflows`,
  and `.gitlab/launchset-targets.yml` with a `.launchset-<target>` job per target, prefilled from
  the build steps found in the existing CI where possible.
- Docs: a GitLab page per area (getting started, token, previews, recipes); keep GitHub the
  default in examples. Update both agent skills (`launchset`, `launchset-adopt`).

## Trial fixes (from adopting a GitLab project)

A trial adoption of a real GitLab project (a Rust + Python desktop app: a Windows runner with
PowerShell, packages and a site image built on tags, templates in `.gitlab-ci.yml`) found six
gaps. Each is fixed; the details are in design/DECISIONS.md.

1. **PowerShell runners.** Target option `gitlab: { shell: "powershell" }`: the child job's
   launchset lines are PowerShell (`$env:`, `Get-Command`, `'@plan.json'`, `. ./launchset.ps1`,
   `$LASTEXITCODE` checks), and `--ci` also writes `launchset.ps1`. init proposes it for jobs
   that use PowerShell or run on `windows`-tagged runners.
2. **Targets after targets.** Target option `after: [...]` (GitLab only; an error on GitHub):
   optional `needs` with artifacts on the other targets' jobs, in release and preview children.
   A retry that only builds the dependent target has no artifacts from the earlier pipeline:
   documented, with a generic package registry example in the custom target template.
3. **Tag pipelines.** launchset pushes its tags with `-o ci.skip` on GitLab (release and
   prerelease tags opt back in with `gitlab: { tagPipelines: true }`); init notes a
   `workflow: rules` entry that allows tag pipelines.
4. **Adopting a project without detectable targets.** init proposes custom targets from tag jobs
   that keep artifacts, deploy or publish, prefills their `.launchset-<target>` from the job,
   turns `needs` between them into `after`; `--decide target.<name>=custom` declares one by
   hand. Machinery: `disable` removes only the tag rule of a job other rules still start, and a
   job only removed jobs need can be removed with them.
5. **Templates in `.gitlab-ci.yml`.** Config `gitlab: { include: [...] }`: files the child
   pipeline includes (checked: hidden jobs, `variables`, `default` only). init moves the
   templates the target jobs extend to `.gitlab/ci-templates.yml` and includes it from both.
6. **Interruptible previews.** A preview job keeps `interruptible: false` from the user's job or
   the templates it extends.

## More hosts (Forgejo, Gitea, Codeberg)

Not planned yet, but the code no longer assumes exactly two hosts, or one CI system per host,
so adding either later doesn't mean finding every `host === "gitlab"` again.

**Hosts and CI systems are separate tables.** One forge can be used with more than one CI
system: Codeberg (a Forgejo instance) has hosted Forgejo Actions and Woodpecker CI, and
self-managed Forgejo and Gitea are often paired with Woodpecker or Drone.
- `HOSTS` (`src/core/hosts.ts`) has one `HostProfile` per forge: its words and paths (`!12`,
  `-/merge_requests/12`), its own CI system (`ci`: what init sets up and what runs locally)
  and the forge's traits: `prereleaseFlag`, `latestFlag`, `lowercaseAlerts`,
  `nestedRepositories`, `selfManagedRemotes`, `skipCiPushOption`, `gitTokenUser`.
- `CI_SYSTEMS` has one `CiProfile` per CI system (`actions`, `gitlab-ci`): how it's detected
  (`detect`: a variable and its value, so `CI=woodpecker` fits as well as `GITLAB_CI=true`),
  the hosts it serves (the first is used when the environment names none), and the CI's
  traits: `runPath`, `labelEvents`, `fallbackListsJobs`, `ciFilesByDefault` (`--ci` on by
  default) and `logSection` (collapsed log sections).
- The CI environment is read per CI system (`readCiEnvironment`): the one the environment names
  when it serves the host, else the host's own (`ciSystemFor`). `CiEnvironment.system` and
  `ciSystemOf(context)` give the run's CI system; code about the CI (job names, the child
  pipeline, MR checkouts, the sweep) asks it, not the host. CI systems are checked in
  `CI_DETECTION_ORDER`, GitHub Actions last.
- Texts per host are `Record<ForgeHost, …>` tables (`forge-hints.ts`, git's push-failure
  wording, init's image guess), so adding a host to `FORGE_HOSTS` makes the compiler list each
  one. Many hints are really about the CI (`actions/checkout`, `GIT_DEPTH`); they stay keyed by
  host until a host gets a second CI system.
- `src/flow/hosts.ts` holds the run-time side per host: the API client and what `createContext`
  does differently (server from the remote, commit identity).
- Tests fail on a new comparison with `"github"`/`"gitlab"` and on a direct read of a CI
  system's detection variable outside `flow/ci/`. init's host guess (`init/detect.ts`) is the
  exception to both: it weighs GitLab's own evidence.
- Not moved yet: `listJobs` stays on `Forge`, and run URLs are built from `runPath` under the
  repository URL. Both are wrong for a CI on its own server (see Woodpecker below) and move
  when one is added.

**What a new host needs.**
1. A profile in `HOSTS`, its texts in the tables, and its CI system in a `CiProfile`'s `hosts`.
2. A `Forge` client (`src/forge/<host>/`) and an adapter in `flow/hosts.ts`.
3. Templates and init support for its CI system. A host on `actions` might reuse the GitHub
   workflows and the Action with small changes; that's the main reason Forgejo and Gitea look
   cheap. But:
   - launchset's own jobs (check, plan, finalize, the preview plan and comment) hard-code
     `runs-on: ubuntu-latest`; build and preview jobs already take a label per target
     (`@@runs_on@@`). Codeberg's hosted runners use labels like `codeberg-medium`, and
     self-hosted runners their own, so those jobs need a configurable label.
   - Forgejo's default runner image is a small Debian one with Node, not GitHub's Ubuntu
     image: anything the templates assume from `ubuntu-latest` needs checking.
   - `uses: actions/…` resolves from the runner's default actions URL, which isn't always
     github.com.
4. Docs, skills, and its own "To verify" list.

**A new CI system needs** a `CiProfile` (with the hosts it serves), an environment reader in
`flow/ci/`, `listJobs` from its own API instead of the forge's, run URLs from its environment,
and templates.

**Forgejo and Gitea: what we know and what to check.** Their CI (Forgejo Actions, Gitea
Actions) runs GitHub-Actions-style workflows, so they'd be served by `actions`. From their docs:
- Forgejo's workflows are "familiar, not compatible": some job keys are ignored
  (`permissions`, `continue-on-error`), OIDC uses `enable-openid-connect`, the default runner
  image is a small Debian one with Node, and the `github` context lacks some keys. The
  workflow templates need a trial there, not an assumption.
- Forgejo fires `pull_request` `labeled`, so label events work and no preview sweep is needed.
  Fork PRs get read-only tokens and no secrets, as on GitHub.
- Gitea's API has `GET /repos/{owner}/{repo}/actions/runs/{run}/jobs` (for `listJobs`); since
  which version, and whether Forgejo has the same, is open.
- Gitea documents repository push options (`repo.private`), not `ci.skip`, so
  `skipCiPushOption` would be unset (tag pushes may start tag workflows, as on GitHub).

To check before designing: which variables their runners set (whether `GITHUB_ACTIONS` is set
too, which is why GitHub Actions is detected last); whether Gitea's and Forgejo's APIs still
match closely enough for one client; release `prerelease` and latest handling; Markdown alerts
in comments; how a workflow token or access token authenticates git pushes and whether its
pushes start workflows; whether the Action (`runs.using: node24`) runs on their runners; and
how init tells them apart (`.forgejo/workflows`, `.gitea/workflows`, the remote's host name).

**Woodpecker CI** (Codeberg's ci.codeberg.org; often with self-managed Forgejo and Gitea).
Verified against its environment docs (3.20.x,
<https://woodpecker-ci.org/docs/usage/environment>):
- Detection: `CI=woodpecker` and `CI_SYSTEM_NAME=woodpecker`; it sets no `GITHUB_*` variables,
  so it doesn't collide with GitHub Actions. `detect` would be `{ variable: "CI", value:
  "woodpecker" }`.
- The forge comes from the environment: `CI_FORGE_TYPE` is `bitbucket`, `bitbucket_dc`,
  `forgejo`, `gitea`, `github` or `gitlab`, and `CI_FORGE_URL` is its root URL. So the CI
  system comes from `CI`, and the host from `CI_FORGE_TYPE` (`hostFromEnv` would need to read
  it instead of taking the CI's first host).
- The CI server is separate from the forge (`CI_SYSTEM_URL`, `CI_SYSTEM_HOST`), and
  `CI_PIPELINE_URL` is the run's web URL (`https://ci.example.com/repos/7/pipeline/8`): the
  run link must come from the environment, not from `runPath` under the repository URL.
- Repository, commit and PR: `CI_REPO` (`owner/name`), `CI_REPO_URL`; `CI_COMMIT_SHA`,
  `CI_COMMIT_REF`, `CI_COMMIT_BRANCH` (the target branch on PRs), `CI_COMMIT_SOURCE_BRANCH` and
  `CI_COMMIT_TARGET_BRANCH` (PRs only), `CI_COMMIT_TAG`; `CI_COMMIT_PULL_REQUEST` (the number)
  and `CI_COMMIT_PULL_REQUEST_LABELS` (the docs don't say how several labels are separated).
- Events: `CI_PIPELINE_EVENT` is `push`, `pull_request`, `pull_request_closed`,
  `pull_request_metadata`, `tag`, `release`, `manual` or `cron`. `pull_request_metadata` with
  `CI_PIPELINE_EVENT_REASON` `label_updated` or `label_cleared` (on Forgejo, Gitea, GitHub and
  GitLab) means `labelEvents` would be true: it's a CI trait, not the forge's.
- Run number and attempt: `CI_PIPELINE_NUMBER`; `CI_PIPELINE_RERUNS` is unset on the first
  run and counts restarts, so the attempt is reruns + 1.
- Tokens: none for the forge's API. The only credentials are `CI_NETRC_USERNAME`,
  `CI_NETRC_PASSWORD` and `CI_NETRC_MACHINE`, marked "Internal - Please don't use!" and only
  there for some images. So a Woodpecker setup needs `LAUNCHSET_TOKEN` as a secret, and
  `fallbackListsJobs` is false.

## Decided (formerly open decisions)

1. **Previews by label.** A `when: manual` preview job in every MR pipeline (it builds without
   the label, `LAUNCHSET_PREVIEW_MANUAL=true`); with the label the job runs automatically on every
   pipeline of the MR (adding the label needs a push or a new pipeline). `rebuildOnPush: false`
   makes the labeled job manual too. Optional **preview sweep**: a pipeline schedule with
   `LAUNCHSET_PREVIEW_SWEEP=true` runs `launchset preview-sweep` (job `launchset-preview-sweep`),
   which starts an MR pipeline (`POST /merge_requests/:iid/pipelines`) for each open labeled MR
   whose label was added (resource label events) after its last MR pipeline for the head commit;
   at most 10 per run, oldest label first, never fork or release MRs. It refuses with
   `rebuildOnPush: false`: that API takes no variables and the pipeline looks like any MR
   pipeline (source `merge_request_event`, user the token's bot), so the template can't build
   for it and stay manual for pushes.
2. **Release "latest" and pre-releases.** Accepted and documented: GitLab's "latest" release is
   the newest `released_at`, so a hotfix release of a lower version becomes "latest". finalize
   creates superseded partial releases before the version's own release, so the real one is
   created last.
3. **`semver` build numbers.** Kept: GitLab has no attempt counter, so the attempt is always 1
   (`core/build-number.ts` defaults a missing attempt to 1). A retried plan job computes the same
   build number again, which is what a retry of the same release should upload. (`semver` is
   rejected with previews enabled, on both hosts.)
4. **Distribution.** No CI/CD component for now: jobs install the npm package (`LAUNCHSET_CLI`,
   pinned to the version that rendered the files; `NPM_TOKEN` for the private package). A
   component needs a public GitLab project; it can come later from the same templates.
5. **Self-managed versions.** Minimum GitLab 18.2 (`trigger:strategy: mirror`; markdown alerts
   need 17.10; `workflow:auto_cancel` is older).

## To verify

Settled from the docs (docs.gitlab.com, November 2026):

- Dotenv report limits: 5 KB and 20 variables by default on self-managed (instance settings,
  17.1+); on GitLab.com 50 / 100 / 150 variables (Free / Premium / Ultimate). The plan doesn't go
  through dotenv (plan.json artifacts). `release --ci`, whose launchset.env the templates upload
  as a dotenv report, writes 14 variables and warns when the file exceeds the defaults; other
  commands (the child's build jobs add stamp, verify and mark variables) only log it at debug.
- `CI_JOB_TOKEN`: may push when the project allows it ("Allow Git push requests to the
  repository", 18.4, off by default), but those pushes never start pipelines, so it can't push the
  release branch. It may read MRs and notes and use the Releases API, but not post notes, create
  MRs or list pipeline jobs. `LAUNCHSET_TOKEN` stays required for writes.
- Markdown alerts render since 17.10, documented in lowercase (`> [!note]`), which launchset
  writes on GitLab.
- `resource_group`: waiting jobs are kept (never dropped); default process mode `unordered`
  (changeable only through the API). Auto-cancel ("conservative" default) can cancel a pipeline
  whose `interruptible: false` jobs haven't started yet: hence
  `workflow: auto_cancel: on_new_commit: interruptible` in the generated `.gitlab-ci.yml`, and the
  recovery (Run pipeline without variables) in the comments.
- A generated child can't use variables in `include` (documented): the child has a literal path.
  Child pipelines run at the parent's project, ref and commit.
- `needs: pipeline: $PARENT_PIPELINE_ID, job:` fetches artifacts from a parent job that
  succeeded; `PARENT_PIPELINE_ID` is passed by the trigger job's `variables` (forwarded by
  default).
- No trigger job skipping: a child always gets a `launchset-child.yml`, with one visible job when
  there is nothing to build (a config without visible jobs, or with every job ruled out, fails).
- `strategy: mirror` (18.2) gives the trigger job exactly the child's status; optional manual jobs
  don't block it.
- `after_script` runs in a separate shell, whatever `script` did, and before the artifacts
  upload; so an `exit 0` in `script` (the already-published case) ends the job as a success (the
  docs don't spell out `exit`; that part is plain shell).
- Variable-to-variable comparisons (`$A != $B`) are allowed in `rules: if:` (the fork check).
  Regex patterns are RE2 between `/`; `@` must be written `\x40`.
- Pipeline variables can be restricted by role: "Minimum role to use pipeline variables"
  (default Maintainer on self-managed, `no_one_allowed` for new projects in new namespaces on
  GitLab.com).

Still needs a real GitLab instance:

- `include: local` + `extends` + `!reference [.launchset-<target>, script]` inside an
  artifact-generated child (expected to work: includes merge before `!reference`).
- Whether `launchset-release`'s dotenv variables reach child jobs through `needs: pipeline:`
  (harmless either way: launchset.sh is sourced after `stamp`).
- That a job `needs`-ing an optional manual job (the MR preview plan job) is skipped until the
  manual job runs, then runs (GitLab's 13.12 behaviour), also for the `when: always` comment job.
- `author.bot` on notes isn't documented (the MR API has it since 19.5); launchset also matches
  the `project_<id>_bot_` username. Check a note posted by a project access token.
- `GET /user` with a project access token (expected: the bot user).
- `$CI_PIPELINE_ID` in a trigger job's `variables` (the docs' own example; marked job-only in the
  variables table).
- The images: `docker:29` + `docker:29-dind` with buildx and `apk add nodejs-current`,
  `cimg/android:*-node` as a non-root user with the npm prefix, Node on the hosted macOS images.
- With `strategy: mirror`, how a failed child job shows in the MR widget.
- PowerShell build jobs on a real Windows runner (Windows PowerShell 5.1 and PowerShell 7, npm's
  `.ps1` / `.cmd` shims, `exit` in a step script). Checked so far: the generated lines under
  PowerShell 7 on Linux, as a file and on stdin, with the runner's per-line error check.
- `git push -o ci.skip` on a tag push to GitLab creates no pipeline (documented).
- A child job with `needs: - job: <x> optional: true` where `<x>` isn't in the pipeline starts
  (documented for `optional`).
- The preview sweep: that an API-created MR pipeline has `CI_PIPELINE_SOURCE=merge_request_event`
  and `CI_MERGE_REQUEST_LABELS` (so the labeled rule builds), that the MR pipelines listing has
  `created_at` and a `refs/merge-requests/<iid>/…` ref per pipeline (the docs' example shows only
  id, sha, ref, status), that a label given at MR creation has a label event, and the permission
  of `POST /merge_requests/:iid/pipelines` (not documented on the endpoint; Developer assumed from
  "Run CI/CD pipeline").

## Estimate

All phases are done. Before it ships, a trial on a real GitLab project settles the "Still needs a
real GitLab instance" list.
