---
title: Concepts
description: The ideas behind launchset, in the order you meet them.
---

launchset is built for repos where **one version** drives **many things**: a backend image, an Android app, an iOS app, a web app. They live in one repo and are released together.

## One version

The `version` in the root `package.json` is the single source of truth. Every target gets that same version. When a release happens, every target is built at it.

There are no partial releases by design. A changeset never says "only the Android app". Every release builds every target. (There is one exception, [manual targets](/guides/manual-targets/), for things that can't be released on every version.)

## launchset does not build anything

launchset decides **what** to release, writes version numbers into files and records the results. Your own workflow steps do the building and the uploading: `docker/build-push-action`, Gradle, fastlane, Xcode, `npm publish`.

## Changesets

A **changeset** is a small markdown file in `.launchset/` that you add in your PR:

```md
---
bump: minor
---

Add offline mode to the mobile app.
```

It says how big the change is (`major`, `minor`, `patch`, or `none` for "no release needed") and what to write in the changelog. Commit messages don't matter. See [Writing changesets](/changesets/).

The release bump is the highest bump of all pending changesets.

## Targets

A **target** is one thing that gets built and shipped per release: `docker-api`, `android`, `ios`, `web`. Each target becomes one job in the build matrix. A target has a type (`docker`, `web`, `android`, `ios`, `custom`) that tells launchset which files hold its version. See [Targets](/targets/).

## The release PR

launchset keeps one pull request open, titled `Release v1.5.0`. It contains the version bump, the stamped version files, the new changelog section and the deleted changesets. **Merging it is the release.**

The branch (`launchset/release/main`) is rebuilt from the base branch on every push and force-pushed, so it never has conflicts. Don't edit it.

## Build numbers

Stores want a number that only goes up, besides the version: `versionCode` on Android, `CFBundleVersion` on iOS. launchset assigns it **in CI at build time** and never commits it. By default it is the number of seconds since 2020-01-01, so it rises across all branches without any state. See [Build numbers](/guides/build-numbers/).

## Markers and the release tag

State lives in git tags, not in a database.

| Tag | Example | Meaning |
| --- | --- | --- |
| **Marker tag** | `launchset/android@1.5.0` | The `android` target shipped version 1.5.0. |
| **Release tag** | `v1.5.0` | Every auto target shipped. The version is fully released. |
| **Partial tag** | `launchset/partial/1.4.0` | Version 1.4.0 was never completed and a newer version replaced it. |
| **Prerelease tag** | `v1.5.0-alpha.3` | A prerelease build. See [previews](/guides/previews/). |

Because the markers are tags, every step is idempotent. Re-running a failed job or a whole workflow never publishes twice.

## Channels

Each build job gets a **channel**: `release`, `prerelease` or `preview`. Your workflow uses it to choose where to upload: the Play production track or the internal track, a TestFlight group, an npm dist-tag, a Docker tag.

## Previews

A **preview** is a test build from a PR or a branch. It has a version like `1.5.0-pr.123.4` and a build number, but no side effects: nothing is committed, no changeset is consumed, no marker or release tag is created. See [Preview builds and prerelease branches](/guides/previews/).

## The GitHub App

Releases are done with a token from a GitHub App you create once per org. Events caused by the built-in `GITHUB_TOKEN` don't trigger other workflows, so a release PR opened with it would never run CI. See [GitHub App setup](/github-app/).

## What goes where

| You | launchset |
| --- | --- |
| Write a changeset in each PR. | Checks the PR has one and comments on it. |
| Review and merge the release PR. | Opens and updates it, with changelog and stamped files. |
| Write the build and upload steps. | Plans the matrix, stamps version and build number, checks the store, records markers. |
| Fix and re-run a failed target. | Skips what already shipped. Creates the release tag when every target did. |
