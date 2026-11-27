---
title: iOS
description: Stamp the marketing version and build number into an Xcode project and upload to TestFlight.
---

An `ios` target stamps the marketing version (`CFBundleShortVersionString` / `MARKETING_VERSION`) and the build number (`CFBundleVersion` / `CURRENT_PROJECT_VERSION`).

```ts
ios: {
  type: "ios",
  source: { kind: "xcodeproj", file: "apps/mobile/ios/App.xcodeproj" },
  verify: ["store"],
  store: { appId: "1234567890" },
}
```

## Sources

| `source.kind` | Stamps | Notes |
| --- | --- | --- |
| `xcodeproj` | `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` in `project.pbxproj`. | The usual choice. |
| `plist` | `CFBundleShortVersionString` and `CFBundleVersion` in one or more `Info.plist` files (`file` or `files`). | Errors when a value is a build-setting reference like `$(MARKETING_VERSION)`. |
| `xcconfig` | `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` in a `.xcconfig` file. | Edits the single unconditional assignment. Conditional ones are left alone. |
| `capacitor` | `<dir>/ios/App/App.xcodeproj`. | See [Capacitor](/targets/capacitor/). |
| `expo` | `expo.version` and `expo.ios.buildNumber` in `app.json`. | See [Expo](/targets/expo/). |
| `flutter` | `version` in `<dir>/pubspec.yaml`, which Flutter passes to Xcode. | See [Flutter](/targets/flutter/). |

Bare React Native uses `xcodeproj`. See [React Native](/targets/react-native/).

### xcodeproj

launchset reads the project only to find which build configurations belong to which native targets. It then changes only the values in `MARKETING_VERSION = ...;` and `CURRENT_PROJECT_VERSION = ...;`, and keeps quotes, tabs and line endings. Xcode and CocoaPods reformat this file on their own. launchset never adds to that churn.

By default it stamps **every** native target that has those settings. That covers app extensions and widgets, which must carry the same version and build number as the host app, or App Store Connect complains. To limit it:

```ts
source: {
  kind: "xcodeproj",
  file: "ios/App.xcodeproj",
  xcodeTargets: ["App", "Widget"],
},
```

Each selected target must get every value from its own build configurations or from the project-level ones. Conditional, duplicated and `$(...)` values in a selected target are errors, and so is a project where no selected target sets them. The message says what to set in Xcode's Build Settings.

If your `Info.plist` files use `$(MARKETING_VERSION)` (the Xcode default), use `xcodeproj`.

## Versions and build numbers

- The marketing version must be a plain `X.Y.Z`. Apple doesn't accept prerelease suffixes. Previews and prereleases use the plain next version (for example `1.5.0`), and the **build number** tells their builds apart.
- The build number is a positive integer, written as a string where the format wants one.

See [Build numbers](/guides/build-numbers/).

## Verify against App Store Connect

`verify: ["store"]` needs `store.appId`, the numeric Apple ID of the app. It lists the app's iOS builds, takes the highest build number, and decides:

- The same build number under the same marketing version exists: `already-published` is `true`.
- The same number under another version, or a higher number: the step fails and suggests a `buildNumber.offset`.
- Otherwise: `already-published` is `false`.

Builds for tvOS, visionOS and macOS in the same app record are ignored. The step needs three secrets, set from an App Store Connect API key:

| Secret | Value |
| --- | --- |
| `LAUNCHSET_ASC_KEY_ID` | The key ID. |
| `LAUNCHSET_ASC_ISSUER_ID` | The issuer ID. |
| `LAUNCHSET_ASC_PRIVATE_KEY` | The contents of the `.p8` file. `verify` also accepts a base64-encoded copy, but store it **raw**: the fastlane upload (`key_content`) reads the same secret and needs the raw text. |

How to create them: [Apple pipeline](/store-pipelines/apple/).

## Build steps

iOS builds need a macOS runner. The generated workflow switches `runs-on` to `macos-latest` for the iOS target. It adds commented `xcodebuild archive` steps and a commented upload step that runs a fastlane lane (`testflight`, built from `app_store_connect_api_key` and `upload_to_testflight`, reading `ASC_KEY_ID`, `ASC_ISSUER_ID` and `ASC_PRIVATE_KEY` from the `LAUNCHSET_ASC_*` secrets). The lane itself is in [Workflow recipes](/guides/recipes/#ios-upload-to-testflight-with-fastlane). In front of them sits a failing step named **Build steps missing (ios)**: delete it when your steps are in.

`channel` helps you choose where the build goes: `release` to TestFlight ready to submit, `prerelease` to an external TestFlight group and `preview` to internal testers.

For environment variables, use the **`marketing-version`** output of `stamp` for iOS, not `version`:

```yaml
env:
  LAUNCHSET_VERSION: ${{ steps.stamp.outputs.marketing-version }}
  LAUNCHSET_BUILD_NUMBER: ${{ steps.stamp.outputs.build-number }}
  LAUNCHSET_CHANNEL: ${{ steps.stamp.outputs.channel }}
```

`marketing-version` is the plain `X.Y.Z` Apple accepts, also on previews and prereleases, where `version` is the full `1.5.0-pr.123.4`.

See [Workflow recipes](/guides/recipes/) and [Store pipelines](/store-pipelines/).

## Ship it on demand

Many teams build iOS by hand or less often than every release. Set `release: "manual"` and see [Manual targets](/guides/manual-targets/).
