---
bump: patch
---

A tag template can use a placeholder more than once, like `tags.release: "release/{version}/v{version}"`. Before, the config accepted it, but every command that read the repo's tags then failed with `SyntaxError: Duplicate capture group name`. Now a tag matches only when each placeholder has the same value everywhere (`release/1.2.0/v1.2.0`, not `release/1.2.0/v1.3.0`).
