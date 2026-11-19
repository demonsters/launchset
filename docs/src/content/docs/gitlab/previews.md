---
title: Previews on GitLab
description: Preview builds of merge requests and branches, and prerelease branches, in GitLab CI.
---

Previews and prerelease branches work the same on GitLab as on GitHub: a preview has no side effects, and a prerelease branch gets a real version, a git tag and a release. Read [Preview builds and prerelease branches](/guides/previews/) for the concepts, versions and config (`preview.targets`, `preview.branches`, `prerelease`). This page covers what is different in CI.

The jobs are in `.gitlab/launchset.yml`, unless you set `preview: false` (then `init` doesn't write them):

| Job | What it does |
| --- | --- |
| `launchset-preview-plan` | Decides the version, build number and targets. On a prerelease branch it reserves the tag. Writes `plan.json` and the child pipeline. |
| `launchset-preview` | Triggers the child pipeline: one `preview-<target>` job per target. |
| `launchset-preview-comment` | Posts the result. Runs `when: always`, so a failed build is reported. |

Your build steps are the same hidden jobs as for releases (`.launchset-<target>` in `.gitlab/launchset-targets.yml`). Pick the upload channel with `$LAUNCHSET_CHANNEL`: `preview` and `prerelease` go to internal channels only.

## Preview an MR

GitLab starts no pipeline when you add a label to an MR, so launchset can't react to the label the way it does on GitHub. In MR pipelines the plan job works like this:

- **The MR has the label** (`launchset:preview`, or your `preview.label`): `launchset-preview-plan` runs **automatically on every pipeline of the MR**. Add the label, then push a commit or start a new pipeline: the label only counts when a pipeline starts.
- **The MR has no label**: `launchset-preview-plan` is a **manual job** (`when: manual`, `allow_failure: true`). Click play on it to build a preview without the label. Because it is optional, an unplayed preview never blocks the MR or the merge.
- **`preview.rebuildOnPush: false`**: every MR gets the manual job, label or not. A preview is built only when someone plays it.

The child pipeline and the comment job wait for the plan job. If you never play the manual job, they are skipped.

**MRs from forks never get a preview.** Their pipelines run without your project's variables, so there is no `LAUNCHSET_TOKEN` and nothing can be uploaded. A maintainer can push the branch to the project to get one.

The version is `<next>-pr.<MR number>.<pipeline number>`, for example `1.5.0-pr.123.4`. The number is the pipeline IID (`CI_PIPELINE_IID`), the GitLab counterpart of a run number.

A new push cancels the previous preview pipeline of the MR: the plan job is `interruptible` (with `workflow: auto_cancel: on_new_commit: interruptible`, which `init` writes). Once a prerelease started building, its jobs are not interruptible.

## Preview a branch

Two ways:

- **On every push.** List the branch in `preview.branches`, as on GitHub. The generated rules turn each name into a branch rule: a name without wildcards is an exact match, a glob (`*`, `**`, `?`, `{a,b}`) becomes a pattern. Branches that match `maintenanceBranches` never auto-preview.
- **By hand.** Go to **Build → Pipelines → Run pipeline**, pick the branch and set the variable `LAUNCHSET_PREVIEW` to `true`. Optionally set `LAUNCHSET_TARGET` to a comma-separated list of target names (or `all`). This needs pipeline variables to be allowed: [Token and permissions](/gitlab/token/#pipeline-variables-for-manual-runs).

The branch pipeline for a preview branch is always a branch pipeline, never an MR pipeline, even when the branch has an MR. The `workflow: rules` that `init` writes see to that.

## Prerelease branches

A `preview.branches` entry with `prerelease` works as on GitHub: a push plans `<next>-alpha.<n>`, `launchset-preview-plan` pushes the tag `v1.5.0-alpha.3` *before* the builds start (retrying with the next number when a concurrent run took it), the builds run with channel `prerelease`, and the last job creates a **GitLab release** for the tag.

- The token pushes the tag, so it needs `write_repository` and the right to create the tag. If the tag is protected, add the token's bot to **Allowed to create**. `CI_JOB_TOKEN` can't push here: pushes made with it start no pipelines. See [Token and permissions](/gitlab/token/#protected-branches-and-tags).
- GitLab releases have no `prerelease` flag. A prerelease release is a normal release for the tag, and the "Latest" release on GitLab is the one with the newest `released_at`. See [Differences from GitHub](/gitlab/reference/#differences-from-github).
- Re-running only the failed jobs reuses the plan, so the version stays the same. Running the whole pipeline again plans again and reserves a new tag.
- The check runs for MRs that target a prerelease branch.

## The result

`launchset-preview-comment` posts **one sticky note** on the MR. It holds the version, the build number per target, the Docker tags, and a result per target with a link to its job. The next run updates the same note. On a prerelease branch it writes the GitLab release body instead.

It finds each target's job by name, so keep the generated job names (`preview-<target>`). It lists the pipeline's jobs through the API, which needs `LAUNCHSET_TOKEN` with the `api` scope: `CI_JOB_TOKEN` can't list jobs, so with only the job token the note says it couldn't read the job results and lists the targets as `unknown`.

The note is posted as the token's bot user.

:::note
Mark the variable `LAUNCHSET_TOKEN` as **not Protected**. A protected variable isn't available to MR pipelines, and the comment job couldn't post.
:::

## Switch previews off

```ts
preview: false,
```

Then remove the preview jobs from `.gitlab/launchset.yml`. If you leave them, the plan job ends with a notice that previews are disabled.
