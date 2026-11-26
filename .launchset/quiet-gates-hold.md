---
bump: none
---

launchset's own release and preview jobs run in a `release` environment that only `main`, `release/*.x` and `next/*` may use, so the GitHub App key and npm publishing are out of reach of workflows on other branches.
