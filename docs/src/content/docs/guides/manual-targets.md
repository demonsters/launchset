---
title: Manual targets
description: Keep a store app in version step with every release, but ship it on demand.
---

A target with `release: "manual"` is stamped by every release and shipped later, when you decide. Typical cases:

- a store app that isn't automated yet,
- a platform that shouldn't get a store build for every web release (macOS minutes, upload limits, review cadence).

```ts
ios: {
  type: "ios",
  source: { kind: "xcodeproj", file: "apps/mobile/ios/App.xcodeproj" },
  release: "manual",
},
```

## How it differs from an auto target

| Step | Auto target | Manual target |
| --- | --- | --- |
| Release PR | marketing version stamped | **same**: committed every release, so native files never drift |
| PR check (version consistency) | checked | **same** |
| Publish matrix | included | not included |
| Release tag `v<version>` | needs the target's marker | doesn't wait for it |
| [Superseding](/guides/partial-releases/) | counts | ignored |
| Preview | per `preview.targets` | **same** |

You need at least one auto target. Switching a target between `manual` and `auto` is a one-line change. It takes effect from the next release, and existing markers stay valid.

## Ship it

Shipping a manual target always ships an **already released** version, one that has a `v<version>` tag. Unreleased commits are what previews are for.

### From CI

1. Open **Actions → Launchset release → Run workflow**.
2. Enter `target` (for example `ios`) and optionally `version`. Without `version` it is the latest release on the branch you started from.
3. The run is in mode `ship`. It checks out the commit of `v<version>`, computes a fresh build number and runs the normal `build` job: stamp, verify, your steps and `mark`. `finalize` then only updates the "Manual targets" list in the GitHub Release. It never creates tags.

With the `semver` build-number strategy, a second run for the same version gets the same build number. Set `attempt` (for example `2`) to give it a new one: see [Shipping the same version again](/guides/build-numbers/#shipping-the-same-version-again).

On GitLab: open **Build → Pipelines → Run pipeline** on the base (or a maintenance) branch and set the variable `LAUNCHSET_TARGET` (for example `ios`). Optionally set `LAUNCHSET_RELEASE_VERSION`, `LAUNCHSET_FORCE=true` to ship a version lower than the target's highest marker, and `LAUNCHSET_ATTEMPT` for the `semver` attempt. It runs the same child pipeline. Pipeline variables must be allowed: see [Token and permissions](/gitlab/token/#pipeline-variables-for-manual-runs).

### By hand

For example an Xcode archive on a Mac:

```sh
git fetch --tags
git checkout v1.4.0
npx launchset ship --target ios
# ... archive and upload in Xcode ...
npx launchset mark --target ios --version 1.4.0 --build-number 217175105
```

`ship` checks that HEAD is at the release tag of the version (it tells you the `git checkout` to run otherwise), computes a build number with the target's strategy and stamps the files. `--json` prints the version, the build number and the `LAUNCHSET_*` values as `env`. `ship` needs **no token**: it reads tags (fetching them when there is a remote), computes the number and edits files. `mark --version` creates the marker tag and updates the GitHub Release, so it needs a token that can push (`--token`, `LAUNCHSET_TOKEN` or `GITHUB_TOKEN`) and the repository, from `--repo owner/repo`, `GITHUB_REPOSITORY` or the `origin` remote.

The `run-number` strategy only works in CI. `timestamp` and `semver` work by hand.

With `semver`, the attempt part of the build number is 1 by hand, so uploading the same version twice gives the same number, and the store rejects the second upload. Pass `--attempt` (1 to 99) for the next one:

```sh
npx launchset ship --target ios --attempt 2
# ... archive and upload ...
npx launchset mark --target ios --version 1.4.0 --build-number 10400002
```

`--attempt` is only for targets with the `semver` strategy: for any other strategy `ship` stops with an error (a `timestamp` build number is new every time anyway).

### Rules

- **Never backwards.** Shipping a version lower than the target's highest marker is an error, because stores reject it. `--force` overrides.
- **Idempotent.** If the marker for that target and version exists, `ship` says so and stops.
- **Store verification** works the same as for auto targets.
- **Auto targets can't be shipped this way.** The command says so and tells you how to retry a release instead.

## Seeing the gap

`launchset status` lists each manual target with its last shipped version and how many releases it is behind:

```text
ios: 1.3.0 (9 releases behind)
```

The release PR body shows the same list, so the team sees the gap at every release. The GitHub Release of each version ends with a "Manual targets" list: `ios: not shipped yet` or `ios: shipped 2026-11-20, build 217175105`.
