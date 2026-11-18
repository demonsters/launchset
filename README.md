# launchset

Changesets-style releases for repos where **one version** drives **many targets**: Docker images, Android, iOS and web apps, built from one repo and released together.

Every PR adds a small changeset file. launchset collects them into a release PR. Merging that PR releases every target at the same version. launchset builds nothing: it decides what to release, writes version and build numbers into your files and records what shipped as git tags. Your own workflow steps (docker build/push, Gradle, fastlane, Xcode) do the building.

```sh
npx @demonsters/launchset init     # set up a repo
npx @demonsters/launchset add      # create a changeset
npx @demonsters/launchset status   # pending changes and the next version
```

The package is `@demonsters/launchset` (private on npm). The GitHub Action is published to the public repo `demonsters/launchset-action`, so any org can use it with its own GitHub App.

## Documentation

The docs site is in [`docs/`](docs/) (Astro Starlight). Start with `docs/src/content/docs/getting-started.md`, or run `pnpm --filter docs dev`.

- Getting started, concepts, writing changesets
- Targets: Docker, web, Android, iOS, React Native, Capacitor, Expo, custom
- Release flow, build numbers, previews and prerelease branches, hotfixes, manual targets
- GitHub App setup, store pipelines, workflow recipes, migrating an existing repo
- Reference: configuration, CLI, the GitHub Action, troubleshooting

The design is in [`design/SPEC.md`](design/SPEC.md) and [`design/DECISIONS.md`](design/DECISIONS.md).

## Agent skills

- [`skills/launchset`](skills/launchset/SKILL.md): for agents working in a repo that uses launchset. `launchset init` installs it into `.claude/skills/launchset/`.
- [`skills/launchset-adopt`](skills/launchset-adopt/SKILL.md): for agents moving an existing repo onto launchset. It ships in the npm package. Install it at user level (`~/.claude/skills/launchset-adopt/`): see the migration page in the docs.

## Development

Node 26 and pnpm.

```sh
pnpm install
pnpm build           # CLI (dist/), JSON Schema, action bundle (action/dist/)
pnpm test            # vitest
pnpm typecheck
pnpm lint            # biome; `pnpm format` fixes
pnpm --filter docs dev      # docs with live reload
pnpm --filter docs build    # docs production build
```

The docs generate their configuration reference, CLI reference, action inputs and outputs and the GitHub App permissions from the code (`docs/scripts/generate.ts`), and `pnpm --filter docs build` runs that first.

```
src/        core logic, config schema, platform stampers, git, GitHub, verify, CLI, init
action/     the GitHub Action (action.yml, source, bundle in dist/)
templates/  workflow templates used by init
skills/     agent skills
docs/       the documentation site
test/       tests and fixtures
design/     the spec and decisions
```
