# Changelog

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
