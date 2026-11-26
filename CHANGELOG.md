# Changelog

## 1.1.7 (2026-11-26)

### Patch changes
- The generated workflows pass the GitHub App to `actions/create-github-app-token@v3` as `client-id: ${{ vars.LAUNCHSET_APP_CLIENT_ID || secrets.LAUNCHSET_APP_ID }}`, because v3 deprecates `app-id`. New setups store the App's Client ID as the organization variable `LAUNCHSET_APP_CLIENT_ID`. It isn't secret, so a variable is enough. Existing setups keep working without changes: when the variable is missing, the workflows use the secret `LAUNCHSET_APP_ID`, and GitHub accepts the App ID there too. To migrate, add the variable `LAUNCHSET_APP_CLIENT_ID` (App settings → General → Client ID). In workflows written by an earlier `init`, change `actions/create-github-app-token@v2` to `@v3` and `app-id: ${{ secrets.LAUNCHSET_APP_ID }}` to the `client-id` line above. Once every repo uses it, you can delete the secret `LAUNCHSET_APP_ID`. See GitHub App setup in the docs. ([#22](https://github.com/demonsters/launchset/pull/22), @rene-demonsters)
- `launchset init` on GitHub suggests, among the steps left to do by hand, adding a `.github/dependabot.yml` for the `github-actions` ecosystem when the repo has no Dependabot or Renovate configuration. This keeps the action majors in the generated workflows current, because launchset never rewrites those workflows. init doesn't write the file itself. ([#22](https://github.com/demonsters/launchset/pull/22), @rene-demonsters)
- The agent skills tell agents to look up the latest release of each GitHub Action rather than trust what they remember, and to check compatibility before bumping a major. That means reading the release notes of every major in between, checking that the step's inputs and outputs still exist in the new `action.yml`, and checking runner requirements and behaviour changes. When a new major needs a secret or runner the repo may not have, they keep the working major and say why. `launchset-adopt` updates launchset's own generated steps when they are compatible. For the team's steps it moves over, and for the team's other workflows, it lists the outdated actions with a recommendation and asks before updating them, in a separate commit. The `launchset` skill does the same check when an agent adds or changes a `uses:` step, or reviews a Dependabot PR for one. It asks before updating outdated pins it comes across. ([#22](https://github.com/demonsters/launchset/pull/22), @rene-demonsters)
- The workflows `launchset init` writes use the current major of every action: `actions/checkout@v7`, `actions/setup-node@v7`, `actions/setup-java@v6`, `actions/create-github-app-token@v3`, `docker/login-action@v4`, `docker/setup-buildx-action@v4` and `docker/build-push-action@v7`, commented-out examples included. The older majors ran on Node 20, which GitHub now forces onto Node 24 with a warning. The inputs the workflows pass didn't change meaning, apart from `app-id` (see the GitHub App entry). Workflows written by an earlier `init` keep their pins: launchset never rewrites them. To update them, change the majors by hand, or let Dependabot do it (see "Keep the actions current" in Getting started). ([#22](https://github.com/demonsters/launchset/pull/22), @rene-demonsters)
- The `timestamp` build-number strategy takes a `unit`: `buildNumber: { strategy: "timestamp", unit: "minute" }` counts whole minutes since `epoch` instead of seconds, so numbers stay under Android's 2,100,000,000 limit until about the year 6000 instead of 2086. The default stays `"second"`, so existing configs give the same numbers. It works repo-wide and per target, and is a config error with any other strategy. Two builds in the same minute get the same number, and switching an app that already has uploads from seconds to minutes needs an `offset` above its highest build number (see Build numbers in the docs). ([#20](https://github.com/demonsters/launchset/pull/20), @rene-demonsters)

## 1.1.6 (2026-11-26)

### Patch changes
- `launchset init` now reads the commands a workflow step, `package.json` script or script file actually runs. A command in a comment, a quoted argument or a heredoc no longer counts as release machinery. A script that does more than release keeps running, with only its conflicting lines commented out. Jobs that only release tags start become custom targets on GitHub and GitLab, `workflow_run` chains after them included, and GitLab `=~` tag rules are tested against the tags launchset pushes. When retired Changesets, semantic-release or release-it published a public root package, init proposes an `npm` target. ([#17](https://github.com/demonsters/launchset/pull/17), @rene-demonsters)
- The `semver` build-number strategy now works on targets that previews never build, also while previews are enabled. A target is rejected only when it is in `preview.targets` (`"all"`, the default, is every target) or in the `targets` of a `preview.branches` entry, and the error names the target and says to take it out of those lists or set `preview: false`. So hand-shipped iOS and Android apps can use `buildNumber: { strategy: "semver" }` while previews build only, say, a Docker image. `semver` as the repo-wide `buildNumber.strategy` still needs `preview: false`, and a manual preview run can't name a `semver` target (its `all` leaves them out). ([#19](https://github.com/demonsters/launchset/pull/19), @rene-demonsters)
- `launchset ship --attempt <n>` sets the last two digits of a `semver` build number (1 to 99), so a second upload of the same version gets a number the store doesn't have yet. Before, a hand-made build always got attempt 1. Shipping from CI takes the same value: the release workflow's new `attempt` input, or `LAUNCHSET_ATTEMPT` on GitLab. It is an error for a target with another strategy, and without a target. A `launchset-release.yml` generated by an earlier version has no `attempt` input: add it next to `force` as a `string` input (see Build numbers in the docs). ([#19](https://github.com/demonsters/launchset/pull/19), @rene-demonsters)

## 1.1.5 (2026-11-26)

### Patch changes
- The CLI now runs on Node 24 or newer (it needed Node 26). ([#15](https://github.com/demonsters/launchset/pull/15), @rene-demonsters)

## 1.1.4 (2026-11-26)

### Patch changes
- `launchset init` turns a job in a GitHub workflow that release tags start, and that uploads an artifact, publishes or deploys (an Electron desktop build, for example), into a custom target, with its steps copied, commented out, into `launchset-release.yml`. Before, init removed that workflow's tag trigger and nothing built the job for releases anymore. ([#13](https://github.com/demonsters/launchset/pull/13), @rene-demonsters)
- `launchset init` no longer takes a command that a workflow step only prints, such as `echo "create it with 'git tag -a'"`, for release machinery, and no longer offers to remove that step. ([#13](https://github.com/demonsters/launchset/pull/13), @rene-demonsters)

## 1.1.3 (2026-11-24)

### Patch changes
- The `launchset` agent skill, the `AGENTS.md` section and `.launchset/README.md` now say to keep each changelog bullet to one change: a changeset for each change in a PR (each with its own bump), or, for related changes with one bump, a lead line with a sub-bullet per change. Before, agents could put a feature and several fixes in one bullet. Run `launchset init` again to update the skill and the `AGENTS.md` section in a repo; `.launchset/README.md` is only written when missing. ([#11](https://github.com/demonsters/launchset/pull/11), @rene-demonsters)

## 1.1.2 (2026-11-24)

### Patch changes
- launchset's PR comments (the changeset check and the preview comment) start with a 🚀, so they stand out in a PR, the way Changesets puts a 🦋 in front of its comment. ([#9](https://github.com/demonsters/launchset/pull/9), @rene-demonsters)

## 1.1.1 (2026-11-24)

### Patch changes
- GitLab: a preview started from the manual `launchset-preview-plan` job now gets its MR note. The comment job `launchset-preview-comment` moved into the preview's child pipeline, as its last job (`when: always`), so it runs once the builds are done, and only when a preview was planned. Before, it sat in the parent pipeline and needed the manual plan job, so GitLab ran it straight away in every MR pipeline without the preview label ("nothing to report") and never again after someone played the plan job. ([#6](https://github.com/demonsters/launchset/pull/6), @rene-demonsters)

  `init` doesn't rewrite an existing `.gitlab/launchset.yml`. To get the fix in a project set up with 1.1.0 or earlier:

  1. Raise `LAUNCHSET_CLI` in `.launchset-cli` (in `.gitlab/launchset.yml`) to this version.
  2. Delete the job `launchset-preview-comment` from `.gitlab/launchset.yml`. With this version it no longer posts anything (the child pipeline's job does) and says so in its log, but until you delete it, it still costs a job in every MR pipeline.
- `regex` file stamps now work on files with Windows (CRLF) line endings, such as a Windows runner's checkout with `core.autocrlf=true`. A `\n` in `pattern` matches LF and CRLF line endings alike, the stamped file keeps its line endings, and `$1`-style references copy the file's text byte for byte. Patterns that already use `\r?\n` or `\r\n` work as before. When a pattern matches nothing in a file with `\r` characters, the error now says what line endings the file has. ([#7](https://github.com/demonsters/launchset/pull/7), @rene-demonsters)

## 1.1.0 (2026-11-23)

### Minor changes
- GitLab support: run launchset in GitLab CI (gitlab.com and self-managed, 18.2+). `launchset init` sets up GitLab repos with `.gitlab/launchset.yml` and a `.gitlab/launchset-targets.yml` for your build steps. Releases build in a generated child pipeline. New CLI commands `release`, `preview-plan` and `preview-comment`, and a `--ci` mode that writes `plan.json`, `launchset.env` and `launchset.sh`. An optional preview sweep (`launchset preview-sweep`, run by a pipeline schedule) starts an MR pipeline when the preview label is added, since GitLab starts none for a label. `changelog.github` is renamed to `changelog.links` (the old name still works). ([#3](https://github.com/demonsters/launchset/pull/3), @rene-demonsters)
- GitLab: build jobs on Windows runners with PowerShell (`gitlab: { shell: "powershell" }` on a target; `--ci` also writes `launchset.ps1`), targets that build after other targets with their artifacts (`after`, GitLab only), and templates for the target jobs from extra files the child pipeline includes (`gitlab.include`). Preview jobs keep `interruptible: false` from your job. launchset's tag pushes no longer start tag pipelines (`git push -o ci.skip`; `gitlab.tagPipelines: true` lets release and prerelease tags start one). `launchset init` turns GitLab jobs that build on tags into custom targets with their steps copied, moves the templates they extend to `.gitlab/ci-templates.yml`, removes only the tag rule of a job that other rules still start, notes `workflow: rules` that allow tag pipelines, and takes `--decide target.<name>=custom` to declare a target it didn't detect. A build script that only reads `CFBundleShortVersionString` is no longer flagged as a version writer. ([#3](https://github.com/demonsters/launchset/pull/3), @rene-demonsters)

## 1.0.3 (2026-11-19)

### Patch changes
- `mark` works in repos that use Git LFS. It failed with "You must have push access to verify locks", because git-lfs's pre-push hook sent the build job's read-only `GITHUB_TOKEN` instead of the App token. Tag pushes now skip the LFS hook (a tag carries no new LFS objects), and branch pushes give git-lfs the App token. ([#12](https://github.com/demonsters/launchset/pull/12), @rene-demonsters)
- launchset runs its git commands without the repo's git hooks. A job that installed husky, simple-git-hooks, lefthook or git-lfs hooks before `mark` could fail after the upload, because a pre-push hook ran tests, lint or `launchset check --push` on launchset's own push. ([#14](https://github.com/demonsters/launchset/pull/14), @rene-demonsters)

## 1.0.2 (2026-11-19)

### Patch changes
- Document running launchset alongside Changesets in repos that also publish independently versioned npm packages: launchset releases the app, Changesets keeps the packages. The adoption skill now proposes this setup instead of stopping, and the `launchset` skill and `AGENTS.md` section explain that a PR changing such a package needs both a `.changeset/` file and a `.launchset/` changeset. ([#11](https://github.com/demonsters/launchset/pull/11), @rene-demonsters)
- `launchset init` reads existing Docker workflows correctly: the build context of a `docker build` run step with `${{ secrets.X }}` build args is no longer read as `}}`, image tags taken from the pushed git tag through a variable (`RELEASE_VERSION=${GITHUB_REF#refs/*/}` in `$GITHUB_ENV`) keep their `v`, docker targets get `verify: ["registry"]` (decision `docker.<name>.verify`), no pre-push hook is offered for a husky setup that isn't there or a hook file git ignores, and gitignored folders are no longer searched for targets. ([#9](https://github.com/demonsters/launchset/pull/9), @rene-demonsters)

## 1.0.1 (2026-11-18)

### Patch changes
- `verify` no longer tries to read private npm packages with an npm trusted-publishing token. npm only accepts those tokens for publishing, so the check failed with HTTP 400 "OIDC publish authorize: Invalid token". A private package needs a read token in `LAUNCHSET_NPM_TOKEN` or `NODE_AUTH_TOKEN`; the docs explain how to publish with trusted publishing and no npm secret. ([#7](https://github.com/demonsters/launchset/pull/7), @rene-demonsters)

## 1.0.0 (2026-11-18)

### Major changes
- First release of launchset: Changesets-style releases for lock-step monorepos. One version drives every target (Docker, Android, iOS, web, custom): changesets are collected into a release PR, merging it stamps the versions, builds and ships every target, and records the results as git tags. ([#3](https://github.com/demonsters/launchset/pull/3), @rene-demonsters)

  Includes the `launchset` CLI (`init`, `add`, `status`, `version`, `plan`, `stamp`, `verify`, `mark`, `ship`, `finalize`, `hotfix`, `check`), the GitHub Action (`demonsters/launchset-action`), workflow templates, previews and prerelease branches.
