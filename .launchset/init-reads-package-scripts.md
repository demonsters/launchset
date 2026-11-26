---
bump: patch
---

`launchset init` reads `package.json` scripts and `sh -c '…'` scripts as shell commands, and edits each CI step in the shell it runs in:
  - `disable` no longer cuts a script apart at an `&&` inside quotes. Before, `sh -c 'git tag v1 && git push --tags'` became `sh -c 'git tag v1`, which was broken and still created the tag.
  - A command joined with `;` is its own command, so `tsc; semantic-release` becomes `tsc` instead of losing the build. Where a conflicting command is joined to the rest with `||`, a pipe or `&`, or shares an `sh -c`, a `( … )` group, an `if`, a loop or a `case` with other work, init offers only `keep` and `remove`. The commands that stay keep the operators between them.
  - When init removes a script that a workflow step, a GitLab job or another script still runs by name (`npm run release`), it lists that place as a manual follow-up, because the call now fails.
  - Release commands inside `bash -c "…"` and `sh -c '…'` count, in workflow steps, GitLab jobs and scripts. So do fastlane's version actions run from the command line (`fastlane run increment_build_number`), unless they write launchset's numbers.
  - Workflow steps are edited in the shell they run in (`shell:`, `defaults.run.shell`, or pwsh on Windows runners), and GitLab jobs on Windows or PowerShell runners too. In PowerShell the no-op is `$null`: before, init wrote `:`, which PowerShell doesn't have, so the edited step failed. In `cmd`, in a matrix of Windows and other runners, and next to a PowerShell line continuation, init only removes whole lines. Steps in another language (`shell: python`) are read like script files and not edited.
