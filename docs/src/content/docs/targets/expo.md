---
title: Expo
description: Stamp app.json, read launchset values from app.config.js, or let EAS number the builds.
---

Expo apps have three setups. Pick the one that matches yours.

## `app.json`

launchset edits the `expo` object in `app.json`:

```ts
targets: {
  android: { type: "android", source: { kind: "expo", file: "app.json" } },
  ios: { type: "ios", source: { kind: "expo", file: "app.json" } },
}
```

`file` defaults to `app.json`.

| Target | Marketing version | Build number |
| --- | --- | --- |
| `android` | `expo.version` | `expo.android.versionCode` (a JSON integer) |
| `ios` | `expo.version` | `expo.ios.buildNumber` (a JSON string) |

The release PR stamps `expo.version`. The build number is written only in CI. If the key or its `android` or `ios` object is missing, `stamp` inserts a minimal property in the file's indentation. The file is never left changed in git.

Run `expo prebuild` or your EAS build **after** `stamp`, so it sees the numbers.

## `app.config.js` or `app.config.ts`

These files are code, and launchset won't edit code. Read the values from the environment instead. The `stamp` step exports three variables to the steps that follow:

| Variable | Value |
| --- | --- |
| `LAUNCHSET_VERSION` | The version of this run. For `android` and `ios` targets it is the target's marketing version (plain `X.Y.Z` for `ios`). For a **custom** target it is the full version of the run, for example `1.5.0-pr.123.4` on a preview. |
| `LAUNCHSET_BUILD_NUMBER` | The build number (empty with the `eas` strategy). |
| `LAUNCHSET_CHANNEL` | `release`, `prerelease` or `preview`. |

```js title="app.config.js"
const pkg = require("./package.json");

// Releases: the committed version. Builds: the version of the run, without a prerelease
// suffix. Apple rejects suffixes like -pr.123.4 in the iOS version, and Expo has one
// `version` for both platforms.
const version = (process.env.LAUNCHSET_VERSION ?? pkg.version).split("-")[0];

module.exports = {
  expo: {
    name: "Acme",
    version,
    ios: { buildNumber: process.env.LAUNCHSET_BUILD_NUMBER ?? "1" },
    android: { versionCode: Number(process.env.LAUNCHSET_BUILD_NUMBER ?? 1) },
  },
};
```

:::caution
On a **custom** target `LAUNCHSET_VERSION` is the full version of the run, so on a PR preview or a prerelease it is `1.5.0-pr.123.4`. An iOS build with that version is rejected by Apple, which is why the config above strips everything after the first dash. An `ios` target with `source: { kind: "expo" }` (an `app.json`) doesn't have this problem: its `marketing-version` output, and `LAUNCHSET_VERSION` for it, are always the plain `X.Y.Z`.
:::

An Expo project that only has `app.config.js` gives launchset no file to edit. Use `custom` targets without `files` (one per platform). Each becomes a job in the matrix and gets a marker, and the config reads the stamped values from the environment. `launchset init` prints this advice when it finds an `app.config.*` file.

## EAS with remote versions

If EAS Build assigns build numbers (`appVersionSource: "remote"` with `autoIncrement`), tell launchset to leave build numbers alone:

```ts
buildNumber: { strategy: "eas" },
```

With `eas`:

- launchset outputs no build number and stamps none.
- The `build-number` output is empty.
- `verify: ["store"]` can't be used: it needs a build number. EAS's `autoIncrement` keeps them unique.

launchset still plans, stamps `expo.version` and records markers. Your workflow steps run `eas build` (and `eas submit`).

:::note
Expo OTA updates and `runtimeVersion` are not handled by launchset in this version.
:::
