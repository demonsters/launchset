---
title: Android
description: Stamp versionName and versionCode and upload to Google Play.
---

An `android` target stamps `versionName` (the marketing version) and `versionCode` (the build number).

```ts
android: {
  type: "android",
  source: { kind: "gradle", file: "apps/mobile/android/app/build.gradle" },
  verify: ["store"],
  store: { packageName: "com.acme.app" },
}
```

## Sources

| `source.kind` | Stamps | Notes |
| --- | --- | --- |
| `gradle` | `versionCode` and `versionName` in `defaultConfig` of `build.gradle` or `build.gradle.kts`. | The values must be literals. |
| `gradle-properties` | The keys `VERSION_NAME` and `VERSION_CODE` in a `gradle.properties` file. | Change the names with `versionNameKey` and `versionCodeKey`. |
| `capacitor` | `<dir>/android/app/build.gradle`. | See [Capacitor](/targets/capacitor/). |
| `expo` | `expo.version` and `expo.android.versionCode` in `app.json`. | See [Expo](/targets/expo/). |

Bare React Native uses `gradle`. See [React Native](/targets/react-native/).

### Gradle

launchset edits only inside `android { defaultConfig { ... } }`:

```groovy
android {
    defaultConfig {
        versionCode 12          // changed in CI
        versionName "1.4.0"     // changed by the release PR
    }
}
```

Kotlin DSL works the same (`versionCode = 12`, `versionName = "1.4.0"`).

These cases are errors, with a message that names the file:

- the values are not literals (`versionCode computeVersionCode()`),
- they appear twice,
- product flavors override `versionName` or `versionCode`.

In those cases move the values into `gradle.properties` and use `gradle-properties`:

```properties title="android/gradle.properties"
VERSION_NAME=1.4.0
VERSION_CODE=12
```

```groovy title="android/app/build.gradle"
defaultConfig {
    versionCode project.property("VERSION_CODE").toInteger()
    versionName project.property("VERSION_NAME")
}
```

```ts
source: { kind: "gradle-properties", file: "apps/mobile/android/gradle.properties" },
```

## Versions and build numbers

- On a release, `versionName` is the release version (`1.5.0`).
- On a preview, `versionName` is the full preview version (`1.5.0-pr.123.4`). On a prerelease it is the full prerelease version (`1.5.0-alpha.3`).
- `versionCode` is the build number, an integer. Google Play's maximum is 2,100,000,000. A larger number is an error. The default `timestamp` strategy stays below it until about 2086.

See [Build numbers](/guides/build-numbers/).

## Verify against Google Play

`verify: ["store"]` needs `store.packageName` and a service account. It opens a Play edit, lists the bundles and APKs, takes the highest `versionCode`, and deletes the edit.

- If this `versionCode` exists: `already-published` is `true`. Your steps skip the upload and `mark` still runs. This covers "uploaded, but the job failed before marking".
- If the store's highest number is greater than or equal to ours: the step fails and suggests a `buildNumber.offset`.
- Otherwise: `already-published` is `false`.

The secret `LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON` holds the service account's JSON key. `verify` also accepts a base64-encoded copy, but store it **raw** when the upload step (fastlane `supply`, `SUPPLY_JSON_KEY_DATA`) uses the same secret. The generated workflow passes it to the `verify` step. How to create it: [Google Play pipeline](/store-pipelines/google-play/).

## Build steps

```yaml
- uses: actions/setup-java@v5
  if: matrix.target == 'android' && steps.verify.outputs.already-published != 'true'
  with: { distribution: temurin, java-version: "21" }
- name: Build the app bundle
  if: matrix.target == 'android' && steps.verify.outputs.already-published != 'true'
  working-directory: apps/mobile/android
  run: ./gradlew bundleRelease
```

The generated workflow includes commented steps for the build and the upload with fastlane `supply`, and a failing step named **Build steps missing (android)** that you delete once your steps are in. `channel` chooses the Play track: `release` goes to `production`, `prerelease` to `beta` and `preview` to `internal`. See [Workflow recipes](/guides/recipes/) and [Store pipelines](/store-pipelines/).
