---
title: Compared to other tools
description: How launchset relates to package release tools (Changesets, release-please, semantic-release) and to mobile release management (Tramline, Runway, Expo EAS), and when one of them is the better pick.
---

launchset sits between two kinds of tools, and borrows from both.

- **Package release tools** such as [Changesets](https://github.com/changesets/changesets), [release-please](https://github.com/googleapis/release-please) and [semantic-release](https://github.com/semantic-release/semantic-release) version packages: npm packages, Python packages, Go modules, crates. Changeset files and the release PR come from there. They do packages very well, so launchset leaves packages to them.
- **Mobile release management** such as [Tramline](https://tramline.app/), [Runway](https://www.runway.team/) and, for Expo apps, [EAS](https://expo.dev/eas) runs the release of an app: release trains, store submissions, staged rollouts, approvals. They go much further into the stores than launchset does.

launchset is built for one product with one version, shipped as several things at once, such as a Docker image, a web app, an Android app and an iOS app. It lives in your repo and your CI, and stops where your upload steps start.

Comparisons were checked against each tool's own documentation in November 2026. If something is wrong or out of date, [open an issue](https://github.com/demonsters/launchset/issues/new/choose).

## What launchset adds

- **The version goes into native project files.** `versionName` in Gradle, `MARKETING_VERSION` in the Xcode project or `CFBundleShortVersionString` in `Info.plist`, the `expo` object in `app.json` (experimental), Docker image tags. The package tools can update arbitrary files with a marker comment or a script of your own, but they don't know these formats.
- **Store build numbers.** `versionCode` and `CFBundleVersion` are assigned in CI and never committed. By default they always go up, across every branch. launchset can check them against Google Play and App Store Connect before your upload step runs. See [Build numbers](/guides/build-numbers/).
- **Apps, images and web in one release.** Merging the release PR plans one CI job per target. Each job records a marker tag when it ships, and `v1.5.0` is only tagged once every target shipped. Re-running a failed job skips the targets that already shipped. See [Release flow](/guides/release-flow/).
- **Preview builds of apps.** Label a PR and get a TestFlight, Play internal or Docker build at `1.5.0-pr.123.4`, with nothing committed or tagged. See [Previews](/guides/previews/).
- **Nothing to host.** launchset is a CLI and a CI action. Its state is git tags, so there is no service, database or account.

## Package release tools

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

## Mobile release management

These tools start roughly where launchset stops. launchset decides the version, writes it into your files, numbers the build and records what shipped. Tramline and Runway also run the store side: they cut release branches on a schedule, send builds to testers, submit for review, and run staged rollouts that pause when crash rates go up. EAS is Expo's build, submit and update service; the part that overlaps with launchset is how it numbers builds.

They are also mobile only. If the same release has to ship an API image or a web app, that part stays with you.

| | launchset | Tramline | Runway | Expo EAS |
| --- | --- | --- | --- | --- |
| **What it is** | A CLI and a CI action in your repo | A release management app, hosted or self-hosted | A hosted release management service | Expo's build, submit and update service |
| **Ships** | Docker, web, Android, iOS and custom targets, including React Native, Capacitor, Expo and Flutter apps | iOS and Android apps, including Flutter | iOS and Android apps | Expo and React Native apps |
| **The next version comes from** | Changesets in each PR | A strategy per release train (by default a minor bump per release, a patch bump for fixes) | A strategy per app | You, in the app config |
| **Version written into files** | By the release PR, which you review and merge | Passed to CI; optionally a version bump PR | A version bump PR | You keep it in the app config |
| **Build numbers** | Computed in CI (timestamp by default), optionally checked against the stores | A counter that checks the stores' latest build | Not covered in their public docs | A counter on Expo's servers (`autoIncrement`) |
| **When a release starts** | When you merge the release PR | On a schedule, or by hand | On a schedule, or by hand | When you run a build, by hand or from an EAS Workflow |
| **Store submission and review** | No: your upload steps (fastlane, Gradle) | Yes | Yes | Yes (EAS Submit) |
| **Staged rollouts** | No | Yes; Android rollouts pause when health rules fail | Yes, with health checks that halt the rollout | Percentage rollouts of OTA updates |
| **Approvals** | Review of the release PR; anything more through your CI | Optional approvals before submitting | Approvals and checklists | Not covered here |
| **Over-the-air updates** | No ([#1](https://github.com/demonsters/launchset/issues/1)) | Not covered in their public docs | Not covered in their public docs | Yes (EAS Update) |
| **Hotfixes** | `release/1.4.x` branches, changelog backport PR | A hotfix release from the last release, fixes backmerged by PR | Cherry-picks into the release branch | A new build, or an OTA update |
| **Changelog** | `CHANGELOG.md` and a GitHub Release, from changesets | A GitHub Release with a generated changelog; store notes carried over | Release notes per release; Jira integration | No release changelog |
| **CI and forges** | GitHub Actions, GitLab CI | GitHub Actions, GitLab CI, Bitbucket Pipelines, Bitrise | GitHub, GitLab, Bitbucket, Azure DevOps; Bitrise, Codemagic, Jenkins, CircleCI, GitHub Actions | Its own build servers, or local builds |
| **Something to run** | No: state lives in git tags | Their hosted app, or your own (Postgres, Redis) | Their service | Expo's service |
| **License and price** | MIT, free | Apache 2.0 | Free for up to 2 apps and 4 users; paid plans priced per app | Free tier and paid plans |

Runway's and Tramline's details come from their marketing pages and docs, and EAS's from Expo's docs. Where those don't say, the table says so.

## When another tool fits better

- **You publish libraries.** Several npm packages with their own versions: use Changesets. Packages in Python, Go, Rust or Java: use release-please. A repo with both an app and published packages can run launchset [alongside Changesets](/guides/with-changesets/).
- **Your team already writes Conventional Commits** and likes it. release-please and semantic-release read the release from those messages, with no extra file per PR.
- **You want every merge to release, without a release PR.** That's semantic-release.
- **You want someone to run the store side.** Scheduled release trains, store review submissions, staged rollouts that pause on crashes, sign-offs: that's Tramline (open source, can be self-hosted) or Runway (hosted). launchset leaves those steps to your own fastlane or Gradle steps.
- **You have one Expo app and nothing else in the repo.** EAS's remote version source and `autoIncrement` may be all the versioning you need. launchset helps more when the same release also ships an API or a web app.
- **Your targets ship on their own schedules, with their own versions.** launchset releases everything together on purpose. Only [manual targets](/guides/manual-targets/) step outside that, and they still share the version.
- **Your CI isn't GitHub Actions or GitLab CI.** semantic-release runs on most CI services; Runway and Tramline work with Bitrise and others.
- **You're in an Nx workspace.** Nx Release versions and publishes the projects Nx already knows about.

## Tools launchset works with

launchset doesn't replace the tools that build and upload. fastlane, Gradle, Xcode, `docker/build-push-action` and EAS Build run in your workflow's steps, and launchset hands them the version, the build number and the channel. See [Workflow recipes](/guides/recipes/).

fastlane can bump version and build numbers on its own (`increment_version_number`, `increment_build_number`), but it has no changesets, release PR or changelog. In an Expo project that numbers its builds with EAS, use the `eas` build number strategy: see [Expo](/targets/expo/).
