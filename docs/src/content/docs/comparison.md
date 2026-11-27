---
title: Compared to other tools
description: How launchset relates to Changesets, release-please and semantic-release, what it does that they don't, and when one of them is the better pick.
---

launchset borrows most of its ideas. Changeset files and the release PR come from [Changesets](https://github.com/changesets/changesets), and [release-please](https://github.com/googleapis/release-please) works with a release PR too. What's different is the kind of repo launchset is built for: one product with one version, shipped as several things at once, such as a Docker image, a web app, an Android app and an iOS app.

The other tools version packages, such as npm packages, Python packages, Go modules and crates. They do that very well, so launchset leaves packages to them.

## What launchset adds

- **The version goes into native project files.** `versionName` in Gradle, `MARKETING_VERSION` in the Xcode project or `CFBundleShortVersionString` in `Info.plist`, the `expo` object in `app.json` (experimental), Docker image tags. The other tools can update arbitrary files with a marker comment or a script of your own, but they don't know these formats.
- **Store build numbers.** `versionCode` and `CFBundleVersion` are assigned in CI and never committed. By default they always go up, across every branch. launchset can check them against Google Play and App Store Connect before your upload step runs. See [Build numbers](/guides/build-numbers/).
- **One release, many build jobs.** Merging the release PR plans one CI job per target. Each job records a marker tag when it ships, and `v1.5.0` is only tagged once every target shipped. Re-running a failed job skips the targets that already shipped. See [Release flow](/guides/release-flow/).
- **Preview builds of apps.** Label a PR and get a TestFlight, Play internal or Docker build at `1.5.0-pr.123.4`, with nothing committed or tagged. See [Previews](/guides/previews/).

## Feature table

Compared with the tools teams most often use for releases. Checked against their documentation in November 2026; corrections are welcome.

| | launchset | Changesets | release-please | semantic-release |
| --- | --- | --- | --- | --- |
| **Built for** | One version, shipped as several apps and images | npm packages in a workspace | Packages in many languages | Packages, mostly npm |
| **Release intent comes from** | Changeset files | Changeset files | Conventional Commit messages | Conventional Commit messages |
| **Release PR to review** | Yes | Yes | Yes | No: every releasable merge releases |
| **Independent version per package** | No: one version per repo | Yes, plus fixed and linked groups | Yes | Through community plugins |
| **Ecosystems** | Version in a `package.json`; other files stamped through JSON, YAML or regex | JavaScript | Node, Python, Java, Go, Rust, Ruby, PHP, Helm and more | npm first, others through plugins |
| **Android and iOS version files** | Built in | No | Marker comments in each file (`extra-files`) | Your own scripts (`@semantic-release/exec`) |
| **Store build numbers** | Assigned in CI, checked against the stores | No | No | No |
| **Publishes** | Nothing: your workflow builds and uploads | npm packages | Nothing: you add publish steps | npm, GitHub and GitLab releases; more through plugins |
| **Release tag waits for every target** | Yes | Tags each package after it's published | No: tags when the release PR merges | No: tags before publishing |
| **PR preview builds** | App, store and image builds | Snapshot releases of npm packages | No | No |
| **Prereleases** | Prerelease branches (experimental), no state file | Pre mode (`pre.json`) | Prerelease versioning | Prerelease branches |
| **Hotfix branches** | `release/1.4.x`, with a changelog backport PR | No built-in support | Run it on the hotfix branch | Maintenance branches |
| **CI** | GitHub Actions, GitLab CI | GitHub Action; the CLI runs anywhere | GitHub | Most CI services |
| **Maturity** | New: 1.0 shipped in November 2026, used at <a href="https://demonsters.nl" target="_blank" rel="noopener">De Monsters</a> | Widely used | Widely used, maintained by Google | Widely used |
| **License** | MIT | MIT | Apache 2.0 | MIT |

## When another tool fits better

- **You publish libraries.** Several npm packages with their own versions: use Changesets. Packages in Python, Go, Rust or Java: use release-please. A repo with both an app and published packages can run launchset [alongside Changesets](/guides/with-changesets/).
- **Your team already writes Conventional Commits** and likes it. release-please and semantic-release read the release from those messages, with no extra file per PR.
- **You want every merge to release, without a release PR.** That's semantic-release.
- **Your targets ship on their own schedules, with their own versions.** launchset releases everything together on purpose. Only [manual targets](/guides/manual-targets/) step outside that, and they still share the version.
- **Your CI isn't GitHub Actions or GitLab CI.** semantic-release runs on most CI services.
- **You're in an Nx workspace.** Nx Release versions and publishes the projects Nx already knows about.

## Tools launchset works with

launchset doesn't replace the tools that build and upload. fastlane, Gradle, Xcode, `docker/build-push-action` and EAS Build run in your workflow's steps, and launchset hands them the version, the build number and the channel. See [Workflow recipes](/guides/recipes/).

fastlane can bump version and build numbers on its own (`increment_version_number`, `increment_build_number`), but it has no changesets, release PR or changelog. In an Expo project that numbers its builds with EAS, use the `eas` build number strategy: see [Expo](/targets/expo/).
