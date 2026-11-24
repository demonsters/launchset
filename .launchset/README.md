# .launchset

This folder holds **changesets** for [launchset](https://demonsters.github.io/launchset/), the tool that releases this repo. One version drives every build target (Docker images, Android, iOS, web), and they're released together.

Every pull request adds a changeset: a small markdown file that says how big the change is and what to write in the changelog.

```md
---
bump: minor
---

Add offline mode to the mobile app.
```

- `bump`: `major` (breaking for users or API clients), `minor` (new features), `patch` (fixes) or `none` (no release needed: docs, CI, tests).
- The text below the frontmatter is the changelog entry: one bullet about one change, with any further lines indented under it. A PR that adds a feature and fixes a bug adds two changesets.
- Name the file with three random words, like `brave-lions-sing.md`.

Create one with `npx @demonsters/launchset add`, or write the file by hand.

launchset collects the changesets into a release PR (`Release vX.Y.Z`). Merging that PR releases every target. Don't edit version numbers, build numbers or `CHANGELOG.md` by hand, and don't create `v*` or `launchset/*` tags (or whatever `tags` in `launchset.config.*` sets).

See the launchset docs for more: https://demonsters.github.io/launchset/
