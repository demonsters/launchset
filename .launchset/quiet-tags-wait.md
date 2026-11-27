---
bump: minor
---

`launchset init --baseline` no longer creates the release tag at HEAD: it writes `baseline: "<version>"` to the config, and the first release workflow run on the base branch after the merge creates the tag on that commit. Pushing the tag at HEAD ran the tag-triggered workflows init was about to retire, because GitHub runs a tag's workflows from the commit it points to. The steps init prints no longer tell you to push it, and say why not to.
