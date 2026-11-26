# launchset: specification (v1)

Status: agreed design, ready to build. Last updated 2026-11-18.

Package: `@demonsters/launchset` (private npm package, demonsters org).
Repo: https://github.com/demonsters/launchset (private). The CLI, the GitHub Action source, the docs site and the agent skills live in this repo.
Action: https://github.com/demonsters/launchset-action (**public**). It contains only the released, bundled action (section 10), so any repo in any org can use it without access settings. launchset may be open-sourced later; the public bundle already makes the core readable, which is accepted.

---

## 1. What launchset is

launchset is a Changesets-style release tool for repos where **one version** drives **many build targets**: Docker images, Android, iOS and web apps, all built from the same repo and released together.

Developers describe each change in a small changeset file in their PR. Commit messages don't matter. launchset collects the changesets into a release PR. Merging that PR is the release: launchset then tells CI which targets to build, what version and build number to use, and records which targets have shipped.

**launchset does not build anything.** It decides *what* to release, writes version numbers into files, and records results. The team's own workflow steps (docker build/push, Gradle, fastlane, Xcode, etc.) do the building and uploading.

### 1.1 Principles

1. **One version per repo.** The root `package.json` `version` is the single source of truth.
2. **Lock step, no partial releases.** Every release builds every target. A changeset never targets a subset. The one exception is a **manual target** (section 9.8): its version is still stamped by every release, but it's shipped on demand for an already released version.
3. **No commit-message conventions.** Release intent lives in changeset files only.
4. **Build numbers are assigned in CI at build time and never committed.** That makes build numbers independent of branches.
5. **Idempotent.** Re-running any workflow never double-publishes. State lives in git tags, not in external systems.
6. **GitHub Actions only** (for v1). GitLab CI is supported too: see design/GITLAB.md.
7. **Agent-friendly.** Every CLI command works non-interactively with flags and can print JSON.

### 1.2 Out of scope for v1

- Per-package npm publishing in workspaces (that's what Changesets does). launchset can run next to Changesets in one repo: launchset releases the one version and its targets, Changesets versions and publishes the independently versioned npm packages. Each package is released by one tool. The docs describe the setup ("Alongside Changesets").
- CI systems other than GitHub Actions.
- Expo OTA updates / `runtimeVersion` handling: issue [#1](https://github.com/demonsters/launchset/issues/1).
- Store-ready release notes per platform: issue [#2](https://github.com/demonsters/launchset/issues/2). Unknown changeset frontmatter keys must be kept (not rejected) so #2 can add a field later.
- Running the actual builds or store uploads.
- Build services that run outside GitHub Actions (Xcode Cloud, Codemagic). Expo EAS is covered by the `eas` build-number strategy (7.2). A generic `external` strategy can be added when a project needs it.

---

## 2. Glossary

| Term | Meaning |
|---|---|
| **Changeset** | A markdown file in `.launchset/` with a bump type and a summary. |
| **Target** | One thing that gets built and shipped per release, e.g. `docker-api`, `android`, `ios`, `web`. Each target becomes one job in the GitHub Actions matrix. |
| **Release** | Building and shipping every auto target for one version, from the release commit. |
| **Auto / manual target** | `release: "auto"` (default): built in every release's publish matrix, and required before the release tag. `release: "manual"`: stamped by every release PR, but shipped later on demand for a released version (section 9.8). |
| **Release commit** | The commit where the root version first became the version being released, looking only along the branch's **first-parent** history. In practice: the commit that was pushed when the release PR merged (the merge commit, or the single commit of a squash/rebase merge), never a commit on the release PR's side branch. All release builds check out this exact commit. |
| **Release PR** | The PR launchset opens and keeps updated, titled `Release vX.Y.Z`, that applies pending changesets. |
| **Marker tag** | A git tag recording that one target shipped for one version: `launchset/<target>@<version>`. |
| **Release tag** | `v<version>` (template `tags.release`), created only when **every** auto target has a marker. Means "this version is fully released". Only tags whose version is a plain `X.Y.Z` count as release tags; prerelease tags (9.9) and partial tags (9.6) never do. |
| **Prerelease** | A build from a prerelease branch (9.9): a preview with a stable version `X.Y.Z-<preid>.N`, a git tag and a GitHub pre-release, but nothing committed. |
| **Maintenance branch** | `release/<major>.<minor>.x`, used for hotfixes on an older version line. |
| **Preview** | A test build from a PR or branch (TestFlight, Play internal track, preview Docker tags). Has no side effects. |
| **Channel** | `release`, `prerelease` or `preview`, passed to each build job so the workflow chooses where to upload. |
| **Marketing version** | The user-visible version: `versionName` (Android), `CFBundleShortVersionString` / `MARKETING_VERSION` (iOS), `expo.version`. Committed by the release PR. |
| **Build number** | `versionCode` (Android), `CFBundleVersion` / `CURRENT_PROJECT_VERSION` (iOS), `expo.ios.buildNumber` / `expo.android.versionCode`. Assigned in CI only. |

---

## 3. Files in a repo that uses launchset

```
launchset.config.ts          # configuration (also .mjs, .js, .json)
.launchset/
  README.md                # short explanation + link to docs (written by init)
  brave-lions-sing.md      # a changeset
CHANGELOG.md
.github/workflows/
  launchset-check.yml
  launchset-release.yml
  launchset-preview.yml
.claude/skills/launchset/SKILL.md   # optional, installed by init
```

---

## 4. Changesets

### 4.1 Format

```md
---
bump: minor
---

Add offline mode to the mobile app.
```

- `bump`: `major` | `minor` | `patch` | `none`.
  - `none` means "this PR intentionally needs no release" (docs, CI tweaks). It satisfies the PR check and never triggers a release on its own. It's deleted at the next release and doesn't appear in the changelog.
- The body (after the frontmatter) is the changelog entry, in markdown. It can be several lines. It must not be empty unless `bump: none`.
- **Unknown frontmatter keys** produce a warning and are kept. Don't reject them (see issue #2).
- Generated changesets (for bot PRs, section 9.4) add `source: bot` and `pr: <number>`.
- Filename: three random lowercase words joined by dashes plus `.md`, like Changesets does (`brave-lions-sing.md`). Any `.md` file in `.launchset/` other than `README.md` is a changeset.
- Parse errors (missing or invalid frontmatter, invalid bump) are hard errors with file name and line.

### 4.2 Migration from Changesets

`launchset init` can convert existing `.changeset/*.md` files: their frontmatter (`"pkg-name": minor` lines) becomes one `bump` with the highest bump found. Summaries are kept. `.changeset/config.json` and `README.md` are left alone; init tells the user they can delete the folder.

### 4.3 Computing the bump

The release bump is the highest bump among all pending changesets (`major` > `minor` > `patch` > `none`). If only `none` changesets are pending, there is no release.

---

## 5. Configuration

`launchset.config.ts` (or `.mjs`, `.js`, `.json`). The TypeScript config is loaded with `jiti` (bundled), so it works on any supported Node version. The package exports `defineConfig` for types. The config is validated with `zod`; errors name the exact field and say what is expected.

```ts
import { defineConfig } from "@demonsters/launchset";

export default defineConfig({
  version: { file: "package.json" },          // default
  changelog: { file: "CHANGELOG.md", github: true },  // github: add PR links + authors
  baseBranch: "main",                          // default
  maintenanceBranches: "release/*.x",          // default; release/<major>.<minor>.x

  tags: {
    release: "v{version}",                     // default
    marker: "launchset/{target}@{version}",      // default
    partial: "launchset/partial/{version}",    // default; see 9.6
  },

  buildNumber: {
    strategy: "timestamp",                     // default; see section 7
    epoch: "2020-01-01T00:00:00Z",             // default
    offset: 0,                                 // default
  },

  check: {
    bots: ["dependabot[bot]", "renovate[bot]"],  // default
  },

  preview: {
    label: "launchset:preview",                  // default
    rebuildOnPush: true,                       // default
    branches: [],                              // auto-preview on push, see 9.7 and 9.9, e.g.
    //   ["develop"]
    //   [{ branch: "feature/*", targets: ["docker-api"] },
    //    { branch: "next/*", prerelease: "alpha" }]   // prerelease branch: tagged, 9.9
    targets: "all",                            // or ["android", "ios"]
  },

  targets: {
    "docker-api": {
      type: "docker",
      image: "ghcr.io/demonsters/api",
      tags: ["v{version}", "latest"],          // optional, see 6.1; also { release, preview, prerelease }
      verify: ["registry"],                    // optional: skip if the tag already exists
    },
    web: { type: "web" },
    android: {
      type: "android",
      source: { kind: "gradle", file: "apps/mobile/android/app/build.gradle" },
      verify: ["store"],                       // optional, needs Play credentials
      store: { packageName: "com.demonsters.app" },
    },
    ios: {
      type: "ios",
      source: { kind: "xcodeproj", file: "apps/mobile/ios/App.xcodeproj" },
      verify: ["store"],
      store: { appId: "1234567890" },
      release: "manual",                       // optional, default "auto"; see section 9.8
    },
    npm: {
      type: "custom",
      files: [{ path: "packages/sdk/package.json", kind: "json", key: "version" }],
    },
  },
});
```

Any target may override `buildNumber`. Any target may have extra `files` entries (section 6.6) to stamp the marketing version into more files. Any target may set `release: "manual"` (section 9.8).

**Validation rules** (config load fails with a clear message):
- At least one target. Target names: `[a-z0-9][a-z0-9-]*`.
- At least one target with `release: "auto"` (otherwise no release would ever complete).
- With previews enabled, `semver` is an error as the root `buildNumber.strategy` and on any target previews can build (section 7.2).
- Docker `tags` rules from 6.1 (a release list needs a `{version}` template; preview and prerelease lists can't contain `latest`).
- `preview.branches` entries are globs. Branches matching `maintenanceBranches` never auto-preview, even if a pattern matches them. A pattern that matches the base branch is an error for prerelease entries (9.9).
- Source files referenced by targets must exist.
- Unknown keys are errors (catches typos) except where noted.

---

## 6. Targets and file stamping

All file edits are **text-preserving**: only the version values change. Never re-serialize a whole file (no JSON re-formatting, no plist re-ordering, no pbxproj rewriting). Keep indentation, quotes, comments and line endings. Tests assert exact output.

**Rule: parse to find, splice to edit.** A stamper may parse a file only to find the exact character range of each value it changes. It then replaces those characters in the original text, and every other byte stays identical. It never writes a parsed structure back out.
- **JSON**: `jsonc-parser` (from VS Code) gives the offsets of a value; replace only the value.
- **YAML**: use the `yaml` library's node ranges to locate the scalar; replace only its text, keeping its quote style.
- **pbxproj**: read the object graph (`PBXNativeTarget` → `buildConfigurationList` → `XCBuildConfiguration`) only to find which configuration blocks belong to the selected targets. Within those blocks, replace only the value in `MARKETING_VERSION = …;` / `CURRENT_PROJECT_VERSION = …;`, keeping quotes if present, plus tabs and line endings. The diff must contain nothing but those value changes. Xcode and CocoaPods reformat this file on their own; launchset must never add to that churn, and doesn't try to undo it either.
- **Gradle, plist, xcconfig, gradle.properties**: small scanners scoped to the right block (`defaultConfig`, the key's `<string>` element, the key's line), with the same splice-only edit.
- If a value can't be located unambiguously, fail with the file and the reason rather than guessing.

Two kinds of stamping:
- **Marketing version**: written by the release PR (committed) and by previews in CI (not committed).
- **Build number**: written only in CI, by `launchset stamp` (never committed). The build-number values in the repo are placeholders; launchset doesn't care what they are, except `init` reading them for an offset (section 11).

### 6.1 `docker`

- Options: `image` (required, may be a list for several registries), `tags` (optional, see below), `verify: ["registry"]`.
- No files stamped by default.

**Tag templates.** `tags` is either a list (the release list; preview and prerelease keep their defaults) or an object `{ release?, preview?, prerelease? }` of lists. Each entry is a template.

| Placeholder | Value |
|---|---|
| `{version}` | the version of this run: the release version, the preview version (8.3) or the prerelease version (9.9) |
| `{major}`, `{minor}`, `{patch}` | parts of the plain `X.Y.Z` (for previews and prereleases: of `{next}`) |
| `{preid}` | prerelease id (prerelease only) |
| `{prNumber}` | PR number (PR previews only) |
| `{branchSlug}` | branch slug, 8.3 (branch previews and prereleases only) |
| `{sha}`, `{shortSha}` | full / 7-character commit sha of the built commit |
| `{buildNumber}` | the run's build number |

| List | Default | Example result |
|---|---|---|
| `release` | `["{version}", "{major}.{minor}", "{major}", "latest"]` | `1.5.0`, `1.5`, `1`, `latest` |
| `preview` | `["{version}", "pr-{prNumber}", "{branchSlug}"]` | `1.5.0-pr.123.4`, `pr-123` |
| `prerelease` | `["{version}", "{branchSlug}"]` | `1.5.0-alpha.3`, `next-new-form` |

Rules:
- A template whose placeholder has no value in this run (e.g. `{prNumber}` on a branch preview) is skipped.
- **Maintenance branches**: templates that contain neither `{version}` nor `{minor}` are dropped (that removes `latest` and major-only tags). This applies to custom lists too. A hotfix must never move `latest` or `{major}` while a newer line exists.
- **0.x versions**: templates that contain neither `{version}` nor `{minor}`, other than the literal `latest`, are skipped while the major version is 0. A moving `:0` tag means nothing.
- Validation: the `release` list must contain at least one template with `{version}` (used by `verify`, 7.4). `preview` and `prerelease` lists can't contain `latest` or a template that renders to a plain `X.Y.Z`.
- Existing images often use a `v` prefix (`app:v1.5.0`). Keep it with `tags: ["v{version}", …]`; `init` reads the current tags from existing workflows (11.1), following variables set from the git ref (`RELEASE_VERSION=${GITHUB_REF#refs/*/}` via `$GITHUB_ENV`) to keep the `v`.

- Outputs for the job: full image refs (`image:tag`, one per line and as JSON), plus `version`, `build-number`, `channel`, and OCI label values (`org.opencontainers.image.version`, `.revision`, `.created`) so the workflow can pass them to `docker/build-push-action`.

### 6.2 `web`

- No files stamped by default (the root `package.json` already has the version). Optional `files`.
- Outputs: `version`, `build-number`, `channel`.

### 6.3 `android`

`source.kind`:
- `gradle`: `build.gradle` (Groovy: `versionCode 12`, `versionName "1.4.0"`) or `build.gradle.kts` (`versionCode = 12`, `versionName = "1.4.0"`). Only edit inside `defaultConfig`. If product flavors override `versionName`/`versionCode`, error with a clear message (not supported in v1, suggest `gradle-properties`).
- `gradle-properties`: `gradle.properties` keys, configurable: `{ kind: "gradle-properties", file, versionNameKey: "VERSION_NAME", versionCodeKey: "VERSION_CODE" }`.
- `capacitor`: alias. `{ kind: "capacitor", dir: "apps/mobile" }` resolves to `<dir>/android/app/build.gradle`.
- `expo`: `{ kind: "expo", file: "app.json" }`: `expo.version` and `expo.android.versionCode` (integer).
- Bare React Native uses `gradle`.

Marketing version: `versionName`. On previews `versionName` is the full preview version (`1.5.0-pr.123.4`).
Build number: `versionCode`, integer, max 2,100,000,000 (Play limit). Exceeding it is an error.

### 6.4 `ios`

`source.kind`:
- `xcodeproj`: edits `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` in `project.pbxproj` for every `XCBuildConfiguration` of the selected native targets. Default: every target that has those settings, which covers app extensions and widgets (they must carry the same version and build number as the host app, or App Store Connect complains). Optional `xcodeTargets: ["App", "Widget"]` to limit it.
- `plist`: edits `CFBundleShortVersionString` and `CFBundleVersion` in one or more `Info.plist` files. If a value is a build-setting reference like `$(MARKETING_VERSION)`, error with a message saying to use `xcodeproj` (or `init` should detect this and pick `xcodeproj`).
- `xcconfig`: edits `MARKETING_VERSION = ...` and `CURRENT_PROJECT_VERSION = ...` in a `.xcconfig` file.
- `capacitor`: alias. `{ kind: "capacitor", dir: "apps/mobile" }` resolves to `<dir>/ios/App/App.xcodeproj`.
- `expo`: `expo.version` and `expo.ios.buildNumber` (string).
- Bare React Native uses `xcodeproj`.

Marketing version must be plain `X.Y.Z` (Apple doesn't accept prerelease suffixes). Previews use the plain next version, e.g. `1.5.0`; the build number tells preview builds apart.
Build number: positive integer, written as a string where the format wants a string.

### 6.5 Expo `app.config.js` / `app.config.ts`

These are code and can't be safely rewritten. launchset doesn't edit them. `init` and the docs tell users to read version and build numbers from `package.json` / environment variables in their config instead. launchset sets `LAUNCHSET_VERSION`, `LAUNCHSET_BUILD_NUMBER` and `LAUNCHSET_CHANNEL` as job outputs for that purpose.

### 6.6 `custom` and extra `files`

For anything else (an npm package, a Helm chart, a version file a web app reads):
- `files` is **optional** on a `custom` target. Without files, the target is just a matrix entry plus a marker: the release PR already bumped the root version, and the team's build step does the rest. launchset's own `npm` and `action` targets work this way (section 15).
- `{ path, kind: "json", key: "version" }`: dotted key path into a JSON file; text-preserving edit of that value only.
- `{ path, kind: "yaml", key: "appVersion" }`: same for YAML (e.g. `Chart.yaml`). Text-preserving.
- `{ path, kind: "regex", pattern: "...", replace: "...{version}..." }`: pattern must match exactly once, or error.
- Placeholders in `replace`: `{version}`, `{major}`, `{minor}`, `{patch}`, `{buildNumber}` (CI only).
- `{ path, kind: "image" }` (only in `docker` targets, opt-in): stamps image references in deploy manifests (k8s, Compose, Helm values). Every occurrence of `<image>:<tag>` for this target's `image` in the file gets the target's verify tag (6.1, 7.4), e.g. `image: ghcr.io/org/app:v1.5.0`. Text-preserving; error if the file has no reference to the image. `path` may be a glob (`deploy/k8s/*.yaml`); files in the glob without a reference are skipped, but the glob must match at least one reference. 6.7 checks that every reference equals the release tag. Stamped by the release PR like other files, so the committed manifests point at the release. Leave out manifests that hold per-environment deploy state (for example a production overlay that is promoted by hand). Kustomize `images[].newTag` (tag without the image name) isn't covered in v1.

**npm lockfile.** When `version.file` is a `package.json` and a `package-lock.json` or `npm-shrinkwrap.json` sits next to it, launchset also updates the root version in that lockfile: the top-level `"version"` and `packages[""].version`. This happens everywhere the version file is written (release PR, previews and prereleases in CI), with the same text-preserving edit, so the lockfile never drifts the way it would without `npm version`. If either value is missing, it's skipped silently. pnpm, Yarn and Bun lockfiles don't store the root version and need nothing.

### 6.7 Version consistency

`launchset status` and the PR check verify that every target's committed marketing version equals the root version. A mismatch (someone edited a version file by hand) fails the PR check with a list of files and values.

---

## 7. Build numbers

### 7.1 When and how

- A build number is computed **once per workflow run**, in the `plan` step, and shared by all targets in that run. Re-running failed jobs reuses the plan output, so a re-run uses the same number.
- `launchset stamp --target <name>` writes the version and build number into that target's files in the CI checkout.

### 7.2 Strategies

| Strategy | Value | Notes |
|---|---|---|
| `timestamp` (default) | `floor((now - epoch) / unit) + offset` | Epoch default `2020-01-01T00:00:00Z`; `unit` `"second"` (default) or `"minute"`. About 217 million in November 2026 (3.6 million in minutes); stays under the Android limit until about 2086 (minutes: about 6012). Always increases, across all branches, without credentials. Minutes: two builds in the same minute (two runs, or two ship runs) get the same number; switching an app with uploads from seconds to minutes needs an `offset` above its highest number. `unit` with another strategy is a config error. |
| `run-number` | `github.run_number + offset` | Simple; resets if the workflow file is renamed. Documented as such. |
| `semver` | `major*10^7 + minor*10^5 + patch*10^2 + attempt` | `attempt` is the run attempt (1 to 99; 1 outside CI and on GitLab), or the `attempt` input of a ship (9.8). **Only for targets previews never build** while previews are enabled: previews of `1.5.0` and the real `1.5.0` would compete for the same numbers. Config validation rejects `semver` as the root strategy while previews are enabled (previews number their plan with it), and on a target that `preview.targets` or a `preview.branches` entry's `targets` include (`"all"` is every target; an entry without `targets` uses `preview.targets`). A manual preview run can't name a `semver` target, and its `all` leaves them out. |
| `eas` | none | For Expo projects building on EAS with `appVersionSource: "remote"` and `autoIncrement`. launchset outputs no build number and doesn't stamp one. |

`offset` exists for migrating apps whose existing build numbers are higher than what the strategy would produce.

A target's override may set any of `strategy`, `epoch`, `offset` and `unit`; a target with an override gets its own number, every other target shares the run's.

### 7.3 Verification against stores (`verify: ["store"]`)

The store is not a source of numbers, only a safety check. `launchset verify --target <name>` (run in the build job, before uploading):
1. Fetch the highest build number already in the store.
   - **Google Play** (Android Publisher API v3): open an edit, list bundles and APKs, take the max `versionCode`, then delete the edit. Auth: service account JSON in `LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON`.
   - **App Store Connect API**: list builds for `appId`, take the max build `version`. Auth: JWT (ES256) from `LAUNCHSET_ASC_KEY_ID`, `LAUNCHSET_ASC_ISSUER_ID`, `LAUNCHSET_ASC_PRIVATE_KEY`.
2. If this exact build number already exists for this version: output `already-published=true`. The workflow skips the upload and goes straight to `mark`. (Covers "upload succeeded but the job failed before marking".)
3. If the store's highest number is **greater than or equal to** ours: fail, saying which number the store has and suggesting a `buildNumber.offset`.
4. Otherwise output `already-published=false`.

### 7.4 Registry verification (`verify: ["registry"]`)

For `docker` targets: check if the **verify tag** already exists. That is the first template in the run's tag list (6.1) that contains `{version}`, rendered: `image:1.5.0` with the defaults, `image:v1.5.0` with `tags: ["v{version}", …]`. The check uses the registry HTTP API (OCI distribution spec, `HEAD /v2/<name>/manifests/<tag>` with token auth). Support at least ghcr.io and Docker Hub; generic registries with basic auth. Credentials from env (`LAUNCHSET_REGISTRY_USERNAME` / `LAUNCHSET_REGISTRY_PASSWORD`) or the standard Docker config file. If it exists: `already-published=true`. This replaces the team's old "ask the Docker API whether the image exists" workflow, but only as a safety net: the source of truth is the marker tags. With private GHCR packages, `verify` needs read access before it runs: `packages: read` plus the registry env variables, or a `docker/login-action` step placed **before** `verify`. The generated workflow template does this.

---

### 7.5 npm verification (`verify: ["npm"]`)

For `custom` targets that publish an npm package:
- Config: `npm: { package: "package.json" }` (default: the root `package.json`). launchset reads the package name from that file, and the registry from `publishConfig.registry`, the repo's `.npmrc`, or `https://registry.npmjs.org`.
- Check: fetch the package document from the registry (`GET <registry>/<name>`, with `NODE_AUTH_TOKEN` or `LAUNCHSET_NPM_TOKEN` for private packages) and look for the exact version.
  - If it exists: `already-published=true`. The workflow skips `npm publish` and goes straight to `mark`. This covers "publish succeeded, but the job failed before marking".
  - If it doesn't exist, or the package itself doesn't exist yet (404): `already-published=false`.
- Any other error (auth, network) fails the step with a clear message. A failed check is never treated as "not published".
- The `dist-tag` output (section 10) tells the workflow which npm tag to publish with, so a hotfix doesn't move `latest`.

## 8. Versions

### 8.1 Next version

1. `current` = root `package.json` version.
2. `next` = `semver.inc(current, bump)`.
3. **Next free version**: if the release tag for `{next}` or any marker tag for `{next}` already exists (for example a hotfix released it from a maintenance branch), increase the patch until a free version is found. Example: main is at `1.4.0` with a pending patch, but `v1.4.1` was released from `release/1.4.x` → next is `1.4.2`.

### 8.2 Maintenance branches

- On a branch matching `maintenanceBranches` (e.g. `release/1.4.x`), only `patch` and `none` changesets are allowed. `minor`/`major` fail the PR check, saying the change belongs on main.
- The next version must stay in that line (`1.4.*`).

### 8.3 Preview versions

- Base: the next version computed from the changesets on the PR/branch. If none are pending, use a patch bump.
- PR: `{next}-pr.{prNumber}.{runNumber}` → `1.5.0-pr.123.4`.
- Branch preview (auto or `workflow_dispatch`): `{next}-{branchSlug}.{runNumber}` → `1.5.0-develop.17`. Slug: lowercase, `[a-z0-9-]`, max 30 chars.
- Prerelease branch (9.9): `{next}-{preid}.{n}` → `1.5.0-alpha.3`, where `n` is the next free number for that `{next}` and `{preid}`, starting at 0.
- iOS marketing version: plain `{next}` (section 6.4).

---

## 9. The GitHub flow

### 9.1 Authentication: GitHub App

Events caused by the default `GITHUB_TOKEN` don't trigger other workflows. A release PR opened with it would never run CI (so required checks block merging) and tags pushed with it wouldn't trigger tag workflows. So:

- Each org that uses launchset has its own **GitHub App** (for demonsters: "launchset"), created by an org owner in the browser. The agent building launchset can't create it; the docs must explain how, step by step. Because the action is public (section 10), another org only needs to create its own App and secrets.
- Repository permissions: **Contents: read & write**, **Pull requests: read & write**, Metadata: read (automatic). Verify during implementation whether anything else is needed (for example Issues: write for labels or comments, Checks: read) and document the final list.
- Org variable `LAUNCHSET_APP_CLIENT_ID` and org secret `LAUNCHSET_APP_PRIVATE_KEY` (older setups: the secret `LAUNCHSET_APP_ID`, which the workflows still accept as a fallback).
- Workflows mint a token with `actions/create-github-app-token` and pass it to the launchset action as `token`.
- Every git push and `ls-remote` authenticates with that token, even when the checkout persisted another one (the `build` job checks out with the read-only `GITHUB_TOKEN`). It goes in as `http.<server>/<owner>/.extraheader` through `GIT_CONFIG_*` env, never into `.git/config`: an empty value resets the list, then the App header follows. The owner-scoped key is more specific than the checkout's `http.<server>/.extraheader`. (git-lfs ignores the reset and uses only the most specific key, should it ever run with this env.)
- launchset runs every git command with `core.hooksPath` pointed at nothing (`/dev/null`, `NUL` on Windows), through the same env. It runs git in the team's checkout, where an earlier install step may have installed hooks (husky on `prepare`, simple-git-hooks, lefthook, git-lfs). None of them has work to do for launchset's commits, branches and tags, which never add LFS objects, and a failing one would break `mark` after the upload (git-lfs's lock check with the read-only checkout token did, in the first release of an LFS repo). Tag pushes also set `GIT_LFS_SKIP_PUSH=1`.
- The PR check may use the default `GITHUB_TOKEN` (it only reads and comments).

### 9.2 PR check (`launchset-check.yml`)

Trigger: `pull_request` (opened, synchronize, reopened, edited, labeled, unlabeled) targeting the base branch, a maintenance branch or a prerelease branch (9.9).

The check passes when:
- the PR adds or changes at least one valid changeset, **or**
- the PR author is in `check.bots`, **or**
- the PR is a launchset release PR (head branch `launchset/release/*`).

It also fails on: invalid changesets anywhere in `.launchset/`, `minor`/`major` changesets on a maintenance branch, and version mismatches (section 6.7).

It maintains **one sticky comment** per PR (found by a hidden HTML marker, updated in place), like changeset-bot:
- With changesets: the bump and the version this would produce, and the list of changeset summaries.
- Without: how to add one (`npx @demonsters/launchset add`, or write the file by hand with an example), and a link to the docs.

### 9.3 Release workflow (`launchset-release.yml`)

Trigger: `push` to the base branch and maintenance branches, plus `workflow_dispatch` (for retrying a publish, or with the inputs `target` and `version` for shipping a manual target, 9.8). Concurrency: `group: launchset-release-${{ github.ref }}`, `cancel-in-progress: false`.

**Job `launchset`** runs the action with `command: release`, which decides the mode:

1. **`publish`**: HEAD is the release commit for the current version (the version changed in this push), and `v{version}` doesn't exist yet. Also when started by `workflow_dispatch` with an unfinished release of the current version.
   - Output: `matrix` (JSON list of **auto** targets that have **no marker** yet; manual targets are never in it), `version`, `build-number`, `channel=release`, `release-sha`.
   - `release-sha`: on a push, the pushed commit (`github.sha`). On a `workflow_dispatch` retry: the commit of an existing marker tag for this version if there is one (markers sit on the release commit); otherwise the first commit on the branch's first-parent history whose root version differs from its first parent's. Never a commit reached through the second parent of a merge, so a retry always finds the same commit as the original run, even after a local merge or a release PR merged while it was behind the base branch.
   - Build jobs check out `release-sha`, never a later commit.
2. **`release-pr`**: pending changesets exist (including generated bot changesets, 9.4), and it's not a publish. Create or update the release PR:
   - Branch `launchset/release/<base-branch>`, **rebuilt from the base branch on every run and force-pushed**, so it never has conflicts.
   - The commit: deletes consumed changesets, bumps the root version, stamps every target's marketing version (manual targets included), prepends the changelog section.
   - Title `Release v1.5.0`; body is the changelog section that will be added, plus a short "merging this releases all targets" note.
   - If the release PR is open and nothing is pending anymore, close it.
3. **`ship`**: started by `workflow_dispatch` with a `target` input (9.8). Output: `matrix` with just that target, the `version` to ship (input, default the latest release on this branch), a fresh `build-number`, `channel=release`, and `release-sha` = the commit of `v{version}`. The `build` job runs as usual; `finalize` only updates the GitHub Release (9.8).
4. **`none`**: nothing to do. If there are commits since the last release tag but **no** changeset is pending at all, the job summary shows a warning listing those commits ("N commits since v1.4.0 and no pending changeset: they won't be released"). There's no per-commit check: several commits often share one changeset.

Normally a push is never both: a publish push is the release PR merge, which used up all changesets. If changesets do exist at a publish commit (for example someone pushed one straight to main together with a version change), publish wins and release-pr runs on the next push.

Pushes after the release commit **do not** auto-retry an unfinished release. If a target failed, the team re-runs the failed job, or starts `workflow_dispatch`, or ships a new version (which supersedes, 9.6).

**Job `build`** (matrix, only when mode is `publish` or `ship`): the team's own steps. A generated template looks like:

```yaml
build:
  needs: launchset
  if: contains(fromJSON('["publish","ship"]'), needs.launchset.outputs.mode)
  strategy:
    fail-fast: false
    matrix:
      target: ${{ fromJSON(needs.launchset.outputs.matrix) }}
  steps:
    - uses: actions/checkout@v7
      with: { ref: "${{ needs.launchset.outputs.release-sha }}" }
    - id: stamp
      uses: demonsters/launchset-action@v1
      with: { command: stamp, target: "${{ matrix.target }}", plan: "${{ needs.launchset.outputs.plan }}" }
    - id: verify
      uses: demonsters/launchset-action@v1
      with: { command: verify, target: "${{ matrix.target }}", plan: "${{ needs.launchset.outputs.plan }}" }
    # --- your build + upload steps, e.g. per target with if: matrix.target == 'android' ---
    - uses: demonsters/launchset-action@v1
      with: { command: mark, target: "${{ matrix.target }}", plan: "...", token: "${{ steps.app-token.outputs.token }}" }
```

(Exact shape is up to the implementation. `plan` is a JSON output carrying version, build number, channel, release sha and per-target data, so later steps don't recompute anything.)

**Job `finalize`** (`needs: build`, `if: always()` and mode is `publish` or `ship`): runs `command: finalize`:
- If every **auto** target has a marker: create `v{version}` at `release-sha` and a GitHub Release with that version's changelog section. If this is the base branch, mark it "latest"; maintenance releases are not marked latest. The Release body ends with a "Manual targets" list showing each manual target as "not shipped yet" (9.8).
- Otherwise: fail with a summary of which auto targets are missing (job summary + log).
- In `ship` mode: update the "Manual targets" list of `v{version}`'s GitHub Release (shipped, with build number and date). Never creates tags.
- Also handles superseding (9.6) and the changelog backport (9.5).

### 9.4 Bot PRs

- The PR check passes for authors in `check.bots`. **launchset never pushes to bot branches**: Dependabot and Renovate stop rebasing PRs that others have pushed to.
- When building the release PR, launchset lists PRs merged into the branch since the last release tag (commits between the last release tag and HEAD → associated PRs via the GitHub API), and for each one authored by a bot that **didn't** add a changeset, it writes a generated changeset: `bump: patch`, `source: bot`, `pr: <n>`, body = the PR title (e.g. "Bump react-native from 0.76.1 to 0.76.3"). These are generated fresh on every release-PR run (the branch is rebuilt), so they're never duplicated.
- Merged bot PRs alone are enough to open a release PR.
- In the changelog, bot entries go under a **Dependencies** heading.

### 9.5 Hotfixes / maintenance branches

- `launchset hotfix <major.minor>` (CLI, run locally): creates `release/<major>.<minor>.x` from the latest release tag in the `<major>.<minor>` line (e.g. `v1.4.2`) and pushes it. Errors if the branch already exists or no such tag exists.
- On that branch the whole flow is identical: PRs target it, the check runs, a release PR `launchset/release/release/1.4.x` is opened (branch naming must handle slashes), merging it publishes.
- Build numbers: `timestamp` keeps working because it increases over time regardless of branch. Hotfix Android builds always get a higher `versionCode` than earlier uploads.
- Docker tags on maintenance releases: see 6.1 (never `latest`).
- **Changelog backport**: after `finalize` creates a maintenance release tag, launchset opens a PR to the base branch titled `Changelog: v1.4.1` that only inserts the `1.4.1` section into the base branch's `CHANGELOG.md` at the right place (sorted by version). It doesn't touch version files or changesets.
- The fix itself still has to land on main through a normal PR with its own changeset. The docs explain this. Version calculation on main skips taken versions (8.1).

### 9.6 Partial (unfinished) releases

- Only the newest version is ever published. When a newer version reaches `finalize` and an older version has marker tags but no release tag, that older version is **superseded**:
  - Create the partial tag (`tags.partial`, default `launchset/partial/{version}`) at the old release commit. Also create a GitHub Release for it, marked **pre-release** and titled `v1.4.0 (partial, superseded by v1.4.1)`, listing which targets shipped and which didn't, plus the changelog section.
  - The partial tag deliberately sits outside the `v*` namespace, so existing `on: push: tags: ["v*"]` workflows don't fire on it. (A `v{old}-partial` tag would match `v*` and `v*.*.*` filters, and would also parse as a semver prerelease.)
  - It never gets a release tag.
- Only auto targets count. An older version that has all its auto markers is a normal release, whether or not its manual targets were ever shipped.
- `plan` only ever considers the current version (for `publish`; `ship` may target any released version, 9.8).

### 9.7 Previews (`launchset-preview.yml`)

Triggers:
- `pull_request` (labeled, synchronize, reopened): only when the PR has `preview.label`. With `rebuildOnPush: false`, only on the `labeled` event.
- `workflow_dispatch` on any branch (optional input: targets).
- `push` to branches matching `preview.branches` (globs; entries may be objects `{ branch, targets? }`, where `targets` overrides `preview.targets` for that branch). Entries with `prerelease` are prerelease branches (9.9).
- Concurrency per PR/branch with `cancel-in-progress: true` (a newer push replaces the older preview; build numbers stay unique).
- PRs from forks: secrets aren't available; skip with a clear notice in the job summary.

Behavior:
- `command: preview-plan` outputs the same shape as `plan` with `channel=preview`, the preview version (8.3), a build number, and the preview targets (`preview.targets`).
- **No side effects**: no changesets consumed, nothing committed, no marker or release tags, no GitHub Releases. (Prerelease branches add a tag and a GitHub pre-release, 9.9.)
- `command: preview-comment` (final job, `if: always()`): one sticky PR comment with version, build number per platform, Docker image tags, and per-target success/failure with links to the jobs. Updated on each preview run.
- Manual targets can be in `preview.targets` like any other target (for example TestFlight previews by label).

### 9.8 Manual targets

A target with `release: "manual"` is kept in version step with every release, but shipped on demand. Typical cases: a store app that isn't automated yet, or a platform that shouldn't get a store build for every web release (macOS minutes, upload limits, review cadence).

| Step | Auto target | Manual target |
|---|---|---|
| Release PR | marketing version stamped | **same** (committed every release, so the native files never drift) |
| PR check consistency (6.7) | checked | **same** |
| Publish matrix | included | not included |
| Release tag `v{version}` | needs this target's marker | doesn't wait for it |
| Superseding (9.6) | counts | ignored |
| Preview | per `preview.targets` | **same** |

**Shipping** a manual target always ships an **already released** version (it has a `v{version}` tag). Unreleased commits are what previews are for.

- **From CI**: `workflow_dispatch` on `launchset-release.yml` with `target` and optional `version` (default: the latest release on the branch it's started from). Mode `ship` (9.3): checks out the commit of `v{version}`, computes a fresh build number, and runs the normal `build` job (stamp → verify → the team's build steps → mark `launchset/<target>@<version>`).
- **By hand** (for example an Xcode archive on a Mac): `launchset ship --target ios [--version 1.4.0]` checks that HEAD is at `v{version}` (error otherwise, with the `git checkout` command to run), computes a build number, and stamps the target's files. `--json` prints the version and build number. After the upload, `launchset mark --target ios --version 1.4.0` creates the marker and updates the GitHub Release. Both commands need a token for pushing and the Release update (`GITHUB_TOKEN` / `--token`).

**Rules:**
- **Never backwards**: shipping a version lower than the target's highest existing marker is an error (stores reject lower versions), unless `--force`.
- **Idempotent**: if a marker for that target and version already exists, `ship` says so and stops.
- **Build numbers**: computed at ship time with the target's strategy, so `timestamp` stays increasing. `semver` is fine as well; `run-number` only from CI. A `semver` target's attempt can be set per ship (`ship --attempt <n>`, the release workflow's `attempt` input, GitLab `LAUNCHSET_ATTEMPT`), 1 to 99, so a second upload of the same version gets a new number; it is an error for other strategies and without a target.
- **Store verification** (7.3) works the same as for auto targets.

**Visibility:**
- `launchset status` lists each manual target with its last shipped version and how many releases it is behind, e.g. `ios: 1.3.0 (9 releases behind)`.
- The release PR body shows the same list, so the team sees the gap at every release.
- (Later, issue #2) store release notes for a manual target can be built from every changelog section between its previous marker and the version being shipped.

**Switching** a target between `manual` and `auto` is a one-line config change. It takes effect from the next release; existing markers stay valid.

### 9.9 Prerelease branches (tagged previews)

For long-lived lines that ship real, installable prereleases (public npm alphas, alpha images deployed to staging, betas that other repos pin). Configured as a `preview.branches` entry with `prerelease`:

```ts
preview: { branches: [{ branch: "next/*", prerelease: "alpha", targets: "all" }] }
```

A push to a matching branch runs the preview workflow (9.7), with these differences:

- **Version**: `{next}-{preid}.{n}` (8.3). `{next}` comes from the changesets on the branch compared with the base branch. `n` is the next free number: one higher than the highest existing `{next}-{preid}.*` prerelease tag, starting at 0.
- **Tag as reservation**: `preview-plan` creates and pushes the tag (release template, e.g. `v1.5.0-alpha.3`) at the built commit **before** the builds start, using the App token. If the push fails because the tag exists (a concurrent run), it retries with `n+1`. Re-running failed jobs reuses the plan, so the version stays the same. Numbers reserved by cancelled or failed runs are skipped; gaps are fine.
- **Channel** `prerelease`. Docker tags from the `prerelease` list (6.1, default `{version}` and `{branchSlug}`), never `latest`. The `dist-tag` output is `{preid}`, for npm. Android `versionName` is the full prerelease version; iOS uses the plain `{next}` (6.4), and the build number tells builds apart.
- **GitHub pre-release**: the final job (`preview-comment`) creates or updates a GitHub Release for the tag, marked **pre-release**, never "latest". The body lists the changesets pending on the branch (the ones the base branch doesn't have) and the per-target result.
- **Nothing is committed, no changesets are consumed, no markers.** When the branch merges into the base branch, its changesets produce a normal release PR with the full changelog. So there's no pre-mode state file, no "exit pre mode", and no prerelease version committed on main.
- **Never release tags**: prerelease tags don't count for "last release", next-free-version (8.1), the hotfix base or the bot-PR range (glossary).
- Concurrency per branch with `cancel-in-progress: false`, so every push gets its prerelease.
- The PR check (9.2) also runs for PRs that target a prerelease branch.
- Migrating from Changesets pre mode: `init` converts the changesets on the default branch (4.2). Changesets on a pre-mode branch are converted on that branch with `launchset init --convert-only`; `pre.json` is ignored, with a warning.

---

## 10. The GitHub Action

- **Source** lives at `action/` in the launchset repo (`action/action.yml`, `action/src/index.ts`). The build produces `action/dist/index.js`: a **single bundled file** that includes the CLI core and all dependencies. It is a build output in the launchset repo (not committed there).
- **Published** to the separate public repo `demonsters/launchset-action` by launchset's own release (section 15): a commit with `action.yml` at the repo root, `dist/index.js`, a README and a LICENSE, tagged `v1.2.3`, with the moving major tag `v1` updated. Consumer repos never install anything from npm.
- Used as `demonsters/launchset-action@v1`. launchset's own workflows use the freshly built local action (`uses: ./action`), so they never depend on the public repo.
- Inputs: `command` (`check` | `release` | `stamp` | `verify` | `mark` | `finalize` | `preview-plan` | `preview-comment` | `add`), `token`, `target`, `bump` and `message` (for `add`: write a changeset in a workflow, e.g. from a bot's workflow, without npm access), `version` (with `release` + `target`: ship a manual target, 9.8), `plan`, `working-directory`.
- Outputs (depending on command): `mode` (`publish` | `ship` | `release-pr` | `none`), `matrix`, `plan`, `version`, `build-number`, `channel` (`release` | `prerelease` | `preview`), `release-sha`, `already-published`, `docker-tags`, `docker-labels`, `dist-tag` (npm dist-tag suggestion: `latest` for base-branch releases, `release-<major>.<minor>` on maintenance branches, `<preid>` for prereleases, `pr-<n>` / `<branchSlug>` for previews), `pr-number`.
- Writes a readable job summary (`$GITHUB_STEP_SUMMARY`) for every command.
- Versioning: the action repo's tags follow launchset's version (`v1.2.3`) plus a moving major tag `v1`.

---

## 11. CLI

Binary: `launchset`. Package `@demonsters/launchset` (private on npm, demonsters org). Node ≥ 24 (Maintenance LTS until April 2028; also the GitHub Actions runtime of the action).

Rules for every command: no interactive prompt when stdin isn't a TTY or `--yes`/flags are given; `--json` where output is data; non-zero exit on failure; no color when not a TTY or `NO_COLOR` is set; `--cwd <dir>`.

| Command | What it does |
|---|---|
| `launchset init` | Set up a repo (11.1). |
| `launchset add` | Create a changeset. Interactive (bump + summary), or `--bump <type> --message <text>`. `--empty` = `bump: none`. Prints the created path. |
| `launchset status` | Pending changesets, bump, next version, consistency check, last release, unfinished releases, last shipped version per manual target (9.8), and the "commits since the last release but no changeset" warning (9.3). `--json`. Exit code 1 with `--require-changeset` if none pending vs a base ref (`--since <ref>`). |
| `launchset version` | Apply pending changesets locally (what the release PR commit does). For debugging and manual use. `--dry-run` prints the diff. |
| `launchset plan` | Print the release plan (mode, matrix, version, build number) as JSON. `--preview` for preview mode. |
| `launchset stamp --target <name>` | Write version + build number into the target's files. Accepts `--plan <json>` or `--version`/`--build-number`/`--channel`. |
| `launchset verify --target <name>` | Store/registry verification (7.3, 7.4). |
| `launchset mark --target <name>` | Create and push the marker tag. `--version <v>` for a manual target shipped by hand (9.8). |
| `launchset ship --target <name>` | Prepare a manual target for a hand-made build of a released version: check HEAD is at `v{version}`, compute a build number, stamp (9.8). `--version` (default: latest release), `--force`, `--json`. |
| `launchset finalize` | Create the release tag + GitHub Release when complete; handle supersede and backport. |
| `launchset hotfix <major.minor>` | Create a maintenance branch (9.5). |
| `launchset check` | Run the PR check logic (used by the action; also usable locally against a base ref). `--push`: for a pre-push hook on the base branch. It warns (exit 0) when commits since the last release exist and no changeset is pending at all, and never blocks. |

The GitHub-facing commands work from the CLI too when given `GITHUB_TOKEN`/`--token` and repo info, but they're mainly called by the action.

### 11.1 `launchset init`

1. **Detect**:
   - **Versions**: root `package.json`; `package.json` files next to each detected Dockerfile; existing tags (`v1.2.3`, `1.2.3`, `name@1.2.3`, with or without prerelease).
   - **Android**: `android/app/build.gradle(.kts)`, `gradle.properties` version keys.
   - **iOS**: `*.xcodeproj`, `Info.plist`, `.xcconfig` (only if it contains `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION`). Choose `xcodeproj` when plists use `$(MARKETING_VERSION)`.
   - **Capacitor**: `capacitor.config.*`; prefer the `capacitor` alias.
   - **Expo**: `app.json` with an `expo` key. For `app.config.*`, print the advice from 6.5.
   - **Search scope**: the repo root, workspace packages (`workspaces`, `pnpm-workspace.yaml`) and `**/Dockerfile*`, excluding `node_modules` and anything git ignores (a gitignored `out/` copy of the apps is not a target).
   - **Dockerfiles**: suggest docker targets. Read the image name, `file`/`context` and the current tag pattern (e.g. a `v` prefix) from existing `docker/build-push-action` / `docker/metadata-action` steps or `docker build` / `docker push` lines, and only ask when nothing is found. Docker targets get `verify: ["registry"]` by default (the generated workflow logs in before `verify`, 7.4).
   - **Existing release machinery** that would conflict with launchset (step 4):
     - workflows (`.github/workflows/*`, `.gitlab-ci.yml`) triggered by `push.tags` patterns that match the release tag (`v*`, `v*.*.*`, `*.*.*`, …);
     - `changesets/action`, and `changeset version|status|publish|tag` in workflows or `package.json` scripts;
     - steps or scripts that create tags or GitHub Releases (`git tag`, `gh release create`, `createRelease`);
     - Docker pushes of `latest` on branch pushes;
     - scripts that write `MARKETING_VERSION`, `CURRENT_PROJECT_VERSION`, `versionCode` or `versionName` (they would overwrite stamped build numbers in CI);
     - `@changesets/write` in scripts;
     - release instructions in `CLAUDE.md`, `AGENTS.md` and `README` (`npm version`, `git tag`, `changeset`).
2. **Canonical version**: show every version found, per file and per tag.
   - **Default to the highest** of: the root version, the `package.json` next to each Dockerfile target, native marketing versions, and the highest existing release-like tag. Explain the choice.
   - **Never lower** a version without explicit confirmation (`--decide version=<v>` or an interactive answer). Stores reject lower marketing versions, and image tags or runtime versions would go backwards.
   - Then align the target files to the canonical version. Image-pin files (k8s/kustomize/Helm) are never aligned automatically; they are only offered as `kind: "image"` `files` entries (6.6), as a decision per file.
   - **Target kind**: for every detected platform, ask whether it is shipped by CI with every release (`auto`), shipped on demand (`manual`, 9.8), or not a target. Default: `auto` when an existing workflow already builds it, `manual` for native projects that no workflow builds.
3. **Build numbers**: read the current highest `versionCode` / `CFBundleVersion` from the files (and, if credentials are present, from the stores). If any is higher than what the chosen strategy produces now, set `buildNumber.offset` so new numbers stay higher, and explain.
4. **Write**: `launchset.config.ts`, `.launchset/README.md`, the three workflow files (with commented placeholders for the team's build steps, and example steps for docker/build-push-action and fastlane), `CHANGELOG.md` if missing.
   - **Retire conflicting machinery**: list everything found in step 1 with the reason it conflicts. Examples: "fires again on launchset's `v{version}` tag and pushes the image twice"; "creates `v{version}` before `finalize`"; "overwrites the stamped build number".
   - Per item, offer **remove** (delete the workflow or script), **disable** (remove only the conflicting trigger or step), or **keep**.
   - Default with `--yes`: disable the conflicting trigger or step, and print a list of the changes. Never leave a conflict in place silently.
5. **Baseline**: offer to create the release tag for the canonical version on HEAD, so it counts as released (skip if it exists).
   - Default **yes** only when an existing tag in another format (`0.9.4`, `name@0.9.4`) already marks that version as released.
   - Otherwise default **no**, with a warning that the version may never have been built. A baseline tag on an unreleased version means launchset never builds it, and pinned images might not exist.
   - `--baseline` forces it.
6. **Convert** existing `.changeset/*.md` (4.2). `launchset init --convert-only` runs only this step, e.g. on a Changesets pre-mode branch (9.9).
7. **Agent skill**: offer to install `.claude/skills/launchset/SKILL.md` and add a short launchset section to `AGENTS.md` (create it if missing) for non-Claude agents.
8. Print the manual steps that remain: GitHub App + secrets, store credential secrets. Offer to add `launchset check --push` to an existing pre-push hook setup (simple-git-hooks, husky, lefthook) for repos that push straight to the base branch. husky counts when it's a dependency or `.husky/` has hooks (not just husky's generated `_` folder). Never offer a hook file that git ignores: it could never be committed.

`--yes` accepts all defaults; every question has a flag.

**Agent-assisted adoption.** Repos will move to launchset one at a time, mostly done by an agent, so init has a detection-only mode for that:

- `launchset init --detect --json` writes nothing. It prints everything from steps 1–3 (files, versions, build numbers, Dockerfiles, native projects, existing workflows) plus a list of **decisions**. Each decision has an `id`, the question, the options, the proposed default, and the evidence (`path:line`) behind the default.
- Example decisions: the canonical version; which detected platforms become targets, and `auto` or `manual`; Docker image names and tag templates; what to do with each piece of conflicting release machinery; whether to create the baseline tag.
- Every decision can be answered with `--decide <id>=<value>` (repeatable), besides the named flags.
- The intended loop: the agent runs `--detect --json`, asks the human only the decisions where the default isn't obviously right, then runs `launchset init --yes --decide …`. The adoption skill (16.3) describes this loop.

---

## 12. Changelog

Format, newest first, with a title line kept at the top:

```md
# Changelog

## 1.5.0 (2026-11-18)

### Major changes
- ...

### Minor changes
- Add offline mode to the mobile app. ([#123](https://github.com/org/repo/pull/123), @someone)

### Patch changes
- Fix crash on the login screen. ([#130](...))

### Dependencies
- Bump react-native from 0.76.1 to 0.76.3 ([#131](...))
```

- Empty headings are left out.
- With `changelog.github: true`, find the PR and author for each changeset (the commit that added the file → associated PR via the API), like `@changesets/changelog-github`. Without a token, or if not found, leave the links out (no failure).
- Multi-line summaries: first line as the bullet, the rest indented under it.

**Existing changelogs.** Repos that adopt launchset often already have a `CHANGELOG.md` in another format, for example Changesets (`## 0.18.0` without a date, `### Minor Changes`) or auto-changelog (`### Changelog`, a preamble, `#### [v3.5.6](url)`).
- A **version heading** is any heading (any level) whose text starts with a semver version, optionally prefixed with `v`, optionally a markdown link, and optionally followed by a date. Examples: `## 1.5.0 (2026-11-18)`, `## 0.18.0`, `#### [v3.5.6](https://…) - 2023-01-02`.
- New sections are inserted **directly before the first version heading**. Everything above it (title, badges, preamble) stays at the top unchanged. If there is no version heading, the new section goes after the first heading (the title), or at the very top if the file has no heading.
- Old sections are never rewritten. A file with mixed styles (old Changesets sections below new launchset sections) is accepted.
- The changelog backport (9.5) places a section by comparing versions with the parsed version headings; headings it can't parse are skipped when sorting. Prerelease headings sort before their release (`1.5.0-alpha.2` < `1.5.0`).
- `init` doesn't convert or move an existing changelog. It only creates one if it's missing.

---

## 13. Tech stack and repo layout (launchset repo)

- TypeScript (strict), ESM. The CLI requires Node ≥ 24 (Node 22 leaves support in April 2027). The action runs on `node24`, the newest runtime GitHub Actions offers; the action bundle targets Node 24, so the core must not use APIs newer than Node 24. Move the action to a newer runtime once GitHub supports one.
- Package manager: pnpm. Tests: vitest. Lint/format: Biome.
- Libraries (use current maintained versions): `zod` (config schema; also generates the JSON Schema for `launchset.config.json` and the docs' config reference), `jiti` (loading `launchset.config.ts`; the same loader ESLint uses for `eslint.config.ts`), `semver`, `jsonc-parser` (JSON offsets for text-preserving edits), `yaml` (YAML node ranges), `@clack/prompts` (interactive CLI), `@octokit/rest` (+ `@actions/core` for the action), `jose` (signs the store JWTs: RS256 for the Google service account token exchange, ES256 for App Store Connect; plain `fetch` for the HTTP calls, no `google-auth-library`), `msw` (HTTP mocking in tests).
- Bundling: a current bundler (e.g. tsdown or esbuild) for the npm package and a single-file bundle for the action.
- Git: shell out to `git` (always available in CI) through one small wrapper module.

```
src/
  core/        # pure logic, no I/O: changesets, config schema, versions, plan, changelog, build numbers
  platforms/   # file stampers: gradle, gradle-properties, xcodeproj, plist, xcconfig, expo, json, yaml, regex
  git/         # git wrapper (tags, log, commit, push)
  github/      # Octokit: PRs, comments, tags, releases, bot-PR detection
  verify/      # Play, App Store Connect, OCI registry clients
  cli/         # commands
  index.ts     # public API: defineConfig, types
action/
  action.yml
  src/index.ts
  dist/index.js  (build output, published to demonsters/launchset-action, not committed)
templates/
  workflows/     # used by init
skills/
  launchset/SKILL.md          # for repos that use launchset (16.2)
  launchset-adopt/SKILL.md    # for migrating a repo onto launchset (16.3)
docs/            # Astro Starlight site (own package.json)
test/
  fixtures/      # real-world sample files per platform
design/
  SPEC.md
```

Keep `core/` free of I/O so it can be tested with plain inputs.

---

## 14. Testing

- **Changelog**: inserting into existing Changesets-style and auto-changelog files (preamble kept, mixed styles), backport sorting with unparsable and prerelease headings.
- **Stampers**: fixtures for Groovy and KTS Gradle files (incl. flavors → error), `gradle.properties`, a pbxproj with several targets and configurations including an app extension, Info.plist with literal values and with `$(MARKETING_VERSION)`, `.xcconfig`, Capacitor layout, Expo `app.json`, bare RN layout, JSON/YAML/regex, `package-lock.json` and `npm-shrinkwrap.json` root versions (incl. a lockfile without `packages[""]`). Assert exact output text (only the values changed).
- **Core**: bump calculation, next-free version, maintenance restrictions, preview and prerelease versions (counter, gaps, prerelease tags never counted as releases), Docker tag template rendering (placeholders, skipped templates, maintenance filtering, 0.x major, validation errors), build-number strategies incl. limits and the semver+preview rejection, changelog rendering, config validation messages.
- **Plan/state**: every mode (`publish`, `ship`, `release-pr`, `none`), markers present/missing, release-sha detection (merge commit, squash, rebase, a release PR merged while behind the base branch, a local merge; retry via marker and via first-parent search), superseding, `workflow_dispatch` retry. Manual targets: left out of the publish matrix, not needed for `v{version}`, ignored by superseding; `ship` of the latest and an older version, refusal to go backwards, already-marked version.
- **GitHub**: mocked HTTP (msw): release PR create/update/close, sticky comments, tags, releases, bot-PR detection, changelog backport PR.
- **Verify**: mocked Play, App Store Connect, OCI registry and npm registry responses incl. "already published", "store is ahead", npm 404 and npm auth errors; registry verify uses the rendered verify tag (`v{version}` templates).
- **Git auth and hooks**: a push from a checkout with a persisted read-only header sends only the App header; in an LFS repo it makes no LFS requests. An e2e release (release PR, `mark`, `finalize`, a hotfix line and its backport PR) from checkouts with failing hooks of every kind installed runs none of them.
- **init detection**: fixture repos with tag-triggered workflows, a Changesets pipeline, a version-sync script, a `v`-prefixed `docker/build-push-action`, mismatched versions where the root is lower (no lowering by default), and an unreleased root version (no baseline by default); `docker build` run steps with `${{ secrets.X }}` build args after the context and image tags from the git ref through `$GITHUB_ENV` (context `.`, `v{version}` tags, registry verify), with gitignored leftovers (husky's generated `.husky/_`, an `out/` copy of the apps) that must not become a hook setup or targets.
- **End to end**: real temporary git repos with a local bare remote, running the CLI through a full lifecycle: init → add → version → plan → stamp → mark → finalize; a hotfix line; a superseded partial release; a preview; a manual target shipped by hand two releases later (`ship` → `mark --version`); a prerelease branch with two concurrent pushes (tag reservation retry) and its merge into main; `init --detect --json` followed by `init --yes --decide …` on fixture repos.
- **launchset's own CI**: lint, typecheck, tests, action bundle builds and a smoke test that runs the local action (`uses: ./action`), docs build.

---

## 15. launchset releases itself

launchset uses launchset (dogfooding):
- Targets: `npm` (custom, no files, `verify: ["npm"]`; the workflow runs `npm publish` to the private `@demonsters` scope unless `already-published`) and `action` (custom; the workflow builds the bundle and publishes it to `demonsters/launchset-action`: commit, tag `v{version}`, move `v1`. It needs a token with write access to that repo, from the launchset App installed there).
- npm auth for publishing: prefer npm trusted publishing (OIDC from GitHub Actions) if it works for a private package from a private repo; otherwise an `NPM_TOKEN` secret. Document which one was chosen.

---

## 16. Documentation and agent skill

### 16.1 Docs site (Astro Starlight, in `docs/`)

For humans. Every command, flag, config option and output shown must match the code. Pages:

- Getting started (install, `init`, first release)
- Concepts (one version, targets, changesets, release PR, markers, channels)
- Writing changesets
- Configuration reference (every option, with defaults; generate from the zod schema if practical)
- Targets: Docker, Web, Android, iOS, React Native, Capacitor, Expo, Custom
- Build numbers (strategies, offset, store verification, migrating existing apps)
- Release flow (workflows explained step by step)
- Preview builds and prerelease branches
- Hotfixes and maintenance branches
- Partial releases
- Manual targets (shipping a store app on demand, `launchset ship`)
- GitHub App setup (step by step, permissions, secrets; also for orgs other than demonsters)
- Repos that push straight to the base branch (one changeset per change, not per commit; the release PR as the review point; the pre-push hook)
- Bot PRs from your own workflows: write a changeset in the bot's workflow (the action's `add` command, or a hand-written `.launchset/*.md` file, with `bump: patch` or `bump: none`), and open the PR with an App token instead of `GITHUB_TOKEN`, so CI and `launchset-check` run on it
- Workflow recipes (docker/build-push-action, fastlane for Play and TestFlight, Gradle, xcodebuild)
- Setting up native store pipelines step by step: Apple certificates, provisioning profiles and the App Store Connect API key; the Play upload key and service account; which GitHub secrets to create and how to test them with a preview build. Written so a human can follow it with an agent guiding them (16.3)
- Migrating from Changesets / moving an existing repo (`init`, `init --detect --json`, agent-assisted adoption with the adoption skill; retiring tag-triggered workflows and Changesets pipelines; Changesets pre mode → prerelease branches)
- CLI reference
- Troubleshooting / FAQ (e.g. "release PR has no CI runs" → App token missing)

Hosting isn't decided yet: the site must build (`pnpm --filter docs build`), but don't deploy it.

### 16.2 Agent skill (`skills/launchset/SKILL.md`)

For AI agents working **in repos that use launchset** (not in the launchset repo itself). Claude Code skill format: frontmatter with `name: launchset` and a `description` that makes agents load it whenever they change code in a repo containing `launchset.config.*` or `.launchset/`, or when they're about to open a PR there. Content:

- Every PR needs a changeset. Create it with `npx @demonsters/launchset add --bump <type> --message "<summary>"`, or write the file by hand (show the exact format) if the CLI isn't available (the package is private, so npm auth may be missing).
- How to pick the bump: major (breaking for users or API clients), minor (new features), patch (fixes), none (no release needed: docs, CI, tests only).
- How to write a good summary: user-facing, one line about one change, past or present tense consistently, no PR number (launchset adds it).
- One changeset per change, not per commit and not per PR: a PR with several changes (a feature and two fixes) adds a changeset for each, with its own bump. Related changes with one bump may share a changeset as a lead line plus sub-bullets. Never several changes in one sentence or bullet. Show a bad and a good example.
- When pushing straight to the base branch (no PR): make sure a changeset covers the work before pushing. One changeset per change, not per commit; edit an existing pending changeset if the work extends it.
- Never edit version numbers, build numbers or `CHANGELOG.md` by hand; never create `v*` or `launchset/*` tags; never edit the release PR.
- On a `release/X.Y.x` branch only patch or none.
- Preview builds: add the `launchset:preview` label.
- `npx @demonsters/launchset status` to check pending changes and the next version.
- Manual targets (9.8): never ship one unasked. When `status` shows one is behind, mention it to the human, and point to the `workflow_dispatch` ship run or `launchset ship`.
- Repos that also use Changesets (1.2): a PR that changes an npm package needs a `.changeset/` file and a `.launchset/` changeset; the launchset bump is about the targets (`none` when no target uses the package). Never edit or merge the `Version Packages` PR unasked.

The skill ships inside the npm package and is installed into consumer repos by `launchset init` (11.1 step 7), together with an equivalent short section for `AGENTS.md`.

### 16.3 Adoption skill (`skills/launchset-adopt/SKILL.md`)

For AI agents moving an **existing repo** onto launchset. Repos will be migrated one at a time, mostly by agents. This skill must be available **before** the repo has launchset, so it's meant to be installed at user level (or as a Claude Code plugin from the launchset repo), not by `init`. Its `description` makes agents load it when asked to set up or migrate a repo to launchset. Content:

- Run `npx @demonsters/launchset init --detect --json` first; never write anything before the human has seen the decisions.
- Present the decisions, grouped. Ask only the ones whose default isn't clearly right, with the evidence. Always ask about:
  - lowering any version;
  - a baseline tag for a version that has no release tag;
  - native projects that no workflow builds. Suggest `release: "manual"` for those, and explain what it means (9.8).
- Find and explain the existing release machinery that will conflict: tag-triggered workflows, Changesets workflows and scripts, scripts that write version or build numbers, release instructions in `CLAUDE.md`/`AGENTS.md`/`README`. Propose removing or adapting each one, and do it only after the human agrees.
- Keep existing conventions unless the human decides otherwise: the git tag format (`tags.release`) and Docker image tags (e.g. `v{version}`) that deploy tooling pulls.
- Long-lived Changesets pre-mode branches (`.changeset/pre.json`): propose a prerelease branch entry (9.9) and run `init --convert-only` on that branch.
- Deploy manifests that pin the image tag: ask per file whether launchset should stamp them (`kind: "image"`, 6.6) or whether they're deploy state that stays manual.
- Native store pipelines (signing certificates, provisioning profiles, the Play upload key, App Store Connect API key, GitHub secrets) are set up by a human. Guide them step by step following the docs recipe (16.1), check each step (secret names present in the workflow, `verify` passing on a preview build), and never handle the secret values yourself.
- Move the team's existing build and upload steps into the generated workflows (`docker/build-push-action` tags and file, signing, fastlane, deploy steps), keeping secrets and environments as they are.
- Run `init --yes --decide …` with the answers, then open a single PR with everything. The PR body lists the decisions, what was removed or changed, and the manual steps that remain (GitHub App installation, secrets, store credentials).
- Repos that have a shared version **and** independently versioned npm packages get the hybrid setup (1.2): launchset for the shared version, Changesets kept for the packages, after the human confirms.
- Don't migrate repos that are out of scope (for example only independently versioned npm packages, 1.2). Say why instead.

---

## 17. Manual steps for the demonsters team (not for the building agent)

1. Create the GitHub App, install it on the repos using launchset, add the org variable `LAUNCHSET_APP_CLIENT_ID` and the org secret `LAUNCHSET_APP_PRIVATE_KEY`.
2. Create the public repo `demonsters/launchset-action` and install the App on it, so launchset's release can publish the action (sections 10, 15).
3. Add store credentials as secrets where `verify: ["store"]` is used.
4. Set up npm publishing auth for `@demonsters/launchset` (section 15).
5. Decide where the docs site is hosted.

---

## 18. Decisions taken while writing this spec

These weren't discussed explicitly; they follow from the agreed design. Change them here if they're wrong.

- Changeset folder `.launchset/`, config file `launchset.config.ts`, frontmatter key `bump`.
- Marker tags are namespaced `launchset/<target>@<version>` to avoid clashing with other tools.
- Partial releases get a tag outside the `v*` namespace (`launchset/partial/{version}`), because a GitHub Release needs a tag and existing `v*` tag workflows must not fire on it.
- Release builds always check out the release commit (`release-sha`); later pushes don't auto-retry an unfinished release.
- "Next free version" on main skips versions already taken by hotfixes.
- Maintenance releases never move Docker `latest`/`{major}` tags and aren't marked "latest" on GitHub.
- After a maintenance release, launchset opens a changelog-only backport PR to main.
- Store verification also detects "this build is already uploaded" so a re-run skips the upload instead of failing.
- A `custom` target type covers npm packages, Helm charts etc., and lets launchset release itself.
- The PR check also fails when version files don't match the root version.
- Manual targets (9.8) only ship already released versions, never lower than their last shipped version, and don't block the release tag. Added after validating the spec against existing projects.
- `init` has a detection-only JSON mode with explicit decisions, and a separate adoption skill exists, because most repos will be migrated one at a time by agents.
- Docker tags are templates (`v{version}` keeps today's `v`-prefixed images), and registry verify checks the rendered verify tag, not a fixed `image:{version}`.
- `init` retires conflicting release machinery (tag-triggered workflows, Changesets pipelines, tag scripts, version-sync scripts) instead of leaving it in place, because launchset's App-token tags would trigger it.
- `init` defaults to the highest version it finds and never lowers a version or baselines an unreleased version without confirmation.
- Prereleases are tagged previews (9.9): a stable `X.Y.Z-<preid>.N` version, a tag and a GitHub pre-release, but nothing committed and no changesets consumed. This replaces Changesets pre mode without its state file.
- Build services outside GitHub Actions (Xcode Cloud) are out of scope for v1.
- The action is published to a separate public repo (`demonsters/launchset-action`), so other orgs can use it with their own GitHub App and no org access settings are needed.
- `custom` targets may have no `files`; npm packages get `verify: ["npm"]` so re-runs never fail on an already published version; npm lockfiles get their root version updated with the version file; existing changelogs keep their preamble and old sections, and new sections go before the first version heading.
- The release commit is found along first-parent history (or from a marker), so merges, stale release branches and retries always resolve to the commit that was pushed to the base branch, like Changesets tagging main's HEAD after the merge.
- Direct pushes to the base branch are fine. There's no per-commit check; launchset only warns when commits exist since the last release and no changeset is pending at all.
