# Changelog

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
