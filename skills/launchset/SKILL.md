---
name: launchset
description: Load this whenever you change code in a repo that contains launchset.config.* or a .launchset/ folder, before you open a pull request or push to the base branch there, and when asked to bump a version, edit CHANGELOG.md, or create a tag or release. launchset releases the repo from changeset files, so every PR needs one. This skill says how to write the changeset, which bump to pick, and what never to edit by hand (version numbers, build numbers, CHANGELOG.md, release tags, the release PR).
---

# launchset: releases in this repo

This repo is released with launchset. One version drives every target (Docker images, Android, iOS, web). You describe each change in a small **changeset** file in `.launchset/`. launchset collects the changesets into a release PR (`Release vX.Y.Z`). Merging that PR is the release.

Commit messages don't matter. Release intent lives in changeset files only.

## Every PR needs a changeset

Before you open a PR, make sure it adds one. Create it with:

```sh
npx @demonsters/launchset add --bump <major|minor|patch|none> --message "<summary>"
```

For a change that needs no release (docs, CI, tests only) use `--empty`, which is `bump: none`:

```sh
npx @demonsters/launchset add --empty
```

The command prints the path of the new file, for example `.launchset/brave-lions-sing.md`. Commit it with your change.

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

The summary becomes the changelog entry.

- User-facing: say what changed for the people who use the product, not how you did it.
- One line. Use the same tense as the other entries in `CHANGELOG.md` (look at it first).
- No PR number and no author: launchset adds them.
- Fix: `Fix the crash when opening the login screen without a network connection.`
- Don't: `fix bug in LoginScreen.tsx (#123)`.

## One changeset per change

Write one changeset per change, not per commit. If your work extends something that already has a pending changeset in `.launchset/`, edit that file instead of adding another. Look in `.launchset/` before you add.

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

To get a test build of a PR (TestFlight, Play internal track, preview Docker tags), add the label `launchset:preview` to the PR (or whatever `preview.label` says in `launchset.config.*`). Previews have no side effects. PRs from forks don't get one.

## Check the state

```sh
npx @demonsters/launchset status          # pending changesets, bump, next version, warnings
npx @demonsters/launchset status --json   # the same as JSON
```

## Manual targets

A target with `release: "manual"` is stamped by every release but shipped on demand. **Never ship one unasked.** When `status` shows a manual target is behind (`ios: 1.3.0 (9 releases behind)`), tell the human. Say that it is shipped with the **Launchset release** workflow started by hand (`workflow_dispatch` with the `target` input, and optionally `version`), or by `launchset ship --target <name>` followed by `launchset mark`. Do not run those yourself without being asked.

## If something looks wrong

- The PR check says "this PR adds no changeset": the changeset must be added or changed **in this PR**, in `.launchset/`, with a valid `bump`.
- The PR check says "version mismatch": someone edited a version file by hand. Undo that edit.
- A changeset is rejected with `file:line`: read the message. Valid bumps are `major`, `minor`, `patch`, `none`, and a summary is required unless the bump is `none`.
- `.launchset/README.md` explains the folder to people. Read it for repo-specific notes.
