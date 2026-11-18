# Changelog

## 1.0.0 (2026-11-18)

### Major changes
- First release of launchset: Changesets-style releases for lock-step monorepos. One version drives every target (Docker, Android, iOS, web, custom): changesets are collected into a release PR, merging it stamps the versions, builds and ships every target, and records the results as git tags. ([#3](https://github.com/demonsters/launchset/pull/3), @rene-demonsters)

  Includes the `launchset` CLI (`init`, `add`, `status`, `version`, `plan`, `stamp`, `verify`, `mark`, `ship`, `finalize`, `hotfix`, `check`), the GitHub Action (`demonsters/launchset-action`), workflow templates, previews and prerelease branches.
