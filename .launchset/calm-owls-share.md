---
bump: patch
---

Document running launchset alongside Changesets in repos that also publish independently versioned npm packages: launchset releases the app, Changesets keeps the packages. The adoption skill now proposes this setup instead of stopping, and the `launchset` skill and `AGENTS.md` section explain that a PR changing such a package needs both a `.changeset/` file and a `.launchset/` changeset.
