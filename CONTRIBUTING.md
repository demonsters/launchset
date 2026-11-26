# Contributing to launchset

Thanks for helping. launchset is built and used by a small team at [demonsters](https://github.com/demonsters), and shared as is: we maintain it as we use it, with no support commitment or promised response time. Bug reports, fixes, docs and real-world test cases are welcome.

**Send us your weird build files.** launchset has to read and edit build files written in every style there is: a `build.gradle` that computes its `versionCode`, product flavors, a `project.pbxproj` with a dozen configurations, an `app.config.js` that does its own thing. If yours trips launchset up, open an issue with a copy of the file (names and secrets removed). Those files are how the stampers get better.

For anything bigger than a fix, open an issue or a [discussion](https://github.com/demonsters/launchset/discussions) first, so we can agree on the approach before you spend time on it. Security problems go through [SECURITY.md](SECURITY.md), not a public issue.

## Good first contributions

- **A file launchset can't stamp.** If `launchset stamp` or `launchset init` gets your `build.gradle`, `project.pbxproj`, `Info.plist`, `.xcconfig` or `app.json` wrong, a minimal copy of that file (with names and secrets removed) as a test fixture is the most useful thing you can send. Fixtures live in `test/fixtures/`, and the stamper tests in `test/platforms/`.
- **A stamper fix** for one of those files, with the fixture as its test.
- **Docs**: a wrong command, a missing step, a page that didn't answer your question.

Issues labelled [`good first issue`](https://github.com/demonsters/launchset/labels/good%20first%20issue) are a good place to start.

## Setup

You need Node 24 or newer and pnpm (the version is pinned in `package.json`; `corepack enable` picks it up).

```sh
pnpm install
pnpm build                  # CLI (dist/), JSON Schema, action bundle (action/dist/)
pnpm test                   # vitest
pnpm typecheck
pnpm lint                   # biome; `pnpm format` fixes formatting
pnpm --filter docs dev      # docs with live reload
```

Run the CLI from your checkout with `node dist/cli.js <command>` after `pnpm build`.

## Every PR needs a changeset

launchset releases itself, so every PR adds a changeset in `.launchset/`. That includes PRs that only change docs, CI or tests: they get `bump: none`.

```md
---
bump: patch
---

`launchset stamp` keeps a CRLF line ending on the last line of `Info.plist`.
```

- `bump`: `major` (breaking for users or their config), `minor` (a new feature), `patch` (a fix) or `none` (no release needed).
- The text is the changelog entry: one bullet about one change, written for users of launchset. A PR with a feature and a fix adds two changesets.
- Name the file with three random words, like `brave-lions-sing.md`. `node dist/cli.js add` writes one for you.

See [Writing changesets](https://demonsters.github.io/launchset/changesets/) for more. Don't edit the version in `package.json` or `CHANGELOG.md`: the release PR does that.

## How the code is organised

```
src/        core logic, config schema, platform stampers, git, GitHub and GitLab, verify, CLI, init
action/     the GitHub Action (action.yml and its source; the bundle is built, not committed)
templates/  the workflow and pipeline templates init writes
skills/     the agent skills that ship in the npm package
docs/       the documentation site (Astro Starlight)
test/       tests and fixtures
design/     the spec and the design decisions
```

A few rules hold everywhere:

- **Stampers are pure text functions** (`src/platforms/`). Parse to find a value, then splice to edit it: every other byte of the file stays identical, including indentation, quotes, comments and line endings. Never re-serialize a parsed file. If a value can't be found unambiguously, throw a `StampError` that names the file and the reason; never guess. See `src/platforms/types.ts`.
- **The design lives in `design/`.** [`SPEC.md`](design/SPEC.md) is the agreed design. When you settle a detail it leaves open, or have to deviate from it, add one line to [`DECISIONS.md`](design/DECISIONS.md): what, why, and the spec section.
- **Parts of the docs are generated from the code**: the configuration and CLI reference, the action's inputs and outputs, and the GitHub App permissions (`docs/scripts/generate.ts`, run by `pnpm --filter docs build`). Change the code or `docs/scripts/descriptions.ts`, not the generated tables.
- **Tests come with the change.** Bug fixes get a test that fails without the fix.

## Pull requests

- Keep a PR to one change. Several unrelated fixes are easier to review as several PRs.
- CI runs lint, typecheck, tests, the docs build, the action bundle, a run of the local action, and the changeset check. All of them must pass.
- Workflows from forks run after a maintainer approves them, so the first CI run on your PR may wait for us.
- A maintainer merges the PR. Releases happen when a maintainer merges the release PR.

## License

By contributing, you agree that your contributions are licensed under the [MIT license](LICENSE), like the rest of launchset.
