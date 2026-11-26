---
title: Configuration
description: Every option of launchset.config.ts, with its type and default.
---

launchset reads its configuration from one file at the root of the repo. It looks for these names, in this order, and fails when it finds more than one:

`launchset.config.ts`, `launchset.config.mts`, `launchset.config.mjs`, `launchset.config.js`, `launchset.config.json`

TypeScript and JavaScript configs are loaded with [jiti](https://github.com/unjs/jiti), so they work on any Node version, and `import { defineConfig } from "launchset"` works even where the package isn't installed (for example inside the GitHub Action). `defineConfig` only gives you types.

```ts title="launchset.config.ts"
import { defineConfig } from "launchset";

export default defineConfig({
  version: { file: "package.json" },
  changelog: { file: "CHANGELOG.md", links: true },
  baseBranch: "main",
  maintenanceBranches: "release/*.x",

  tags: {
    release: "v{version}",
    marker: "launchset/{target}@{version}",
    partial: "launchset/partial/{version}",
  },

  buildNumber: { strategy: "timestamp", epoch: "2020-01-01T00:00:00Z", offset: 0 },

  check: { bots: ["dependabot[bot]", "renovate[bot]", "renovate-bot"] },

  preview: {
    label: "launchset:preview",
    rebuildOnPush: true,
    branches: [{ branch: "next/*", prerelease: "alpha" }],
    targets: "all",
  },

  targets: {
    "docker-api": {
      type: "docker",
      image: "ghcr.io/acme/api",
      tags: ["v{version}", "latest"],
      verify: ["registry"],
    },
    web: { type: "web" },
    android: {
      type: "android",
      source: { kind: "gradle", file: "apps/mobile/android/app/build.gradle" },
      verify: ["store"],
      store: { packageName: "com.acme.app" },
    },
    ios: {
      type: "ios",
      source: { kind: "xcodeproj", file: "apps/mobile/ios/App.xcodeproj" },
      verify: ["store"],
      store: { appId: "1234567890" },
      release: "manual",
    },
    npm: {
      type: "custom",
      files: [{ path: "packages/sdk/package.json", kind: "json", key: "version" }],
    },
  },
});
```

Only `targets` is required. `version`, `changelog`, `baseBranch`, `maintenanceBranches`, `tags`, `buildNumber`, `check` and the `label`, `rebuildOnPush` and `targets` keys of `preview` are written out with their default values, so you can see what you get when you leave them out. The `targets` section and the prerelease entry in `preview.branches` (whose default is an empty list) are examples, not defaults.

## JSON and editor support

A `launchset.config.json` gets completion and checking from the JSON Schema that ships with the package:

```json title="launchset.config.json"
{
  "$schema": "./node_modules/launchset/dist/launchset.schema.json",
  "targets": {
    "web": { "type": "web" }
  }
}
```

The package also exports it as `launchset/schema.json`. A top-level `$schema` key is allowed in every config file. It is ignored.

## Validation

The config is checked when launchset loads it. Errors name the exact field and say what is expected, and every problem is listed:

```text
error: Invalid launchset config in launchset.config.ts:
  - targets.api.image: expected an image name without tag or digest, like "ghcr.io/org/app" (got "ghcr.io/acme/api:latest"); set tags with "tags"
  - chek: unknown key (check the spelling; see the configuration reference)
```

These rules apply on top of the types:

- **At least one target**, and at least one with `release: "auto"`. Otherwise no release could ever complete.
- Target names are lowercase letters, digits and dashes, starting with a letter or digit.
- **Unknown keys are errors.** That catches typos.
- While previews are enabled, `semver` can't be the repo-wide `buildNumber.strategy` (previews number their plan with it), and a target can only use it when previews never build that target: it isn't in `preview.targets` (`"all"` is every target) or in the `targets` of any `preview.branches` entry (an entry without `targets` uses `preview.targets`). Take the target out of those lists, or set `preview: false`.
- `buildNumber.unit` only goes with the `timestamp` strategy: setting it next to another strategy (repo-wide, or in a target's override, whose strategy may come from the root) is an error. A repo-wide `unit` that a target with another strategy inherits is fine.
- `maintenanceBranches` has exactly one `*` and must not match `baseBranch`.
- `tags.partial` must differ from `tags.release`.
- Docker: `image` has no tag or digest. Unknown `{placeholders}` are errors. The `release` list needs a template with `{version}`. `preview` and `prerelease` lists can't contain `latest` or a template that renders a plain `X.Y.Z`.
- `verify: ["store"]` needs `store.packageName` (Android) or `store.appId` (iOS).
- `kind: "image"` files are only allowed in docker targets.
- `preview.targets` and every `preview.branches[].targets` must name existing targets.
- A prerelease pattern in `preview.branches` must not match `baseBranch`.
- `after` names existing targets, not the target itself and none twice, without cycles; an auto target can only come after auto targets. On GitHub `after` is an error.
- `gitlab.include` entries are literal repo-relative `.yml` or `.yaml` paths (no variables or wildcards).
- Files that targets point to must exist. A glob in an `image` entry must match at least one file.

## All options

The tables below are generated from the schema the code uses, so they always match the version of launchset you read about. "required" in the default column means there is no default.

<!-- generated:config-options:start -->
### Top-level options

Everything is optional except `targets`. `$schema` is only for editors: point it at `node_modules/launchset/dist/launchset.schema.json` in a `launchset.config.json` to get completion.

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `$schema` | `string` |  | Path or URL of the JSON Schema, for editor completion in `launchset.config.json`. Ignored by launchset. |
| `version` | `object` |  | Where the repo's one version lives. |
| `version.file` | `string` | `"package.json"` | A JSON file with a top-level `"version"`. The release PR bumps it, and a `package-lock.json` or `npm-shrinkwrap.json` next to it gets its root version updated too. |
| `changelog` | `object` |  | The changelog file. |
| `changelog.file` | `string` | `"CHANGELOG.md"` | The changelog, relative to the repo root. New sections are inserted before the first version heading. |
| `changelog.links` | `boolean` | `true` | Add PR links and authors to changelog lines. Needs a token; without one, or when no PR is found, the links are left out. |
| `changelog.github` | `boolean` |  | Deprecated: the old name of `changelog.links`, still accepted. Giving both with different values is an error. |
| `baseBranch` | `string` | `"main"` | The branch releases are made from. |
| `maintenanceBranches` | `string` | `"release/*.x"` | Pattern of the maintenance branches used for hotfixes. The single `*` stands for `<major>.<minor>`. It must not match `baseBranch`. |
| `tags` | `object` |  | Names of the git tags launchset creates. |
| `tags.release` | `string` | `"v{version}"` | The release tag, created when every auto target has shipped. Must contain `{version}`. Keep your existing format here (for example `{version}` without the `v`). |
| `tags.marker` | `string` | `"launchset/{target}@{version}"` | The marker tag that records one target shipped for one version. Must contain `{target}` and `{version}`. |
| `tags.partial` | `string` | `"launchset/partial/{version}"` | The tag for a release that was superseded before it was complete. Must contain `{version}` and differ from `tags.release`. Keep it outside the namespace your tag-triggered workflows listen to. |
| `buildNumber` | `object` |  | How build numbers are computed. A target can override any of these keys. |
| `buildNumber.strategy` | `"timestamp" \| "run-number" \| "semver" \| "eas"` | `"timestamp"` | `timestamp`: seconds (or minutes, see `unit`) since `epoch`, plus `offset`. `run-number`: `github.run_number` plus `offset`. `semver`: derived from the version; not allowed here while previews are enabled, and only on targets that previews don't build. `eas`: no build number at all, for Expo builds on EAS. |
| `buildNumber.epoch` | `string` | `"2020-01-01T00:00:00Z"` | Start of the `timestamp` strategy, as an ISO 8601 date-time. |
| `buildNumber.offset` | `integer` | `0` | Added to every build number. Use it when existing builds in a store have higher numbers than the strategy would produce. |
| `buildNumber.unit` | `"second" \| "minute"` |  | What the `timestamp` strategy counts since `epoch`: `"second"` (the default) or whole `"minute"`s (rounded down). Minutes stay under Android's limit until about the year 6000, but two builds in the same minute get the same number. An error with any other strategy. |
| `check` | `object` |  | The PR check. |
| `check.bots` | `string[]` | `["dependabot[bot]", "renovate[bot]", "renovate-bot"]` | PR authors that pass the check without a changeset. Matched case-insensitively. Their merged PRs get a generated patch entry under Dependencies in the next release. |
| `gitlab` | `object` |  | GitLab settings. Ignored on GitHub. |
| `gitlab.include` | `string[]` | `[]` | Local files launchset's child pipeline includes before `.gitlab/launchset-targets.yml`, so the `.launchset-<target>` jobs can extend their templates (`extends: .windows`). Literal repo-relative `.yml` paths. Each file may only hold hidden jobs (names starting with `.`), `variables` and `default`: the plan job checks this before it writes the child pipeline. `init` moves the templates your target jobs extend to `.gitlab/ci-templates.yml` and lists it here. |
| `gitlab.tagPipelines` | `boolean` | `false` | Let launchset's release and prerelease tags start tag pipelines. With `false`, every tag launchset pushes on GitLab is pushed with `git push -o ci.skip`, so none starts a pipeline; marker and partial tags never do. |

### Previews

Set `preview: false` to switch off previews and prerelease branches. While previews are on, the `semver` build-number strategy is only allowed on targets that previews never build (see Build numbers).

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `preview` | `false \| object` | `{}` | Preview builds and prerelease branches. `false` switches them off; an object configures them. |
| `preview.label` | `string` | `"launchset:preview"` | A PR with this label gets a preview build. |
| `preview.rebuildOnPush` | `boolean` | `true` | Rebuild the preview on every push to a labeled PR. With `false`, a preview is only built when the label is added. |
| `preview.branches` | `(string \| object)[]` | `[]` | Branches that build a preview on every push. A string is a branch glob (`develop`, `feature/*`). An object can limit the targets or turn the branch into a prerelease branch. Branches that match `maintenanceBranches` never auto-preview. A prerelease pattern must not match `baseBranch`. |
| `preview.branches[].branch` | `string` | required | The branch glob. |
| `preview.branches[].targets` | `"all" \| string[]` |  | Targets to build on this branch: `"all"` or a list of target names. Overrides `preview.targets`. |
| `preview.branches[].prerelease` | `string` |  | A prerelease id such as `alpha`, `beta` or `rc`. Makes this a prerelease branch: pushes get a tag like `v1.5.0-alpha.3` and a GitHub pre-release. |
| `preview.targets` | `"all" \| string[]` | `"all"` | Targets built by previews: `"all"` or a list of target names. Manual targets can be listed too. |

### Targets

`targets` is an object. Each key is a target name (lowercase letters, digits and dashes, starting with a letter or digit), each value one of the target types below. You need at least one target, and at least one with `release: "auto"`.

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `targets` | `object` | required | One entry per thing that is built and shipped, for example `docker-api`, `android`, `ios`, `web`. |

### Options of every target

These options exist on every target type.

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `targets.<name>.release` | `"auto" \| "manual"` | `"auto"` | `auto`: built by every release, and the release tag waits for it. `manual`: its version is stamped by every release, but it is shipped on demand (see Manual targets). |
| `targets.<name>.buildNumber` | `object` |  | Overrides the root `buildNumber` for this target. Every key is optional and falls back to the root value. |
| `targets.<name>.buildNumber.strategy` | `"timestamp" \| "run-number" \| "semver" \| "eas"` |  | See `buildNumber.strategy`. |
| `targets.<name>.buildNumber.epoch` | `string` |  | See `buildNumber.epoch`. |
| `targets.<name>.buildNumber.offset` | `integer` |  | See `buildNumber.offset`. |
| `targets.<name>.buildNumber.unit` | `"second" \| "minute"` |  | See `buildNumber.unit`. |
| `targets.<name>.files` | `object[]` | `[]` | Extra files that get the version stamped, next to what the target type already stamps. Each entry has a `kind`. |
| `targets.<name>.files[].path` <br>*kind json* | `string` | required | File to edit, relative to the repo root. |
| `targets.<name>.files[].key` <br>*kind json* | `string` | required | Dotted key path to the value, for example `version` or `expo.version`. |
| `targets.<name>.files[].path` <br>*kind yaml* | `string` | required | File to edit, for example `charts/app/Chart.yaml`. |
| `targets.<name>.files[].key` <br>*kind yaml* | `string` | required | Dotted key path to the value, for example `appVersion`. |
| `targets.<name>.files[].path` <br>*kind regex* | `string` | required | File to edit. |
| `targets.<name>.files[].pattern` <br>*kind regex* | `string` | required | JavaScript regular expression source. It must match exactly once in the file. A `\n` matches LF and CRLF line endings alike (since 1.1.1). |
| `targets.<name>.files[].replace` <br>*kind regex* | `string` | required | The replacement text. Placeholders: `{version}`, `{major}`, `{minor}`, `{patch}`, `{buildNumber}`. `$1`, `$<name>`, `$&` and `$$` work like in `String.prototype.replace`. An entry that uses `{buildNumber}` is only stamped in CI. |
| `targets.<name>.files[].flags` <br>*kind regex* | `string` |  | Extra RegExp flags: any of `i`, `m`, `s`, `u`. `g` is not allowed. |
| `targets.<name>.files[].path` <br>*kind image* | `string` | required | Docker targets only. A deploy manifest (Kubernetes, Compose, Helm values) or a glob such as `deploy/k8s/*.yaml`. Every `<image>:<tag>` reference to this target's image gets the release tag. |
| `targets.<name>.after` | `string[]` |  | GitLab only (an error on GitHub). Targets whose jobs must finish first, in the same pipeline: this target's job gets their artifacts. In the child pipeline it `needs` their `build-<target>` (or `preview-<target>`) jobs as optional, so a retry that only builds this target still starts, without those artifacts. Names must exist, can't form a cycle, and an auto target can only come after auto targets. |
| `targets.<name>.gitlab` | `object` |  | GitLab settings of this target. Ignored on GitHub. |
| `targets.<name>.gitlab.shell` | `"sh" \| "powershell"` | `"sh"` | `sh` or `powershell`: the shell of the runner that runs this target's job. With `powershell` (Windows PowerShell 5.1 or PowerShell 7), launchset writes its lines of the job in PowerShell and checks `$LASTEXITCODE` after each command; the runner needs Node 24 or later, npm and git on its PATH. |

### Targets of type "docker"

A Docker image. launchset gives your build step the tags and labels.

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `targets.<name>.type` | `"docker"` | required | Selects this target type. |
| `targets.<name>.image` | `string \| string[]` | required | The image name without a tag or digest, for example `ghcr.io/org/app`. A list pushes to several registries. |
| `targets.<name>.tags` | `string[] \| object` |  | Tag templates. A list is the release list (preview and prerelease keep their defaults). An object sets any of the three lists. Placeholders: `{version}`, `{major}`, `{minor}`, `{patch}`, `{preid}`, `{prNumber}`, `{branchSlug}`, `{sha}`, `{shortSha}`, `{buildNumber}`. |
| `targets.<name>.tags.release` | `string[]` |  | Default `["{version}", "{major}.{minor}", "{major}", "latest"]`. Needs at least one template with `{version}`. |
| `targets.<name>.tags.preview` | `string[]` |  | Default `["{version}", "pr-{prNumber}", "{branchSlug}"]`. Can't contain `latest` or a plain `X.Y.Z`. |
| `targets.<name>.tags.prerelease` | `string[]` |  | Default `["{version}", "{branchSlug}"]`. Can't contain `latest` or a plain `X.Y.Z`. |
| `targets.<name>.verify` | `"registry"[]` | `[]` | `["registry"]` checks the registry before building: if the first release tag containing `{version}` already exists, the build is skipped. |

### Targets of type "web"

A web app. launchset stamps nothing by default (the root version is already in `package.json`); add `files` if the app reads the version from somewhere else.

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `targets.<name>.type` | `"web"` | required | Selects this target type. |
| `targets.<name>.verify` | `never[]` | `[]` | Web targets have no checks: leave it out. |

### Targets of type "android"

An Android app.

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `targets.<name>.type` | `"android"` | required | Selects this target type. |
| `targets.<name>.source` | `object` | required | Where the version lives. `kind` is `gradle`, `gradle-properties`, `capacitor` or `expo`. |
| `targets.<name>.source.file` <br>*kind gradle* | `string` | required | `build.gradle` or `build.gradle.kts`. launchset edits the literal `versionCode` and `versionName` in `defaultConfig`. |
| `targets.<name>.source.file` <br>*kind gradle-properties* | `string` | required | The `gradle.properties` file. |
| `targets.<name>.source.versionNameKey` <br>*kind gradle-properties* | `string` | `"VERSION_NAME"` | Key that holds the version name. |
| `targets.<name>.source.versionCodeKey` <br>*kind gradle-properties* | `string` | `"VERSION_CODE"` | Key that holds the version code. |
| `targets.<name>.source.dir` <br>*kind capacitor* | `string` | required | The Capacitor project directory. launchset edits `<dir>/android/app/build.gradle`. |
| `targets.<name>.source.file` <br>*kind expo* | `string` | `"app.json"` | The Expo config. launchset edits `expo.version` and `expo.android.versionCode`. |
| `targets.<name>.store` | `object` |  | Google Play settings, needed for `verify: ["store"]`. |
| `targets.<name>.store.packageName` | `string` | required | The application id, for example `com.example.app`. |
| `targets.<name>.verify` | `"store"[]` | `[]` | `["store"]` compares the build number with Google Play before uploading. Needs `store.packageName` and the `LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON` secret. |

### Targets of type "ios"

An iOS app.

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `targets.<name>.type` | `"ios"` | required | Selects this target type. |
| `targets.<name>.source` | `object` | required | Where the version lives. `kind` is `xcodeproj`, `plist`, `xcconfig`, `capacitor` or `expo`. |
| `targets.<name>.source.file` <br>*kind xcodeproj* | `string` | required | The `.xcodeproj` directory. launchset edits `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` in its `project.pbxproj`. |
| `targets.<name>.source.xcodeTargets` <br>*kind xcodeproj* | `string[]` |  | Xcode targets to stamp. Default: every target that has these settings, which includes app extensions and widgets. |
| `targets.<name>.source.file` <br>*kind plist* | `string` |  | One `Info.plist`. Use this or `files`. |
| `targets.<name>.source.files` <br>*kind plist* | `string[]` |  | Several `Info.plist` files. Use this or `file`. |
| `targets.<name>.source.file` <br>*kind xcconfig* | `string` | required | A `.xcconfig` file with one unconditional `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION`. |
| `targets.<name>.source.dir` <br>*kind capacitor* | `string` | required | The Capacitor project directory. launchset edits `<dir>/ios/App/App.xcodeproj`. |
| `targets.<name>.source.xcodeTargets` <br>*kind capacitor* | `string[]` |  | Xcode targets to stamp, like for `xcodeproj`. |
| `targets.<name>.source.file` <br>*kind expo* | `string` | `"app.json"` | The Expo config. launchset edits `expo.version` and `expo.ios.buildNumber`. |
| `targets.<name>.store` | `object` |  | App Store Connect settings, needed for `verify: ["store"]`. |
| `targets.<name>.store.appId` | `string` | required | The numeric Apple ID of the app (App Store Connect, App Information). |
| `targets.<name>.verify` | `"store"[]` | `[]` | `["store"]` compares the build number with App Store Connect before uploading. Needs `store.appId` and the three `LAUNCHSET_ASC_*` secrets. |

### Targets of type "custom"

Anything else: an npm package, a Helm chart, a version file. Without `files` it is just an entry in the build matrix plus a marker.

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `targets.<name>.type` | `"custom"` | required | Selects this target type. |
| `targets.<name>.npm` | `object` |  | Which package.json `verify: ["npm"]` reads the package name from. |
| `targets.<name>.npm.package` | `string` | `"package.json"` | Path of the package.json. |
| `targets.<name>.verify` | `"npm"[]` | `[]` | `["npm"]` looks the version up on the npm registry: if it exists, the publish step is skipped. |
<!-- generated:config-options:end -->
