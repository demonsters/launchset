/**
 * Hand-written text for each command of the CLI reference. The generator adds the real
 * `--help` output below it, and fails when a command has no entry here (or an entry has no
 * command), so a new command can't go undocumented.
 */

export const COMMON_FLAGS_NOTE = [
  "Rules that hold for every command:",
  "",
  "- Nothing asks a question when stdin is not a terminal, or when `--yes` or `--json` is given. A command that needs an answer then says which flag to pass.",
  "- `--json` prints JSON on stdout and sends logs and warnings to stderr.",
  "- The exit code is `0` on success, `1` when the command failed and `2` for wrong usage (an unknown command or flag).",
  "- `--cwd <dir>` sets the repo root. Without it, launchset uses the nearest parent folder that has a `launchset.config.*` file. `init` has no config yet, so it defaults to the git repository root (CI configuration only runs from there: GitHub workflows, `.gitlab-ci.yml`) and says so when that isn't the folder you ran it in.",
  "- GitHub-facing commands take a token from `--token`, then `LAUNCHSET_TOKEN`, then `GITHUB_TOKEN`, and the repository from `--repo`, then `GITHUB_REPOSITORY`, then the `origin` remote.",
  "- `--plan` takes the plan JSON itself, `@file.json`, or reads `LAUNCHSET_PLAN`.",
  "- `--ci` (default: on when `GITLAB_CI=true`; `--no-ci` turns it off) is accepted by every command that produces outputs: `release`, `plan`, `preview-plan`, `preview-comment`, `preview-sweep`, `stamp`, `verify`, `mark`, `finalize`, `check`, `ship` and `status`. See CI output files below.",
  "- Colors are only used in a terminal, and never when `NO_COLOR` is set. `LAUNCHSET_DEBUG=1` prints stack traces.",
].join("\n");

/** Describes the `--ci` files; shown after the common rules. */
export const CI_OUTPUT_NOTE = [
  "### CI output files (`--ci`)",
  "",
  "A CI runner without the GitHub Action gets a command's results as files, written to the working directory after the command ran (also when it failed, not when it crashed):",
  "",
  "- `plan.json` (`LAUNCHSET_PLAN_FILE`): the plan JSON, written when the command produced a plan. Pass it on with `--plan @plan.json`.",
  "- `launchset.env` (`LAUNCHSET_DOTENV`): GitLab `artifacts:reports:dotenv` format, one `NAME=value` per line. Values with a line break are left out. GitLab accepts at most 5 KB and (by default) 20 variables in a dotenv report; `release`, whose file the GitLab templates upload as one, warns when it is over that.",
  "- `launchset.sh` (`LAUNCHSET_SHELL_ENV`): the same variables as `export NAME='value'` lines, including multi-line values. Run `launchset stamp --target web --plan @plan.json --ci`, then `. ./launchset.sh` as the next script line, and later lines see `$LAUNCHSET_VERSION`. Keep them two lines, not `a && b`: CI shells run with `set -e`, which ignores a failure on the left of `&&`.",
  "",
  "Every output except `plan` becomes `LAUNCHSET_` plus its name in upper snake case: `already-published` is `LAUNCHSET_ALREADY_PUBLISHED`, `build-number` is `LAUNCHSET_BUILD_NUMBER`, `release-sha` is `LAUNCHSET_RELEASE_SHA`. The exported variables of `stamp` and `ship` (`LAUNCHSET_VERSION`, `LAUNCHSET_BUILD_NUMBER`, `LAUNCHSET_CHANNEL`) are added as they are and win on a clash.",
  "",
  "Commands that run in one job (`stamp`, then `verify`, then `mark`) merge into the same files: variables a command sets are replaced, the others stay. With `--ci` the job summary is printed after the result lines (on stderr with `--json`), and these files (also a `plan.json` from a parent job's artifacts) don't count as uncommitted changes for the commands that need a clean working tree.",
].join("\n");

export const CLI_INTROS: Record<string, string> = {
  init: [
    "Sets up a repo: finds versions and native projects, writes `launchset.config.ts`, `.launchset/README.md`, the three workflows and a `CHANGELOG.md` if there is none, retires release machinery that conflicts with launchset, and converts `.changeset/*.md` files. It refuses to run when a launchset config already exists.",
    "",
    "In a terminal it asks the open questions. With `--yes` it accepts every default. `--detect --json` writes nothing and prints what it found plus the list of decisions, so an agent can ask a human and then run `init --yes --decide <id>=<value>`. See [Migrating to launchset](/guides/migrating/) for the decision ids.",
  ].join("\n"),
  add: "Creates a changeset in `.launchset/` with a random three-word name and prints its path. In a terminal, `launchset add` asks for the bump and the summary. In scripts pass `--bump` and `--message`, or `--empty` for a change that needs no release.",
  status:
    "Shows the pending changesets, the next version, the last release, unfinished releases, the last shipped version of every manual target and whether the version files agree. Warns when there are commits since the last release but no changeset at all. With `--require-changeset` it exits `1` unless a changeset was added or changed compared with `--since` (default `origin/<base branch>`).",
  version:
    "Applies the pending changesets in your working tree: bumps the version, stamps the marketing version into every target's files, adds the changelog section and deletes the changesets. This is what the release PR commit does. Use `--dry-run` to see the diff first.",
  plan: "Prints the plan as JSON and writes nothing: the mode (`publish`, `ship`, `release-pr` or `none`), the matrix, the version and the build number. With `--preview` it plans a preview build instead. That is a dry run: on a prerelease branch it shows the version the next prerelease would get, but reserves no tag (only the action's `preview-plan` does), so the real run may pick a higher number. Outside CI a preview needs `--run-number`.",
  release:
    "Decides the release mode from the pending changesets and the tags, then acts on it: opens or updates the release PR/MR, or closes it when nothing is pending. The `plan` command is the dry run. For a manual target, `--target` and `--version` plan a hand-made build. This is what the action's `release` command does.",
  "preview-plan":
    "Plans a preview build and, on a prerelease branch, reserves the prerelease tag by pushing it. `plan --preview` is the dry run. `--target` lists the targets of a manual run (comma separated, or `all`). The plan is skipped (with a reason) when there is nothing to preview.",
  "preview-comment":
    "Posts the preview results: the sticky PR comment, or the prerelease notes on a prerelease branch. Pass the plan from `preview-plan`. An empty or missing plan means the preview was skipped, and nothing is posted.",
  "preview-sweep":
    "GitLab only. Starts a merge request pipeline for each open MR that got the preview label since its last MR pipeline for the head commit, so its preview builds without a push (GitLab starts no pipeline when a label is added). Runs in a pipeline schedule with `LAUNCHSET_PREVIEW_SWEEP=true`; see [Previews on GitLab](/gitlab/previews/#start-previews-when-the-label-is-added-preview-sweep). Starts at most `--max` pipelines (default 10), oldest label first, skips fork MRs and the release MR, and reports every MR. `--dry-run` only reports. Exits `1` when a pipeline couldn't be started (the others are still started). Needs `LAUNCHSET_TOKEN`, and refuses when `preview.rebuildOnPush` is false.",
  stamp:
    "Writes the version and build number into one target's files in the current checkout. Nothing is committed. In CI the action runs this for you. By hand, give it a plan or `--version`.",
  verify:
    "Asks the store, registry or npm whether this version and build number is already published (see `verify` on the target). It prints `already-published` and fails when the store already has a higher build number.",
  mark: "Creates and pushes the marker tag `launchset/<target>@<version>` that records one target shipped. For a manual target you shipped by hand, pass `--version` (and `--build-number`). It needs a token that can push.",
  ship: "Prepares a manual target for a build you make yourself: checks that HEAD is at the release tag of the version, computes a build number and stamps the target's files. After the upload, run `launchset mark`.",
  finalize:
    "Creates the release tag and the GitHub Release once every auto target has a marker. Also marks superseded releases as partial and opens the changelog backport PR after a maintenance release. It fails and lists the missing targets when the release is incomplete.",
  hotfix:
    "Creates the maintenance branch `release/<major>.<minor>.x` at the latest release tag of that line and pushes it. It fails when the branch exists or the line has no release.",
  check:
    "Runs the PR check: a valid changeset, no invalid changesets, no version mismatch and, on a maintenance branch, only `patch` or `none`. In a workflow it also posts the sticky PR comment. `--push` is for a pre-push hook: it only warns, and never fails.",
};
