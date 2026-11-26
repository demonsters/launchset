# Security policy

## Reporting a vulnerability

Please don't open a public issue for a security problem. Report it privately through GitHub instead: **[Report a vulnerability](https://github.com/demonsters/launchset/security/advisories/new)** (the repo's **Security** tab → **Report a vulnerability**). Only the maintainers see it.

Include what you found, how to reproduce it, and what an attacker could do with it.

launchset is shared as is: we built it for our own releases and maintain it as we use it. There's no support agreement and no promised response time.

## What's in scope

- The `launchset` CLI and library on npm.
- The GitHub Action [`demonsters/launchset-action`](https://github.com/demonsters/launchset-action), built from `action/` in this repo.
- The workflows and GitLab pipelines that `launchset init` writes into other repos (`templates/`).

launchset runs in CI with tokens that can push to a repo, so we especially want to hear about:

- tokens or secrets that can end up in logs, PR comments, job summaries or artifacts;
- input that reaches a shell, a workflow expression or a git command unescaped: config values, changeset text, branch names, PR titles, labels;
- generated workflows or pipelines that give a job more access than it needs, or run untrusted code from forks with secrets.

## Versions

Fixes, security ones included, only go into new releases; older versions aren't patched. The action's `v1` tag moves to each new 1.x release, so workflows that use `demonsters/launchset-action@v1` pick up a fix without changes. For the CLI, update to the latest `launchset` on npm.
