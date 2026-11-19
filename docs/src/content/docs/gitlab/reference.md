---
title: GitLab reference
description: Job names, variables, output files and the differences from GitHub.
---

Everything here is read from the generated files and the code. For the setup, see [launchset on GitLab](/gitlab/getting-started/).

## Jobs

Parent pipeline, in `.gitlab/launchset.yml`:

| Job | Runs in | What it does |
| --- | --- | --- |
| `launchset-check` | MR pipelines into the base, maintenance and prerelease branches (not a fork MR's pipeline in the fork) | The changeset check and its sticky MR note. `interruptible`. |
| `launchset-release` | Pushes, and Run pipeline / API pipelines, of the base and maintenance branches | Updates the release MR, or plans the release. Writes `plan.json`, `launchset.env`, `launchset.sh` and `launchset-child.yml`. `resource_group: launchset-release-$CI_COMMIT_REF_SLUG`, not interruptible. |
| `launchset-build` | Same as `launchset-release` | Trigger job. Runs the child pipeline with `strategy: mirror`. Passes `PARENT_PIPELINE_ID`. |
| `launchset-preview-plan` | MR pipelines (automatic with the label, else manual), preview and prerelease branch pushes, Run pipeline with `LAUNCHSET_PREVIEW=true` | Plans a preview or prerelease. |
| `launchset-preview` | Same conditions | Trigger job for the preview child pipeline. |
| `launchset-preview-comment` | Same conditions, `when: always` | The sticky MR note, or the prerelease GitLab release. |
| `launchset-preview-sweep` | Only scheduled pipelines with `LAUNCHSET_PREVIEW_SWEEP=true` (a [schedule you create](/gitlab/previews/#start-previews-when-the-label-is-added-preview-sweep)) | `launchset preview-sweep`: starts an MR pipeline for open MRs that just got the preview label. `GIT_DEPTH: "1"`, `interruptible`. No other launchset job runs in that pipeline. |

Hidden templates: `.launchset-cli` (the `node:24` image, `GIT_DEPTH: "0"`, the install lines) and `.launchset-release-rules`. Jobs run in one stage (see [the stage](/gitlab/getting-started/#the-stage)).

Child pipeline (`launchset-child.yml`):

| Job | What it does |
| --- | --- |
| `build-<target>` | A release build of one target: `stamp`, `verify`, your steps, `mark`. |
| `preview-<target>` | A preview build: `stamp`, your steps. |
| `launchset-finalize` | `when: always`. Creates the release tag and the GitLab release, or records a partial release. Release pipelines only. |
| `launchset-nothing-to-build` | The only job when there is nothing to build (a release MR update, `none` mode, a skipped preview). Prints why. |
| `.launchset_cli` | Hidden. The child's own CLI template. |

Your hidden jobs in `.gitlab/launchset-targets.yml` are `.launchset-<target>`.

## Pipeline variables (Run pipeline)

Set on **Build → Pipelines → Run pipeline** or through the API. They need [pipeline variables to be allowed](/gitlab/token/#pipeline-variables-for-manual-runs).

| Variable | Where | Effect |
| --- | --- | --- |
| none | Base or maintenance branch | Retries an unfinished release of the current version. |
| `LAUNCHSET_TARGET=<name>` | Base or maintenance branch | Ships a manual target. See [Manual targets](/guides/manual-targets/). |
| `LAUNCHSET_RELEASE_VERSION=<version>` | With `LAUNCHSET_TARGET` | The released version to ship. Default: the latest release on the branch. |
| `LAUNCHSET_FORCE=true` | With `LAUNCHSET_TARGET` | Ships even when the target already shipped a higher version. |
| `LAUNCHSET_PREVIEW=true` | Any branch | Builds a preview of the branch instead of releasing. |
| `LAUNCHSET_TARGET=<names>` | With `LAUNCHSET_PREVIEW=true` | The targets to preview (comma-separated, or `all`). |

`LAUNCHSET_PREVIEW_MANUAL=true` is set by the manual preview job in MR pipelines. You don't set it yourself.

## Schedule variables

| Variable | Where | Effect |
| --- | --- | --- |
| `LAUNCHSET_PREVIEW_SWEEP=true` | A pipeline schedule (Build → Pipeline schedules) on the default branch | Runs only `launchset-preview-sweep`. Your jobs without `rules` run there too unless you exclude them: see [Keep your own jobs out of the schedule](/gitlab/previews/#keep-your-own-jobs-out-of-the-schedule). |

## The `--ci` files

Every command that produces outputs takes `--ci`. It is on by default when `GITLAB_CI=true`; `--no-ci` turns it off. It writes, to the working directory:

| File | Variable to move it | Content |
| --- | --- | --- |
| `plan.json` | `LAUNCHSET_PLAN_FILE` | The plan. Pass it on with `--plan @plan.json`. |
| `launchset.env` | `LAUNCHSET_DOTENV` | A dotenv report (`artifacts:reports:dotenv`): `NAME=value`, values with line breaks left out. |
| `launchset.sh` | `LAUNCHSET_SHELL_ENV` | The same variables as `export NAME='value'`, multi-line values included. `. ./launchset.sh` loads them. |
| `launchset-child.yml` | `LAUNCHSET_CHILD_PIPELINE` | The child pipeline. Only `release` and `preview-plan`, always. |

Commands in one job merge into the same files. The plan doesn't go through the dotenv file, because GitLab limits it to 5 KB and 20 variables on self-managed (more on GitLab.com, by tier). `launchset-release` keeps `launchset.env` as a dotenv report for your own later jobs; `release` writes 14 variables and warns when the file is over those defaults. In the build jobs, where stamp, verify and mark add more, nothing uploads the file, so going over is only a debug message (`LAUNCHSET_DEBUG=1`).

These files never count as uncommitted changes, also when they come from a parent job's artifacts (finalize needs a clean working tree for the changelog backport). Other untracked files do: launchset's jobs therefore set `cache: []`, and `launchset-release` sets `dependencies: []` so no artifacts of earlier stages land in its checkout.

**Naming rule.** Every output except `plan` becomes `LAUNCHSET_` plus its name in upper snake case: `already-published` is `LAUNCHSET_ALREADY_PUBLISHED`, `release-sha` is `LAUNCHSET_RELEASE_SHA`, `dist-tag` is `LAUNCHSET_DIST_TAG`, `docker-tags` is `LAUNCHSET_DOCKER_TAGS`. The exported variables of `stamp` and `ship` (`LAUNCHSET_VERSION`, `LAUNCHSET_BUILD_NUMBER`, `LAUNCHSET_CHANNEL`) are added as they are and win on a clash. The outputs per command are in the [Action reference](/reference/action/#outputs) (same names); `launchset <command> --help` lists the main ones.

See also [CLI reference](/reference/cli/).

## Variables launchset reads

| Variable | Used for |
| --- | --- |
| `LAUNCHSET_TOKEN` | The access token. The first choice. See [Token and permissions](/gitlab/token/). |
| `GITLAB_TOKEN` | The token when `LAUNCHSET_TOKEN` is not set. |
| `CI_JOB_TOKEN` | Reads only (merge requests, notes, releases). Never used for pushes. |
| `NPM_TOKEN` | Reads the private package when a job installs the CLI. |
| `LAUNCHSET_CLI` | What jobs install with npm. Default `@demonsters/launchset@<version that wrote the files>`. |
| `LAUNCHSET_HOST` | `github` or `gitlab`. Overrides detection. |
| `LAUNCHSET_TARGET`, `LAUNCHSET_RELEASE_VERSION`, `LAUNCHSET_FORCE` | The inputs of a manual run (above). |
| `LAUNCHSET_PREVIEW`, `LAUNCHSET_PREVIEW_MANUAL` | Preview runs (above). |
| `LAUNCHSET_PREVIEW_SWEEP` | The preview sweep schedule (above). Read by the job's rules only. |
| `LAUNCHSET_PLAN` | The plan JSON, for `--plan`. |
| `LAUNCHSET_DEBUG` | `1` prints stack traces. |
| `CI_*` | Predefined variables: `CI_PIPELINE_SOURCE`, `CI_COMMIT_BRANCH`, `CI_COMMIT_SHA`, `CI_COMMIT_TAG`, `CI_PROJECT_PATH`, `CI_SERVER_URL`, `CI_API_V4_URL`, `CI_PIPELINE_ID`, `CI_PIPELINE_IID`, `CI_JOB_NAME`, `CI_MERGE_REQUEST_*`. |

Host detection: `LAUNCHSET_HOST`, else `GITLAB_CI=true` means GitLab, else `GITHUB_ACTIONS=true` means GitHub, else the host of the `origin` remote (a name with `gitlab` in it means GitLab), else GitHub. An invalid `LAUNCHSET_HOST` is an error.

Pipeline events: `merge_request_event` is a check or preview of an MR (also the MR pipelines the preview sweep starts); `push` is a branch push; `web`, `api` (and `trigger`, `pipeline`, `chat`) count as a manual run with the inputs above; `parent_pipeline` is a child pipeline and takes the MR of its parent; `schedule` runs only the preview sweep.

## The `preview-sweep` command

`launchset preview-sweep [--dry-run] [--max <n>]` is GitLab only. It lists the open MRs with `preview.label`, finds when the label was last added to each (its label events), and starts an MR pipeline unless one of the MR's pipelines for its head commit was created at or after that time. At most `--max` (10) per run, oldest label first; fork MRs and the release MR are skipped. It reports every MR (`--json`: `mergeRequests[]` with `outcome` `created`, `would-create`, `skipped` or `failed`) and exits `1` when a pipeline couldn't be started. It needs `LAUNCHSET_TOKEN` and refuses when `preview.rebuildOnPush` is false. API calls: `GET /projects/:id/merge_requests?state=opened&labels=…`, `GET …/merge_requests/:iid/resource_label_events`, `GET …/merge_requests/:iid/pipelines`, `GET …/merge_requests/:iid` (the head pipeline, only after a merged results pipeline) and `POST …/merge_requests/:iid/pipelines`. See [the CLI reference](/reference/cli/#launchset-preview-sweep).

## Differences from GitHub

| | GitHub | GitLab |
| --- | --- | --- |
| How CI runs launchset | The action `demonsters/launchset-action` | `launchset <command>` in a `node:24` job. There is no GitLab equivalent of the Action. |
| Dynamic pipeline | `if:` on a job's outputs | A generated child pipeline |
| Where build steps go | The `build` job in `launchset-release.yml` | `.launchset-<target>` jobs in `.gitlab/launchset-targets.yml` |
| Token | A GitHub App | An access token in `LAUNCHSET_TOKEN` |
| MR words | PR, `#N` | MR, `!N`, links to `/-/merge_requests/N` |
| Run link | `/actions/runs/N` | `/-/pipelines/N` |
| Preview by label | Starts when the label is added | Automatic on every pipeline of a labeled MR; otherwise a manual job. No label events: the optional preview sweep schedule starts a pipeline a few minutes after the label is added. |
| Markdown alerts in notes | `> [!NOTE]` | `> [!note]` (lowercase, what GitLab documents; rendered since 17.10) |
| Releases | A pre-release flag, `make_latest` | No prerelease flag, no "latest" flag. "Latest" is the release with the newest `released_at`. A hotfix release of a lower version therefore becomes the "latest" one. |
| `semver` build numbers | Use the run attempt | Always attempt 1: GitLab has no attempt counter. A retried plan job computes the same number, which is what a retry should upload. |
| Concurrency | `concurrency` groups, one waiting run | `resource_group`, which keeps every waiting job. The order isn't guaranteed; the release flow handles that. |
| Run number | `GITHUB_RUN_NUMBER` | `CI_PIPELINE_IID` |
| Fork PRs | No secrets: no preview | No project variables: no preview, and no check in the fork's own pipeline (run the MR's pipeline in your project to check it) |
| Bot PRs (`check.bots`) | `dependabot[bot]`, `renovate[bot]` | `renovate-bot` is also a default. Self-managed instances name their bots themselves: add yours to `check.bots`. |
| Jobs summary | The job summary | The job log |
| Repository path | `owner/repo` | `group/subgroup/project` (nested groups) |

launchset finalize creates superseded partial releases before the version's own release on GitLab, so the real release is created last and is the "latest".

## Known limitations

GitLab support is written from GitLab's documentation and tested against recorded API responses. These points have not been verified on a real GitLab instance yet. Report anything that behaves differently.

- `include: local` with `extends` and `!reference [.launchset-<target>, script]` inside an artifact-generated child pipeline. The documentation says includes merge before `!reference`.
- Whether the dotenv variables of `launchset-release` reach child jobs through `needs: pipeline:`. It doesn't matter for launchset, which loads `launchset.sh` after `stamp`.
- A job that `needs` an optional manual job (the MR preview plan job) should be skipped until the manual job runs, and then run. This includes the comment job with `when: always`.
- How launchset recognizes its own sticky note: GitLab doesn't document `author.bot` on notes, so it also matches the `project_<id>_bot_` username. Check a note posted by a project access token on your instance.
- `GET /user` with a project access token should return the bot user, which sets the commit identity.
- `$CI_PIPELINE_ID` as a variable of a trigger job (GitLab's own example uses it, but the variables table marks it job-only).
- The Docker, Android and macOS templates: `docker:29` with `docker:29-dind` and `apk add nodejs-current`, `cimg/android` as a non-root user with an npm prefix, and Node on hosted macOS runners.
- With `strategy: mirror`, how a failed child job shows in the MR widget.

Also remember: GitLab 18.2 or newer is the minimum, there is no CI/CD component (jobs install the npm package), and no static pipeline mode (the generated child pipeline is the only shape, so a policy that forbids child pipelines can't use launchset yet).
