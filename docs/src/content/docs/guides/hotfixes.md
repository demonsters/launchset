---
title: Hotfixes and maintenance branches
description: Fix an older version line without releasing what is on main.
---

Sometimes `main` is on `1.5.0` and you need a fix for `1.4.x` right now. A **maintenance branch** is a branch named `release/<major>.<minor>.x` (the pattern is `maintenanceBranches`, default `release/*.x`). On it the whole flow works as on `main`, but only for patches.

## Create the branch

```sh
git fetch --tags
npx @demonsters/launchset hotfix 1.4
```

```text
Created release/1.4.x at v1.4.2 (88554b4) and pushed it.
Next: git checkout release/1.4.x, then open PRs against it with patch changesets.
```

The branch starts at the latest release tag in the `1.4` line. The command fails when the branch already exists or the line has no release. It needs push access (`--token` or `GITHUB_TOKEN`).

## Fix, release

1. Branch from `release/1.4.x`, make the fix and open a PR **against `release/1.4.x`**.
2. Add a `patch` (or `none`) changeset. `minor` and `major` fail the PR check: the change belongs on `main`.
3. Merge. The release workflow opens a release PR from the branch `launchset/release/release/1.4.x`.
4. Merge the release PR. The build jobs run for the version, for example `1.4.3`, which stays in the `1.4.*` line.

The generated workflows already listen to maintenance branches.

## What is different on a maintenance branch

- **Docker tags.** Templates with neither `{version}` nor `{minor}` are dropped, which removes `latest` and the major-only tag. A hotfix never moves `latest` while a newer line exists.
- **npm.** The `dist-tag` output is `release-1.4`, not `latest`.
- **GitHub Release.** It is not marked "latest".
- **Build numbers.** The default `timestamp` strategy increases over time regardless of branch, so the hotfix Android build always gets a higher `versionCode` than earlier uploads.

## The changelog backport

After the release tag is created, launchset opens a PR to the base branch titled `Changelog: v1.4.3`. It only inserts the `1.4.3` section into `main`'s `CHANGELOG.md`, in the right place by version. It doesn't touch version files or changesets. Merge it. The backport is a no-op when the section already exists, so re-running `finalize` is safe.

## The fix must also reach main

The hotfix itself is not on `main`. Land it there through a normal PR with its own changeset. If you cherry-pick it, add a changeset in that PR too.

When `main` gets its next release, launchset skips versions that a hotfix took. Example: `main` is at `1.4.0` with a pending patch, `v1.4.1` was released from `release/1.4.x`: the release PR on `main` is `1.4.2`.

## Previews on a maintenance branch

Maintenance branches never auto-preview. Start **Launchset preview** by hand on the branch if you want one.
