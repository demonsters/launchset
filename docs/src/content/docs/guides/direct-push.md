---
title: Repos that push straight to the base branch
description: Use launchset when commits go to main without a PR.
---

Not every repo works with PRs. Some push to `main` all day and treat the release PR as the review point. launchset works for that too.

## What changes

There is no PR, so there is no PR check and no sticky comment. Everything else is the same:

1. You push commits to `main`.
2. The release workflow runs on every push. If a changeset is pending, it creates or updates the release PR.
3. You review and merge the release PR. That is the release.

**The release PR is the review point.** It shows the changelog section and the version bump of everything since the last release.

## One changeset per change, not per commit

Several commits often belong to one change. Write **one** changeset for the change, not one per commit. The other way round holds too: a push with several changes gets one changeset for each. If new work extends something that already has a pending changeset, edit that file instead of adding another.

```sh
npx launchset add --bump minor --message "Add offline mode to the mobile app."
git add .launchset
git commit -m "Add offline mode"
git push
```

Put the changeset in the same commit as the work, or in a later push. Both work. There is no per-commit check, because that would force a changeset on every small commit.

## The warning

When commits exist since the last release and **no changeset at all** is pending, nothing will be released. launchset doesn't fail. It warns:

- The release workflow's job summary shows: `3 commits since v1.4.0 and no pending changeset: they won't be released.` with the commit list.
- `launchset status` prints the same warning.

If those commits need no release, add an empty changeset: `npx launchset add --empty`.

## A pre-push hook

To see the warning before the push instead of in CI, run `launchset check --push` in a pre-push hook:

```sh
npx launchset check --push
```

```text
launchset: 3 commits since v1.4.0 and no pending changeset: they won't be released.
...
(This is a warning only; the push goes ahead.)
```

It never blocks the push: the exit code is `0`. It also warns about changesets that are invalid.

`launchset init` can add the line for you when it finds a hook setup. It supports **husky** (`.husky/pre-push`, when husky is a dependency or `.husky/` has hooks), **simple-git-hooks** and **lefthook**. It never installs a hook tool on its own, and never writes a hook file that git ignores. Use `--hook` or answer the `hook` decision with `yes`.

For simple-git-hooks run `npx simple-git-hooks` afterwards, to install the updated hook.

## Staying safe without PRs

- **Fast pushes are fine.** Every push gets its own release run, and none is ever cancelled, so the run for the release commit always builds. Runs for older commits leave the release PR to the run for the newest commit.
- Don't push `package.json` version changes by hand. A push that changes the root version is read as a release commit, and the build jobs run for it. Version numbers are written by the release PR only.
- Require the release PR to be reviewed before it is merged if your team wants a gate. It is a normal PR.
