## Releases (launchset)

This repo is released with [launchset](https://demonsters.github.io/launchset/): one version for every target, driven by changeset files in `.launchset/`. The release PR (`Release vX.Y.Z`) collects them. Merging it is the release.

- **Every PR needs a changeset, and each changelog bullet is about one change.** Create each with `npx launchset add --bump <major|minor|patch|none> --message "<summary>"`. Use `--empty` (`bump: none`) for docs, CI or test-only changes. If the CLI isn't available, write the file by hand in `.launchset/<three-words>.md`:

  ```md
  ---
  bump: minor
  ---

  Add offline mode to the mobile app.
  ```

- **Bump:** `major` breaks users or API clients, `minor` adds a feature, `patch` fixes a bug, `none` needs no release.
- **One changeset per change**, not per commit and not per PR. A change is one thing a user notices on its own (a feature, a fix). A PR that adds a feature and fixes two bugs gets three changesets, each with its own bump. Related changes with the same bump may share one changeset as a lead line plus a sub-bullet per change (start with the lead line, not `- `). Edit an existing pending changeset when your work extends it.
- **Summary:** user-facing; the first line becomes the changelog bullet. No PR number. Never put several changes in one sentence: if a line joins separate changes with "and", semicolons or a list, split it.
- **Repos that also use Changesets** (a `.changeset/` folder): npm packages with their own versions are released with Changesets. A PR that changes one needs a `.changeset/` file for the package **and** the `.launchset/` changeset. The launchset bump is about the launchset targets: `none` when no target uses the package, otherwise usually `patch`. Don't edit or merge the `Version Packages` PR (branch `changeset-release/*`) unless asked.
- **Pushing straight to the base branch:** make sure a changeset covers the work before you push. `npx launchset status` shows what is pending.
- **Never** edit version numbers, build numbers or `CHANGELOG.md` by hand. Never create tags starting with `v` or `launchset/` (or what `tags` sets in the launchset config). Never edit or push to the release PR (branch `launchset/release/*`), and don't merge it unless asked.
- On a `release/X.Y.x` branch (or what `maintenanceBranches` sets) only `patch` or `none` is allowed.
- Add the label `launchset:preview` (or whatever `preview.label` sets) to a PR to get a preview build.
- Manual targets (`release: "manual"`) are shipped on demand. Never ship one unasked. If `status` shows one is behind, tell the human.
- On GitLab (`.gitlab-ci.yml`, `.gitlab/launchset.yml`) read "MR" for "PR". Build steps live in `.gitlab/launchset-targets.yml` (one hidden `.launchset-<target>` job per target, no `rules`/`when`/`needs`/`stage`, one command per line, no early `exit`). A preview there needs a new pipeline after the label is added, or the manual `launchset-preview-plan` job. Never ask for or print `LAUNCHSET_TOKEN`.
