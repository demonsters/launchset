---
bump: patch
---

`launchset init` reads `package.json` scripts as shell commands, and reads the commands an `sh -c '…'` runs:
  - `disable` no longer cuts a script apart at an `&&` inside quotes. Before, `sh -c 'git tag v1 && git push --tags'` became `sh -c 'git tag v1`, which was broken and still created the tag.
  - A command joined with `;` is its own command, so `tsc; semantic-release` becomes `tsc` instead of losing the build. Where a conflicting command is joined to the rest with `||`, a pipe or `&`, or shares an `sh -c` or a `( … )` group with other work, init offers only `keep` and `remove`.
  - When init removes a script that a workflow step, a GitLab job or another script still runs by name (`npm run release`), it lists that place as a manual follow-up, because the call now fails.
  - Release commands inside `bash -c "…"` and `sh -c '…'` count, in workflow steps, GitLab jobs and scripts. So do fastlane's version actions run from the command line (`fastlane run increment_build_number`), unless they write launchset's numbers.
