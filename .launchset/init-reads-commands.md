---
bump: patch
---

`launchset init` now reads the commands a workflow step, `package.json` script or script file actually runs. A command in a comment, a quoted argument or a heredoc no longer counts as release machinery. A script that does more than release keeps running, with only its conflicting lines commented out. Jobs that only release tags start become custom targets on GitHub and GitLab, `workflow_run` chains after them included, and GitLab `=~` tag rules are tested against the tags launchset pushes. When retired Changesets, semantic-release or release-it published a public root package, init proposes an `npm` target.
