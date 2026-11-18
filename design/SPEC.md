# shiplog: specification (v1)

Status: agreed design, ready to build. Last updated 2026-11-18.

Package: `@demonsters/shiplog` (private npm package, demonsters org).
Repo: https://github.com/demonsters/shiplog (private). The CLI, the GitHub Action, the docs site and the agent skill all live in this one repo.

---

## 1. What shiplog is

shiplog is a Changesets-style release tool for repos where **one version** drives **many build targets**: Docker images, Android, iOS and web apps, all built from the same repo and released together.

Developers describe each change in a small changeset file in their PR. Commit messages don't matter. shiplog collects the changesets into a release PR. Merging that PR is the release: shiplog then tells CI which targets to build, what version and build number to use, and records which targets have shipped.

**shiplog does not build anything.** It decides *what* to release, writes version numbers into files, and records results. The team's own workflow steps (docker build/push, Gradle, fastlane, Xcode, etc.) do the building and uploading.

### 1.1 Principles

1. **One version per repo.** The root `package.json` `version` is the single source of truth.
2. **Lock step, no partial releases.** Every release builds every target. A changeset never targets a subset.
3. **No commit-message conventions.** Release intent lives in changeset files only.
4. **Build numbers are assigned in CI at build time and never committed.** That makes build numbers independent of branches.
5. **Idempotent.** Re-running any workflow never double-publishes. State lives in git tags, not in external systems.
6. **GitHub Actions only** (for v1).
7. **Agent-friendly.** Every CLI command works non-interactively with flags and can print JSON.

### 1.2 Out of scope for v1

- Per-package npm publishing in workspaces (that's what Changesets does).
- CI systems other than GitHub Actions.
- Expo OTA updates / `runtimeVersion` handling: issue [#1](https://github.com/demonsters/shiplog/issues/1).
- Store-ready release notes per platform: issue [#2](https://github.com/demonsters/shiplog/issues/2). Unknown changeset frontmatter keys must be kept (not rejected) so #2 can add a field later.
- Running the actual builds or store uploads.

---

## 2. Glossary

| Term | Meaning |
|---|---|
| **Changeset** | A markdown file in `.shiplog/` with a bump type and a summary. |
| **Target** | One thing that gets built and shipped per release, e.g. `docker-api`, `android`, `ios`, `web`. Each target becomes one job in the GitHub Actions matrix. |
| **Release** | Building and shipping every target for one version, from the release commit. |
| **Release commit** | The commit where the root `package.json` version first became the version being released (normally the merge of the release PR). All release builds check out this exact commit. |
| **Release PR** | The PR shiplog opens and keeps updated, titled `Release vX.Y.Z`, that applies pending changesets. |
| **Marker tag** | A git tag recording that one target shipped for one version: `shiplog/<target>@<version>`. |
| **Release tag** | `v<version>`, created only when **every** target has a marker. Means "this version is fully released". |
| **Maintenance branch** | `release/<major>.<minor>.x`, used for hotfixes on an older version line. |
| **Preview** | A test build from a PR or branch (TestFlight, Play internal track, preview Docker tags). Has no side effects. |
| **Channel** | `release` or `preview`, passed to each build job so the workflow chooses where to upload. |
| **Marketing version** | The user-visible version: `versionName` (Android), `CFBundleShortVersionString` / `MARKETING_VERSION` (iOS), `expo.version`. Committed by the release PR. |
| **Build number** | `versionCode` (Android), `CFBundleVersion` / `CURRENT_PROJECT_VERSION` (iOS), `expo.ios.buildNumber` / `expo.android.versionCode`. Assigned in CI only. |

---

## 3. Files in a repo that uses shiplog

```
shiplog.config.ts          # configuration (also .mjs, .js, .json)
.shiplog/
  README.md                # short explanation + link to docs (written by init)
  brave-lions-sing.md      # a changeset
CHANGELOG.md
.github/workflows/
  shiplog-check.yml
  shiplog-release.yml
  shiplog-preview.yml
.claude/skills/shiplog/SKILL.md   # optional, installed by init
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
- Filename: three random lowercase words joined by dashes plus `.md`, like Changesets does (`brave-lions-sing.md`). Any `.md` file in `.shiplog/` other than `README.md` is a changeset.
- Parse errors (missing or invalid frontmatter, invalid bump) are hard errors with file name and line.

### 4.2 Migration from Changesets

`shiplog init` can convert existing `.changeset/*.md` files: their frontmatter (`"pkg-name": minor` lines) becomes one `bump` with the highest bump found. Summaries are kept. `.changeset/config.json` and `README.md` are left alone; init tells the user they can delete the folder.

### 4.3 Computing the bump

The release bump is the highest bump among all pending changesets (`major` > `minor` > `patch` > `none`). If only `none` changesets are pending, there is no release.

---

## 5. Configuration

`shiplog.config.ts` (or `.mjs`, `.js`, `.json`). The TypeScript config is loaded with `jiti` (bundled), so it works on any supported Node version. The package exports `defineConfig` for types. The config is validated with `zod`; errors name the exact field and say what is expected.

```ts
import { defineConfig } from "@demonsters/shiplog";

export default defineConfig({
  version: { file: "package.json" },          // default
  changelog: { file: "CHANGELOG.md", github: true },  // github: add PR links + authors
  baseBranch: "main",                          // default
  maintenanceBranches: "release/*.x",          // default; release/<major>.<minor>.x

  tags: {
    release: "v{version}",                     // default
    marker: "shiplog/{target}@{version}",      // default
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
    label: "shiplog:preview",                  // default
    rebuildOnPush: true,                       // default
    branches: [],                              // e.g. ["develop"]: auto-preview on push
    targets: "all",                            // or ["android", "ios"]
  },

  targets: {
    "docker-api": {
      type: "docker",
      image: "ghcr.io/demonsters/api",
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
    },
    npm: {
      type: "custom",
      files: [{ path: "packages/sdk/package.json", kind: "json", key: "version" }],
    },
  },
});
```

Any target may override `buildNumber`. Any target may have extra `files` entries (section 6.6) to stamp the marketing version into more files.

**Validation rules** (config load fails with a clear message):
- At least one target. Target names: `[a-z0-9][a-z0-9-]*`.
- `buildNumber.strategy: "semver"` together with previews enabled is an error (section 7.2).
- Source files referenced by targets must exist.
- Unknown keys are errors (catches typos) except where noted.

---

## 6. Targets and file stamping

All file edits are **text-preserving**: only the version values change. Never re-serialize a whole file (no JSON re-formatting, no plist re-ordering, no pbxproj rewriting). Keep indentation, quotes, comments and line endings. Tests assert exact output.

Two kinds of stamping:
- **Marketing version**: written by the release PR (committed) and by previews in CI (not committed).
- **Build number**: written only in CI, by `shiplog stamp` (never committed). The build-number values in the repo are placeholders; shiplog doesn't care what they are, except `init` reading them for an offset (section 11).

### 6.1 `docker`

- Options: `image` (required, may be a list for several registries), `tags` (optional, override defaults), `verify: ["registry"]`.
- No files stamped by default.
- Default release tags: `{version}`, `{major}.{minor}`, `{major}`, `latest`.
  - On a maintenance branch: only `{version}` and `{major}.{minor}`. A hotfix must never move `latest` or `{major}` while a newer line exists.
- Preview tags: `pr-<number>` (or `<branch-slug>` for branch previews) and the full preview version, e.g. `1.5.0-pr.123.4`. Never `latest` or a plain version.
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

These are code and can't be safely rewritten. shiplog doesn't edit them. `init` and the docs tell users to read version and build numbers from `package.json` / environment variables in their config instead. shiplog sets `SHIPLOG_VERSION`, `SHIPLOG_BUILD_NUMBER` and `SHIPLOG_CHANNEL` as job outputs for that purpose.

### 6.6 `custom` and extra `files`

For anything else (an npm package, a Helm chart, a version file a web app reads):
- `{ path, kind: "json", key: "version" }`: dotted key path into a JSON file; text-preserving edit of that value only.
- `{ path, kind: "yaml", key: "appVersion" }`: same for YAML (e.g. `Chart.yaml`). Text-preserving.
- `{ path, kind: "regex", pattern: "...", replace: "...{version}..." }`: pattern must match exactly once, or error.
- Placeholders in `replace`: `{version}`, `{major}`, `{minor}`, `{patch}`, `{buildNumber}` (CI only).

### 6.7 Version consistency

`shiplog status` and the PR check verify that every target's committed marketing version equals the root version. A mismatch (someone edited a version file by hand) fails the PR check with a list of files and values.

---

## 7. Build numbers

### 7.1 When and how

- A build number is computed **once per workflow run**, in the `plan` step, and shared by all targets in that run. Re-running failed jobs reuses the plan output, so a re-run uses the same number.
- `shiplog stamp --target <name>` writes the version and build number into that target's files in the CI checkout.

### 7.2 Strategies

| Strategy | Value | Notes |
|---|---|---|
| `timestamp` (default) | `floor((now - epoch) / 1s) + offset` | Epoch default `2020-01-01T00:00:00Z`. About 217 million in November 2026; stays under the Android limit until about 2086. Always increases, across all branches, without credentials. |
| `run-number` | `github.run_number + offset` | Simple; resets if the workflow file is renamed. Documented as such. |
| `semver` | `major*10^7 + minor*10^5 + patch*10^2 + attempt` | `attempt` is the run attempt (max 99). **Not allowed when previews are enabled**: previews of `1.5.0` and the real `1.5.0` would compete for the same numbers. Config validation rejects the combination. |
| `eas` | none | For Expo projects building on EAS with `appVersionSource: "remote"` and `autoIncrement`. shiplog outputs no build number and doesn't stamp one. |

`offset` exists for migrating apps whose existing build numbers are higher than what the strategy would produce.

### 7.3 Verification against stores (`verify: ["store"]`)

The store is not a source of numbers, only a safety check. `shiplog verify --target <name>` (run in the build job, before uploading):
1. Fetch the highest build number already in the store.
   - **Google Play** (Android Publisher API v3): open an edit, list bundles and APKs, take the max `versionCode`, then delete the edit. Auth: service account JSON in `SHIPLOG_PLAY_SERVICE_ACCOUNT_JSON`.
   - **App Store Connect API**: list builds for `appId`, take the max build `version`. Auth: JWT (ES256) from `SHIPLOG_ASC_KEY_ID`, `SHIPLOG_ASC_ISSUER_ID`, `SHIPLOG_ASC_PRIVATE_KEY`.
2. If this exact build number already exists for this version: output `already-published=true`. The workflow skips the upload and goes straight to `mark`. (Covers "upload succeeded but the job failed before marking".)
3. If the store's highest number is **greater than or equal to** ours: fail, saying which number the store has and suggesting a `buildNumber.offset`.
4. Otherwise output `already-published=false`.

### 7.4 Registry verification (`verify: ["registry"]`)

For `docker` targets: check if `image:{version}` already exists via the registry HTTP API (OCI distribution spec, `HEAD /v2/<name>/manifests/<tag>` with token auth). Support at least ghcr.io and Docker Hub; generic registries with basic auth. Credentials from env (`SHIPLOG_REGISTRY_USERNAME` / `SHIPLOG_REGISTRY_PASSWORD`) or the standard Docker config file. If it exists: `already-published=true`. This replaces the team's old "ask the Docker API whether the image exists" workflow, but only as a safety net: the source of truth is the marker tags.

---

## 8. Versions

### 8.1 Next version

1. `current` = root `package.json` version.
2. `next` = `semver.inc(current, bump)`.
3. **Next free version**: if `v{next}` or any marker tag for `{next}` already exists (for example a hotfix released it from a maintenance branch), increase the patch until a free version is found. Example: main is at `1.4.0` with a pending patch, but `v1.4.1` was released from `release/1.4.x` → next is `1.4.2`.

### 8.2 Maintenance branches

- On a branch matching `maintenanceBranches` (e.g. `release/1.4.x`), only `patch` and `none` changesets are allowed. `minor`/`major` fail the PR check, saying the change belongs on main.
- The next version must stay in that line (`1.4.*`).

### 8.3 Preview versions

- Base: the next version computed from the changesets on the PR/branch. If none are pending, use a patch bump.
- PR: `{next}-pr.{prNumber}.{runNumber}` → `1.5.0-pr.123.4`.
- Branch preview (auto or `workflow_dispatch`): `{next}-{branchSlug}.{runNumber}` → `1.5.0-develop.17`. Slug: lowercase, `[a-z0-9-]`, max 30 chars.
- iOS marketing version: plain `{next}` (section 6.4).

---

## 9. The GitHub flow

### 9.1 Authentication: GitHub App

Events caused by the default `GITHUB_TOKEN` don't trigger other workflows. A release PR opened with it would never run CI (so required checks block merging) and tags pushed with it wouldn't trigger tag workflows. So:

- The demonsters org has a **GitHub App** ("shiplog"), created by an org owner in the browser. The agent building shiplog can't create it; the docs must explain how, step by step.
- Repository permissions: **Contents: read & write**, **Pull requests: read & write**, Metadata: read (automatic). Verify during implementation whether anything else is needed (for example Issues: write for labels or comments, Checks: read) and document the final list.
- Org secrets: `SHIPLOG_APP_ID`, `SHIPLOG_APP_PRIVATE_KEY`.
- Workflows mint a token with `actions/create-github-app-token` and pass it to the shiplog action as `token`.
- The PR check may use the default `GITHUB_TOKEN` (it only reads and comments).

### 9.2 PR check (`shiplog-check.yml`)

Trigger: `pull_request` (opened, synchronize, reopened, edited, labeled, unlabeled) targeting the base branch or a maintenance branch.

The check passes when:
- the PR adds or changes at least one valid changeset, **or**
- the PR author is in `check.bots`, **or**
- the PR is a shiplog release PR (head branch `shiplog/release/*`).

It also fails on: invalid changesets anywhere in `.shiplog/`, `minor`/`major` changesets on a maintenance branch, and version mismatches (section 6.7).

It maintains **one sticky comment** per PR (found by a hidden HTML marker, updated in place), like changeset-bot:
- With changesets: the bump and the version this would produce, and the list of changeset summaries.
- Without: how to add one (`npx @demonsters/shiplog add`, or write the file by hand with an example), and a link to the docs.

### 9.3 Release workflow (`shiplog-release.yml`)

Trigger: `push` to the base branch and maintenance branches, plus `workflow_dispatch` (for retrying a publish). Concurrency: `group: shiplog-release-${{ github.ref }}`, `cancel-in-progress: false`.

**Job `shiplog`** runs the action with `command: release`, which decides the mode:

1. **`publish`**: HEAD is the release commit for the current version (the version changed in this push), and `v{version}` doesn't exist yet. Also when started by `workflow_dispatch` with an unfinished release of the current version.
   - Output: `matrix` (JSON list of targets that have **no marker** yet), `version`, `build-number`, `channel=release`, `release-sha`.
   - Build jobs check out `release-sha`, never a later commit.
2. **`release-pr`**: pending changesets exist (including generated bot changesets, 9.4), and it's not a publish. Create or update the release PR:
   - Branch `shiplog/release/<base-branch>`, **rebuilt from the base branch on every run and force-pushed**, so it never has conflicts.
   - The commit: deletes consumed changesets, bumps the root version, stamps every target's marketing version, prepends the changelog section.
   - Title `Release v1.5.0`; body is the changelog section that will be added, plus a short "merging this releases all targets" note.
   - If the release PR is open and nothing is pending anymore, close it.
3. **`none`**: nothing to do.

Normally a push is never both: a publish push is the release PR merge, which used up all changesets. If changesets do exist at a publish commit (for example someone pushed one straight to main together with a version change), publish wins and release-pr runs on the next push.

Pushes after the release commit **do not** auto-retry an unfinished release. If a target failed, the team re-runs the failed job, or starts `workflow_dispatch`, or ships a new version (which supersedes, 9.6).

**Job `build`** (matrix, only when mode is `publish`): the team's own steps. A generated template looks like:

```yaml
build:
  needs: shiplog
  if: needs.shiplog.outputs.mode == 'publish'
  strategy:
    fail-fast: false
    matrix:
      target: ${{ fromJSON(needs.shiplog.outputs.matrix) }}
  steps:
    - uses: actions/checkout@v4
      with: { ref: "${{ needs.shiplog.outputs.release-sha }}" }
    - id: stamp
      uses: demonsters/shiplog/action@v1
      with: { command: stamp, target: "${{ matrix.target }}", plan: "${{ needs.shiplog.outputs.plan }}" }
    - id: verify
      uses: demonsters/shiplog/action@v1
      with: { command: verify, target: "${{ matrix.target }}", plan: "${{ needs.shiplog.outputs.plan }}" }
    # --- your build + upload steps, e.g. per target with if: matrix.target == 'android' ---
    - uses: demonsters/shiplog/action@v1
      with: { command: mark, target: "${{ matrix.target }}", plan: "...", token: "${{ steps.app-token.outputs.token }}" }
```

(Exact shape is up to the implementation. `plan` is a JSON output carrying version, build number, channel, release sha and per-target data, so later steps don't recompute anything.)

**Job `finalize`** (`needs: build`, `if: always() && needs.shiplog.outputs.mode == 'publish'`): runs `command: finalize`:
- If every target has a marker: create `v{version}` at `release-sha` and a GitHub Release with that version's changelog section. If this is the base branch, mark it "latest"; maintenance releases are not marked latest.
- Otherwise: fail with a summary of which targets are missing (job summary + log).
- Also handles superseding (9.6) and the changelog backport (9.5).

### 9.4 Bot PRs

- The PR check passes for authors in `check.bots`. **shiplog never pushes to bot branches**: Dependabot and Renovate stop rebasing PRs that others have pushed to.
- When building the release PR, shiplog lists PRs merged into the branch since the last release tag (commits between `v{last}` and HEAD → associated PRs via the GitHub API), and for each one authored by a bot that **didn't** add a changeset, it writes a generated changeset: `bump: patch`, `source: bot`, `pr: <n>`, body = the PR title (e.g. "Bump react-native from 0.76.1 to 0.76.3"). These are generated fresh on every release-PR run (the branch is rebuilt), so they're never duplicated.
- Merged bot PRs alone are enough to open a release PR.
- In the changelog, bot entries go under a **Dependencies** heading.

### 9.5 Hotfixes / maintenance branches

- `shiplog hotfix <major.minor>` (CLI, run locally): creates `release/<major>.<minor>.x` from the latest `v<major>.<minor>.*` release tag and pushes it. Errors if the branch already exists or no such tag exists.
- On that branch the whole flow is identical: PRs target it, the check runs, a release PR `shiplog/release/release/1.4.x` is opened (branch naming must handle slashes), merging it publishes.
- Build numbers: `timestamp` keeps working because it increases over time regardless of branch. Hotfix Android builds always get a higher `versionCode` than earlier uploads.
- Docker tags on maintenance releases: see 6.1 (never `latest`).
- **Changelog backport**: after `finalize` creates a maintenance release tag, shiplog opens a PR to the base branch titled `Changelog: v1.4.1` that only inserts the `1.4.1` section into the base branch's `CHANGELOG.md` at the right place (sorted by version). It doesn't touch version files or changesets.
- The fix itself still has to land on main through a normal PR with its own changeset. The docs explain this. Version calculation on main skips taken versions (8.1).

### 9.6 Partial (unfinished) releases

- Only the newest version is ever published. When a newer version reaches `finalize` and an older version has marker tags but no `v` tag, that older version is **superseded**:
  - Create tag `v{old}-partial` at the old release commit, and a GitHub Release for it marked **pre-release**, titled `v1.4.0 (partial, superseded by v1.4.1)`, listing which targets shipped and which didn't, plus the changelog section.
  - It never gets a `v{old}` tag.
- `plan` only ever considers the current version.

### 9.7 Previews (`shiplog-preview.yml`)

Triggers:
- `pull_request` (labeled, synchronize, reopened): only when the PR has `preview.label`. With `rebuildOnPush: false`, only on the `labeled` event.
- `workflow_dispatch` on any branch (optional input: targets).
- `push` to branches in `preview.branches`.
- Concurrency per PR/branch with `cancel-in-progress: true` (a newer push replaces the older preview; build numbers stay unique).
- PRs from forks: secrets aren't available; skip with a clear notice in the job summary.

Behavior:
- `command: preview-plan` outputs the same shape as `plan` with `channel=preview`, the preview version (8.3), a build number, and the preview targets (`preview.targets`).
- **No side effects**: no changesets consumed, nothing committed, no marker or release tags, no GitHub Releases.
- `command: preview-comment` (final job, `if: always()`): one sticky PR comment with version, build number per platform, Docker image tags, and per-target success/failure with links to the jobs. Updated on each preview run.

---

## 10. The GitHub Action

- Lives at `action/` in the shiplog repo: `action/action.yml`, `runs.using: node24`, `main: dist/index.js`.
- `dist/index.js` is a **single bundled file** that includes the CLI core and all dependencies, and is committed. CI in the shiplog repo fails if `dist` is out of date. Consumer repos never install anything from npm.
- Used as `demonsters/shiplog/action@v1`.
- Inputs: `command` (`check` | `release` | `stamp` | `verify` | `mark` | `finalize` | `preview-plan` | `preview-comment`), `token`, `target`, `plan`, `working-directory`.
- Outputs (depending on command): `mode`, `matrix`, `plan`, `version`, `build-number`, `channel`, `release-sha`, `already-published`, `docker-tags`, `docker-labels`, `pr-number`.
- Writes a readable job summary (`$GITHUB_STEP_SUMMARY`) for every command.
- Versioning of shiplog itself: tags `v1.2.3` plus a moving major tag `v1`.
- Because the repo is private, other demonsters repos can only use the action after an org owner enables **Settings → Actions → General → Access → "Accessible from repositories in the 'demonsters' organization"**. Document this.

---

## 11. CLI

Binary: `shiplog`. Package `@demonsters/shiplog` (private on npm). Node ≥ 20.

Rules for every command: no interactive prompt when stdin isn't a TTY or `--yes`/flags are given; `--json` where output is data; non-zero exit on failure; no color when not a TTY or `NO_COLOR` is set; `--cwd <dir>`.

| Command | What it does |
|---|---|
| `shiplog init` | Set up a repo (11.1). |
| `shiplog add` | Create a changeset. Interactive (bump + summary), or `--bump <type> --message <text>`. `--empty` = `bump: none`. Prints the created path. |
| `shiplog status` | Pending changesets, bump, next version, consistency check, last release, unfinished releases. `--json`. Exit code 1 with `--require-changeset` if none pending vs a base ref (`--since <ref>`). |
| `shiplog version` | Apply pending changesets locally (what the release PR commit does). For debugging and manual use. `--dry-run` prints the diff. |
| `shiplog plan` | Print the release plan (mode, matrix, version, build number) as JSON. `--preview` for preview mode. |
| `shiplog stamp --target <name>` | Write version + build number into the target's files. Accepts `--plan <json>` or `--version`/`--build-number`/`--channel`. |
| `shiplog verify --target <name>` | Store/registry verification (7.3, 7.4). |
| `shiplog mark --target <name>` | Create and push the marker tag. |
| `shiplog finalize` | Create the release tag + GitHub Release when complete; handle supersede and backport. |
| `shiplog hotfix <major.minor>` | Create a maintenance branch (9.5). |
| `shiplog check` | Run the PR check logic (used by the action; also usable locally against a base ref). |

The GitHub-facing commands work from the CLI too when given `GITHUB_TOKEN`/`--token` and repo info, but they're mainly called by the action.

### 11.1 `shiplog init`

1. **Detect**: root `package.json`; Android (`android/app/build.gradle(.kts)`, `gradle.properties` version keys); iOS (`*.xcodeproj`, `Info.plist`, `.xcconfig`; choose `xcodeproj` when plists use `$(MARKETING_VERSION)`); Capacitor (`capacitor.config.*`); Expo (`app.json` with an `expo` key; for `app.config.*` print the advice from 6.5); Dockerfiles (suggest docker targets, ask for the image name).
2. **Show versions** found per file. If they don't match, pick the canonical version (default: root `package.json`) and align the files.
3. **Build numbers**: read the current highest `versionCode` / `CFBundleVersion` from the files (and, if credentials are present, from the stores). If any is higher than what the chosen strategy produces now, set `buildNumber.offset` so new numbers stay higher, and explain.
4. **Write**: `shiplog.config.ts`, `.shiplog/README.md`, the three workflow files (with commented placeholders for the team's build steps, and example steps for docker/build-push-action and fastlane), `CHANGELOG.md` if missing.
5. **Baseline**: offer to create the `v{version}` tag on HEAD so the current version counts as released (skip if it exists).
6. **Convert** existing `.changeset/*.md` (4.2).
7. **Agent skill**: offer to install `.claude/skills/shiplog/SKILL.md` and add a short shiplog section to `AGENTS.md` (create it if missing) for non-Claude agents.
8. Print the manual steps that remain: GitHub App + secrets, store credential secrets, action access setting.

`--yes` accepts all defaults; every question has a flag.

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

---

## 13. Tech stack and repo layout (shiplog repo)

- TypeScript (strict), ESM, Node ≥ 20 for the CLI; the action runs on `node24`.
- Package manager: pnpm. Tests: vitest. Lint/format: Biome.
- Libraries (suggestions; use current maintained versions): `zod` (config), `jiti` (TS config loading), `semver`, `yaml`, `@clack/prompts` (interactive CLI), `@octokit/rest` (+ `@actions/core` for the action), `google-auth-library` or plain JWT for Play, `jose` for the App Store Connect JWT, `msw` for HTTP mocking in tests.
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
  dist/index.js  (committed bundle)
templates/
  workflows/     # used by init
skills/
  shiplog/SKILL.md
docs/            # Astro Starlight site (own package.json)
test/
  fixtures/      # real-world sample files per platform
design/
  SPEC.md
```

Keep `core/` free of I/O so it can be tested with plain inputs.

---

## 14. Testing

- **Stampers**: fixtures for Groovy and KTS Gradle files (incl. flavors → error), `gradle.properties`, a pbxproj with several targets and configurations including an app extension, Info.plist with literal values and with `$(MARKETING_VERSION)`, `.xcconfig`, Capacitor layout, Expo `app.json`, bare RN layout, JSON/YAML/regex. Assert exact output text (only the values changed).
- **Core**: bump calculation, next-free version, maintenance restrictions, preview versions, build-number strategies incl. limits and the semver+preview rejection, changelog rendering, config validation messages.
- **Plan/state**: every mode (`publish`, `release-pr`, `none`), markers present/missing, release-sha detection, superseding, `workflow_dispatch` retry.
- **GitHub**: mocked HTTP (msw): release PR create/update/close, sticky comments, tags, releases, bot-PR detection, changelog backport PR.
- **Verify**: mocked Play, App Store Connect and registry responses incl. "already published" and "store is ahead".
- **End to end**: real temporary git repos with a local bare remote, running the CLI through a full lifecycle: init → add → version → plan → stamp → mark → finalize; a hotfix line; a superseded partial release; a preview.
- **shiplog's own CI**: lint, typecheck, tests, `action/dist` up to date, docs build.

---

## 15. shiplog releases itself

shiplog uses shiplog (dogfooding):
- Targets: `npm` (custom, root `package.json`; the workflow runs `npm publish` to the private `@demonsters` scope) and `action` (custom; the workflow moves the `v1` major tag to the release commit).
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
- Preview builds
- Hotfixes and maintenance branches
- Partial releases
- GitHub App setup (step by step, permissions, secrets, action access setting)
- Workflow recipes (docker/build-push-action, fastlane for Play and TestFlight, Gradle, xcodebuild)
- Migrating from Changesets / moving an existing repo (`init`)
- CLI reference
- Troubleshooting / FAQ (e.g. "release PR has no CI runs" → App token missing)

Hosting isn't decided yet: the site must build (`pnpm --filter docs build`), but don't deploy it.

### 16.2 Agent skill (`skills/shiplog/SKILL.md`)

For AI agents working **in repos that use shiplog** (not in the shiplog repo itself). Claude Code skill format: frontmatter with `name: shiplog` and a `description` that makes agents load it whenever they change code in a repo containing `shiplog.config.*` or `.shiplog/`, or when they're about to open a PR there. Content:

- Every PR needs a changeset. Create it with `npx @demonsters/shiplog add --bump <type> --message "<summary>"`, or write the file by hand (show the exact format) if the CLI isn't available (the package is private, so npm auth may be missing).
- How to pick the bump: major (breaking for users or API clients), minor (new features), patch (fixes), none (no release needed: docs, CI, tests only).
- How to write a good summary: user-facing, one line, past or present tense consistently, no PR number (shiplog adds it).
- Never edit version numbers, build numbers or `CHANGELOG.md` by hand; never create `v*` or `shiplog/*` tags; never edit the release PR.
- On a `release/X.Y.x` branch only patch or none.
- Preview builds: add the `shiplog:preview` label.
- `npx @demonsters/shiplog status` to check pending changes and the next version.

The skill ships inside the npm package and is installed into consumer repos by `shiplog init` (11.1 step 7), together with an equivalent short section for `AGENTS.md`.

---

## 17. Manual steps for the demonsters team (not for the building agent)

1. Create the GitHub App, install it on the repos using shiplog, add `SHIPLOG_APP_ID` and `SHIPLOG_APP_PRIVATE_KEY` as org secrets.
2. Enable action access for org repos in `demonsters/shiplog` settings (section 10).
3. Add store credentials as secrets where `verify: ["store"]` is used.
4. Set up npm publishing auth for `@demonsters/shiplog` (section 15).
5. Decide where the docs site is hosted.

---

## 18. Decisions taken while writing this spec

These weren't discussed explicitly; they follow from the agreed design. Change them here if they're wrong.

- Changeset folder `.shiplog/`, config file `shiplog.config.ts`, frontmatter key `bump`.
- Marker tags are namespaced `shiplog/<target>@<version>` to avoid clashing with other tools.
- Partial releases get a `v{old}-partial` tag, because a GitHub Release needs a tag.
- Release builds always check out the release commit (`release-sha`); later pushes don't auto-retry an unfinished release.
- "Next free version" on main skips versions already taken by hotfixes.
- Maintenance releases never move Docker `latest`/`{major}` tags and aren't marked "latest" on GitHub.
- After a maintenance release, shiplog opens a changelog-only backport PR to main.
- Store verification also detects "this build is already uploaded" so a re-run skips the upload instead of failing.
- A `custom` target type covers npm packages, Helm charts etc., and lets shiplog release itself.
- The PR check also fails when version files don't match the root version.
