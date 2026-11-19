---
bump: minor
---

GitLab support: run launchset in GitLab CI (gitlab.com and self-managed, 18.2+). `launchset init` sets up GitLab repos with `.gitlab/launchset.yml` and a `.gitlab/launchset-targets.yml` for your build steps. Releases build in a generated child pipeline. New CLI commands `release`, `preview-plan` and `preview-comment`, and a `--ci` mode that writes `plan.json`, `launchset.env` and `launchset.sh`. `changelog.github` is renamed to `changelog.links` (the old name still works).
