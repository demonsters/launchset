---
title: Build numbers
description: How build numbers are assigned, the four strategies, offsets and checking against the stores.
---

Stores want a number that only goes up, besides the version. launchset assigns it in CI and never commits it. That makes build numbers independent of branches: a hotfix built today gets a higher number than a release built yesterday.

## When a number is computed

Once per workflow run, in the plan step (`command: release` or `preview-plan`). All targets in the run share it, except a target with its own `buildNumber` override (a different strategy, `epoch` or `offset`): that target gets its own number from its own settings. Re-running failed jobs reuses the plan, so a re-run gets the same number.

`launchset stamp --target <name>` writes the number into the target's files in the CI checkout. The numbers in your repo are placeholders.

## Strategies

Set `buildNumber.strategy`. Any target can override it.

| Strategy | Value | Notes |
| --- | --- | --- |
| `timestamp` (default) | Seconds since `epoch` (default `2020-01-01T00:00:00Z`), plus `offset`. | About 217 million in November 2026. Stays under the Android limit until about 2086. Always increases, across all branches, without credentials. |
| `run-number` | `github.run_number` plus `offset`. | Simple. Resets if you rename the workflow file. Only works in CI. |
| `semver` | `major*10^7 + minor*10^5 + patch*10^2 + attempt` | `attempt` is the run attempt (1 to 99). Limits: minor up to 99, patch up to 999. **Not allowed while previews are enabled**, because a preview of `1.5.0` and the real `1.5.0` would compete for the same numbers. Use `preview: false`. |
| `eas` | None. | For Expo projects whose builds are numbered by EAS. See [Expo](/targets/expo/). |

The `offset` applies to every strategy that produces a number.

```ts
buildNumber: { strategy: "timestamp", offset: 0 },
```

A per-target override:

```ts
ios: {
  type: "ios",
  source: { kind: "xcodeproj", file: "ios/App.xcodeproj" },
  buildNumber: { offset: 50000 },
},
```

### Limits

- Build numbers are positive integers.
- Android's `versionCode` can't exceed 2,100,000,000. launchset fails when it would.

## Migrating an app that already has build numbers

An existing app has build numbers in its stores, and they may be **higher** than what a strategy produces now. A store rejects a lower number. The `offset` fixes that.

`launchset init` reads the highest build number in your files and, if it is above what the `timestamp` strategy gives now, sets `buildNumber.offset` to keep new numbers higher and explains why (the `offset` decision).

To check against the store itself, use `verify: ["store"]`. If the store is ahead, the step fails with a suggestion:

```text
Google Play (com.acme.app) already has versionCode 217300000, which is >= this run's build number
217175105. Uploading would fail. Raise buildNumber.offset in the launchset config from 0 to 130000
(at least 124896) so new build numbers are higher than the store's.
```

The minimum offset is the current offset, plus how far the store is ahead, plus one: here `0 + (217300000 - 217175105) + 1 = 124896`. The suggestion rounds it up to two significant digits (`130000`), and the message shows the exact minimum in parentheses when they differ.

## Verifying against the stores

The store is not a source of numbers. It is a safety check. `launchset verify --target <name>` runs in the build job, before the upload:

1. It fetches the highest build number in the store. Google Play: open an edit, list bundles and APKs, take the highest `versionCode`, delete the edit. App Store Connect: list the app's iOS builds and take the highest build number.
2. If this exact build already exists for this version: `already-published=true`. The workflow skips the upload and goes to `mark`. This covers "the upload worked, but the job failed before marking".
3. If the store's highest number is greater than or equal to ours: the step fails and says which number the store has.
4. Otherwise `already-published=false`.

Credentials are secrets you pass to the `verify` step as environment variables:

| Store | Variables |
| --- | --- |
| Google Play | `LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON` |
| App Store Connect | `LAUNCHSET_ASC_KEY_ID`, `LAUNCHSET_ASC_ISSUER_ID`, `LAUNCHSET_ASC_PRIVATE_KEY` |

The generated workflow adds an `env:` block with the right secrets to the `verify` step when a target has `verify: ["store"]`. See [Store pipelines](/store-pipelines/) for how to create them.

Docker and npm have their own checks: see [Docker](/targets/docker/#verify) and [Custom](/targets/custom/#npm-packages). When a target has several `verify` entries, all must succeed, and the version counts as published only when every check agrees.

## Previews

Previews get a build number too (same strategy). That is why `semver` is rejected while previews are on. A preview of version `1.5.0-pr.123.4` and the release `1.5.0` must never share a number.
