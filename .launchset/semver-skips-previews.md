---
bump: patch
---

The `semver` build-number strategy now works on targets that previews never build, also while previews are enabled. A target is rejected only when it is in `preview.targets` (`"all"`, the default, is every target) or in the `targets` of a `preview.branches` entry, and the error names the target and says to take it out of those lists or set `preview: false`. So hand-shipped iOS and Android apps can use `buildNumber: { strategy: "semver" }` while previews build only, say, a Docker image. `semver` as the repo-wide `buildNumber.strategy` still needs `preview: false`, and a manual preview run can't name a `semver` target (its `all` leaves them out).
