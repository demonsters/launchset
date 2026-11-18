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

## Frequently asked questions

**Does launchset build my app?** No. It plans, stamps, checks and records. Your steps build and upload.

**Where are build numbers stored?** Nowhere. They are computed in CI and never committed. The default is the time since 2020-01-01 in seconds.

**Where does launchset keep state?** In git tags: marker tags, release tags and partial tags.

**Can I release only one target?** Not as part of a release: every release builds every auto target. Manual targets are shipped on demand. See [Manual targets](/guides/manual-targets/).

**Can I edit the release PR?** Don't. The branch is rebuilt and force-pushed on every run. Change the changesets on the base branch instead.

**Can I use another CI system?** No. GitHub Actions only.

**Commit messages? Conventional commits?** They don't matter. Release intent lives in changesets only.

**Why does the PR check complain about my bot's PR?** Add the bot's login to `check.bots`, or have it add a changeset. See [Bot PRs](/guides/bot-prs/).

**How do I stop launchset?** Delete the three workflows, `launchset.config.ts` and `.launchset/`. Existing tags stay.
