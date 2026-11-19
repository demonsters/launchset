---
title: launchset on GitLab
description: Set up launchset in a GitLab project, from init to the child pipeline, the CI files, your build steps and debugging.
---

launchset works on GitLab.com and on self-managed GitLab. The release flow is the same as on GitHub: every MR adds a changeset, launchset keeps a release MR, merging it releases every target. Only the CI part differs. This page covers that part. For the basics (changesets, targets, config), read [Getting started](/getting-started/) and [Concepts](/concepts/) first.

There is no GitHub Action on GitLab. Each CI job installs the CLI with npm and runs `launchset <command>`.

## Before you start

You need:

- **GitLab 18.2 or newer.** The generated pipeline uses `trigger:strategy: mirror`, which arrived in 18.2.
- **Merge request pipelines.** The PR check runs as an MR pipeline job. `launchset init` writes the `workflow: rules` that turn them on (see [the workflow rules](#the-workflow-rules)).
- **Runners** that can run the `node:24` image. Every job that runs launchset needs Node 24 or newer, npm and git. Docker targets use Docker-in-Docker, so that runner must allow it.
- **Read access to the private `@demonsters/launchset` package on npm.** Jobs install it with npm. You give them an `NPM_TOKEN` variable, see [Token and permissions](/gitlab/token/#npm_token).
- **A project or group access token** called `LAUNCHSET_TOKEN`. That is the counterpart of the GitHub App. See [Token and permissions](/gitlab/token/).

Node 26 is only needed on your machine, to run `init`.

## 1. Run init

In the root of your repo:

```sh
npx @demonsters/launchset init
```

`init` picks the host by looking at the repo. It uses, in this order: `LAUNCHSET_HOST`, `GITLAB_CI=true`, the host of the `origin` remote (a name that contains `gitlab` means GitLab, `github.com` means GitHub), then a `.gitlab-ci.yml` without `.github/workflows`. When these disagree it asks. The `host` decision is only listed when something points at GitLab. To answer it yourself:

```sh
npx @demonsters/launchset init --decide host=gitlab
```

Everything else is the same as on GitHub: versions, targets, conflicting release machinery, the config. On GitLab it also looks for release machinery in `.gitlab-ci.yml` and the local files it includes: jobs that run on tags, `glab release create`, the `release:` keyword, `npm publish`, Docker pushes of `latest` from branch pushes. Remote, project, template and component includes are not scanned.

### The files it writes

| File | What it is |
| --- | --- |
| `launchset.config.ts` | Your configuration. |
| `.launchset/README.md` | A short explanation for your team. |
| `.gitlab/launchset.yml` | launchset's jobs. Included by `.gitlab-ci.yml`. |
| `.gitlab/launchset-targets.yml` | **Your build steps**, one hidden job per target. |
| `.gitlab-ci.yml` | Written when you have none. Otherwise only an `include:` is added. |
| `CHANGELOG.md` | Only if you have none. |
| `.claude/skills/launchset/SKILL.md` and `AGENTS.md` | Instructions for AI agents (optional). |

Files that already exist are kept. `--decide file.<path>=overwrite` replaces one. For `.gitlab/launchset-targets.yml` that is rarely what you want: when it exists, `init` keeps your jobs and only appends the jobs of targets it has no job for.

### The `.gitlab-ci.yml` edit

When you already have a `.gitlab-ci.yml`, `init` adds one entry to its top-level `include:`:

```yaml
include:
  - local: .gitlab/launchset.yml
```

A block or flow list is extended. A single string or map becomes a list. Without an `include:` it appends one at the end of the file. If it can't edit the file, it prints the snippet for you to add. It never edits your `workflow:`.

### The stage

launchset's jobs run in one stage, ordered by `needs`. `init` uses `test` when your `stages:` list has it, else the last stage that is not `.pre` or `.post`. Without `stages:` it uses GitLab's default `test`. The summary says which one it picked. You can change `stage:` in `.gitlab/launchset.yml` by hand.

### The workflow rules

Your `.gitlab-ci.yml` should have `workflow: rules` that pick one pipeline type per push: an MR pipeline when the branch has an open MR, a branch pipeline otherwise. Without them, a push to an MR branch runs two pipelines, and launchset's own tag pushes start tag pipelines that run every job without rules.

When you have no `.gitlab-ci.yml`, `init` writes this for you. When you have one without `workflow: rules`, it prints the recommended block as a manual step and leaves your file alone (the rules decide every pipeline of the project). The block looks like this:

```yaml
workflow:
  auto_cancel:
    on_new_commit: interruptible
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    # ... preview and prerelease branches always get branch pipelines ...
    - if: $CI_COMMIT_BRANCH && $CI_OPEN_MERGE_REQUESTS && $CI_PIPELINE_SOURCE == "push"
      when: never
    - if: $CI_COMMIT_BRANCH
```

`auto_cancel: on_new_commit: interruptible` matters. GitLab's default (`conservative`) can cancel a pipeline whose `interruptible: false` jobs haven't started yet. The release job of a release commit waits for its `resource_group`, so a quick second push could cancel the pipeline that was about to publish. With `interruptible`, a new push cancels only the jobs marked `interruptible: true` (checks and previews). launchset's release jobs are never cancelled.

If the pipeline is cancelled anyway, open **Build → Pipelines → Run pipeline** on the base branch and run it without variables. That retries the unfinished release.

## 2. Add your build steps

Open `.gitlab/launchset-targets.yml`. It is **your** file: launchset reads it and never rewrites it. For each target it holds a hidden job `.launchset-<target>` with the image, services, tags, variables, `before_script` and the build steps.

For Docker targets `init` writes working steps (Docker-in-Docker, `docker buildx build --push` with the tags and labels from launchset). For Android, iOS, web and custom targets it writes commented examples and a line that always fails with `No build steps for <target> yet`. Add your steps and **delete that line**. Until then the target's job fails, `mark` never runs, and the release can't complete. That is on purpose.

A web target with its steps:

```yaml title=".gitlab/launchset-targets.yml"
.launchset-web:
  image: node:24
  script:
    - npm ci
    - npm run build
    - ./scripts/deploy-web.sh
```

The rules for these jobs are in the header of the file:

- **No `rules`, `when`, `needs` or `stage`.** The child pipeline decides when a job runs. A child pipeline whose jobs are all ruled out fails to start.
- **Node 24 or newer, npm and git in the image.** Every job runs launchset. The Docker job template installs them with `apk` in `before_script`. If you change `image:`, keep this true.
- **One command per line.** GitLab runs the lines in one shell with `set -e`, and `set -e` ignores a failure on the left of `&&`. Write `- make build` and `- make deploy`, not `- make build && make deploy`.
- **No early `exit`.** An `exit` in your script skips `mark`, and the target is never recorded as shipped.
- **`before_script` runs first**, then launchset's lines and your `script`, in one shell. launchset starts with `cd "$CI_PROJECT_DIR"` and does it again before `mark`, so your steps may change directory.
- **The variables from `stamp` are set.** `LAUNCHSET_VERSION` (plain `X.Y.Z` for iOS), `LAUNCHSET_BUILD_NUMBER`, `LAUNCHSET_CHANNEL` (`release`, `prerelease` or `preview`: pick the upload channel with it, previews go to internal channels only), `LAUNCHSET_DIST_TAG`, `LAUNCHSET_DOCKER_TAGS` and `LAUNCHSET_DOCKER_LABELS` (one per line) and `LAUNCHSET_TAG`.
- **Secrets are CI/CD variables** (Settings → CI/CD → Variables). Reference them by name only.

On GitHub the same job is a matrix entry with `if: matrix.target == ...` guards. On GitLab each target has its own job, so no guards are needed. The recipes in [Workflow recipes](/guides/recipes/) translate directly: take the commands, not the `uses:` steps.

## 3. The three flows

### Check, in MR pipelines

`launchset-check` runs in MR pipelines whose target branch is the base branch, a maintenance branch or a prerelease branch. It needs a changeset (or `bump: none`), except for bot MRs and the release MR. It posts one sticky MR note with the result. It is `interruptible`, so a new push replaces it. It skips a fork MR's pipeline that runs in the fork, which has none of your variables (see [Token and permissions](/gitlab/token/)).

### Release MR, then publish

`launchset-release` runs on pushes (and Run pipeline / API pipelines) of the base branch and the maintenance branches. It has a `resource_group` per branch, so release jobs on the same branch run one after the other, and it is never interruptible.

- With pending changesets it rebuilds the branch `launchset/release/<branch>` and opens or updates the release MR `Release v1.4.1`.
- When you merge the release MR, the push to the base branch makes it plan the release. It writes `plan.json` and the child pipeline `launchset-child.yml`.
- The job `launchset-build` triggers that child pipeline. The child has one `build-<target>` job per target to build, then `launchset-finalize`, which creates the release tag and the GitLab release once every auto target shipped.

`launchset-build` uses `strategy: mirror`: the trigger job, the pipeline and the MR get the status of the child pipeline.

### Previews

Preview jobs build an MR, a preview branch or a prerelease branch without releasing anything. See [Previews on GitLab](/gitlab/previews/).

## 4. The child pipeline

GitLab fixes the jobs of a pipeline before any job runs, so one job can't switch another on by its output (GitHub does that with `if: needs.launchset.outputs.mode == 'publish'`). So `launchset release` **writes** a second pipeline, `launchset-child.yml`, with only the jobs the plan needs. The parent triggers it. When there is nothing to build, the child is a single job, `launchset-nothing-to-build`, that prints why.

For a plan with one target `web`, the child looks like this (shortened):

```yaml title="launchset-child.yml"
include:
  - local: .gitlab/launchset-targets.yml      # your .launchset-web job

build-web:
  extends: .launchset-web                      # image, services, variables, before_script
  needs:
    - pipeline: $PARENT_PIPELINE_ID            # gets plan.json from the parent's plan job
      job: launchset-release
  interruptible: false
  script:
    - cd "$CI_PROJECT_DIR"
    - launchset stamp --target web --plan @plan.json --ci
    - . ./launchset.sh                         # exports LAUNCHSET_VERSION and the others
    - launchset verify --target web --plan @plan.json --ci
    - . ./launchset.sh
    # Already published? Only record it and stop.
    - if [ "${LAUNCHSET_ALREADY_PUBLISHED:-}" = "true" ]; then launchset mark --target web --plan @plan.json --ci; exit $?; fi
    - !reference [.launchset-web, script]      # YOUR steps
    - cd "$CI_PROJECT_DIR"
    - launchset mark --target web --plan @plan.json --ci

launchset-finalize:
  when: always                                 # also records a partial release
  needs: [...]
  script:
    - launchset finalize --plan @plan.json --ci
```

Notes:

- Each launchset command is its own script line, for the `set -e` reason above.
- When the plan's commit is not the pipeline's commit (a retry of an unfinished release, a merged results pipeline), every child job first runs `git checkout --quiet --detach <release-sha>` with `GIT_DEPTH: "0"`. Otherwise build jobs keep your project's clone depth.
- The `build-<target>` jobs are not interruptible. Preview jobs are named `preview-<target>`.
- If a target has no `.launchset-<target>` job with a `script` (or `extends`) in the targets file, `launchset release` fails before it writes the child, with a hint naming the job.

## 5. Open the first MR

```sh
git checkout -b add-launchset
git add -A
git commit -m "Add launchset"
git push -u origin add-launchset
```

Create the MR. The check job reports that the MR has no changeset. Add one with `npx @demonsters/launchset add --bump patch --message "Set up releases with launchset"`, push, and the check turns green. At the end of its output, `init` printed the manual steps still open. Do these before you merge:

1. Create `LAUNCHSET_TOKEN` and `NPM_TOKEN`: [Token and permissions](/gitlab/token/).
2. Let the token's bot push to the protected branches and create tags (usually already true).
3. Allow pipeline variables if you want to run manual targets or previews by hand.
4. Add your build steps to `.gitlab/launchset-targets.yml`.

Then merge. The release job opens `Release v1.4.1`. Merge that, and the child pipeline builds every target.

## Debugging

- **Read the child pipeline.** In `--ci` mode on GitLab, `launchset release` and `launchset preview-plan` always write `launchset-child.yml`, print it in the job log (a collapsed section named "Child pipeline launchset-child.yml") and keep it as a job artifact for 30 days.
- **Plan on your machine.** `launchset plan` prints the plan JSON. `launchset plan --gitlab -` prints the child pipeline for that plan on stdout instead, and `launchset plan --gitlab out.yml` writes it to a file (the plan JSON still goes to stdout). Both check your targets file. Use `--target`, `--version` or `--preview` to plan other runs.
- **Read the job summary.** Every command prints its summary to the job log, after the result lines.
- **Failed build job.** Retry just that job in the child pipeline. It reads `plan.json` from the parent's `launchset-release` job, so keep the parent's artifacts until you are done (30 days).
- **Unfinished release.** Run pipeline on the base branch without variables.
- `LAUNCHSET_DEBUG=1` prints stack traces.

More: [Troubleshooting](/reference/troubleshooting/#gitlab) and the [GitLab reference](/gitlab/reference/).
