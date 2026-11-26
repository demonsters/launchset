---
bump: patch
---

The agent skills tell agents to look up the latest release of each GitHub Action rather than trust what they remember, and to check compatibility before bumping a major. That means reading the release notes of every major in between, checking that the step's inputs and outputs still exist in the new `action.yml`, and checking runner requirements and behaviour changes. When a new major needs a secret or runner the repo may not have, they keep the working major and say why. `launchset-adopt` updates launchset's own generated steps when they are compatible. For the team's steps it moves over, and for the team's other workflows, it lists the outdated actions with a recommendation and asks before updating them, in a separate commit. The `launchset` skill does the same check when an agent adds or changes a `uses:` step, or reviews a Dependabot PR for one. It asks before updating outdated pins it comes across.
