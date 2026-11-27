<p align="center"><img src="https://demonsters.github.io/launchset/logo.svg" alt="" width="120"></p>

<h1 align="center">launchset</h1>

<p align="center"><strong>Changesets is for packages. launchset is for apps: one version, every platform, build numbers handled.</strong></p>

<p align="center"><a href="https://demonsters.github.io/launchset/">Documentation</a> · <a href="https://demonsters.github.io/launchset/getting-started/">Getting started</a> · <a href="https://demonsters.github.io/launchset/concepts/">How it works</a> · <a href="https://demonsters.github.io/launchset/reference/cli/">CLI reference</a></p>

You have one repo that ships an API image, a web app and an Android and iOS app, and they all carry the same version. launchset gives that repo a Changesets-style release flow. Every PR adds a changeset, launchset keeps a release PR open, and merging it releases every target at the same version, each with a fresh build number.

launchset builds nothing itself. It decides what to release, writes the version and build number into each target's files, and records what shipped as git tags and a GitHub Release. Your own steps do the building and uploading: `docker build`, Gradle, fastlane, Xcode, `npm publish`.

It runs on GitHub Actions and on GitLab CI (GitLab.com and self-managed 18.2+).

## Is it for you?

**Use launchset when:**

- one repo ships several things that share one version: Docker images, a web app, native or cross-platform mobile apps;
- you want store builds with a version and a unique, always increasing build number, without committing build numbers;
- you want a changelog and a release PR instead of tagging by hand.

**Look elsewhere when:**

- you publish npm packages that each have their own version. That's what [Changesets](https://github.com/changesets/changesets) is for. launchset can [run alongside it](https://demonsters.github.io/launchset/guides/with-changesets/) when a repo has both;
- each app in the repo has its own version and release schedule;
- you want one tool that also builds, signs and uploads. launchset hands that to your own steps (see [store pipelines](https://demonsters.github.io/launchset/store-pipelines/) for fastlane and Gradle recipes).

## How it works

1. **Every PR adds a changeset**, a small markdown file in `.launchset/` that says how big the change is and what goes in the changelog. `npx launchset add` writes it, and a PR check tells you when one is missing.
2. **launchset keeps a release PR open**, `Release v1.5.0`. It holds the version bump, the version written into each target's files and the new changelog section. It's rebuilt on every push, so it never has conflicts.
3. **Merging it is the release.** The workflow runs one job per target. Each job writes the version and a fresh build number into its checkout, runs your build and upload steps, and records a marker tag.
4. **Once every target has shipped**, launchset tags `v1.5.0` and publishes the GitHub Release. If a job fails, re-run it: targets that already shipped are skipped.

There's more: [preview builds](https://demonsters.github.io/launchset/guides/previews/) from a PR label (TestFlight, Play internal track, Docker), [hotfixes](https://demonsters.github.io/launchset/guides/hotfixes/) from `release/1.4.x`, [manual targets](https://demonsters.github.io/launchset/guides/manual-targets/) for apps you ship when you decide, and Dependabot and Renovate PRs that pass the check without a changeset.

## Get started

You need Node 24 or newer.

```sh
npx launchset init --detect   # see what init would do, without writing anything
npx launchset init            # set up the repo: the config and the workflows
npx launchset add             # add a changeset to a PR
npx launchset status          # pending changes and the next version
```

`init` finds your current version and build numbers, your Dockerfiles and native projects, and release tooling that would conflict. It never lowers a version without asking. On GitHub, releases run with a GitHub App you create once per org; see [GitHub App setup](https://demonsters.github.io/launchset/github-app/). The workflows use the action [`demonsters/launchset-action@v1`](https://github.com/demonsters/launchset-action).

Start with [Getting started](https://demonsters.github.io/launchset/getting-started/), or [Moving an existing repo](https://demonsters.github.io/launchset/guides/migrating/) if the repo already has a release process.

## Targets

| Target | What launchset writes |
| --- | --- |
| [Docker](https://demonsters.github.io/launchset/targets/docker/) | image tags and OCI labels for your build-push step |
| [Web](https://demonsters.github.io/launchset/targets/web/) | nothing by default (the root `package.json` holds the version), or the version in extra JSON, YAML or text files |
| [Android](https://demonsters.github.io/launchset/targets/android/) | `versionName` and `versionCode` (`build.gradle`, `build.gradle.kts` or `gradle.properties`) |
| [iOS](https://demonsters.github.io/launchset/targets/ios/) | marketing version and build number (Xcode project, `Info.plist` files or an `.xcconfig`) |
| [React Native](https://demonsters.github.io/launchset/targets/react-native/), [Capacitor](https://demonsters.github.io/launchset/targets/capacitor/), [Expo](https://demonsters.github.io/launchset/targets/expo/) (experimental) | the same Android and iOS targets, pointed at their files |
| [Custom](https://demonsters.github.io/launchset/targets/custom/) | anything else: an npm package, a CLI, a file of your choice |

## Agent skills

launchset ships two skills for AI coding agents:

- [`launchset`](https://github.com/demonsters/launchset/blob/main/skills/launchset/SKILL.md), for agents working in a repo that uses launchset. `launchset init` installs it into `.claude/skills/launchset/`.
- [`launchset-adopt`](https://github.com/demonsters/launchset/blob/main/skills/launchset-adopt/SKILL.md), for agents moving an existing repo onto launchset. Install it at user level; see [the adoption skill](https://demonsters.github.io/launchset/guides/migrating/#the-adoption-skill).

## Development

Node 24 and pnpm.

```sh
pnpm install
pnpm build                  # CLI (dist/), JSON Schema, action bundle (action/dist/)
pnpm test                   # vitest
pnpm typecheck
pnpm lint                   # biome; `pnpm format` fixes
pnpm --filter docs dev      # docs with live reload
pnpm --filter docs build    # docs production build
```

The docs (Astro Starlight, in [`docs/`](https://github.com/demonsters/launchset/tree/main/docs)) generate their configuration reference, CLI reference, action inputs and outputs and the GitHub App permissions from the code. They're published to GitHub Pages on every push to `main`.

```
src/        core logic, config schema, platform stampers, git, GitHub and GitLab, verify, CLI, init
action/     the GitHub Action (action.yml, source; the bundle is built into action/dist/)
templates/  workflow and pipeline templates used by init
skills/     agent skills
docs/       the documentation site
test/       tests and fixtures
design/     the spec and the design decisions
```

The design is in [`design/SPEC.md`](https://github.com/demonsters/launchset/blob/main/design/SPEC.md) and [`design/DECISIONS.md`](https://github.com/demonsters/launchset/blob/main/design/DECISIONS.md).

## License

[MIT](https://github.com/demonsters/launchset/blob/main/LICENSE). Built and used at [De Monsters](https://demonsters.nl).
