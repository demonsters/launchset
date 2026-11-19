# GitLab support: plan

Status: in progress (phases 1–3 done). Last updated 2026-11-19.

launchset runs on GitHub only today. This plan covers what it takes to also run on GitLab
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

### Phase 4: GitLab CI templates

- A CI/CD component (or `include:` templates) for the three pipelines: check, preview, release.
- `concurrency` → `resource_group` (check that a waiting release-commit pipeline is never dropped,
  which the GitHub template relies on).
- The child pipeline (decisions 2 and 3). The parent pipeline:

  ```yaml
  launchset:
    script: [launchset release --ci]          # writes plan.json, launchset.env, child.yml
    artifacts:
      reports: { dotenv: launchset.env }
      paths: [plan.json, child.yml]
  build:
    needs: [launchset]
    trigger:
      include: [{ artifact: child.yml, job: launchset }]
      strategy: depend                         # the MR shows the child's result
  ```

  The generated `child.yml`, for a plan with only `web`:

  ```yaml
  include: [{ local: .gitlab/launchset-targets.yml }]
  build-web:
    extends: .launchset-web
    needs: [{ pipeline: $PARENT_PIPELINE_ID, job: launchset }]   # gets plan.json
    script:
      - launchset stamp --target web --plan @plan.json
      - launchset verify --target web --plan @plan.json
      - !reference [.launchset-web, script]
      - launchset mark --target web --plan @plan.json
  finalize:
    needs: [build-web]
    when: always                               # records partial releases
    script: [launchset finalize --plan @plan.json]
  ```

  When the plan has nothing to build, no build jobs run (how exactly: see "To verify").
- Debuggability: `launchset` prints `child.yml` to the job log and keeps it as an artifact;
  `launchset plan --gitlab` writes it locally.
- Manual targets and previews: the same child pipeline from a different plan. Manual targets
  start from a `web` pipeline with `TARGET` / `VERSION` / `FORCE` inputs.
- The snippets (`docker`, `android`, `ios`, `custom`, `custom-npm`, `docker-login`): GitLab
  versions; Docker login uses `CI_REGISTRY` / `CI_REGISTRY_USER` / `CI_REGISTRY_PASSWORD` by default.
- Previews: see "Open decisions".

### Phase 5: `init`, docs, skills

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

## Open decisions

1. **Previews by label.** Adding a label to an MR doesn't start a pipeline on GitLab, so
   `preview.label` (`labeled` events, `core/preview.ts`) can't work as on GitHub. Options: a
   `when: manual` preview job on every MR pipeline; the label only applies on the next push; or a
   webhook (out of scope). Proposal: manual job, and the label (if set) makes it run automatically
   on push.
2. **Release "latest" and pre-releases.** GitLab releases have no `prerelease` and no
   `make_latest`; the latest release is the one with the newest `released_at`. A release of a
   lower version (hotfix on a maintenance branch) would become "latest". Options: set
   `released_at` to the original release's time for lower versions; or accept it and document.
   Prerelease releases: create them with "Pre-release" in the name, or skip them on GitLab.
3. **`semver` build numbers.** They use `run_attempt`, which GitLab doesn't have. Retrying a GitLab
   job keeps `CI_PIPELINE_IID`, so the build number would repeat. Options: use `CI_JOB_ID` (unique,
   large), or reject `semver` on GitLab.
4. **Distribution.** A GitLab CI/CD component needs a public GitLab project (like the public
   `launchset-action` repo for GitHub), or users install the npm package in the job (private
   package: needs an npm token).
5. **Self-managed versions.** Pick a minimum GitLab version (CI/CD components, `spec:inputs` and
   markdown alert blocks need a recent one).

## To verify before building

- The dotenv report limits on gitlab.com and the default on self-managed.
- Whether `CI_JOB_TOKEN` can push (there is a newer project setting for it) and read MRs, notes,
  releases and pipeline jobs; if so it could replace the access token for some commands.
- That MR notes posted by a project access token have `author.bot === true`.
- Markdown alert blocks (`> [!NOTE]`) render in GitLab MR notes and release bodies.
- `resource_group` ordering and cancellation behaviour against the release flow's needs.
- A generated child pipeline can `include:` a local file from the repo and use `!reference` on
  its jobs.
- Child jobs get the parent's `plan.json` through `needs: pipeline: $PARENT_PIPELINE_ID`.
- How to skip the trigger job when there is no `child.yml` (`rules` can't see artifacts):
  probably always write a `child.yml`, with a single no-op job when there is nothing to build.
- With `strategy: depend`, a failed or manual child job shows correctly on the parent pipeline
  and in the MR.

## Estimate

Phases 1–3: a few days of focused work. Phases 4–5 are larger: phase 4 needs a trial on a real
GitLab project to settle the "To verify" list.
