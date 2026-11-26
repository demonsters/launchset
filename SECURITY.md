# Security policy

## Reporting a vulnerability

Please don't open a public issue for a security problem. Report it privately through GitHub instead: **[Report a vulnerability](https://github.com/demonsters/launchset/security/advisories/new)** (the repo's **Security** tab → **Report a vulnerability**). Only the maintainers see it.

Include what you found, how to reproduce it, and what an attacker could do with it. We'll acknowledge the report within three working days, keep you posted while we fix it, and credit you in the advisory unless you'd rather not be named.

## What's in scope

- The `launchset` CLI and library on npm.
- The GitHub Action [`demonsters/launchset-action`](https://github.com/demonsters/launchset-action), built from `action/` in this repo.
- The workflows and GitLab pipelines that `launchset init` writes into other repos (`templates/`).

launchset runs in CI with tokens that can push to a repo, so we especially want to hear about:

- tokens or secrets that can end up in logs, PR comments, job summaries or artifacts;
- input that reaches a shell, a workflow expression or a git command unescaped: config values, changeset text, branch names, PR titles, labels;
- generated workflows or pipelines that give a job more access than it needs, or run untrusted code from forks with secrets.

## Supported versions

Security fixes go into the latest release of the current major version (1.x). The action's `v1` tag moves to that release, so workflows that use `demonsters/launchset-action@v1` get the fix without changes. For the CLI, update to the latest `launchset` on npm.
