---
title: Flutter
description: Stamp the version in pubspec.yaml and let Flutter pass it to the Android and iOS projects.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
Flutter support is new. It has had less real-world use than the other targets, so its details may still change. If something doesn't work for your app, [open an issue](https://github.com/demonsters/launchset/issues/new/choose).
:::

A Flutter app keeps its version in `pubspec.yaml`. One field holds both numbers: `version: 1.5.0+217175105` is the build name `1.5.0` and the build number `217175105`. `flutter build` passes them to the native projects. Android reads them as `flutter.versionName` and `flutter.versionCode` in Gradle. iOS reads them as `$(FLUTTER_BUILD_NAME)` and `$(FLUTTER_BUILD_NUMBER)` in `Info.plist`.

So launchset stamps `pubspec.yaml`, not the `android/` and `ios/` folders. Make the app two targets with `kind: "flutter"`:

```ts
targets: {
  android: {
    type: "android",
    source: { kind: "flutter", dir: "apps/mobile" },
    verify: ["store"],
    store: { packageName: "com.acme.app" },
  },
  ios: {
    type: "ios",
    source: { kind: "flutter", dir: "apps/mobile" },
    verify: ["store"],
    store: { appId: "1234567890" },
  },
}
```

`dir` is the Flutter project folder, the one with `pubspec.yaml`. It defaults to `"."`, the repo root.

## What gets stamped

| When | `android` | `ios` |
| --- | --- | --- |
| The release PR (committed) | `1.4.0+12` becomes `1.5.0+12` | `1.5.0+12` |
| A release build in CI | `1.5.0+217175105` | `1.5.0+217175105` |
| A PR preview in CI | `1.5.0-pr.123.4+217175105` | `1.5.0+217175105` |

- The release PR changes only the build name. The `+N` stays as it is, so the diff is the version and nothing else. A `pubspec.yaml` without `+N` keeps having none.
- The build number is written only in CI, like on every other target. The `+N` in your repo is a placeholder.
- iOS always gets the plain `X.Y.Z`. Apple rejects suffixes, and Flutter would turn `1.5.0-pr.123.4` into `1.5.0.123.4` without a warning.
- Quotes and comments on the `version` line are kept. The `version` of a dependency is never touched: only the top-level key counts.

## The native projects must read Flutter's numbers

A project made by `flutter create` already does this. Check yours if it is older or was changed by hand.

```kotlin title="android/app/build.gradle.kts"
defaultConfig {
    versionCode = flutter.versionCode
    versionName = flutter.versionName
}
```

```xml title="ios/Runner/Info.plist"
<key>CFBundleShortVersionString</key>
<string>$(FLUTTER_BUILD_NAME)</string>
<key>CFBundleVersion</key>
<string>$(FLUTTER_BUILD_NUMBER)</string>
```

If your project sets literal numbers there instead, Flutter's numbers never reach the app. Change it back to the lines above. Or stamp the native files directly with `kind: "gradle"` and `kind: "xcodeproj"`, as for [React Native](/targets/react-native/).

## A repo with only a Flutter app

A Flutter repo has no `package.json`. Point `version.file` at the app's `pubspec.yaml`:

```ts
export default defineConfig({
  version: { file: "pubspec.yaml" },
  targets: {
    android: { type: "android", source: { kind: "flutter" } },
    ios: { type: "ios", source: { kind: "flutter" } },
  },
});
```

launchset reads the version without the `+N`. The release PR bumps it and keeps the `+N`. A commit that changes only the `+N` doesn't count as a version change.

In CI, `stamp` writes the run's version and build number into this file for every target. A Flutter web build (`type: "web"`) then gets them too, with no extra config.

In a repo that also has an API or a web app with a root `package.json`, keep `package.json` as the version file. The app's `pubspec.yaml` is stamped as a target file.

## `launchset init`

`init` finds Flutter apps by their `pubspec.yaml`: an app depends on the Flutter SDK and has platform folders. Plugins, packages and their `example/` apps are skipped. It looks in the repo root, a pub workspace or melos, and up to four folders deep, so an app in `apps/mobile` of a JS monorepo is found too.

For each app it proposes an `android` and an `ios` target with `kind: "flutter"`. In a repo without a `package.json` it proposes the app's `pubspec.yaml` as the version file (the `version.file` decision). A `pubspec.yaml` without a `version` gets one.

It also tells you:

- when the native projects don't read Flutter's numbers (see above);
- when a workflow runs `flutter build` with its own `--build-number` or `--build-name`;
- when Codemagic or Bitrise builds the repo, since launchset runs in GitHub Actions and GitLab CI;
- when the `+N` is a date-based number close to Google Play's limit.

It retires what would overwrite the stamped numbers: `cider bump` and `pubver`, `sed -i` or `yq -i` edits of the `pubspec.yaml` version, Dart scripts in `tool/` that rewrite it, fastlane version actions in `android/` and `ios/`, and `melos version`. See [Retire what conflicts](/guides/migrating/#retire-what-conflicts).

## Build

Pass launchset's numbers to `flutter build` as flags. `stamp` already wrote them into `pubspec.yaml`, so the flags give the same values. They make the build independent of what ran before it, and they show the numbers in the log.

```yaml
- uses: subosito/flutter-action@v2
  if: matrix.target == 'android'
  with:
    channel: stable
- run: >
    flutter build appbundle --release
    --build-name "${{ steps.stamp.outputs.marketing-version }}"
    --build-number "${{ steps.stamp.outputs.build-number }}"
  if: matrix.target == 'android' && steps.verify.outputs.already-published != 'true'
  working-directory: apps/mobile
```

For iOS, run `flutter build ipa` with the same two flags and an `--export-options-plist`, on a macOS runner. The `marketing-version` output is always the plain `X.Y.Z` there. The workflows that `launchset init` writes have both as commented examples, with the Play and TestFlight uploads. See [Workflow recipes](/guides/recipes/#flutter) for GitHub and GitLab.

## Build numbers

Every [strategy](/guides/build-numbers/) works except `eas`, which is for Expo. A Flutter target with `eas` is a config error: the committed `+N` would end up in every build.

Two things are specific to Flutter:

- **Split APKs.** `flutter build apk --split-per-abi` adds `1000`, `2000`, `3000` or `4000` to the build number, one per ABI. The store then has numbers launchset didn't hand out, so `verify` can't spot an upload that already happened. With the `semver` strategy the added thousands also overlap the patch and attempt digits. Upload an app bundle instead (Google Play requires one for new apps).
- **Date-based numbers.** Some Flutter apps use numbers like `+2024112701`. Those are close to Google Play's limit of 2,100,000,000. Moving such an app to launchset needs an `offset` above its highest number, which leaves little room before the limit. See [Where Android's limit comes from](/guides/build-numbers/#where-androids-limit-comes-from).

## Web and desktop

- **Web**: a `web` target. Run `flutter build web` with `--build-name` and `--build-number`; Flutter writes them to `version.json`.
- **macOS, Windows and Linux**: a [custom target](/targets/custom/) per platform, with your own build steps. For macOS, pass a plain `X.Y.Z` as `--build-name`: a custom target's `LAUNCHSET_VERSION` is the full version of the run, like `1.5.0-pr.123.4` on a preview, and macOS mangles it the way iOS does.
