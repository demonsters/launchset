---
title: Release flow
description: The three workflows launchset generates, step by step.
---

`launchset init` writes three workflow files. This page explains what each one does and in which order things happen. The files are yours: they say "Safe to edit: launchset never rewrites this file".

| File | Runs on | Purpose |
| --- | --- | --- |
| `launchset-check.yml` | PRs to the base branch, maintenance branches and prerelease branches | The PR check. |
| `launchset-release.yml` | Pushes to the base branch and maintenance branches, and `workflow_dispatch` | Opens the release PR. After it is merged, builds and records the release. |
| `launchset-preview.yml` | Labeled PRs, `workflow_dispatch`, pushes to `preview.branches` | Test builds. See [Previews](/guides/previews/). |

## The PR check

`launchset-check.yml` runs on `pull_request` (opened, synchronize, reopened, edited, labeled, unlabeled). It uses the default `GITHUB_TOKEN`, because it only reads and comments.

The check passes when:

- the PR adds or changes at least one valid changeset, **or**
- the PR author is in `check.bots` (default `dependabot[bot]`, `renovate[bot]` and `renovate-bot`, Renovate's username on gitlab.com), **or**
- the PR is the release PR (head branch `launchset/release/*`, from the same repo, not a fork).

It fails on invalid changesets anywhere in `.launchset/`, on `minor` or `major` changesets in a PR to a maintenance branch, and when a version file disagrees with the root version.

It keeps **one sticky comment** per PR. With a changeset the comment shows the bump, the version this would produce and the summaries. Without one it shows how to add one.

Mark the **Changeset check** job as required in your branch protection, and every PR will have a changeset.

## The release workflow

`launchset-release.yml` has three jobs: `launchset` (decides), `build` (one job per target) and `finalize`. Concurrency is `launchset-release-<ref>-<sha>` with `cancel-in-progress: false`: every push gets its own run and none is cancelled, so the run for the release commit always builds. When pushes overlap, only the run for the branch's newest commit updates or closes the release PR (older runs say so in their summary), and the release branch is pushed with a lease, so overlapping runs can't overwrite each other.

### Job `launchset`: what mode are we in?

The job runs the action with `command: release` and a GitHub App token. It decides one of four modes and outputs it as `mode`:

| Mode | When | What happens |
| --- | --- | --- |
| `release-pr` | Changesets are pending (or merged bot PRs wait), and this isn't a release commit. | Creates or updates the release PR. |
| `publish` | HEAD is the release commit of the current version, and `v<version>` doesn't exist yet. | The `build` jobs run. |
| `ship` | `workflow_dispatch` with a `target` input. | Builds one manual target. See [Manual targets](/guides/manual-targets/). |
| `none` | Nothing to do. | The job summary may warn about commits with no changeset. |

If both could apply, **publish wins**. The release PR is opened on the next push.

#### Mode `release-pr`

launchset rebuilds the branch `launchset/release/<base branch>` from the base branch **on every run** and force-pushes it. The commit:

1. deletes the consumed changesets,
2. bumps the root version,
3. stamps the marketing version into every target's files (manual targets too),
4. prepends the changelog section.

The PR is titled `Release v1.5.0`. Its body is the changelog section that will be added, a note that merging releases every auto target, and the list of manual targets with how far behind they are. When nothing is pending anymore, launchset closes the PR with a comment.

If the next version is already taken, because a hotfix released it, launchset uses the next free patch. Example: `main` is at `1.4.0` with a pending patch, but `v1.4.1` was released from `release/1.4.x`. The release PR is `1.4.2`.

Merged bot PRs without a changeset get a generated patch entry. See [Bot PRs](/guides/bot-prs/).

#### Mode `publish`

The release PR was just merged. The version changed in this push, so HEAD is the **release commit**. launchset outputs:

| Output | Meaning |
| --- | --- |
| `matrix` | JSON list of auto targets that have **no marker yet**. Manual targets are never in it. |
| `version`, `build-number`, `channel` | The version, a build number computed once for the whole run, and `release`. |
| `release-sha` | The commit to build. Build jobs check out exactly this, never a later commit. |
| `plan` | All of the above as JSON. Later steps read it and never recompute anything. |

The release commit is the commit where the root version first became the released version, looking only along first-parent history. That is the merge commit, or the single commit of a squash or rebase merge. Not a commit on the release PR's own branch.

### Job `build`: one job per target

The `build` job has a matrix with one entry per target in `matrix`. `fail-fast` is `false`, so one failing target doesn't stop the others.

For each target:

1. **Check out `release-sha`.**
2. **`stamp`**: writes the version and build number into the target's files in this checkout. Nothing is committed.
3. **`verify`**: checks the store, registry or npm. Sets `already-published`.
4. **Your steps**: build and upload. Give each step `if: matrix.target == '<name>' && steps.verify.outputs.already-published != 'true'` so it skips when the version is already published.
5. **`mark`**: creates the marker tag `launchset/<target>@<version>` at the release commit.

`mark` also runs when `already-published` is `true`. That covers a job that uploaded but failed before marking. It uses a **fresh** App token, created right before it, because tokens expire after an hour and native builds can take longer.

The `build` job checks out with the default `GITHUB_TOKEN`, which can only read. `mark` pushes its tag with the App token instead, so no extra setup is needed.

launchset runs its git commands (commits, checkouts, pushes) **without the repo's git hooks**. An install step earlier in a job often installs hooks: husky, simple-git-hooks and lefthook do on `npm install`, and so does git-lfs. None of them has work to do for launchset's release commit, branches and tags, and a pre-push hook that runs tests, lint or `launchset check --push` would make `mark` fail after the upload. Repos that use **Git LFS** work too: launchset's commits and tags never add LFS objects. Your own git commands, and your hooks, are untouched.

A failed job is re-run from the Actions page. The plan output is reused, so the re-run has the same version and build number.

### Job `finalize`

`finalize` runs after `build` even when a build failed (`if: always()`, in `publish` and `ship` mode).

- If **every auto target has a marker**: it creates the tag `v<version>` at `release-sha` and a GitHub Release with the changelog section. On the base branch the Release is marked "latest". The Release body ends with a list of manual targets, each shown as "not shipped yet".
- Otherwise: it fails and lists the missing targets in the job summary.
- It also [supersedes](/guides/partial-releases/) older unfinished versions and, after a hotfix, [opens the changelog backport PR](/guides/hotfixes/).

## Retrying

Pushes after the release commit **do not** retry an unfinished release. When a target failed:

- Re-run the failed job in the Actions UI. Or
- Start **Launchset release** by hand (`workflow_dispatch`) without inputs. launchset finds the release commit again and builds the targets that have no marker. Or
- Release a new version. It supersedes the unfinished one.


## Try it on your machine

```sh
launchset plan                  # prints the plan as JSON, writes nothing
launchset version --dry-run     # the diff the release PR would contain
launchset status
```

## What launchset never does

- It doesn't build or upload. Your steps do.
- It never pushes to Dependabot's or Renovate's branches.
- It never commits build numbers.
- It never creates a release tag for an incomplete release.
