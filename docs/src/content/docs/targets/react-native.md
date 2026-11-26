---
title: React Native
description: A bare React Native app is two targets, android and ios, in one repo.
---

A bare React Native app has an Android project and an iOS project. Make them two targets. Point `android` at the Gradle file and `ios` at the Xcode project:

```ts
import { defineConfig } from "launchset";

export default defineConfig({
  targets: {
    android: {
      type: "android",
      source: { kind: "gradle", file: "apps/mobile/android/app/build.gradle" },
      verify: ["store"],
      store: { packageName: "com.acme.app" },
    },
    ios: {
      type: "ios",
      source: { kind: "xcodeproj", file: "apps/mobile/ios/App.xcodeproj" },
      verify: ["store"],
      store: { appId: "1234567890" },
    },
  },
});
```

`launchset init` detects `android/app/build.gradle(.kts)` and `*.xcodeproj` and writes this for you.

## Things to know

- **Gradle values must be literals.** If your `build.gradle` computes `versionCode`, move the numbers to `gradle.properties` and use `gradle-properties`. See [Android](/targets/android/).
- **The Xcode project is stamped, not the plist.** With the default `$(MARKETING_VERSION)` in `Info.plist`, use `xcodeproj`. Widgets and extensions get stamped too.
- **`package.json` of the app.** If the app has its own `package.json` with a version that should follow the release, add a `files` entry to one target: `files: [{ path: "apps/mobile/package.json", kind: "json", key: "version" }]`.
- **Metro and JS bundles** don't need the version. If the JS code shows it, read it from the native side (`react-native-device-info`) or inject `LAUNCHSET_VERSION` at build time.

## Build

Build steps are yours. See [Workflow recipes](/guides/recipes/) for Gradle with fastlane `supply` and `xcodebuild` with fastlane `pilot`. The iOS job runs on macOS. The two jobs run in parallel and don't depend on each other. If one fails, re-run that job. The other one is not built again.

Not every team wants an iOS build on every release. Consider `release: "manual"` for `ios`: [Manual targets](/guides/manual-targets/).
