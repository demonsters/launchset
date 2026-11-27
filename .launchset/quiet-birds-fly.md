---
bump: minor
---

Flutter apps are supported (experimental). Android and iOS targets take `source: { kind: "flutter", dir }`, which stamps the `version` in the app's `pubspec.yaml`: the release PR writes the version and keeps the `+N`, and CI writes the build number after the `+`. `version.file` can be a `pubspec.yaml`, so a repo with only a Flutter app needs no `package.json`. The generated GitHub and GitLab steps pass the numbers to `flutter build` as `--build-name` and `--build-number`.
