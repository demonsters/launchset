---
name: launchset
description: Load this whenever you change code in a repo that contains launchset.config.* or a .launchset/ folder, before you open a pull request or push to the base branch there, and when asked to bump a version, edit CHANGELOG.md, or create a tag or release. launchset releases the repo from changeset files, so every PR needs a changeset, and each changelog bullet must be about one change. This skill says how to write changesets, when to split them, which bump to pick, and what never to edit by hand (version numbers, build numbers, CHANGELOG.md, release tags, the release PR).
---

# launchset: releases in this repo

This repo is released with launchset. One version drives every target (Docker images, Android, iOS, web). You describe each change in a small **changeset** file in `.launchset/`. launchset collects the changesets into a release PR (`Release vX.Y.Z`). Merging that PR is the release.

Commit messages don't matter. Release intent lives in changeset files only.

On GitLab the same applies with "MR" for "PR": the release MR is `Release vX.Y.Z` on the branch `launchset/release/<branch>`. See [On GitLab](#on-gitlab).

## Every PR needs a changeset

Before you open a PR, make sure it adds at least one, and that no summary crams several changes into one bullet (see [One changeset per change](#one-changeset-per-change)). Create each with:

```sh
npx @demonsters/launchset add --bump <major|minor|patch|none> --message "<summary>"
```

For a change that needs no release (docs, CI, tests only) use `--empty`, which is `bump: none`:

```sh
npx @demonsters/launchset add --empty
```

The command prints the path of the new file, for example `.launchset/brave-lions-sing.md`. Commit it with your change. For a PR with three changes, run it three times.

If `npx` can't run it (the package is private, so npm authentication may be missing, and it needs Node 26 or newer), write the file by hand. Name it with three lowercase words and `.md`, in `.launchset/`:

```md
---
bump: minor
---

Add offline mode to the mobile app.
```

Only `bump` is needed. Any `.md` file in `.launchset/` other than `README.md` is a changeset. A `none` changeset has no body:

```md
---
bump: none
---
```

## Pick the bump

| Bump | When |
| --- | --- |
| `major` | Breaking for users or API clients. |
| `minor` | A new feature. |
| `patch` | A bug fix. |
| `none` | No release needed: docs, CI, tests, internal refactors. |

When unsure between two, ask the human. The release gets the highest bump of all pending changesets.

## Write a good summary

The summary becomes one changelog entry: its first line is the bullet, and any further lines are indented under it.

- One change per bullet. If a line joins separate changes with "and", semicolons or a list, split them (see below).
- User-facing: say what changed for the people who use the product, not how you did it.
- One short sentence. Use the same tense as the other entries in `CHANGELOG.md` (look at it first).
- No PR number and no author: launchset adds them.
- Fix: `Fix the crash when opening the login screen without a network connection.`
- Don't: `fix bug in LoginScreen.tsx (#123)`.

## One changeset per change

A change is one thing a user would notice on its own: a feature, a fix, a behaviour change. Write one changeset per change: not per commit, and not per PR.

- Several commits for one change: one changeset.
- One PR with several changes: one changeset **for each**, with its own bump. A PR that adds a feature and fixes two bugs gets three changesets: one `minor`, two `patch`. Each lands under the right heading in the changelog.
- Several small changes that belong together and share a bump (parts of one feature, or tweaks to one screen) may share one changeset, written as a short lead line with a sub-bullet per change. Start with the lead line: the first line becomes the changelog bullet, so a body that starts with `- ` renders as `- - …`. Changes with different bumps always get their own changesets.
- Work that extends something with a pending changeset in `.launchset/`: edit that file instead of adding another. Look in `.launchset/` before you add.

Never put several changes in one sentence. Before you open the PR, read your summaries. If a line names more than one thing, split it.

Don't, one changeset for a whole PR:

```md
---
bump: minor
---

Add offline mode to the mobile app; the search field keeps its text after going back, and the login screen no longer crashes without a network connection.
```

Do, three changesets (they need different bumps):

```md
---
bump: minor
---

Add offline mode to the mobile app.
```

```md
---
bump: patch
---

Keep the text in the search field after going back.
```

```md
---
bump: patch
---

Fix the crash when opening the login screen without a network connection.
```

Also fine, related changes with one bump in one changeset:

```md
---
bump: minor
---

Keyboard navigation in the photo grid:

- Space opens the selected photo in the viewer and closes it again.
- Enter opens the selected album.
- Up and Down move between folders.
```

This becomes one bullet with three sub-bullets in the changelog.

## Repos that also use Changesets

If the repo also has a `.changeset/` folder, its npm packages that have their own versions are released with Changesets, and everything else with launchset. A PR that changes such a package needs **both**:

- a `.changeset/` file that names the package and its bump (`npx changeset add`, or the repo's script for it), and
- the `.launchset/` changeset, as always.

The launchset bump is about the launchset targets, not the package. If a target uses the package (for example the app uses it from the workspace), the next release ships the change: pick the bump it means for that target's users, usually `patch`. If no target uses the package, use `bump: none`.

Never edit, push to or merge the Changesets release PR (`Version Packages`, branch `changeset-release/*`) unless the human asked you to. Merging it publishes the npm packages.

## Pushing straight to the base branch

If the workflow here is to push to the base branch without a PR, make sure a changeset covers your work **before** you push. There is no PR check to remind you. `npx @demonsters/launchset status` shows what is pending, and a warning when commits exist that no changeset covers. If the repo has a pre-push hook, `launchset check --push` prints the same warning and never blocks.

## Never do these

- **Never edit version numbers or build numbers by hand.** Not in `package.json`, `build.gradle`, `project.pbxproj`, `Info.plist`, `app.json`, Helm charts, or anywhere else a target's version lives. The release PR writes versions. CI writes build numbers. The PR check fails when a version file disagrees with the root version.
- **Never edit `CHANGELOG.md`.** The release PR adds sections.
- **Never create tags that start with `v` or `launchset/`** (or whatever the repo's launchset config sets in `tags`). They are launchset's release, marker and partial tags, and creating them can trigger or block releases.
- **Never edit or push to the release PR** (branch `launchset/release/*`). It is rebuilt and force-pushed on every run. Change the changesets on the base branch instead.
- **Never merge the release PR unless the human asked you to.** Merging it releases every target.
- Don't push to the branches of Dependabot or Renovate PRs.

## Maintenance branches

On a `release/X.Y.x` branch (a hotfix line; the pattern is `maintenanceBranches` in the config), only `patch` or `none` changesets are allowed. A `minor` or `major` fails the PR check. A feature belongs on the base branch. A fix there also has to reach the base branch through its own PR with its own changeset.

## Previews

To get a test build of a PR (TestFlight, Play internal track, preview Docker tags), add the label `launchset:preview` to the PR (or whatever `preview.label` says in `launchset.config.*`). Previews have no side effects. PRs from forks don't get one. On GitLab, adding a label starts no pipeline: push a commit or start a new pipeline, or play the manual job `launchset-preview-plan` in the MR pipeline. If the project has the preview sweep schedule, the pipeline starts by itself within a few minutes (up to an hour on GitLab.com Free).

## Check the state

```sh
npx @demonsters/launchset status          # pending changesets, bump, next version, warnings
npx @demonsters/launchset status --json   # the same as JSON
```

## Manual targets

A target with `release: "manual"` is stamped by every release but shipped on demand. **Never ship one unasked.** When `status` shows a manual target is behind (`ios: 1.3.0 (9 releases behind)`), tell the human. Say that it is shipped with the **Launchset release** workflow started by hand (`workflow_dispatch` with the `target` input, and optionally `version`), or by `launchset ship --target <name>` followed by `launchset mark`. Do not run those yourself without being asked.

## On GitLab

If the repo has a `.gitlab-ci.yml` and no `.github/workflows/launchset-*.yml`, it runs launchset on GitLab. The rules above hold. What differs:

- **CI files.** launchset's jobs are in `.gitlab/launchset.yml` (included by `.gitlab-ci.yml`). The build and upload steps are in `.gitlab/launchset-targets.yml`: one hidden job `.launchset-<target>` per target. Edit build steps there, as plain GitLab CI YAML: no `rules`, `when`, `needs` or `stage`, one command per line (no `a && b`), no early `exit`. Don't edit `.gitlab/launchset.yml` or the generated `launchset-child.yml` unless asked.
- **Order and templates.** A target that needs another target's output gets `after: ["other"]` in `launchset.config.*`, not `needs` in its job. Templates a target job extends (`extends: .windows`) must be in a file listed in `gitlab.include` (such as `.gitlab/ci-templates.yml`), which may only hold hidden jobs, `variables` and `default`; templates in `.gitlab-ci.yml` aren't visible to the child pipeline.
- **PowerShell runners.** A target with `gitlab: { shell: "powershell" }` builds on a Windows runner: its steps in `.launchset-<target>` are PowerShell, and launchset's variables come from `. ./launchset.ps1` (`$env:LAUNCHSET_VERSION`).
- **Tags start no pipelines.** launchset pushes its tags with `git push -o ci.skip` (unless `gitlab.tagPipelines: true`). Don't add tag-triggered jobs to build releases: releases build in launchset's child pipeline.
- **Never hand-edit** the release MR, tags that start with `v` or `launchset/`, version numbers or `CHANGELOG.md`, as on GitHub.
- **Tokens.** The CI/CD variable `LAUNCHSET_TOKEN` (a project or group access token) is created by a human. Never ask for, read or print its value.
- **Manual targets.** Ship one with Run pipeline on the base branch and the variable `LAUNCHSET_TARGET` (optionally `LAUNCHSET_RELEASE_VERSION`), not with the GitHub workflow input. Never ship one unasked.
- **Preview sweep.** Optional: a pipeline schedule with the variable `LAUNCHSET_PREVIEW_SWEEP=true` runs `launchset-preview-sweep`, which starts an MR pipeline for MRs that just got the preview label. A human creates the schedule (Build > Pipeline schedules). `npx @demonsters/launchset preview-sweep --dry-run` shows what it would do. When you add a job without `rules` to `.gitlab-ci.yml` in such a project, start its rules with `- if: $LAUNCHSET_PREVIEW_SWEEP == "true"` / `when: never` (then `- if: $CI_PIPELINE_SOURCE != "merge_request_event"`), or it runs on every schedule run.
- **Debugging.** The plan job logs the child pipeline (collapsed section) and keeps `launchset-child.yml` as an artifact. `npx @demonsters/launchset plan --gitlab -` prints the child pipeline for the plan locally.

## If something looks wrong

- The PR check says "this PR adds no changeset": the changeset must be added or changed **in this PR**, in `.launchset/`, with a valid `bump`.
- The PR check says "version mismatch": someone edited a version file by hand. Undo that edit.
- A changeset is rejected with `file:line`: read the message. Valid bumps are `major`, `minor`, `patch`, `none`, and a summary is required unless the bump is `none`.
- `.launchset/README.md` explains the folder to people. Read it for repo-specific notes.
