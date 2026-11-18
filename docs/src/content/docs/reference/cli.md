---
title: CLI reference
description: Every launchset command and flag, from the real --help output.
---

The binary is `launchset`. Run it with `npx @demonsters/launchset <command>`, or install the package and run `launchset <command>`. It needs Node 26 or newer.

The sections below are generated from the CLI itself: the text in each box is the output of `launchset <command> --help`.

| Command | Use it to |
| --- | --- |
| [`init`](#launchset-init) | Set up a repo. |
| [`add`](#launchset-add) | Create a changeset. |
| [`status`](#launchset-status) | See pending changes and the next version. |
| [`version`](#launchset-version) | Apply the pending changesets locally. |
| [`plan`](#launchset-plan) | Print the release plan. |
| [`stamp`](#launchset-stamp) | Write version and build number into a target's files. |
| [`verify`](#launchset-verify) | Ask a store, registry or npm whether the build exists. |
| [`mark`](#launchset-mark) | Record that a target shipped. |
| [`ship`](#launchset-ship) | Prepare a manual target for a hand-made build. |
| [`finalize`](#launchset-finalize) | Create the release tag and GitHub Release. |
| [`hotfix`](#launchset-hotfix) | Create a maintenance branch. |
| [`check`](#launchset-check) | Run the PR check. |

The action in your workflows runs `check`, `stamp`, `verify`, `mark`, `finalize` and `add` through the same code as these commands, so you can run them by hand too (the ones that touch GitHub need a token). Three action commands have **no CLI command**: `release` (opens the release PR and decides the mode), `preview-plan` (plans a preview and, on prerelease branches, reserves the tag) and `preview-comment` (the sticky preview comment and the GitHub pre-release). The CLI's `launchset plan` and `launchset plan --preview` are the dry runs of the first two: they print the plan and change nothing. See the [action reference](/reference/action/).

<!-- generated:cli-commands:start -->
### Help of the main command

```text
Usage: launchset [options] [command]

Changesets-style releases for lock-step monorepos: one version, many targets.

Options:
  -V, --version                   print the launchset version
  --cwd <dir>                     run in this directory (default: the nearest folder with a
                                  launchset config)
  --json                          print JSON on stdout (logs go to stderr)
  --yes                           never ask; accept defaults
  --token <token>                 GitHub token (default: $LAUNCHSET_TOKEN, then $GITHUB_TOKEN)
  --repo <owner/repo>             GitHub repository (default: from the origin remote)
  -h, --help                      display help for command

Commands:
  init [options]                  Set up a repo: detect versions and targets, write the config,
                                  workflows and README.
  add [options]                   Create a changeset: the bump (major, minor, patch) and a summary
                                  for the changelog.
  status [options]                Show pending changesets, the next version, the last release and
                                  anything unfinished.
  version [options]               Apply the pending changesets locally (what the release PR commit
                                  does).
  plan [options]                  Print the release plan (mode, matrix, version, build number) as
                                  JSON. Writes nothing.
  stamp [options]                 Write the version and build number into one target's files (never
                                  committed).
  verify [options]                Check the stores and registries: is this version and build number
                                  already published?
  mark [options]                  Create and push the marker tag for a target (for a manual target:
                                  --version).
  ship [options]                  Prepare a manual target for a hand-made build of a released
                                  version, then stamp it.
  finalize [options]              Create the release tag and GitHub Release once every target is
                                  built.
  hotfix [options] <major.minor>  Create a maintenance branch for a released <major>.<minor> line.
  check [options]                 Run the PR check: is there a valid changeset? (--push: the
                                  pre-push hook warning.)
  help [command]                  display help for command

Every command works without prompts when stdin is not a terminal. Add --json for machine-readable output.
Docs: https://demonsters.github.io/launchset/
```

Rules that hold for every command:

- Nothing asks a question when stdin is not a terminal, or when `--yes` or `--json` is given. A command that needs an answer then says which flag to pass.
- `--json` prints JSON on stdout and sends logs and warnings to stderr.
- The exit code is `0` on success, `1` when the command failed and `2` for wrong usage (an unknown command or flag).
- `--cwd <dir>` sets the repo root. Without it, launchset uses the nearest parent folder that has a `launchset.config.*` file. `init` has no config yet, so it defaults to the git repository root (GitHub only runs workflows from there) and says so when that isn't the folder you ran it in.
- GitHub-facing commands take a token from `--token`, then `LAUNCHSET_TOKEN`, then `GITHUB_TOKEN`, and the repository from `--repo`, then `GITHUB_REPOSITORY`, then the `origin` remote.
- `--plan` takes the plan JSON itself, `@file.json`, or reads `LAUNCHSET_PLAN`.
- Colors are only used in a terminal, and never when `NO_COLOR` is set. `LAUNCHSET_DEBUG=1` prints stack traces.

### launchset init

Sets up a repo: finds versions and native projects, writes `launchset.config.ts`, `.launchset/README.md`, the three workflows and a `CHANGELOG.md` if there is none, retires release machinery that conflicts with launchset, and converts `.changeset/*.md` files. It refuses to run when a launchset config already exists.

In a terminal it asks the open questions. With `--yes` it accepts every default. `--detect --json` writes nothing and prints what it found plus the list of decisions, so an agent can ask a human and then run `init --yes --decide <id>=<value>`. See [Migrating to launchset](/guides/migrating/) for the decision ids.

```text
Usage: launchset init [options]

Set up a repo: detect versions and targets, write the config, workflows and README.

Options:
  --cwd <dir>          set up this folder (default: the git repo root; GitHub only runs workflows
                       from the root)
  --yes                Accept the default for every decision that isn't given; never prompt.
  --decide <id=value>  Answer a decision: --decide <id>=<value> (repeatable). See --detect --json
                       for the ids.
  --detect             Only detect: print what was found and the decisions, write nothing.
  --json               Print JSON.
  --convert-only       Only convert .changeset/*.md files into .launchset/ (e.g. on a Changesets
                       pre-mode branch).
  --baseline           Create the release tag for the canonical version at HEAD, so it counts as
                       released.
  --no-baseline        do not: Create the release tag for the canonical version at HEAD, so it
                       counts as released.
  --skill              Install the launchset agent skill and the AGENTS.md section.
  --no-skill           do not: Install the launchset agent skill and the AGENTS.md section.
  --hook               Add `launchset check --push` to the existing pre-push hook (simple-git-hooks,
                       husky, lefthook).
  --no-hook            do not: Add `launchset check --push` to the existing pre-push hook
                       (simple-git-hooks, husky, lefthook).
  -h, --help           display help for command

Example:
  $ launchset init --detect --json   # what would init do? writes nothing
  $ launchset init --yes --decide version=1.4.0
```

### launchset add

Creates a changeset in `.launchset/` with a random three-word name and prints its path. In a terminal, `launchset add` asks for the bump and the summary. In scripts pass `--bump` and `--message`, or `--empty` for a change that needs no release.

```text
Usage: launchset add [options]

Create a changeset: the bump (major, minor, patch) and a summary for the changelog.

Options:
  --cwd <dir>           run in this directory (default: the nearest folder with a launchset config)
  --json                print JSON on stdout (logs go to stderr)
  --yes                 never ask; accept defaults
  --bump <type>         bump type (choices: "none", "patch", "minor", "major")
  -m, --message <text>  summary for the changelog
  --empty               a change that needs no release (bump: none)
  -h, --help            display help for command

Example:
  $ launchset add --bump minor --message "Add dark mode"
  $ launchset add --empty
  $ launchset add            # asks, in a terminal
```

### launchset status

Shows the pending changesets, the next version, the last release, unfinished releases, the last shipped version of every manual target and whether the version files agree. Warns when there are commits since the last release but no changeset at all. With `--require-changeset` it exits `1` unless a changeset was added or changed compared with `--since` (default `origin/<base branch>`).

```text
Usage: launchset status [options]

Show pending changesets, the next version, the last release and anything unfinished.

Options:
  --cwd <dir>          run in this directory (default: the nearest folder with a launchset config)
  --json               print JSON on stdout (logs go to stderr)
  --token <token>      GitHub token (default: $LAUNCHSET_TOKEN, then $GITHUB_TOKEN)
  --repo <owner/repo>  GitHub repository (default: from the origin remote)
  --require-changeset  exit 1 unless a changeset was added or changed compared with --since
  --since <ref>        base ref for --require-changeset (default: origin/<base branch>)
  --no-fetch           don't fetch tags first
  -h, --help           display help for command

Example:
  $ launchset status --json
  $ launchset status --require-changeset --since origin/main
```

### launchset version

Applies the pending changesets in your working tree: bumps the version, stamps the marketing version into every target's files, adds the changelog section and deletes the changesets. This is what the release PR commit does. Use `--dry-run` to see the diff first.

```text
Usage: launchset version [options]

Apply the pending changesets locally (what the release PR commit does).

Options:
  --cwd <dir>          run in this directory (default: the nearest folder with a launchset config)
  --json               print JSON on stdout (logs go to stderr)
  --token <token>      GitHub token (default: $LAUNCHSET_TOKEN, then $GITHUB_TOKEN)
  --repo <owner/repo>  GitHub repository (default: from the origin remote)
  --dry-run            print the diff, write nothing
  --no-fetch           don't fetch tags first
  -h, --help           display help for command

Example:
  $ launchset version --dry-run
```

### launchset plan

Prints the plan as JSON and writes nothing: the mode (`publish`, `ship`, `release-pr` or `none`), the matrix, the version and the build number. With `--preview` it plans a preview build instead. That is a dry run: on a prerelease branch it shows the version the next prerelease would get, but reserves no tag (only the action's `preview-plan` does), so the real run may pick a higher number. Outside CI a preview needs `--run-number`.

```text
Usage: launchset plan [options]

Print the release plan (mode, matrix, version, build number) as JSON. Writes nothing.

Options:
  --cwd <dir>          run in this directory (default: the nearest folder with a launchset config)
  --json               print JSON on stdout (logs go to stderr)
  --token <token>      GitHub token (default: $LAUNCHSET_TOKEN, then $GITHUB_TOKEN)
  --repo <owner/repo>  GitHub repository (default: from the origin remote)
  --preview            plan a preview build instead (a dry run: prerelease tags are not reserved)
  --target <names>     a manual target to ship; with --preview: targets to build (comma separated,
                       or all)
  --version <version>  with --target: the released version to ship
  --force              with --target: allow a version lower than the target's highest marker
  --branch <name>      plan for this branch (default: the current branch)
  --run-number <n>     with --preview: the workflow run number (default: $GITHUB_RUN_NUMBER)
  --no-fetch           don't fetch tags first
  -h, --help           display help for command

Example:
  $ launchset plan > plan.json
  $ launchset plan --preview
```

### launchset stamp

Writes the version and build number into one target's files in the current checkout. Nothing is committed. In CI the action runs this for you. By hand, give it a plan or `--version`.

```text
Usage: launchset stamp [options]

Write the version and build number into one target's files (never committed).

Options:
  --cwd <dir>          run in this directory (default: the nearest folder with a launchset config)
  --json               print JSON on stdout (logs go to stderr)
  --target <name>      target name from the config
  --plan <json|@file>  the plan (default: $LAUNCHSET_PLAN)
  --version <version>  without a plan: the version to write
  --build-number <n>   without a plan: the build number
  --channel <channel>  without a plan: release, prerelease or preview (choices: "release",
                       "prerelease", "preview")
  -h, --help           display help for command

Example:
  $ launchset stamp --target android --version 1.5.0 --build-number 217000000
  $ launchset stamp --target web --plan @plan.json
```

### launchset verify

Asks the store, registry or npm whether this version and build number is already published (see `verify` on the target). It prints `already-published` and fails when the store already has a higher build number.

```text
Usage: launchset verify [options]

Check the stores and registries: is this version and build number already published?

Options:
  --cwd <dir>          run in this directory (default: the nearest folder with a launchset config)
  --json               print JSON on stdout (logs go to stderr)
  --target <name>      target name from the config
  --plan <json|@file>  the plan (default: $LAUNCHSET_PLAN)
  -h, --help           display help for command

Example:
  $ launchset verify --target docker-api --plan @plan.json
```

### launchset mark

Creates and pushes the marker tag `launchset/<target>@<version>` that records one target shipped. For a manual target you shipped by hand, pass `--version` (and `--build-number`). It needs a token that can push.

```text
Usage: launchset mark [options]

Create and push the marker tag for a target (for a manual target: --version).

Options:
  --cwd <dir>          run in this directory (default: the nearest folder with a launchset config)
  --json               print JSON on stdout (logs go to stderr)
  --token <token>      GitHub token (default: $LAUNCHSET_TOKEN, then $GITHUB_TOKEN)
  --repo <owner/repo>  GitHub repository (default: from the origin remote)
  --target <name>      target name from the config
  --plan <json|@file>  the plan (default: $LAUNCHSET_PLAN)
  --version <version>  a released version shipped by hand (manual targets)
  --build-number <n>   with --version: the build number that shipped
  -h, --help           display help for command

Example:
  $ launchset mark --target ios --version 1.5.0 --build-number 217000000
```

### launchset ship

Prepares a manual target for a build you make yourself: checks that HEAD is at the release tag of the version, computes a build number and stamps the target's files. After the upload, run `launchset mark`.

```text
Usage: launchset ship [options]

Prepare a manual target for a hand-made build of a released version, then stamp it.

Options:
  --cwd <dir>          run in this directory (default: the nearest folder with a launchset config)
  --json               print JSON on stdout (logs go to stderr)
  --token <token>      GitHub token (default: $LAUNCHSET_TOKEN, then $GITHUB_TOKEN)
  --repo <owner/repo>  GitHub repository (default: from the origin remote)
  --target <name>      a manual target from the config
  --version <version>  the released version (default: the latest release)
  --force              allow a version lower than the target's highest marker
  --no-fetch           don't fetch tags first
  -h, --help           display help for command

Example:
  $ launchset ship --target ios --json
```

### launchset finalize

Creates the release tag and the GitHub Release once every auto target has a marker. Also marks superseded releases as partial and opens the changelog backport PR after a maintenance release. It fails and lists the missing targets when the release is incomplete.

```text
Usage: launchset finalize [options]

Create the release tag and GitHub Release once every target is built.

Options:
  --cwd <dir>          run in this directory (default: the nearest folder with a launchset config)
  --json               print JSON on stdout (logs go to stderr)
  --token <token>      GitHub token (default: $LAUNCHSET_TOKEN, then $GITHUB_TOKEN)
  --repo <owner/repo>  GitHub repository (default: from the origin remote)
  --plan <json|@file>  the plan (default: $LAUNCHSET_PLAN)
  --no-fetch           don't fetch tags first
  -h, --help           display help for command

Example:
  $ launchset finalize --plan @plan.json --token $GITHUB_TOKEN
```

### launchset hotfix

Creates the maintenance branch `release/<major>.<minor>.x` at the latest release tag of that line and pushes it. It fails when the branch exists or the line has no release.

```text
Usage: launchset hotfix [options] <major.minor>

Create a maintenance branch for a released <major>.<minor> line.

Arguments:
  major.minor          the version line, e.g. 1.4

Options:
  --cwd <dir>          run in this directory (default: the nearest folder with a launchset config)
  --json               print JSON on stdout (logs go to stderr)
  --token <token>      GitHub token (default: $LAUNCHSET_TOKEN, then $GITHUB_TOKEN)
  --repo <owner/repo>  GitHub repository (default: from the origin remote)
  --no-fetch           don't fetch tags first
  -h, --help           display help for command

Example:
  $ launchset hotfix 1.4
```

### launchset check

Runs the PR check: a valid changeset, no invalid changesets, no version mismatch and, on a maintenance branch, only `patch` or `none`. In a workflow it also posts the sticky PR comment. `--push` is for a pre-push hook: it only warns, and never fails.

```text
Usage: launchset check [options]

Run the PR check: is there a valid changeset? (--push: the pre-push hook warning.)

Options:
  --cwd <dir>          run in this directory (default: the nearest folder with a launchset config)
  --json               print JSON on stdout (logs go to stderr)
  --token <token>      GitHub token (default: $LAUNCHSET_TOKEN, then $GITHUB_TOKEN)
  --repo <owner/repo>  GitHub repository (default: from the origin remote)
  --base <ref>         compare against this ref (default: the PR's base commit)
  --push               pre-push hook mode: warn when a changeset is missing, never fail
  --no-comment         don't post the sticky PR comment
  --no-fetch           don't fetch tags first (--push never fetches)
  -h, --help           display help for command

Example:
  $ launchset check --base origin/main
  $ launchset check --push
```
<!-- generated:cli-commands:end -->
