---
bump: patch
---

`launchset init` points out copied workflow steps that run electron-builder without `--publish`: in CI electron-builder publishes to GitHub Releases by itself and fails without `GH_TOKEN`. Pass `--publish never`, or set `GH_TOKEN` on purpose.
