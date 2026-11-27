/**
 * Hand-written descriptions of every config option. The generator takes names, types and
 * defaults from the zod schema and fails when an option here is missing or no longer exists.
 * Keys: the dotted path; `[kind]` for options of a source or file kind, `targets[type]` for a
 * target type, `targets[*]` for options every target has. `#Title` keys are section intros.
 */
export const CONFIG_DESCRIPTIONS: Record<string, string> = {
  "#Top-level options":
    "Everything is optional except `targets`. `$schema` is only for editors: point it at `node_modules/launchset/dist/launchset.schema.json` in a `launchset.config.json` to get completion.",
  $schema:
    "Path or URL of the JSON Schema, for editor completion in `launchset.config.json`. Ignored by launchset.",
  version: "Where the repo's one version lives.",
  "version.file":
    "A JSON file with a top-level `\"version\"`, or a Flutter app's `pubspec.yaml`. The release PR bumps it. A `package-lock.json` or `npm-shrinkwrap.json` next to a JSON file gets its root version updated too. In a `pubspec.yaml` the `+N` build number is kept, and CI writes the run's build number there.",
  changelog: "The changelog file.",
  "changelog.file":
    "The changelog, relative to the repo root. New sections are inserted before the first version heading.",
  "changelog.links":
    "Add PR links and authors to changelog lines. Needs a token; without one, or when no PR is found, the links are left out.",
  "changelog.github":
    "Deprecated: the old name of `changelog.links`, still accepted. Giving both with different values is an error.",
  baseBranch: "The branch releases are made from.",
  maintenanceBranches:
    "Pattern of the maintenance branches used for hotfixes. The single `*` stands for `<major>.<minor>`. It must not match `baseBranch`.",
  tags: "Names of the git tags launchset creates.",
  "tags.release":
    "The release tag, created when every auto target has shipped. Must contain `{version}`. Keep your existing format here (for example `{version}` without the `v`).",
  "tags.marker":
    "The marker tag that records one target shipped for one version. Must contain `{target}` and `{version}`.",
  "tags.partial":
    "The tag for a release that was superseded before it was complete. Must contain `{version}` and differ from `tags.release`. Keep it outside the namespace your tag-triggered workflows listen to.",
  baseline:
    "The version that was released before launchset took over, as a plain `X.Y.Z` (`init --baseline` writes it). While the root version is this version and its release tag doesn't exist, the release workflow on `baseBranch` creates that tag at the commit it runs on (when the config is committed there; GitLab: pushed with `ci.skip`), without building anything, so the version counts as released. Nothing happens on other branches or once the tag exists, so you can remove it afterwards. See [Baseline](/guides/migrating/#baseline).",
  buildNumber: "How build numbers are computed. A target can override any of these keys.",
  "buildNumber.strategy":
    "`timestamp`: seconds (or minutes, see `unit`) since `epoch`, plus `offset`. `run-number`: `github.run_number` plus `offset`. `semver`: derived from the version; not allowed here while previews are enabled, and only on targets that previews don't build. `eas`: no build number at all, for Expo builds on EAS.",
  "buildNumber.epoch": "Start of the `timestamp` strategy, as an ISO 8601 date-time.",
  "buildNumber.offset":
    "Added to every build number. Use it when existing builds in a store have higher numbers than the strategy would produce.",
  "buildNumber.unit":
    'What the `timestamp` strategy counts since `epoch`: `"second"` (the default) or whole `"minute"`s (rounded down). Minutes stay under Android\'s limit until about the year 6000, but two builds in the same minute get the same number. An error with any other strategy.',
  check: "The PR check.",
  "check.bots":
    "PR authors that pass the check without a changeset. Matched case-insensitively. Their merged PRs get a generated patch entry under Dependencies in the next release.",
  gitlab: "GitLab settings. Ignored on GitHub.",
  "gitlab.include":
    "Local files launchset's child pipeline includes before `.gitlab/launchset-targets.yml`, so the `.launchset-<target>` jobs can extend their templates (`extends: .windows`). Literal repo-relative `.yml` paths. Each file may only hold hidden jobs (names starting with `.`), `variables` and `default`: the plan job checks this before it writes the child pipeline. `init` moves the templates your target jobs extend to `.gitlab/ci-templates.yml` and lists it here.",
  "gitlab.tagPipelines":
    "Let launchset's release and prerelease tags start tag pipelines. With `false`, every tag launchset pushes on GitLab is pushed with `git push -o ci.skip`, so none starts a pipeline; marker and partial tags never do.",
  "#Previews":
    "Set `preview: false` to switch off previews and prerelease branches. While previews are on, the `semver` build-number strategy is only allowed on targets that previews never build (see Build numbers).",
  preview:
    "Preview builds and prerelease branches. `false` switches them off; an object configures them.",
  "preview.label": "A PR with this label gets a preview build.",
  "preview.rebuildOnPush":
    "Rebuild the preview on every push to a labeled PR. With `false`, a preview is only built when the label is added.",
  "preview.branches":
    "Branches that build a preview on every push. A string is a branch glob (`develop`, `feature/*`). An object can limit the targets or turn the branch into a prerelease branch. Branches that match `maintenanceBranches` never auto-preview. A prerelease pattern must not match `baseBranch`.",
  "preview.branches[].branch": "The branch glob.",
  "preview.branches[].targets":
    'Targets to build on this branch: `"all"` or a list of target names. Overrides `preview.targets`.',
  "preview.branches[].prerelease":
    "A prerelease id such as `alpha`, `beta` or `rc`. Makes this a prerelease branch (experimental): pushes get a tag like `v1.5.0-alpha.3` and a GitHub pre-release.",
  "preview.targets":
    'Targets built by previews: `"all"` or a list of target names. Manual targets can be listed too.',
  "#Targets":
    '`targets` is an object. Each key is a target name (lowercase letters, digits and dashes, starting with a letter or digit), each value one of the target types below. You need at least one target, and at least one with `release: "auto"`.',
  targets:
    "One entry per thing that is built and shipped, for example `docker-api`, `android`, `ios`, `web`.",
  "#Options of every target": "These options exist on every target type.",
  "targets[*].release":
    "`auto`: built by every release, and the release tag waits for it. `manual`: its version is stamped by every release, but it is shipped on demand (see Manual targets).",
  "targets[*].buildNumber":
    "Overrides the root `buildNumber` for this target. Every key is optional and falls back to the root value.",
  "targets[*].buildNumber.strategy": "See `buildNumber.strategy`.",
  "targets[*].buildNumber.epoch": "See `buildNumber.epoch`.",
  "targets[*].buildNumber.offset": "See `buildNumber.offset`.",
  "targets[*].buildNumber.unit": "See `buildNumber.unit`.",
  "targets[*].after":
    "GitLab only (an error on GitHub). Targets whose jobs must finish first, in the same pipeline: this target's job gets their artifacts. In the child pipeline it `needs` their `build-<target>` (or `preview-<target>`) jobs as optional, so a retry that only builds this target still starts, without those artifacts. Names must exist, can't form a cycle, and an auto target can only come after auto targets.",
  "targets[*].gitlab": "GitLab settings of this target. Ignored on GitHub.",
  "targets[*].gitlab.shell":
    "`sh` or `powershell`: the shell of the runner that runs this target's job. With `powershell` (Windows PowerShell 5.1 or PowerShell 7), launchset writes its lines of the job in PowerShell and checks `$LASTEXITCODE` after each command; the runner needs Node 24 or later, npm and git on its PATH.",
  "targets[*].files":
    "Extra files that get the version stamped, next to what the target type already stamps. Each entry has a `kind`.",
  "targets[*].files[][json].path": "File to edit, relative to the repo root.",
  "targets[*].files[][json].key":
    "Dotted key path to the value, for example `version` or `expo.version`.",
  "targets[*].files[][yaml].path": "File to edit, for example `charts/app/Chart.yaml`.",
  "targets[*].files[][yaml].key": "Dotted key path to the value, for example `appVersion`.",
  "targets[*].files[][regex].path": "File to edit.",
  "targets[*].files[][regex].pattern":
    "JavaScript regular expression source. It must match exactly once in the file. A `\\n` matches LF and CRLF line endings alike (since 1.1.1).",
  "targets[*].files[][regex].replace":
    "The replacement text. Placeholders: `{version}`, `{major}`, `{minor}`, `{patch}`, `{buildNumber}`. `$1`, `$<name>`, `$&` and `$$` work like in `String.prototype.replace`. An entry that uses `{buildNumber}` is only stamped in CI.",
  "targets[*].files[][regex].flags":
    "Extra RegExp flags: any of `i`, `m`, `s`, `u`. `g` is not allowed.",
  "targets[*].files[][image].path":
    "Docker targets only. A deploy manifest (Kubernetes, Compose, Helm values) or a glob such as `deploy/k8s/*.yaml`. Every `<image>:<tag>` reference to this target's image gets the release tag.",
  '#Targets of type "docker"':
    "A Docker image. launchset gives your build step the tags and labels.",
  "targets[docker].type": "Selects this target type.",
  "targets[docker].image":
    "The image name without a tag or digest, for example `ghcr.io/org/app`. A list pushes to several registries.",
  "targets[docker].tags":
    "Tag templates. A list is the release list (preview and prerelease keep their defaults). An object sets any of the three lists. Placeholders: `{version}`, `{major}`, `{minor}`, `{patch}`, `{preid}`, `{prNumber}`, `{branchSlug}`, `{sha}`, `{shortSha}`, `{buildNumber}`.",
  "targets[docker].tags.release":
    'Default `["{version}", "{major}.{minor}", "{major}", "latest"]`. Needs at least one template with `{version}`.',
  "targets[docker].tags.preview":
    'Default `["{version}", "pr-{prNumber}", "{branchSlug}"]`. Can\'t contain `latest` or a plain `X.Y.Z`.',
  "targets[docker].tags.prerelease":
    'Default `["{version}", "{branchSlug}"]`. Can\'t contain `latest` or a plain `X.Y.Z`.',
  "targets[docker].verify":
    '`["registry"]` checks the registry before building: if the first release tag containing `{version}` already exists, the build is skipped.',
  '#Targets of type "web"':
    "A web app. launchset stamps nothing by default (the root version is already in `package.json`); add `files` if the app reads the version from somewhere else.",
  "targets[web].type": "Selects this target type.",
  "targets[web].verify": "Web targets have no checks: leave it out.",
  '#Targets of type "android"': "An Android app.",
  "targets[android].type": "Selects this target type.",
  "targets[android].source":
    "Where the version lives. `kind` is `gradle`, `gradle-properties`, `capacitor`, `expo` or `flutter`.",
  "targets[android].source[gradle].file":
    "`build.gradle` or `build.gradle.kts`. launchset edits the literal `versionCode` and `versionName` in `defaultConfig`.",
  "targets[android].source[gradle-properties].file": "The `gradle.properties` file.",
  "targets[android].source[gradle-properties].versionNameKey": "Key that holds the version name.",
  "targets[android].source[gradle-properties].versionCodeKey": "Key that holds the version code.",
  "targets[android].source[capacitor].dir":
    "The Capacitor project directory. launchset edits `<dir>/android/app/build.gradle`.",
  "targets[android].source[expo].file":
    "The Expo config. launchset edits `expo.version` and `expo.android.versionCode`.",
  "targets[android].source[flutter].dir":
    "The Flutter project folder, relative to the repo root. launchset edits `version` in its `pubspec.yaml`, and Flutter passes it to Gradle.",
  "targets[android].store": 'Google Play settings, needed for `verify: ["store"]`.',
  "targets[android].store.packageName": "The application id, for example `com.example.app`.",
  "targets[android].verify":
    '`["store"]` compares the build number with Google Play before uploading. Needs `store.packageName` and the `LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON` secret.',
  '#Targets of type "ios"': "An iOS app.",
  "targets[ios].type": "Selects this target type.",
  "targets[ios].source":
    "Where the version lives. `kind` is `xcodeproj`, `plist`, `xcconfig`, `capacitor`, `expo` or `flutter`.",
  "targets[ios].source[xcodeproj].file":
    "The `.xcodeproj` directory. launchset edits `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` in its `project.pbxproj`.",
  "targets[ios].source[xcodeproj].xcodeTargets":
    "Xcode targets to stamp. Default: every target that has these settings, which includes app extensions and widgets.",
  "targets[ios].source[plist].file": "One `Info.plist`. Use this or `files`.",
  "targets[ios].source[plist].files": "Several `Info.plist` files. Use this or `file`.",
  "targets[ios].source[xcconfig].file":
    "A `.xcconfig` file with one unconditional `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION`.",
  "targets[ios].source[capacitor].dir":
    "The Capacitor project directory. launchset edits `<dir>/ios/App/App.xcodeproj`.",
  "targets[ios].source[capacitor].xcodeTargets": "Xcode targets to stamp, like for `xcodeproj`.",
  "targets[ios].source[expo].file":
    "The Expo config. launchset edits `expo.version` and `expo.ios.buildNumber`.",
  "targets[ios].source[flutter].dir":
    "The Flutter project folder, relative to the repo root. launchset edits `version` in its `pubspec.yaml`, and Flutter passes it to Xcode.",
  "targets[ios].store": 'App Store Connect settings, needed for `verify: ["store"]`.',
  "targets[ios].store.appId":
    "The numeric Apple ID of the app (App Store Connect, App Information).",
  "targets[ios].verify":
    '`["store"]` compares the build number with App Store Connect before uploading. Needs `store.appId` and the three `LAUNCHSET_ASC_*` secrets.',
  '#Targets of type "custom"':
    "Anything else: an npm package, a Helm chart, a version file. Without `files` it is just an entry in the build matrix plus a marker.",
  "targets[custom].type": "Selects this target type.",
  "targets[custom].npm": 'Which package.json `verify: ["npm"]` reads the package name from.',
  "targets[custom].npm.package": "Path of the package.json.",
  "targets[custom].verify":
    '`["npm"]` looks the version up on the npm registry: if it exists, the publish step is skipped.',
};
