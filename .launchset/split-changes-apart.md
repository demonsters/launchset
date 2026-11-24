---
bump: patch
---

The `launchset` agent skill, the `AGENTS.md` section and `.launchset/README.md` now say to write one changeset for each change in a PR, not one for the whole PR, with an example of a summary to split. Before, agents could put a feature and several fixes in one changelog bullet. Run `launchset init` again to update the skill and the `AGENTS.md` section in a repo; `.launchset/README.md` is only written when missing.
