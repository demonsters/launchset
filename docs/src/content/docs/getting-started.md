---
title: Getting started
description: Install launchset in a repo, make your first change and cut your first release.
---

This page takes you from an empty setup to your first release. It takes about half an hour, most of it spent on the GitHub App.

## Before you start

You need:

- A GitHub repository, and GitHub Actions turned on.
- Node 26 or newer on the machine where you run the CLI. (The GitHub Action brings its own Node.)
- Read access to the private `@demonsters/launchset` package on npm. If `npx @demonsters/launchset --version` fails with a 404 or 401, set up npm authentication for the `@demonsters` scope first.
- Owner rights in the GitHub org, to create a GitHub App. See [GitHub App setup](/github-app/).

:::note
The CLI is only needed for setup and for convenience. In CI, workflows call the public action `demonsters/launchset-action@v1`. It needs no npm access, and any org can use it.
:::

## 1. Run init

In the root of your repo:

```sh
npx @demonsters/launchset init
```

`init` looks at your repo and asks a few questions. It finds:

- the current version (`package.json`, native projects, existing git tags),
- Dockerfiles, Android and iOS projects, Capacitor and Expo apps,
- existing release machinery that would conflict with launchset, like workflows that run on `v*` tags.

It never lowers a version without asking, and it never creates a release tag for a version that might never have been built.

Then it writes:

| File | What it is |
| --- | --- |
| `launchset.config.ts` | Your configuration. |
| `.launchset/README.md` | A short explanation for your team. |
| `.github/workflows/launchset-check.yml` | The PR check. |
| `.github/workflows/launchset-release.yml` | The release workflow. |
| `.github/workflows/launchset-preview.yml` | Preview builds (only when previews are not switched off). |
| `CHANGELOG.md` | Only if you have none. |
| `.claude/skills/launchset/SKILL.md` and `AGENTS.md` | Instructions for AI agents (optional). |

At the end it prints what is left to do by hand. Want to see what it would do first? Run `npx @demonsters/launchset init --detect`. That writes nothing.

A minimal config looks like this:

```ts title="launchset.config.ts"
import { defineConfig } from "@demonsters/launchset";

export default defineConfig({
  targets: {
    api: { type: "docker", image: "ghcr.io/acme/api" },
    android: {
      type: "android",
      source: { kind: "gradle", file: "android/app/build.gradle" },
    },
  },
});
```

Everything you leave out uses its default. See the [configuration reference](/reference/configuration/).

## 2. Add your build steps

Open `.github/workflows/launchset-release.yml`. The `build` job runs once per target. It already contains:

1. a checkout of the release commit,
2. `stamp`: writes the version and build number into the target's files,
3. `verify`: asks the store or registry whether this version was already uploaded,
4. a place for **your** build and upload steps,
5. `mark`: records that the target shipped.

For Docker targets init writes working `docker/build-push-action` steps. For Android, iOS, web and custom targets (without npm publishing) it writes commented examples, plus a step named **Build steps missing (<target>)** that always fails with `No build steps for <target> yet`. Uncomment and adapt the examples, then **delete the "Build steps missing" step** of that target. More examples are in [Workflow recipes](/guides/recipes/).

:::caution
`mark` runs after your steps and records the target as shipped. The failing "Build steps missing" step stops that: until you add real build steps and remove the guard, the target's job fails, `mark` doesn't run, and the release can't complete. That is on purpose, so an unbuilt target is never recorded as shipped. Add the steps and remove the guard before you merge your first release PR.
:::

## 3. Create the GitHub App

Releases use a GitHub App token, not the default `GITHUB_TOKEN`. Events caused by `GITHUB_TOKEN` don't start other workflows, so a release PR opened with it would never get CI. Follow [GitHub App setup](/github-app/) and add the two secrets `LAUNCHSET_APP_ID` and `LAUNCHSET_APP_PRIVATE_KEY`.

## 4. Commit and open a PR

```sh
git checkout -b add-launchset
git add -A
git commit -m "Add launchset"
git push -u origin add-launchset
```

Open the PR. The check runs and reports that the PR has no changeset. That is on purpose. Add one:

```sh
npx @demonsters/launchset add --bump patch --message "Set up releases with launchset"
```

Or, for a change that needs no release, `npx @demonsters/launchset add --empty`. Commit the file in `.launchset/` and push. The check turns green.

## 5. Your first release

1. Merge the PR. The release workflow runs on the push to `main`. It sees a pending changeset and opens a PR titled `Release v1.4.1` (the version depends on your changesets). The branch is `launchset/release/main`.
2. Review the release PR. It shows the changelog section that will be added.
3. Merge it. The release workflow runs again. This time it sees that the version changed, so it builds every target at the release commit, marks each one, and creates the tag `v1.4.1` and a GitHub Release.

From now on, every PR adds a changeset, and merging the release PR is the release. Read [Concepts](/concepts/) for the whole picture and [Writing changesets](/changesets/) for the details of the file.

## Try the CLI

```sh
npx @demonsters/launchset status
```

```text
Branch:        main
Version:       1.4.0
Last release:  v1.4.0
Next version:  1.5.0 (minor)

Pending changesets (1):
  minor  Add offline mode  .launchset/sweet-boxes-draw.md

Version files: consistent
```

`launchset version --dry-run` prints the diff the release PR would contain.
