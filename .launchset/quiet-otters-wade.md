---
bump: patch
---

GitLab MR previews start their child pipeline. The generated child pipeline had no `workflow: rules`, so GitLab dropped all its jobs in an MR pipeline (whose ref is no branch) and the `launchset-preview` trigger job failed with `downstream_pipeline_creation_failed`; previews started on a branch weren't affected. Existing projects get the fix with a newer `LAUNCHSET_CLI`, without running `launchset init` again.
