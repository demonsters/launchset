---
title: Migrating to launchset
description: Move an existing repo, or a Changesets setup, to launchset. By hand or with an agent.
---

Most repos already have releases: tag-triggered workflows, a Changesets pipeline, scripts that bump versions. `launchset init` finds them, asks what to do about each and writes the new setup. This page covers the whole move.

There are two ways. Pick one:

- **By yourself**, interactively: run `npx @demonsters/launchset init` and answer the questions.
- **With an agent** (Claude Code or similar): the agent runs `init --detect --json`, asks you only the questions that matter, then runs `init --yes --decide ...`. The [adoption skill](#the-adoption-skill) tells it how.

## What init finds

`init` reads the repo and writes nothing until you say so:

- **Versions**: the root `package.json`, the `package.json` next to each Dockerfile, native marketing versions and existing tags (`v1.2.3`, `1.2.3`, `name@1.2.3`).
- **Platforms**: Dockerfiles, Android (`build.gradle(.kts)`, `gradle.properties`), iOS (`*.xcodeproj`, `Info.plist`, `.xcconfig`), Capacitor and Expo (`app.json`).
- **How they are built today**: image names, `file`, `context` and tag patterns from `docker/build-push-action`, `docker/metadata-action` and `docker push` lines.
- **Machinery that conflicts** with launchset. See [below](#retire-what-conflicts).
- **Build numbers**: the highest `versionCode` or `CFBundleVersion` in your files.
- **Changesets** files and pre mode.
- **A pre-push hook** setup (husky, simple-git-hooks or lefthook).

Look at the result first:

```sh
npx @demonsters/launchset init --detect
```

```text
Versions found:
  package.json:3  version = 1.4.0
  android/app/build.gradle:5  versionName = 1.4.0
  tags: 1 (latest: v1.4.0)
  canonical: 1.4.0 (highest version found (...))
Targets:
  api (docker): auto, Dockerfile found; the release workflow builds it
  android (android, gradle): manual, no workflow builds it, so it's shipped on demand (release: "manual")
Build numbers: highest 12 (android/app/build.gradle:4); timestamp strategy now 217175069
Decisions (default in brackets; answer with --decide <id>=<value>):
  version [1.4.0]: Which version is the repo on? Every target file is set to it.
  target.android [manual] (check this): How is the Android app in the repo root (gradle) released?
  docker.api.image [ghcr.io/your-org/demo-api] (check this): Image name for api (apps/api/Dockerfile)?
  baseline [no]: v1.4.0 already exists, so 1.4.0 counts as released. Create a baseline tag?
  ...
```

`(check this)` marks a decision whose default is a guess or risky.

## The decisions

Every question `init` asks is a **decision** with a stable id. Answer it with `--decide <id>=<value>` (repeatable) or interactively. Without an answer, the default is used.

| Id | Values | Default | Ask the human when |
| --- | --- | --- | --- |
| `version` | A plain `X.Y.Z`. | The **highest** version found: the root version, the `package.json` next to each Dockerfile, native marketing versions and the highest release-like tag. | The files disagree. Never lower a version without an explicit answer: stores reject lower marketing versions, and image tags would go backwards. |
| `tags.release` | A template with `{version}`. | `v{version}`. | Existing tags use another format (`{version}` without the `v`): keep it. |
| `target.<name>` | `auto`, `manual`, `none`. | `auto` when a workflow already builds it, `manual` for native projects that no workflow builds, `none` for the generic `web` target when other targets already ship the repo. A job that release tags start (through its workflow's tag trigger, an `if:` that checks for a tag, or a `workflow_run` after such a workflow), and that uploads an artifact, publishes, deploys or is the end of a release-only workflow, becomes a custom target (`auto`, named after the workflow file: `desktop-linux.yml` is `desktop-linux`), with its steps copied into `launchset-release.yml`, commented out. When the release machinery init retires (Changesets, semantic-release, release-it or a plain `npm publish`) published a public root package, an `npm` target takes over. | An Android or iOS project defaults to `manual`. Explain what that means. |
| `docker.<name>.image` | An image name without a tag. | Read from the existing workflow. Otherwise a guess, like `ghcr.io/<owner>/<repo>`. | Nothing in the workflows names the image. |
| `docker.<name>.tags` | `default`, or a comma-separated list of tag templates. | The tags the existing workflow pushes, otherwise `default`. A tag taken from the pushed git tag keeps its `v` (`v{version}`), also through a variable like `RELEASE_VERSION=${GITHUB_REF#refs/*/}`. | Existing images have a `v` prefix and should also get the moving tags: `v{version}, v{major}.{minor}, v{major}, latest` (an option). |
| `docker.<name>.verify` | `yes`, `no`. | `yes`: `verify: ["registry"]`, so a re-run skips an image whose release tag is already pushed. | The registry has no HTTP API launchset can reach from CI. |
| `machinery.<path>#<n>` | `remove`, `disable`, `keep`. | `disable` (`keep` when no minimal edit exists). | Always, when the default is `keep`. Otherwise show the list. |
| `image.<path>` | `stamp`, `leave`. | `leave`. | Always. A deploy manifest that pins the image may be deploy state. |
| `host` | `github`, `gitlab`. | The host of the `origin` remote, else the CI files found. Only listed when something points at GitLab. | When the repo is on GitLab and detection guessed wrong: `--decide host=gitlab`. See [launchset on GitLab](/gitlab/getting-started/). |
| `file.<path>` | `keep`, `overwrite`. | `keep`. One decision per file that init would write but that already exists: `.launchset/README.md` and the `launchset-*.yml` workflows. | Rarely. `keep` leaves an edited file alone. `overwrite` replaces it with the newly generated one. |
| `baseline` | `yes`, `no`. | `yes` only when an existing tag in another format already marks the version as released. | Always, when the answer matters. See [baseline](#baseline-tag). |
| `offset` | An integer `>= 0`. | Enough to stay above the highest build number found. | When it is above 0. |
| `skill` | `yes`, `no`. | `yes`. | Rarely. |
| `hook` | `yes`, `no`. | `no`. Only exists when a hook setup is found that doesn't run `launchset check --push` yet: husky as a dependency or with hooks in `.husky/`, simple-git-hooks or lefthook. A hook file git ignores doesn't count. | Optional. |

The machinery id is `machinery.<file path>#<n>`, where `n` counts the items in that file from 1. A path that starts with a dot gives two dots: `machinery..github/workflows/release.yml#1`. Copy ids from the JSON, don't type them.

The `file.<path>` id contains the repo path, for example `file..github/workflows/launchset-release.yml`. Copy it from the JSON.

The flags `--baseline`, `--no-baseline`, `--skill`, `--no-skill`, `--hook` and `--no-hook` are shortcuts for the three yes/no decisions.

## The agent loop

`init --detect --json` writes nothing and prints one JSON document:

```jsonc
{
  "schemaVersion": 1,
  "detection": {
    "root": "/path/to/repo",
    "git": { "repo": true, "head": "88554b4...", "branch": "main", "github": "acme/app" },
    // "existingConfig": "launchset.config.ts"   present only when a config exists: init won't overwrite it
    "packageJson": { "path": "package.json", "name": "app", "version": "1.4.0", "line": 3 },
    "workspaces": [],
    "versions": [ { "source": "root", "path": "package.json", "line": 3, "key": "version", "value": "1.4.0", "plain": "1.4.0" } ],
    "tags": [ { "tag": "v1.4.0", "version": "1.4.0", "format": "v{version}", "prerelease": false } ],
    "canonical": { "version": "1.4.0", "reason": "...", "evidence": [ { "path": "package.json", "line": 3, "note": "..." } ] },
    "targets": [ { "name": "android", "type": "android", "proposed": "manual", "reason": "...", "builtBy": [], "source": { "kind": "gradle", "file": "android/app/build.gradle" } } ],
    "workflows": [ { "path": ".github/workflows/ci.yml", "builds": [ { "platform": "docker", "line": 12, "note": "..." } ] } ],
    "machinery": [ { "id": "machinery..github/workflows/release.yml#1", "kinds": ["tag-trigger"], "path": ".github/workflows/release.yml", "line": 5, "what": "...", "reasons": ["..."], "actions": ["remove", "disable", "keep"], "effects": { "disable": "..." }, "evidence": [] } ],
    "imagePins": [ { "path": "deploy/k8s/api.yaml", "target": "api", "image": "ghcr.io/acme/api", "refs": [ { "line": 18, "tag": "v1.4.0" } ] } ],
    "buildNumbers": { "highest": { "value": 12, "path": "android/app/build.gradle", "line": 4, "key": "versionCode" }, "strategyNow": 217175072, "offset": 0 },
    "existingFiles": [],
    "changesets": { "files": [".changeset/cool-cats-run.md"], "preMode": false },
    "hooks": [ { "tool": "husky", "path": ".husky/pre-push", "installed": false } ],
    "notes": [ { "level": "info", "message": "...", "path": "...", "line": 3 } ]
  },
  "decisions": [
    {
      "id": "target.android",
      "question": "How is the Android app in the repo root (gradle) released?",
      "options": [ { "value": "auto", "label": "..." }, { "value": "manual", "label": "..." }, { "value": "none", "label": "..." } ],
      "default": "manual",
      "evidence": [ { "path": "android/app/build.gradle", "note": "..." } ],
      "ask": true,
      "onlyIf": { "id": "target.api", "values": ["auto", "manual"] }   // optional: only matters for these answers
    }
  ]
}
```

The decision fields: `id`, `question`, `options` (each `value` and `label`), `freeform` (set when other values of that form are accepted, for example `"a plain X.Y.Z version"`), `default`, `evidence` (`path`, optional `line` and a `note`: where the default comes from), `ask` (`true` when the default is a guess or a risk) and optionally `onlyIf`.

The loop:

1. **Detect.** `npx @demonsters/launchset init --detect --json > init.json`. Read it. Write nothing yet.
2. **Ask.** Show the human the decisions. Ask the ones with `"ask": true`, and always the three below. Quote the `evidence`.
3. **Run.** `npx @demonsters/launchset init --yes --decide version=1.4.0 --decide target.android=manual --decide "machinery..github/workflows/release.yml#1=disable"`
4. **Review.** `git status`, `git diff`. Read what init changed. Move the team's own build steps into the generated workflows. Open one PR.

Always ask the human about:

- **Lowering a version.** The default never lowers one. Only `--decide version=<lower>` does, and init warns about every file that goes down.
- **A baseline tag** for a version that has no release tag.
- **Native projects that no workflow builds.** `release: "manual"` is the usual answer. See [Manual targets](/guides/manual-targets/).

A bad answer fails before anything is written: `--decide target.android=maybe` says `expected one of auto, manual, none`, and an unknown id lists the valid ones.

### What init writes

`launchset.config.ts`, `.launchset/README.md`, the three workflows (a file that already exists is kept unless you answer `file.<path>=overwrite`), `CHANGELOG.md` if missing, the changes that retire conflicting machinery, converted changesets, the agent skill and an `AGENTS.md` section, and optionally a pre-push hook line. If a `launchset.config.*` exists, init refuses to run (`already-initialized`). Delete it to start over, or use `--convert-only` to only convert Changesets files.

It ends with the steps left to do by hand: commit and open a PR, create the GitHub App and secrets, add your build steps, store credentials. The agent lists them in the PR body.

## Canonical version

launchset has **one** version. `init` shows every version it found, per file and per tag, and defaults to the highest. Then it aligns the target files to it.

Don't lower a version just to make files agree. Stores reject a lower marketing version than what was uploaded, and registries would show a lower image tag as the newest. Raise the lagging files instead.

## Baseline tag

The **baseline** is the release tag (`v1.4.0`) for the canonical version, created at HEAD, so it counts as released.

- **Default yes** only when a tag in another format already marks that version as released (`1.4.0`, `app@1.4.0`).
- **Otherwise no**, with a warning. The version may never have been built. With a baseline tag launchset never builds it, and pinned images might not exist.

This matters at merge time. When the PR that adds launchset **changes the root version** (because init raised it) and there is no release tag for that version, the merge is read as a release commit, and launchset builds every target for it. If that is what you want, because that version was never built: fine. If the version was already released, create the tag (`--baseline`).

## Retire what conflicts

launchset pushes its tags and creates GitHub Releases with an App token. Unlike `GITHUB_TOKEN`, that **does** start other workflows. So anything that reacts to tags, or does what launchset now does, has to go. `init` lists every finding with its reason:

| Finding | Why it conflicts |
| --- | --- |
| A workflow triggered by `push.tags` that matches the release tag (`v*`, `v*.*.*`, `*.*.*`) | It fires again on launchset's tag, so its build or publish steps run a second time. |
| A `release` trigger | It fires when `finalize` creates the GitHub Release. |
| `changesets/action`, `changeset version\|status\|publish\|tag` in workflows or scripts | Changesets opens its own release PR and bumps versions. launchset's release PR replaces it. |
| semantic-release, release-it, standard-version, release-please | They bump versions and create tags or releases. |
| Steps and scripts that create tags or GitHub Releases (`git tag`, `gh release create`, `createRelease`) | `finalize` creates `v<version>`. A tag made earlier is wrong. |
| Docker pushes of `latest` on branch pushes | launchset moves `latest` only when a release ships. |
| Scripts that write `MARKETING_VERSION`, `CURRENT_PROJECT_VERSION`, `versionCode` or `versionName`, and fastlane version actions | They would overwrite the build numbers stamped in CI. |
| `@changesets/write` in scripts | launchset reads `.launchset/`. |
| Release instructions in `CLAUDE.md`, `AGENTS.md` and `README` (`npm version`, `git tag`, `changeset`) | They describe the old process. |

For each, choose:

| Action | What it does |
| --- | --- |
| `remove` | Deletes the workflow or script file. |
| `disable` | Removes only the conflicting trigger or step, or only the conflicting commands of a `run:` block or script. A script that does more than release keeps running: its conflicting lines are commented out, and one inside an `if`, a loop or an `&&` chain becomes the no-op `:`, so the script stays valid. In a `package.json` script it drops only the conflicting commands joined with `&&` or `;`, so `tsc; semantic-release` becomes `tsc`. Never deletes a file. Every other byte stays identical. |
| `keep` | Does nothing. |

The default with `--yes` is `disable`, and a list of the changes is printed. init never leaves a conflict in place silently. Where no minimal edit exists, the only choices are `keep` and `remove`, and the default is `keep` (marked `ask`). For example, a `package.json` script whose conflicting command is joined to the rest with `||`, a pipe or `&`, or shares an `sh -c '…'`, a `( … )` group, an `if`, a loop or a `case` with other work.

After `disable`, check what is left in the file. Example with a tag trigger and a Changesets step:

```diff
 on:
   push:
     branches: [main]
-    tags: ["v*"]
 jobs:
   release:
     steps:
       - uses: actions/checkout@v7
-      - uses: changesets/action@v1
-        with:
-          publish: npx changeset publish
```

A workflow with no trigger left gets `workflow_dispatch`. A removed step that other steps refer to (`steps.<id>...`, `needs.<job>...`) is listed as a manual follow-up. So is a place that still runs a removed `package.json` script by name (`npm run release` in a workflow, GitLab job or another script), because that call now fails.

init edits a step in the shell it runs in: the step's `shell:`, else `defaults.run.shell`, else the runner's default (pwsh on Windows, bash elsewhere). On GitLab, a job whose runner is tagged `windows` or whose script is PowerShell runs in PowerShell. A command inside a chain or a block becomes the no-op `:` in bash and `$null` in PowerShell. Where there's no safe no-op, init only takes out whole lines and otherwise leaves the step to you: in `cmd`, in a matrix of Windows and other runners, and next to a PowerShell line continuation (`` ` ``). A step in another language (`shell: python`, `node`) is read like a script file, and init doesn't edit it.

Then **move the team's own build steps** into `launchset-release.yml`: the `docker/build-push-action` settings (context, file, platforms), signing, fastlane, deploy steps. Keep secrets and environments as they are.

## Keep what deploy tooling depends on

- **The tag format.** If your tags are `1.4.0` without a `v`, answer `tags.release={version}`. Don't change what other tools read.
- **Image tags.** If deploys pull `app:v1.4.0`, keep the `v`: `docker.api.tags=v{version}, v{major}.{minor}, v{major}, latest`.
- **Deploy manifests that pin an image** (Kubernetes, Compose, Helm). Per file, `image.<path>=stamp` makes the release PR update the tag (a `kind: "image"` files entry, and init aligns the file to the release tag now: make sure that image exists). `image.<path>=leave` keeps it as deploy state that you promote by hand, for example a production overlay.

## Build numbers

`init` reads the highest existing `versionCode` or `CFBundleVersion`. When it is higher than what the `timestamp` strategy gives now, it sets `buildNumber.offset` so new numbers stay higher. See [Build numbers](/guides/build-numbers/).

## An existing changelog

`init` never converts or moves a `CHANGELOG.md`. It only creates one when it is missing. New sections go **before the first version heading** (a heading that starts with a version, such as `## 0.18.0` or `#### [v3.5.6](...) - 2023-01-02`). Everything above stays unchanged, and old sections are never rewritten, so a file with Changesets sections below launchset sections is fine.

## From Changesets

`init` converts the files in `.changeset/*.md` into `.launchset/`. The package lines in the frontmatter (`"pkg-name": minor`) become one `bump`: the highest bump found. Summaries are kept. A file with a bump but no summary gets a `TODO` summary to fill in.

`.changeset/config.json` and `README.md` are left alone, and the folder is not deleted. init tells you it can go. Converting twice is safe.

Then retire the Changesets pipeline (the `changesets/action` workflow, `changeset` scripts in `package.json`). `init` offers to disable them.

Does the repo also publish npm packages that each have their own version, next to the app? Then don't retire Changesets: keep it for those packages and let launchset release the rest. See [Alongside Changesets](/guides/with-changesets/).

### Pre mode

Changesets pre mode (`pre.json`, `pre enter`) keeps prerelease versions in the repo. launchset has no pre mode. Use a **prerelease branch**: see [Preview builds and prerelease branches](/guides/previews/).

1. On the branch that is in pre mode, convert its changesets: `npx @demonsters/launchset init --convert-only`. `pre.json` is ignored, with a warning.
2. Add the branch to the config:

```ts
preview: {
  branches: [{ branch: "next", prerelease: "beta" }],
},
```

Every push to the branch gets a `1.5.0-beta.N` version, a tag and a GitHub pre-release. Nothing is committed. When the branch merges into the base branch, the changesets produce a normal release.

## After init

- `npx @demonsters/launchset status`: the version, the pending changesets, consistency.
- `npx @demonsters/launchset version --dry-run`: the diff of the first release PR.
- `npx @demonsters/launchset plan`: the plan as JSON.
- Create the [GitHub App](/github-app/) and the secrets.
- Set up the [store pipelines](/store-pipelines/) for native targets and test them with a preview build.
- Open one PR with everything. In the description list the decisions, what was removed or changed, and the manual steps that remain.

## The adoption skill

`skills/launchset-adopt/SKILL.md` teaches an AI agent this whole procedure: run `init --detect --json`, ask the right questions, find the conflicting machinery, move build steps, run `init --yes --decide ...` and open one PR. It is meant to be installed **before** the repo has launchset, so `init` doesn't install it. Put it in your user-level skills folder.

The skill ships inside the npm package, next to the `launchset` skill. Copy it from the package (you need read access to the private `@demonsters` scope):

```sh
cd "$(mktemp -d)"
npm pack @demonsters/launchset
tar -xzf demonsters-launchset-*.tgz package/skills/launchset-adopt
mkdir -p ~/.claude/skills
cp -r package/skills/launchset-adopt ~/.claude/skills/
```

If the package is installed in a project, copy it from there instead:

```sh
mkdir -p ~/.claude/skills
cp -r node_modules/@demonsters/launchset/skills/launchset-adopt ~/.claude/skills/
```

With the launchset repo checked out, `cp -r skills/launchset-adopt ~/.claude/skills/` does the same. Without a checkout, the GitHub CLI works too (the repo is private):

```sh
mkdir -p ~/.claude/skills/launchset-adopt
gh api repos/demonsters/launchset/contents/skills/launchset-adopt/SKILL.md \
  -H "Accept: application/vnd.github.raw" > ~/.claude/skills/launchset-adopt/SKILL.md
```

Restart Claude Code and ask it: "Move this repo to launchset." The skill loads when you ask to set up or migrate a repo to launchset.

The other skill, `launchset` (installed into repos by `init` as `.claude/skills/launchset/SKILL.md`), is for agents that work in a repo **after** the move: it tells them to add a changeset to every PR. See [Writing changesets](/changesets/).

## Out of scope

Repos where every package is versioned and published independently (per-package npm releases), with nothing that shares one version, don't fit: launchset has one version per repo. A repo with an app **and** independently versioned npm packages does fit: launchset releases the app, Changesets keeps the packages. See [Alongside Changesets](/guides/with-changesets/). Build services outside GitHub Actions (Xcode Cloud, Codemagic) aren't covered either. Expo EAS is: see [Expo](/targets/expo/).
