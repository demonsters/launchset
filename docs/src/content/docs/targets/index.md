---
title: Targets
description: What a target is, which types exist and how they are stamped.
---

A **target** is one thing that is built and shipped with every release. You list them under `targets` in `launchset.config.ts`. The key is the name (lowercase letters, digits and dashes). Each target becomes one job in the build matrix.

```ts
export default defineConfig({
  targets: {
    "docker-api": { type: "docker", image: "ghcr.io/acme/api" },
    web: { type: "web" },
    android: {
      type: "android",
      source: { kind: "gradle", file: "apps/mobile/android/app/build.gradle" },
    },
    ios: {
      type: "ios",
      source: { kind: "xcodeproj", file: "apps/mobile/ios/App.xcodeproj" },
      release: "manual",
    },
  },
});
```

## Types

| Type | For | Page |
| --- | --- | --- |
| `docker` | A container image. launchset renders the tags and labels. | [Docker](/targets/docker/) |
| `web` | A web app. Nothing stamped by default. | [Web](/targets/web/) |
| `android` | An Android app. Stamps `versionName` and `versionCode`. | [Android](/targets/android/) |
| `ios` | An iOS app. Stamps the marketing version and build number. | [iOS](/targets/ios/) |
| `custom` | Anything else: an npm package, a Helm chart, a version file. | [Custom](/targets/custom/) |

React Native, Capacitor, Expo and Flutter apps use the `android` and `ios` types with the right `source`:

- [React Native](/targets/react-native/): `gradle` and `xcodeproj`.
- [Capacitor](/targets/capacitor/): `kind: "capacitor"`.
- [Expo](/targets/expo/) (experimental): `kind: "expo"`, or environment variables for `app.config.js`.
- [Flutter](/targets/flutter/) (experimental): `kind: "flutter"`, which stamps `pubspec.yaml`.

## How stamping works

There are two kinds of stamping.

| What | Written by | Committed? |
| --- | --- | --- |
| **Marketing version** (`versionName`, `CFBundleShortVersionString`, `expo.version`, the `pubspec.yaml` version, ...) | The release PR. In CI also by `stamp`, so previews carry their own version. | In the release PR, yes. In CI, no. |
| **Build number** (`versionCode`, `CFBundleVersion`, the `+N` in `pubspec.yaml`, ...) | `launchset stamp`, in CI only. | Never. |

The build numbers in your repo are placeholders. launchset doesn't care what they are.

### Edits keep your files intact

launchset reads a file only to find where the value is. It then replaces just those characters. Indentation, quotes, comments and line endings stay as they are. It never re-formats a JSON file, re-orders a plist or rewrites a `project.pbxproj`. The diff of a release PR contains the version values and nothing else.

When a value can't be found unambiguously, launchset fails and names the file and the reason. It never guesses.

### The version check

`launchset status` and the PR check verify that every target's committed marketing version equals the root version. If someone edits a version file by hand, the check fails and lists the files and values.

## Auto and manual targets

Every target has `release`: `"auto"` (default) or `"manual"`. Auto targets are built by every release. Manual targets still get their version stamped, but are shipped on demand. See [Manual targets](/guides/manual-targets/).

## Extra files

Any target can list extra `files` that get the version stamped. See [Custom targets](/targets/custom/#extra-files) for the kinds.
