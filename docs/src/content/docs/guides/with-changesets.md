---
title: Alongside Changesets
description: Release the app with launchset and keep Changesets for npm packages that have their own versions, in the same repo.
---

launchset has one version per repo. Some repos ship that version (a Docker image, web and mobile apps) **and** publish npm packages that each have their own version, such as SDKs that customers install. launchset doesn't version packages independently, and putting those packages on the app's version would make their version numbers meaningless to the people who install them.

Changesets is good at exactly that part. So run both:

- **launchset** releases the one version and its targets.
- **Changesets** versions and publishes the npm packages.

Each package is released by one tool, never both. An npm package that Changesets publishes is never a launchset target.

## Who does what

| | launchset | Changesets |
| --- | --- | --- |
| Version | the one version in `version.file` | each public package's own `package.json` |
| Changeset files | `.launchset/` | `.changeset/` |
| Release PR | `Release vX.Y.Z`, branch `launchset/release/main` | `Version Packages`, branch `changeset-release/main` |
| Tags | `tags.release` (`v{version}`) and `launchset/<target>@<version>` | `<package>@<version>` |
| Ships | the targets: Docker images, apps | the npm packages |
| Changelog | `changelog.file` | one `CHANGELOG.md` per package |

The two release PRs, branches and tags don't overlap, so both tools run on the same pushes to `main` without getting in each other's way.

## Set it up

### 1. Stop Changesets from versioning private packages

The apps launchset releases are usually private workspace packages. In `.changeset/config.json`:

```json
"privatePackages": { "version": false, "tag": false }
```

Changesets then doesn't bump or tag private packages, so the app gets its version only from launchset. It also changes the Changesets PR check: `changeset status` only asks for a `.changeset` file when a **public** package changed, not for app-only PRs (checked with Changesets 2.31).

Keep the rest of the Changesets setup: `changesets/action` with its `publish` command, `changeset status` in CI, and pre mode for npm prereleases.

### 2. Pick the file that holds the one version

By default launchset reads the version from the root `package.json`. That works next to Changesets: in a workspace, Changesets never versions the root package.

If the app's version lives in its own package, point launchset there:

```ts
export default defineConfig({
  version: { file: "apps/app/package.json" },
  changelog: { file: "apps/app/CHANGELOG.md" },
  // ...
});
```

The version file must be a package that Changesets doesn't version: the workspace root, or a private package (step 1). `init` always writes the root, so change this in `launchset.config.ts` after `init`. launchset adds its sections to an existing changelog above the old ones, so a Changesets changelog can stay.

### 3. Run `init`, but keep Changesets

`init` lists Changesets steps and scripts as machinery that conflicts, and proposes `disable` for each. In this setup, answer `keep` for everything that versions, checks or publishes the npm packages: the `changesets/action` step, `changeset version|status|publish` scripts, pre-mode checks.

```sh
npx @demonsters/launchset init \
  --decide 'machinery..github/workflows/publish.yml#1=keep' \
  --decide 'machinery.package.json#1=keep'
```

Copy the ids from `init --detect`. Then edit those workflows by hand and remove what launchset does now: Docker build and push, deploys, tags and GitHub Releases for the app, steps that read the app version from a `package.json`. Move those steps into `launchset-release.yml`. Other machinery, such as tag-triggered workflows, is retired as in [Migrating](/guides/migrating/#retire-what-conflicts).

**Pending Changesets files.** `init` converts every pending `.changeset/*.md` into `.launchset/`, with one bump: the highest bump of all the packages it names. Review the converted files:

- A file that only named npm packages isn't an app change. Delete its copy in `.launchset/`, or set it to `bump: none`.
- A file that named the app and packages: check that the bump fits the app.

The originals stay in `.changeset/`, where Changesets still needs them. Ignore init's hint that the `.changeset/` folder can be deleted. Adopting right after a Changesets release, when `.changeset/` holds no pending files, avoids this step.

### 4. Skip launchset's check on the Version Packages PR

Changesets' `Version Packages` PR has no `.launchset` changeset, so launchset's PR check would fail on it. Skip the check job for that branch in `launchset-check.yml`:

```yaml
jobs:
  check:
    name: Changeset check
    # Changesets' "Version Packages" PR only versions the npm packages.
    if: ${{ !startsWith(github.head_ref, 'changeset-release/') }}
    runs-on: ubuntu-latest
```

Use a job `if`, not a `branches-ignore` filter. GitHub reports a job skipped by `if` as successful, so a required **Changeset check** doesn't block the merge. A workflow filtered out by branch never reports, and a required check would wait forever.

GitHub doesn't start workflows for PRs that a workflow opens with `GITHUB_TOKEN`. If `changesets/action` uses that token, no check runs on the Version Packages PR at all, and any required check blocks it. Give `changesets/action` a GitHub App or personal token in that case. This is a Changesets limitation, not something launchset adds.

### 5. Optional: keep the "Latest" release on the app

`changesets/action` creates a GitHub Release for every package it publishes, and GitHub marks each new release as **Latest**. So publishing a package moves the repo's Latest badge away from the app's release. launchset sets Latest explicitly on its own releases. To keep the badge on the app, turn off Changesets' releases:

```yaml
- uses: changesets/action@v1
  with:
    publish: pnpm run publish:npm
    createGithubReleases: false
```

## Every PR

Every PR needs a `.launchset/` changeset, as always. A PR that changes a published npm package also needs a `.changeset/` file that names the package.

The launchset bump is about the launchset targets, not about the package. If a target ships the changed package, for example because the app uses it from the workspace, the next app release includes the change: pick the bump it means for the app's users, usually `patch`. If no target uses the package, use `bump: none`.

| Change | `.launchset/` | `.changeset/` |
| --- | --- | --- |
| Only the app | the app's bump | nothing |
| A package that the app uses | the bump for the app, usually `patch` | the package's bump |
| A package that no target uses (a CLI, an ESLint plugin) | `bump: none` | the package's bump |
| Docs, CI, tests | `bump: none` | nothing |

## Details

- **Prereleases.** Changesets pre mode stays the way to publish npm prereleases. For prereleases of the app, use a launchset [prerelease branch](/guides/previews/). launchset ignores `.changeset/pre.json`.
- **`launchset status`** warns about commits since the last release that no changeset covers. A merged Version Packages PR is such a commit when no launchset changeset is pending. It's only a warning.
- **Bot PRs.** Don't add `github-actions[bot]`, the usual author of the Version Packages PR, to `check.bots` to get past the check. launchset adds a `patch` entry for every merged bot PR, so each Version Packages merge would release the app. See [Bot PRs](/guides/bot-prs/).
