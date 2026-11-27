---
title: Workflow recipes
description: Copy-paste build and upload steps for Docker, Gradle, Flutter, fastlane and xcodebuild.
---

launchset builds nothing. These recipes are the steps that go into the `build` job of `launchset-release.yml` (and `launchset-preview.yml`), between `verify` and `mark`. They use the outputs of the `stamp` step (`id: stamp`) and the `already-published` output of the `verify` step (`id: verify`).

The generated workflows contain a failing step named **Build steps missing (<target>)** for android, ios, web and custom targets without npm publishing. Delete it for a target once that target's steps are in. Until then the target's job fails and `mark` never records it as shipped.

Every step is guarded with an `if`:

```yaml
if: matrix.target == 'android' && steps.verify.outputs.already-published != 'true'
```

so it only runs for its target, and not when `verify` found the version already uploaded. In the preview workflow there is no `verify` step, so leave out the second half.

Secrets are shown by name. Create them as repository or organization secrets. Nothing here puts a secret value in a file or a log.

## Docker with docker/build-push-action

```yaml
- name: Log in to GitHub Container Registry
  if: matrix.target == 'docker-api'
  uses: docker/login-action@v4
  with:
    registry: ghcr.io
    username: ${{ github.actor }}
    password: ${{ secrets.GITHUB_TOKEN }}
# ... stamp and verify ...
- uses: docker/setup-buildx-action@v4
  if: matrix.target == 'docker-api' && steps.verify.outputs.already-published != 'true'
- name: Build and push
  if: matrix.target == 'docker-api' && steps.verify.outputs.already-published != 'true'
  uses: docker/build-push-action@v7
  with:
    context: apps/api
    file: apps/api/Dockerfile
    platforms: linux/amd64,linux/arm64
    push: true
    tags: ${{ steps.stamp.outputs.docker-tags }}
    labels: ${{ steps.stamp.outputs.docker-labels }}
    cache-from: type=gha,scope=docker-api
    cache-to: type=gha,mode=max,scope=docker-api
```

- Put the login step **before** `verify`. A private GHCR package needs read access for the registry check.
- Give the job `packages: write` for GHCR.
- `docker-tags` and `docker-labels` follow the `tags` config of the target and the channel: release tags for a release, preview tags for a preview.
- Multi-platform builds with `platforms:` need QEMU: add `docker/setup-qemu-action@v3` before Buildx.
- If your Dockerfile wants the version, pass it as a build argument: `build-args: VERSION=${{ steps.stamp.outputs.version }}`.

Docker Hub: use `username: ${{ secrets.DOCKERHUB_USERNAME }}` and `password: ${{ secrets.DOCKERHUB_TOKEN }}` and leave out `registry`.

## Android with Gradle

The `stamp` step has written `versionName` and `versionCode`. Build the bundle, signed with a keystore from secrets.

```yaml
- uses: actions/setup-java@v6
  if: matrix.target == 'android' && steps.verify.outputs.already-published != 'true'
  with:
    distribution: temurin
    java-version: "21"
- name: Restore the upload keystore
  if: matrix.target == 'android' && steps.verify.outputs.already-published != 'true'
  env:
    ANDROID_KEYSTORE_BASE64: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}
  run: echo "$ANDROID_KEYSTORE_BASE64" | base64 --decode > "$RUNNER_TEMP/upload.keystore"
- name: Build the app bundle
  if: matrix.target == 'android' && steps.verify.outputs.already-published != 'true'
  working-directory: apps/mobile/android
  run: ./gradlew bundleRelease
  env:
    ANDROID_KEYSTORE_PATH: ${{ runner.temp }}/upload.keystore
    ANDROID_KEYSTORE_PASSWORD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
    ANDROID_KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}
    ANDROID_KEY_PASSWORD: ${{ secrets.ANDROID_KEY_PASSWORD }}
```

In `app/build.gradle`, read the signing values from the environment:

```groovy
android {
    signingConfigs {
        release {
            storeFile file(System.getenv("ANDROID_KEYSTORE_PATH") ?: "upload.keystore")
            storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
            keyAlias System.getenv("ANDROID_KEY_ALIAS")
            keyPassword System.getenv("ANDROID_KEY_PASSWORD")
        }
    }
    buildTypes {
        release { signingConfig signingConfigs.release }
    }
}
```

launchset only edits `versionCode` and `versionName` in `defaultConfig`, so the signing config doesn't interfere. Where the keystore comes from is covered in [Google Play pipeline](/store-pipelines/google-play/).

## Android upload with fastlane supply

```ruby title="android/Gemfile"
source "https://rubygems.org"
gem "fastlane"
```

```yaml
- uses: ruby/setup-ruby@v1
  if: matrix.target == 'android' && steps.verify.outputs.already-published != 'true'
  with:
    ruby-version: "3.3"
    bundler-cache: true
    working-directory: apps/mobile/android
- name: Upload to Google Play
  if: matrix.target == 'android' && steps.verify.outputs.already-published != 'true'
  working-directory: apps/mobile/android
  run: |
    bundle exec fastlane supply \
      --aab app/build/outputs/bundle/release/app-release.aab \
      --track "$PLAY_TRACK" \
      --package_name "com.acme.app" \
      --skip_upload_metadata --skip_upload_images --skip_upload_screenshots
  env:
    PLAY_TRACK: ${{ steps.stamp.outputs.channel == 'release' && 'production' || (steps.stamp.outputs.channel == 'prerelease' && 'beta' || 'internal') }}
    SUPPLY_JSON_KEY_DATA: ${{ secrets.LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON }}
```

`channel` picks the track: `release` goes to `production`, `prerelease` to `beta` and `preview` to `internal`. Use another mapping if you want releases to land in a closed track first.

A brand-new app that has never been released can only be uploaded as a draft: add `--release_status draft` until the first release is published in the Play Console.

## iOS with xcodebuild

Runs on macOS. The generated workflow already sets `runs-on` to `macos-latest` for the iOS target. The `stamp` step has written the marketing version and build number into the Xcode project.

First import the signing certificate and the provisioning profile into a temporary keychain:

```yaml
- name: Import signing certificate and provisioning profile
  if: matrix.target == 'ios' && steps.verify.outputs.already-published != 'true'
  env:
    IOS_CERTIFICATE_BASE64: ${{ secrets.IOS_CERTIFICATE_BASE64 }}
    IOS_CERTIFICATE_PASSWORD: ${{ secrets.IOS_CERTIFICATE_PASSWORD }}
    IOS_PROVISIONING_PROFILE_BASE64: ${{ secrets.IOS_PROVISIONING_PROFILE_BASE64 }}
  run: |
    KEYCHAIN="$RUNNER_TEMP/build.keychain-db"
    KEYCHAIN_PASSWORD="$(uuidgen)"
    security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
    security set-keychain-settings -lut 21600 "$KEYCHAIN"
    security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
    echo "$IOS_CERTIFICATE_BASE64" | base64 --decode > "$RUNNER_TEMP/certificate.p12"
    security import "$RUNNER_TEMP/certificate.p12" -P "$IOS_CERTIFICATE_PASSWORD" \
      -A -t cert -f pkcs12 -k "$KEYCHAIN"
    security set-key-partition-list -S apple-tool:,apple: -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
    security list-keychain -d user -s "$KEYCHAIN"
    echo "$IOS_PROVISIONING_PROFILE_BASE64" | base64 --decode > "$RUNNER_TEMP/app.mobileprovision"
    security cms -D -i "$RUNNER_TEMP/app.mobileprovision" > "$RUNNER_TEMP/app.plist"
    PROFILE_UUID="$(/usr/libexec/PlistBuddy -c 'Print UUID' "$RUNNER_TEMP/app.plist")"
    mkdir -p "$HOME/Library/MobileDevice/Provisioning Profiles"
    cp "$RUNNER_TEMP/app.mobileprovision" \
      "$HOME/Library/MobileDevice/Provisioning Profiles/$PROFILE_UUID.mobileprovision"
```

Then archive and export. Set the app target to **manual signing** with the distribution profile in the Xcode project (or pass a profile per target in `ExportOptions.plist`). Don't pass `PROVISIONING_PROFILE_SPECIFIER` on the command line: it applies to every target, Pods included.

```yaml
- name: Archive and export
  if: matrix.target == 'ios' && steps.verify.outputs.already-published != 'true'
  run: |
    xcodebuild archive \
      -project apps/mobile/ios/App.xcodeproj \
      -scheme App \
      -configuration Release \
      -destination "generic/platform=iOS" \
      -archivePath "$RUNNER_TEMP/App.xcarchive"
    xcodebuild -exportArchive \
      -archivePath "$RUNNER_TEMP/App.xcarchive" \
      -exportOptionsPlist apps/mobile/ios/ExportOptions.plist \
      -exportPath "$RUNNER_TEMP/export"
  env:
    # For scripts that want the values. iOS wants the plain X.Y.Z: use marketing-version.
    LAUNCHSET_VERSION: ${{ steps.stamp.outputs.marketing-version }}
    LAUNCHSET_BUILD_NUMBER: ${{ steps.stamp.outputs.build-number }}
```

```xml title="apps/mobile/ios/ExportOptions.plist"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>ABCDE12345</string>
  <key>signingStyle</key><string>manual</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>com.acme.app</key><string>Acme App Store</string>
  </dict>
</dict>
</plist>
```

List every bundle id of the app, including extensions, under `provisioningProfiles`. Each needs its own profile. The `stamp` step gave extensions and widgets the same version and build number as the app.

For a workspace (CocoaPods) use `-workspace App.xcworkspace` instead of `-project`.

## iOS upload to TestFlight with fastlane

```ruby title="apps/mobile/ios/fastlane/Fastfile"
default_platform(:ios)

platform :ios do
  lane :testflight do |options|
    api_key = app_store_connect_api_key(
      key_id: ENV.fetch("ASC_KEY_ID"),
      issuer_id: ENV.fetch("ASC_ISSUER_ID"),
      key_content: ENV.fetch("ASC_PRIVATE_KEY"),
    )
    upload_to_testflight(
      api_key: api_key,
      ipa: options.fetch(:ipa),
      skip_waiting_for_build_processing: true,
    )
  end
end
```

```yaml
- uses: ruby/setup-ruby@v1
  if: matrix.target == 'ios' && steps.verify.outputs.already-published != 'true'
  with:
    ruby-version: "3.3"
    bundler-cache: true
    working-directory: apps/mobile/ios
- name: Upload to TestFlight
  if: matrix.target == 'ios' && steps.verify.outputs.already-published != 'true'
  working-directory: apps/mobile/ios
  run: bundle exec fastlane testflight ipa:"$RUNNER_TEMP/export/App.ipa"
  env:
    ASC_KEY_ID: ${{ secrets.LAUNCHSET_ASC_KEY_ID }}
    ASC_ISSUER_ID: ${{ secrets.LAUNCHSET_ASC_ISSUER_ID }}
    ASC_PRIVATE_KEY: ${{ secrets.LAUNCHSET_ASC_PRIVATE_KEY }}
```

The same three secrets are used by `verify`. `key_content` takes the raw contents of the `.p8` file. A build uploaded to TestFlight can then be sent to external testers or submitted for App Store review in App Store Connect. `channel` helps you decide where it goes: you could upload `prerelease` builds and make them available to an external beta group with a second fastlane step.

## Flutter

For targets with `source: { kind: "flutter" }`. The `stamp` step has written the version and build number into the app's `pubspec.yaml`. Pass them to `flutter build` as well, so the build doesn't depend on what ran before it. See [Flutter](/targets/flutter/).

Android, with the upload from [fastlane supply](#android-upload-with-fastlane-supply) after it. The bundle lands in `build/app/outputs/bundle/release/app-release.aab` under the Flutter folder:

```yaml
- uses: actions/setup-java@v6
  if: matrix.target == 'android' && steps.verify.outputs.already-published != 'true'
  with:
    distribution: temurin
    java-version: "17"
- uses: subosito/flutter-action@v2
  if: matrix.target == 'android' && steps.verify.outputs.already-published != 'true'
  with:
    channel: stable
    cache: true
- name: Build the app bundle
  if: matrix.target == 'android' && steps.verify.outputs.already-published != 'true'
  working-directory: apps/mobile
  run: flutter build appbundle --release --build-name "$BUILD_NAME" --build-number "$BUILD_NUMBER"
  env:
    BUILD_NAME: ${{ steps.stamp.outputs.marketing-version }}
    BUILD_NUMBER: ${{ steps.stamp.outputs.build-number }}
```

Signing works as in [Android with Gradle](#android-with-gradle): the release `signingConfig` in `android/app/build.gradle.kts` reads the keystore.

iOS runs on macOS, with the upload from [TestFlight with fastlane](#ios-upload-to-testflight-with-fastlane) after it. `flutter build ipa` archives and exports in one step, to `build/ios/ipa/`:

```yaml
- uses: subosito/flutter-action@v2
  if: matrix.target == 'ios' && steps.verify.outputs.already-published != 'true'
  with:
    channel: stable
    cache: true
- name: Build the IPA
  if: matrix.target == 'ios' && steps.verify.outputs.already-published != 'true'
  working-directory: apps/mobile
  run: |
    flutter build ipa --release \
      --export-options-plist=ios/ExportOptions.plist \
      --build-name "$BUILD_NAME" \
      --build-number "$BUILD_NUMBER"
  env:
    BUILD_NAME: ${{ steps.stamp.outputs.marketing-version }}
    BUILD_NUMBER: ${{ steps.stamp.outputs.build-number }}
```

The `marketing-version` output of an `ios` target is always the plain `X.Y.Z`, also on previews.

On GitLab, the job's script gets the same values from `launchset.sh`:

```yaml
- cd apps/mobile
- flutter build appbundle --release --build-name "$LAUNCHSET_VERSION" --build-number "$LAUNCHSET_BUILD_NUMBER"
```

The generated `.gitlab/launchset-targets.yml` installs Flutter from its git repository in `before_script`. Pin a release there with `--branch <version>`.

## The verify step's environment

When a target has `verify: ["store"]`, give the `verify` step the credentials:

```yaml
- id: verify
  uses: demonsters/launchset-action@v1
  with:
    command: verify
    target: ${{ matrix.target }}
    plan: ${{ needs.launchset.outputs.plan }}
  env:
    LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON: ${{ secrets.LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON }}
    LAUNCHSET_ASC_KEY_ID: ${{ secrets.LAUNCHSET_ASC_KEY_ID }}
    LAUNCHSET_ASC_ISSUER_ID: ${{ secrets.LAUNCHSET_ASC_ISSUER_ID }}
    LAUNCHSET_ASC_PRIVATE_KEY: ${{ secrets.LAUNCHSET_ASC_PRIVATE_KEY }}
```

`launchset init` writes the right `env:` lines for the stores your config checks.

## Use the preview workflow for the same steps

`launchset-preview.yml` has the same shape. Copy the steps, drop the `already-published` half of the `if`, and send builds to internal channels: the Play `internal` track (the `channel` mapping above does this for `preview`) and TestFlight, where you keep builds with internal testers.
