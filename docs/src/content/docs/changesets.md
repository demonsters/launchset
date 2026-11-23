---
title: Writing changesets
description: What a changeset looks like, how to pick the bump and how to write the summary.
---

Every pull request needs a changeset. It is a markdown file in the `.launchset/` folder.

## Create one

```sh
npx @demonsters/launchset add
```

In a terminal this asks for the bump and a summary. To skip the questions:

```sh
npx @demonsters/launchset add --bump minor --message "Add offline mode to the mobile app."
```

The command prints the path of the new file, for example `.launchset/sweet-boxes-draw.md`. Commit it with your PR.

You can also write the file by hand. Name it with any three words and `.md`. Any `.md` file in `.launchset/` other than `README.md` is a changeset.

```md title=".launchset/brave-lions-sing.md"
---
bump: minor
---

Add offline mode to the mobile app.
```

## Pick the bump

| Bump | Use it for |
| --- | --- |
| `major` | Breaking changes for users or API clients. |
| `minor` | New features. |
| `patch` | Bug fixes. |
| `none` | A change that needs no release: docs, CI, tests, refactors. |

`none` still satisfies the PR check. It never starts a release on its own, it doesn't appear in the changelog, and it is deleted by the next release. To create one: `npx @demonsters/launchset add --empty`. It needs no summary.

With several changesets pending, the release gets the highest bump. If only `none` changesets are pending, there is no release.

## Write the summary

The text under the frontmatter becomes the changelog entry. Write it for the people who use the product.

- Say what changed for the user, not how you did it.
- One line is best. Keep tense consistent with the other entries.
- Don't add a PR number or your name. launchset adds the PR link and author (`changelog.links` is on by default and needs a token).
- Markdown works. With several lines, the first line is the bullet and the rest is indented under it.

Good:

```md
---
bump: patch
---

Fix the crash when opening the login screen without a network connection.
```

Less good: `fix bug in LoginScreen.tsx (#123)`.

The summary can only be empty when the bump is `none`.

## One changeset per change

Write one changeset per change, not per commit. If your PR does one thing in five commits, it needs one changeset. If you extend work that already has a pending changeset, edit that file.

## What the file may contain

```md
---
bump: patch
source: bot
pr: 131
---

Bump react-native from 0.76.1 to 0.76.3
```

| Key | Meaning |
| --- | --- |
| `bump` | Required. `major`, `minor`, `patch` or `none`. |
| `source` | Only `bot`. Set on changesets written for bot PRs. |
| `pr` | A positive integer: the PR the entry belongs to. |

Other keys produce a warning and are kept, so tools and later versions can add fields. A broken file is a hard error with the file and the line, for example:

```text
.launchset/bad-file-name.md:2: invalid bump "huge": expected major, minor, patch or none
```

## Where changesets go

launchset only looks in `.launchset/`. Everything else you need to know:

- The release PR reads all pending changesets, applies them and deletes the files.
- The PR check fails when a PR adds no changeset, unless the author is in `check.bots` or the PR is the release PR (head branch `launchset/release/*`).
- On a maintenance branch (`release/1.4.x`) only `patch` and `none` are allowed. See [Hotfixes](/guides/hotfixes/).
- Don't edit version numbers, build numbers or `CHANGELOG.md` by hand. The check fails when a version file disagrees with the root version.

## The PR check comment

The check keeps one comment on each PR and updates it in place. With a changeset it shows the bump, the version this would produce and the summaries. Without one it explains how to add one.

## Migrating from Changesets

`launchset init` converts existing `.changeset/*.md` files: the highest bump found in the frontmatter becomes the `bump`, and summaries are kept. See [Migrating](/guides/migrating/).

## Repos that also use Changesets

Some repos keep Changesets for npm packages that have their own versions. There, a PR that changes such a package needs a `.changeset/` file for the package **and** a `.launchset/` changeset. The launchset bump says what the change means for the launchset targets: `none` when no target uses the package. See [Alongside Changesets](/guides/with-changesets/).
