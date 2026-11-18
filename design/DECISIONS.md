# Decisions taken during the build

Details the spec left open, and how they were settled. One line each: what, why, spec section.
Entries marked **NEEDS REVIEW** deviate from the spec because it couldn't be done as written.

- `preview: false` disables previews and prerelease branches; it's the only way to use the `semver` build-number strategy, since validation rejects semver while previews are enabled. Why: previews are otherwise always possible (label, `workflow_dispatch`). (5, 7.2)
- `changelog.github` defaults to `true`; without a token or a match the links are simply left out. Why: matches the spec example and costs nothing without a token. (5, 12)
- iOS `plist` source takes `file` (one plist) or `files` (several). Why: "one or more Info.plist files", and `file` matches the other sources. (6.4)
- `json` and `yaml` file entries require `key`. Why: explicit beats a guessed default. (6.6)
- A `preview-plan` plan has `mode: "preview"`; the action's `mode` output keeps the four release modes. Why: one plan shape for both, as the spec asks, without pretending a preview is a release mode. (9.7, 10)
- Development and tests run on Node 26; the action bundle targets Node 24 and is smoke-tested on Node 24. (11, 13)
