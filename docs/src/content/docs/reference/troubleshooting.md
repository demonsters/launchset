---
title: Troubleshooting and FAQ
description: Symptoms, causes and fixes for the problems people hit most often.
---

Every launchset failure prints `error:` and, where it can, a `hint:`. Read the hint first. Run the CLI with `LAUNCHSET_DEBUG=1` for a stack trace. In workflows, open the job summary: every command writes one.

## The release PR has no CI runs

**Cause.** The PR was opened with the default `GITHUB_TOKEN`. Events caused by that token don't start other workflows, so the PR gets no checks, and a required check blocks the merge forever.

**Fix.** Open it with the GitHub App token:

1. In `launchset-release.yml`, the `launchset` job must create the token (`actions/create-github-app-token`) and pass it to the action as `token`, and to `actions/checkout` as `token`.
2. The secrets `LAUNCHSET_APP_ID` and `LAUNCHSET_APP_PRIVATE_KEY` must exist and be available to this repo.
3. The App must be installed on this repo.

See [GitHub App setup](/github-app/). Close the old release PR (or let launchset close it) and push to the base branch again.

## `refusing to allow a GitHub App to create or update workflow ... without workflows permission`

**Cause.** The release branch is rebuilt from the base branch and force-pushed. When the base branch changed a file in `.github/workflows/` since the last release PR push, GitHub only allows that push with the **Workflows** permission.

**Fix.** Give the App **Workflows: read & write** (App settings → Permissions & events). After you change permissions, an owner of the org has to **accept the new permissions** for the installation (GitHub shows a banner and sends an email). See [GitHub App setup](/github-app/#permissions).

## `mark` fails with `Authentication required: You must have push access to verify locks`

**Cause.** The repo uses Git LFS, and launchset 1.0.2 or older ran git-lfs's pre-push hook on its pushes. The `build` job's checkout persists the read-only `GITHUB_TOKEN`, and the hook sent that token to the lock check instead of the App token. The image or app was built and uploaded, but `mark` failed, so `finalize` didn't release either.

**Fix.** Update launchset (`demonsters/launchset-action@v1` picks up new releases). From 1.0.3 on, launchset runs git without the repo's hooks, git-lfs's included. Then start **Launchset release** by hand (`workflow_dispatch`) without inputs. It builds the targets without a marker again (with `verify`, the existing uploads are found and the build is skipped), then `mark` and `finalize` finish the release. On an older version, add `git config lfs.locksverify false` as a step before `mark` in `launchset-release.yml`.

## `mark` or the release PR fails in a git hook (`pre-push`, `reference-transaction`, ...)

**Cause.** launchset 1.0.2 or older ran the repo's git hooks on its own pushes, checkouts and commits. A job that installs dependencies before launchset runs (most build jobs) also installs husky, simple-git-hooks or lefthook hooks, and a pre-push hook then ran your tests, lint or `npx @demonsters/launchset check --push` (which can't reach the private package in CI) during `mark`.

**Fix.** Update launchset: from 1.0.3 on, it runs git without the repo's hooks. On an older version, set `HUSKY=0` (husky) or `SKIP_SIMPLE_GIT_HOOKS=1` (simple-git-hooks) for the job, or install dependencies after `mark`.

## `The token lacks access. The GitHub App needs "Contents: read & write"...`

The App isn't installed on this repository, or the token comes from another App. Install it on the repo (App settings → Install App) and check the secrets.

## `no launchset config found in ...`

launchset looks for `launchset.config.ts`, `.mts`, `.mjs`, `.js` or `.json` in the working directory. Run it from the repo root, pass `--cwd <dir>`, or in the action set `working-directory`. For the CLI, the nearest parent folder with a config is used.

`found more than one launchset config`: keep one file.

## The check says "this PR adds no changeset", but I added one

- The changeset must be **added or changed in this PR**. One that is already on the base branch doesn't count.
- It must be in `.launchset/` and end in `.md`. `README.md` is not a changeset.
- Read the check comment for **Problems**: an invalid changeset anywhere in `.launchset/` fails the check, with the file and line.
- A renamed changeset counts only when its content changed too.

## The check fails with `version mismatch`

A version file disagrees with the root version, usually because someone edited it by hand. The message lists the files and the values. Undo the edit. Versions are written by the release PR only. `launchset status` shows the same list locally.

## The check fails on a maintenance branch

On `release/X.Y.x` only `patch` and `none` changesets are allowed. Change the bump, or move the change to the base branch. See [Hotfixes](/guides/hotfixes/).

## No release PR appears after merging

1. Open the **Launchset release** run for the push and read the job summary of the `launchset` job. It names the mode.
2. `none` with "no pending changeset" means no changeset is on the base branch. Add one.
3. `none` with "Only bump: none changesets are pending" is correct: nothing to release.
4. Check the run has `fetch-depth: 0` and the App token.
5. `launchset plan` on your machine shows the same decision.

## A target's job fails with "No build steps for <target> yet"

The generated workflow has a step named **Build steps missing (<target>)** for android, ios, web and custom targets without npm publishing. It always fails (`exit 1`), so `mark` never records a target that nothing builds, and the release can't complete.

**Fix.** Add the target's real build and upload steps, then **delete the guard step** from `launchset-release.yml` (and `launchset-preview.yml`). If you delete the guard without adding steps, the job succeeds, `mark` records the target as shipped and the release completes without building it. Check that every auto target has steps before you remove its guard.

If you got there anyway, the markers exist and the release can't be re-run. Add the steps and release a new version. (Deleting tags by hand is possible but risky. Don't, unless you know exactly what depends on them.)

## The `build` job didn't run

The job only runs in `publish` and `ship` mode, and when the `matrix` isn't `[]`. An empty matrix means every auto target already has a marker for this version. Check the `launchset` job's outputs.

## A release is unfinished and a push didn't retry it

By design, pushes after the release commit don't retry. Re-run the failed job, start **Launchset release** by hand without inputs, or release a new version. See [Release flow](/guides/release-flow/#retrying) and [Partial releases](/guides/partial-releases/).

## `Google Play ... already has versionCode ... Raise buildNumber.offset`

The store has a build number that is greater than or equal to this run's. Set `buildNumber.offset` to the suggested value (rounded up from the minimum) in the config. See [Build numbers](/guides/build-numbers/).

## verify: `LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON isn't valid JSON ...` or `... needs the environment variable ...`

The `verify` step has no credentials. Pass the secrets to that step as `env:`. See [Workflow recipes](/guides/recipes/#the-verify-steps-environment) and [Store pipelines](/store-pipelines/).

## verify: the Docker registry answers 401 or 403

For a private package the registry check needs read access before it runs. Log in with `docker/login-action` **before** the `verify` step and give the job `packages: write` (or `read`). Or set `LAUNCHSET_REGISTRY_USERNAME` and `LAUNCHSET_REGISTRY_PASSWORD`. See [Docker](/targets/docker/#verify).

## verify: a network or auth error stops the build

By design: a check that can't answer is never treated as "not published". Fix the credentials or the network and re-run the job.

## The preview comment lists a target as `unknown`

The comment finds a target's result by the name of its job. Keep the preview build job named `Preview ${{ matrix.target }}` (or `Build ...`). When the jobs can't be listed with the App token, `GITHUB_TOKEN` with `actions: read` is tried: the generated comment job sets both.

## No preview is built for my PR

- The PR needs the label `launchset:preview` (`preview.label`). Adding other labels does nothing.
- **Fork PRs** are skipped. The job summary says so.
- With `preview.rebuildOnPush: false`, only adding the label builds.
- `preview: false` switches previews off.
- Pushes only build for branches in `preview.branches`. Maintenance branches never auto-preview.

## A prerelease tag can't be reserved

The tag is pushed with the App token. Pass it as `token` to `preview-plan` and to `actions/checkout`. If tag rules protect the tag, add the App to their bypass list.

## Tag-triggered workflows run twice, or run for launchset's tags

launchset pushes its tags with an App token, and those pushes **do** start `on: push: tags` workflows. Remove the old trigger. `launchset init` offers this. See [Migrating](/guides/migrating/#retire-what-conflicts). The partial tag (`launchset/partial/<version>`) is outside `v*` on purpose.

## `ship` says `HEAD ... is not at v1.4.0`

A hand-made build must come from the released commit. Run the `git checkout v1.4.0` the message prints, then `launchset ship` again.

## `init` says `launchset.config.ts already exists`

`init` doesn't overwrite a config. Delete the file to start over, or run `launchset init --convert-only` to only convert Changesets files.

## `android is an auto target: it ships with every release`

`launchset ship` and the `target` input are only for targets with `release: "manual"`. To retry an unfinished release, start the workflow without `target`.

## Gradle errors: values must be literals

launchset edits literal `versionCode` and `versionName` in `defaultConfig`. Dynamic values, duplicates and flavor overrides are errors. Move the values to `gradle.properties` and use `source.kind: "gradle-properties"`. See [Android](/targets/android/#gradle).

## The release PR has the wrong version

The next version is the current version plus the highest bump, then the next free patch if that version is already taken. A released hotfix, or markers from a partly shipped version, take a version. The job summary notes: "`1.4.1` is already taken ... so the release PR uses `1.4.2`".

## GitLab

Errors on GitLab print `error:` and a `hint:` too. These are the ones you are most likely to hit. For the setup, see [launchset on GitLab](/gitlab/getting-started/) and [Token and permissions](/gitlab/token/).

### `needs a GitLab token ... and the project`

No `LAUNCHSET_TOKEN` is available to the job (or `--token` locally). Add the CI/CD variable. A protected variable is only passed to pipelines of protected branches and tags: the check in an MR pipeline then fails with this error. Mark the variable **not Protected**. Fork MR pipelines get no project variables at all.

### GitLab API 401

The token is invalid, expired or revoked. `LAUNCHSET_TOKEN` must be a valid project or group access token with the `api` scope. If the message says `CI_JOB_TOKEN was rejected`, there is no `LAUNCHSET_TOKEN` and the job token ended with its job.

### GitLab API 403

The token needs the `api` scope and at least the Developer role (Maintainer to push to protected branches and tags). Check the scopes and the bot's role under Settings → Members. If the message says `CI_JOB_TOKEN can't do this`, the job fell back to the job token, which can only read merge requests and notes. Set `LAUNCHSET_TOKEN`.

### The check or a preview can't post its note (job token)

`CI_JOB_TOKEN` can't post merge request notes, create MRs or list pipeline jobs. Same cause and fix as the 403 above: set `LAUNCHSET_TOKEN`, not Protected, so MR pipelines get it.

### GitLab API 404

`Not found. Check that group/project exists and that the token has access to it`. GitLab answers 404 when a token can't see a resource. Check that the token belongs to this project (or a group that contains it) and hasn't been moved. A group token needs its bot as a member of the project.

### A push is rejected: protected branch or tag

`A protected branch or tag blocks this push.` launchset pushes `launchset/release/<branch>` and its tags (marker, release, partial and prerelease tags). Give the token the Maintainer role, or add its bot user (or Maintainers) to **Allowed to push and merge** for the protected branch and **Allowed to create** for the protected tag (Settings → Repository). Don't protect `launchset/release/*` against force pushes.

### A push is rejected: push rule or hook

`A GitLab push rule or server hook declined this push.` Read the remote's message above it. launchset commits as the token's user: allow that user's email and name in the push rules (Settings → Repository → Push rules).

### The release MR gets no pipeline

The release branch was pushed with the job token, or `LAUNCHSET_TOKEN` is missing: pushes made with `CI_JOB_TOKEN` never start pipelines. The hint reads `No token was given, so git used the runner's CI_JOB_TOKEN`. Set `LAUNCHSET_TOKEN`. Close the old release MR and run **Run pipeline** on the base branch without variables.

### `Clone the full history (set GIT_DEPTH: "0" on the job)`

The job has a shallow clone, so the MR head, the base branch or the tags are missing. The generated jobs set `GIT_DEPTH: "0"`. If you override it in your own `variables:` or in the project's CI/CD settings (Git shallow clone), or set `GIT_STRATEGY: none`, set it back for the launchset jobs.

### `.launchset-<target>` is missing from the targets file

`launchset release` (or `preview-plan`) fails before it writes the child pipeline: `.gitlab/launchset-targets.yml` has no `.launchset-<target>` job with a `script` (or `extends`) for a target it has to build. Add the job (`init` writes one per target), and keep the name exact, with the leading dot. A job that may come from the file's own `include:` is only a warning. The file must be at the repository root, at that path.

### The child pipeline is empty or invalid

- **`launchset-nothing-to-build`** is the only job: that is the correct result when there is nothing to build (the run only updated the release MR, `none` mode, a skipped preview). The job prints why.
- **The trigger job fails** with a pipeline configuration error: open `launchset-child.yml` in the plan job's log (a collapsed "Child pipeline" section) or its artifact. A typical cause is a `.launchset-<target>` job with `rules`, `when`, `needs` or `stage`: remove them. A child whose jobs are all ruled out fails to start. Reproduce it with `launchset plan --gitlab -`.
- A target job fails right away with `No build steps for <target> yet`: the guard line in `.gitlab/launchset-targets.yml` is still there. Add the steps and delete it.

### A build job didn't stop at `mark`, or `mark` didn't run

Check your steps in `.launchset-<target>`: one command per line (no `a && b`), and no `exit`. GitLab ignores a failure on the left of `&&` under `set -e`, and an `exit` skips `mark`.

### Pipeline variables are blocked

Run pipeline rejects `LAUNCHSET_TARGET`, `LAUNCHSET_PREVIEW` and the others, or they have no effect: **Minimum role to use pipeline variables** (Settings → CI/CD → Variables) is above your role. New projects on GitLab.com default to `no_one_allowed`. Change it to Developer or Maintainer, or run without variables (that only retries an unfinished release).

### A newer push cancelled the release pipeline

GitLab's default auto-cancel can cancel a pipeline whose release job hasn't started yet. Add `workflow: auto_cancel: on_new_commit: interruptible` to `.gitlab-ci.yml` (`init` writes it for a new file, and prints it as a manual step for an existing one). Recover the release with Run pipeline on the base branch without variables.

### Two pipelines for every push

Your `.gitlab-ci.yml` has no `workflow: rules`. Add the rules `init` printed: MR pipelines for branches with an open MR, branch pipelines otherwise.

### No preview for my MR

- The MR has the label, but nothing runs: GitLab starts no pipeline when a label is added. Push a commit or start a new pipeline, or set up the [preview sweep](/gitlab/previews/#start-previews-when-the-label-is-added-preview-sweep). Without the label, play the manual job `launchset-preview-plan`.
- The preview sweep is set up, but nothing starts: open the schedule's last pipeline (Build → Pipeline schedules) and read the `launchset-preview-sweep` log, which says what it did for each labeled MR. Check that the schedule is active (it goes inactive when its owner leaves the project) and has the variable `LAUNCHSET_PREVIEW_SWEEP=true`. On GitLab.com Free a schedule runs at most once an hour.
- **Fork MRs** never get a preview.
- With `preview.rebuildOnPush: false` every MR has only the manual job.
- `preview: false` switches previews off.

See [Previews on GitLab](/gitlab/previews/).

### The preview sweep fails

- `preview.rebuildOnPush is false, so on GitLab every MR's preview is a manual job`: the sweep can't help with that setting. Set `rebuildOnPush: true`, or delete the schedule.
- `preview-sweep starts MR pipelines, which needs LAUNCHSET_TOKEN`: the schedule's pipeline has no `LAUNCHSET_TOKEN`. If the variable is Protected, the schedule's target branch must be protected too (the default branch usually is).
- `GitLab API POST …/merge_requests/<iid>/pipelines failed (403)`: the token needs the `api` scope and at least the Developer role; for a protected source branch its bot must be allowed to push or merge to it. The other MRs still got their pipelines.
- `failed (400)` with a message such as `No stages / jobs for this pipeline`: GitLab couldn't create the MR pipeline. Check that `.gitlab-ci.yml` runs merge request pipelines (its `workflow: rules`) and is valid on the MR's branch.
- `preview-sweep is for GitLab only`: on GitHub, adding the label starts the preview workflow by itself. There is nothing to schedule.

## Frequently asked questions

**Does launchset build my app?** No. It plans, stamps, checks and records. Your steps build and upload.

**Where are build numbers stored?** Nowhere. They are computed in CI and never committed. The default is the time since 2020-01-01 in seconds.

**Where does launchset keep state?** In git tags: marker tags, release tags and partial tags.

**Can I release only one target?** Not as part of a release: every release builds every auto target. Manual targets are shipped on demand. See [Manual targets](/guides/manual-targets/).

**Can I edit the release PR?** Don't. The branch is rebuilt and force-pushed on every run. Change the changesets on the base branch instead.

**Can I use another CI system?** GitHub Actions and GitLab CI. See [launchset on GitLab](/gitlab/getting-started/).

**Commit messages? Conventional commits?** They don't matter. Release intent lives in changesets only.

**Why does the PR check complain about my bot's PR?** Add the bot's login to `check.bots`, or have it add a changeset. See [Bot PRs](/guides/bot-prs/).

**How do I stop launchset?** Delete the three workflows, `launchset.config.ts` and `.launchset/`. Existing tags stay.
