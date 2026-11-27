---
bump: patch
---

`launchset init` leaves the targets that only have the "build steps missing" placeholder out of `preview.targets`, so the first preview no longer fails on them, and its steps say to create the `launchset:preview` label.
