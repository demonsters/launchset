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
  "- `--cwd <dir>` sets the repo root. Without it, launchset uses the nearest parent folder that has a `launchset.config.*` file. `init` has no config yet, so it defaults to the git repository root (GitHub only runs workflows from there) and says so when that isn't the folder you ran it in.",
  "- GitHub-facing commands take a token from `--token`, then `LAUNCHSET_TOKEN`, then `GITHUB_TOKEN`, and the repository from `--repo`, then `GITHUB_REPOSITORY`, then the `origin` remote.",
  "- `--plan` takes the plan JSON itself, `@file.json`, or reads `LAUNCHSET_PLAN`.",
  "- Colors are only used in a terminal, and never when `NO_COLOR` is set. `LAUNCHSET_DEBUG=1` prints stack traces.",
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
