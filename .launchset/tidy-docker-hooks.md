---
bump: patch
---

`launchset init` reads existing Docker workflows correctly: the build context of a `docker build` run step with `${{ secrets.X }}` build args is no longer read as `}}`, image tags taken from the pushed git tag through a variable (`RELEASE_VERSION=${GITHUB_REF#refs/*/}` in `$GITHUB_ENV`) keep their `v`, docker targets get `verify: ["registry"]` (decision `docker.<name>.verify`), no pre-push hook is offered for a husky setup that isn't there or a hook file git ignores, and gitignored folders are no longer searched for targets.
