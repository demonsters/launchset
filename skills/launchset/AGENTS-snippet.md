## Releases (launchset)

This repo is released with [launchset](https://github.com/demonsters/launchset): one version for every target, driven by changeset files in `.launchset/`. The release PR (`Release vX.Y.Z`) collects them. Merging it is the release.

- **Every PR needs a changeset.** Create it with `npx @demonsters/launchset add --bump <major|minor|patch|none> --message "<summary>"`. Use `--empty` (`bump: none`) for docs, CI or test-only changes. If the CLI isn't available, write the file by hand in `.launchset/<three-words>.md`:

  ```md
  ---
  bump: minor
  ---

  Add offline mode to the mobile app.
  ```

- **Bump:** `major` breaks users or API clients, `minor` adds a feature, `patch` fixes a bug, `none` needs no release.
- **Summary:** one user-facing line for the changelog, no PR number. One changeset per change, not per commit. Edit an existing pending changeset when your work extends it.
- **Pushing straight to the base branch:** make sure a changeset covers the work before you push. `npx @demonsters/launchset status` shows what is pending.
- **Never** edit version numbers, build numbers or `CHANGELOG.md` by hand. Never create tags starting with `v` or `launchset/` (or what `tags` sets in the launchset config). Never edit or push to the release PR (branch `launchset/release/*`), and don't merge it unless asked.
- On a `release/X.Y.x` branch (or what `maintenanceBranches` sets) only `patch` or `none` is allowed.
- Add the label `launchset:preview` (or whatever `preview.label` sets) to a PR to get a preview build.
- Manual targets (`release: "manual"`) are shipped on demand. Never ship one unasked. If `status` shows one is behind, tell the human.
