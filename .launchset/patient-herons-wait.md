---
bump: patch
---

GitLab: a preview started from the manual `launchset-preview-plan` job now gets its MR note. The comment job `launchset-preview-comment` moved into the preview's child pipeline, as its last job (`when: always`), so it runs once the builds are done, and only when a preview was planned. Before, it sat in the parent pipeline and needed the manual plan job, so GitLab ran it straight away in every MR pipeline without the preview label ("nothing to report") and never again after someone played the plan job.

`init` doesn't rewrite an existing `.gitlab/launchset.yml`. To get the fix in a project set up with 1.1.0 or earlier:

1. Raise `LAUNCHSET_CLI` in `.launchset-cli` (in `.gitlab/launchset.yml`) to this version.
2. Delete the job `launchset-preview-comment` from `.gitlab/launchset.yml`. With this version it no longer posts anything (the child pipeline's job does) and says so in its log, but until you delete it, it still costs a job in every MR pipeline.
