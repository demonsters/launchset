---
bump: patch
---

launchset runs its git commands without the repo's git hooks. A job that installed husky, simple-git-hooks, lefthook or git-lfs hooks before `mark` could fail after the upload, because a pre-push hook ran tests, lint or `launchset check --push` on launchset's own push.
