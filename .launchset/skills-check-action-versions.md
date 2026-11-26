---
bump: patch
---

The agent skills tell agents to look up the latest release of each GitHub Action rather than trust what they remember, and to check compatibility before bumping a major. That means reading the release notes of every major in between, checking that the step's inputs and outputs still exist in the new `action.yml`, and checking runner requirements and behaviour changes. When a new major needs a secret or runner the repo may not have, they keep the working major and say why in the PR. `launchset-adopt` does this for every workflow the migration writes or changes. The `launchset` skill does it whenever an agent adds or changes a `uses:` step, or reviews a Dependabot PR for one.
