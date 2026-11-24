---
bump: patch
---

The `launchset` agent skill, the `AGENTS.md` section and `.launchset/README.md` now say to keep each changelog bullet to one change: a changeset for each change in a PR (each with its own bump), or, for related changes with one bump, a lead line with a sub-bullet per change. Before, agents could put a feature and several fixes in one bullet. Run `launchset init` again to update the skill and the `AGENTS.md` section in a repo; `.launchset/README.md` is only written when missing.
