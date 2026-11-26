---
title: Preview builds and prerelease branches
description: Test builds from a PR or a branch, and tagged prereleases from long-lived branches.
---

A **preview** is a test build of work that isn't released: a TestFlight build of a PR, a Play internal-track build, a preview Docker tag. Previews have **no side effects**. Nothing is committed, no changeset is consumed, and no marker tag, release tag or GitHub Release is created.

A **prerelease branch** is a preview of a long-lived branch that gets a real version, a git tag and a GitHub pre-release. Use it for public npm alphas, alpha images on staging, or betas that other repos pin.

Both run in `launchset-preview.yml`.

On GitLab? See [Previews on GitLab](/gitlab/previews/): there are no label events, so the label starts a preview on the next pipeline, and an MR without it gets a manual job.

## Preview a PR

Add the label `launchset:preview` to a PR. The workflow builds the PR's head commit.

- A new push to the PR builds again, and the newer run cancels the older one (`preview.rebuildOnPush`, default `true`). With `rebuildOnPush: false` a preview is built only when the label is added.
- Adding another label does nothing.
- **PRs from forks are skipped.** GitHub gives fork PRs no secrets, so there is no App token and nothing can be uploaded. The job summary says so. A maintainer can push the branch to the repo to get a preview.

The version is `<next>-pr.<PR number>.<run number>`, for example `1.5.0-pr.123.4`. `<next>` is the version the PR's changesets would release. If none are pending, it is the next patch version.

The workflow ends with `preview-comment`, one sticky comment on the PR with the version, the build number per target, the Docker tags and a result per target with links to the jobs.

:::note
The comment finds each target's result by its job name. Keep the build job named `Preview ${{ matrix.target }}`, as generated. If you rename it, the comment lists the target as `unknown`.
:::

## Preview a branch

Two ways:

- **By hand.** Start **Launchset preview** with `workflow_dispatch` on any branch. The optional `targets` input takes a comma-separated list of target names (or `all`).
- **On every push.** List the branch in `preview.branches`:

```ts
preview: {
  branches: [
    "develop",                                       // a glob, built on every push
    { branch: "feature/*", targets: ["docker-api"] },  // only these targets
  ],
},
```

The version is `<next>-<branch slug>.<run number>`, for example `1.5.0-develop.17`. The slug is the branch name in lowercase with everything except `a-z`, `0-9` and `-` turned into dashes, repeated dashes collapsed, cut at 30 characters.

Branches that match `maintenanceBranches` never auto-preview, even when a pattern matches them. To preview one, start the workflow by hand.

## Which targets

`preview.targets` is `"all"` by default, or a list of target names. A branch entry's `targets` overrides it for that branch. A `workflow_dispatch` input overrides both. Manual targets can be in the list: for example a TestFlight preview per label.

```ts
preview: { targets: ["docker-api", "android"] },
```

## What your build steps do

The `stamp` step in the preview workflow writes the preview version and build number into the target's files. Your steps upload to **internal** channels only:

```yaml
- name: Upload to the Play internal track
  if: matrix.target == 'android'
  run: bundle exec fastlane supply --aab app/build/outputs/bundle/release/app-release.aab --track internal
```

`steps.stamp.outputs.channel` is `preview` (or `prerelease` on a prerelease branch). Docker previews get the tags from the `preview` list: by default `1.5.0-pr.123.4` and `pr-123` for a PR, `1.5.0-develop.17` and `develop` for a branch. `latest` and plain `X.Y.Z` tags are not allowed in preview lists.

iOS builds use the plain next version (`1.5.0`), because Apple doesn't accept suffixes. The build number tells them apart. This is also why, while previews are on, the `semver` build-number strategy is only allowed on targets that previews never build, and not as the repo-wide `buildNumber.strategy` (see [Build numbers](/guides/build-numbers/#previews)).

## Switch previews off

```ts
preview: false,
```

Delete `launchset-preview.yml` too. (If you leave it, its runs end with a notice that previews are disabled.) The `semver` build-number strategy becomes allowed everywhere, repo-wide included.

## Prerelease branches

:::caution[Experimental]
Prerelease branches are experimental. They have had less real-world use than releases and previews, so their details may still change. If something doesn't work for you, [open an issue](https://github.com/demonsters/launchset/issues/new/choose).
:::

A `preview.branches` entry with `prerelease` makes the branch a prerelease branch:

```ts
preview: {
  branches: [{ branch: "next/*", prerelease: "alpha", targets: "all" }],
},
```

A push to `next/new-form` now:

1. **Plans the version** `<next>-alpha.<n>`, for example `1.5.0-alpha.3`. `<next>` comes from the changesets on the branch. `n` is one higher than the highest existing `<next>-alpha.*` tag, starting at 0.
2. **Reserves the tag.** `preview-plan` creates and pushes the tag (`v1.5.0-alpha.3`) at the built commit *before* the builds start, with the App token. If the push fails because a concurrent run took the number, it retries with the next one. Numbers reserved by cancelled or failed runs are skipped. Gaps are fine.
3. **Builds** with channel `prerelease`. Docker gets the `prerelease` tags (default `1.5.0-alpha.3` and the branch slug), never `latest`. The `dist-tag` output is the prerelease id (`alpha`), for `npm publish --tag`. Android's `versionName` is the full prerelease version. iOS gets the plain next version.
4. **Creates a GitHub pre-release** for the tag (never "latest") in the last job. Its body lists the changesets on the branch that the base branch doesn't have, and the result per target.

Re-running failed jobs reuses the plan, so the version stays the same. "Re-run all jobs" plans again and reserves a new tag.

**Nothing is committed and nothing is consumed.** When the branch merges into the base branch, its changesets produce a normal release PR with the full changelog. There is no state file, no "exit pre mode", and no prerelease version in `package.json`.

Prerelease tags are never release tags. They don't count as "last release", for the next free version, as a hotfix base or as the bot-PR range.

Concurrency for prerelease branches is per branch with `cancel-in-progress: false`, so every push gets its own prerelease. The PR check also runs for PRs that target a prerelease branch. A prerelease pattern can't match the base branch.

### Publish an alpha to npm

```yaml
- run: npm publish --tag ${{ steps.stamp.outputs.dist-tag }}
  if: matrix.target == 'npm' && steps.stamp.outputs.channel == 'prerelease'
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

The generated snippet for a `custom` target with `verify: ["npm"]` does exactly this: only releases and prereleases go to npm, never PR or branch previews.

## Coming from Changesets pre mode

Changesets' `pre enter` keeps a `pre.json` and commits prerelease versions. launchset doesn't. Create a prerelease branch entry instead, and run `launchset init --convert-only` on the branch that is in pre mode. `pre.json` is ignored, with a warning. See [Migrating](/guides/migrating/).
