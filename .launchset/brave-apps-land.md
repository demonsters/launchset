---
bump: minor
---

`launchset init` finds Flutter apps, also inside a monorepo where the app has no `package.json`. It proposes Android and iOS targets that stamp the app's `pubspec.yaml`, offers that file as the version file in a repo without `package.json`, warns when the native projects don't read Flutter's numbers, and retires what rewrites the pubspec version (cider, pubver, `sed -i` or `yq -i` on `pubspec.yaml`, Dart scripts in `tool/`, `melos version`).
