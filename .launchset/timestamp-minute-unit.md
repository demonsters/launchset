---
bump: patch
---

The `timestamp` build-number strategy takes a `unit`: `buildNumber: { strategy: "timestamp", unit: "minute" }` counts whole minutes since `epoch` instead of seconds, so numbers stay under Android's 2,100,000,000 limit until about the year 6000 instead of 2086. The default stays `"second"`, so existing configs give the same numbers. It works repo-wide and per target, and is a config error with any other strategy. Two builds in the same minute get the same number, and switching an app that already has uploads from seconds to minutes needs an `offset` above its highest build number (see Build numbers in the docs).
