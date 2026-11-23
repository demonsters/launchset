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
| `launchset-preview-sweep` | Optional. Runs only in a pipeline schedule you create: starts an MR pipeline for MRs that just got the label. See [below](#start-previews-when-the-label-is-added-preview-sweep). |

Your build steps are the same hidden jobs as for releases (`.launchset-<target>` in `.gitlab/launchset-targets.yml`). Pick the upload channel with `$LAUNCHSET_CHANNEL`: `preview` and `prerelease` go to internal channels only.

## Preview an MR

GitLab starts no pipeline when you add a label to an MR, so launchset can't react to the label the way it does on GitHub. In MR pipelines the plan job works like this:

- **The MR has the label** (`launchset:preview`, or your `preview.label`): `launchset-preview-plan` runs **automatically on every pipeline of the MR**. Add the label, then push a commit or start a new pipeline: the label only counts when a pipeline starts. With the [preview sweep](#start-previews-when-the-label-is-added-preview-sweep) set up, launchset starts that pipeline for you a few minutes after you add the label.
- **The MR has no label**: `launchset-preview-plan` is a **manual job** (`when: manual`, `allow_failure: true`). Click play on it to build a preview without the label. Because it is optional, an unplayed preview never blocks the MR or the merge.
- **`preview.rebuildOnPush: false`**: every MR gets the manual job, label or not. A preview is built only when someone plays it. The preview sweep doesn't work with this setting.

The child pipeline and the comment job wait for the plan job. If you never play the manual job, they are skipped.

**MRs from forks never get a preview.** Their pipelines run without your project's variables, so there is no `LAUNCHSET_TOKEN` and nothing can be uploaded. A maintainer can push the branch to the project to get one.

The version is `<next>-pr.<MR number>.<pipeline number>`, for example `1.5.0-pr.123.4`. The number is the pipeline IID (`CI_PIPELINE_IID`), the GitLab counterpart of a run number.

A new push cancels the previous preview pipeline of the MR: the plan job is `interruptible` (with `workflow: auto_cancel: on_new_commit: interruptible`, which `init` writes). Once a prerelease started building, its jobs are not interruptible. A preview job whose `.launchset-<target>` job (or a template it extends) sets `interruptible: false` stays that way too, for runners a cancel breaks.

## Start previews when the label is added (preview sweep)

This is optional. Without it, a labeled MR builds its preview on its next pipeline. With it, a pipeline schedule checks the open MRs every few minutes and starts a new MR pipeline for each MR that just got the label. That pipeline builds the preview, as any pipeline of a labeled MR does. Nobody has to push or click.

### Set it up

You need the Developer role (or higher) in the project, and `preview.rebuildOnPush` must be `true` (the default).

1. Go to **Build → Pipeline schedules** and select **New schedule**.
2. **Description**: `launchset preview sweep`.
3. **Interval pattern**: select **Custom** and enter `*/10 * * * *` (every 10 minutes). See [how often it can run](#how-often-it-runs).
4. **Target branch or tag**: your default branch (the base branch). The job reads the launchset config from it.
5. **Variables**: add `LAUNCHSET_PREVIEW_SWEEP` with the value `true`.
6. Leave **Activated** on and select **Create pipeline schedule**.

To try it, select **Run** (the play button) next to the schedule. The pipeline has one launchset job, `launchset-preview-sweep`, whose log lists every labeled MR and what it did.

The scheduled pipeline runs with the permissions of the schedule's owner (you). If the owner leaves the project, GitLab makes the schedule inactive. A Maintainer can then select **Take ownership** to start it again. The MR pipelines themselves are started with `LAUNCHSET_TOKEN`, so they run as the token's bot user. The token you already have is enough: starting an MR pipeline needs the `api` scope and the Developer role. If the MR's source branch is protected, the bot must also be allowed to push or merge to it.

### When a pipeline is started

For each open MR with the label, launchset looks up when the label was last added (time T, from the MR's label events). The MR gets a new pipeline unless one of its MR pipelines for the current head commit was created at or after T:

- A pipeline for the head from **before** T doesn't count. The MR had no label then, so the preview was the manual job.
- A pipeline from a push **after** T counts. It already built the preview, because the MR had the label.
- The pipeline the sweep starts counts from then on, so an MR gets at most one. Removing the label and adding it again starts another one.
- In merged results pipelines the commit is a merge commit, not the head. launchset then asks GitLab for the MR's head pipeline, which knows.
- A label set when the MR was created counts from the MR's creation, so the MR's own first pipeline covers it.

It skips MRs from forks (they never get previews) and the release MR (`launchset/release/*`). One run starts at most 10 pipelines, oldest label first; the others wait for the next run. The pipeline is a merge request pipeline like one from **Run pipeline** on the MR: detached, or merged results when the project has those on. It runs all of the MR's jobs, your tests too, not only the preview.

If a pipeline can't be started, launchset reports why, starts the others and fails the job, so the schedule shows a failed pipeline.

### How often it runs

A preview starts on the first schedule run after you add the label, plus the time the build takes. GitLab doesn't run schedules exactly on time:

- **GitLab.com**: schedules run at most every 5 minutes. On the Free tier a schedule can create at most 24 pipelines a day, so GitLab slows a 10-minute schedule down to once an hour. Paid tiers allow 288 a day, every 5 minutes.
- **Self-managed**: GitLab's schedule worker runs every 10 minutes by default (`3-59/10 * * * *`), so a schedule can't run more often than that. An administrator can change the worker's interval and the number of pipelines a schedule may create each day.
- Under load, GitLab may start a scheduled pipeline several minutes late.

The cost is one small job per interval: it installs launchset and makes a few API calls (no git history: it clones with `GIT_DEPTH: 1`). Every 10 minutes that is 144 short pipelines a day.

### Keep your own jobs out of the schedule

A scheduled pipeline is a branch pipeline of the target branch. launchset's other jobs never run in it, but **your jobs might**: a job without `rules` runs in every pipeline except MR pipelines, scheduled ones too. Your tests would then run every 10 minutes.

Add this rule at the top of each such job's `rules`:

```yaml
rules:
  - if: $LAUNCHSET_PREVIEW_SWEEP == "true"
    when: never
  # ...the job's other rules
```

For a job that has no `rules` yet, add the second line too, so it keeps running where it ran before (everywhere except MR pipelines):

```yaml
rules:
  - if: $LAUNCHSET_PREVIEW_SWEEP == "true"
    when: never
  - if: $CI_PIPELINE_SOURCE != "merge_request_event"
```

The `.gitlab-ci.yml` that `init` writes for a new project has this note in its header.

### With `rebuildOnPush: false`

Then the sweep refuses to run: its job fails with an explanation. A labeled MR's preview is a manual job in that case, so a pipeline the sweep started wouldn't build anything. GitLab's API for MR pipelines takes no variables, and such a pipeline looks like any other MR pipeline to the job's rules (its source is `merge_request_event`, its user the token's bot), so the rules can't build previews for it and stay manual for pushes. Set `rebuildOnPush` to `true` or don't create the schedule.

### Check it locally

```sh
LAUNCHSET_TOKEN=glpat-... launchset preview-sweep --dry-run
```

It lists the labeled MRs and what a run would do, without starting anything. Outside CI, launchset finds the project and the GitLab server from the `origin` remote (set `LAUNCHSET_HOST=gitlab` if its host name doesn't contain `gitlab`). `--json` prints the same as JSON; `--max <n>` changes the limit of 10.

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
