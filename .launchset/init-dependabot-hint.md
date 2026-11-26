---
bump: patch
---

`launchset init` on GitHub suggests, among the steps left to do by hand, adding a `.github/dependabot.yml` for the `github-actions` ecosystem when the repo has no Dependabot or Renovate configuration. This keeps the action majors in the generated workflows current, because launchset never rewrites those workflows. init doesn't write the file itself.
