---
bump: patch
---

`mark` works in repos that use Git LFS. It failed with "You must have push access to verify locks", because git-lfs's pre-push hook sent the build job's read-only `GITHUB_TOKEN` instead of the App token. Tag pushes now skip the LFS hook (a tag carries no new LFS objects), and branch pushes give git-lfs the App token.
