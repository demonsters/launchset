---
title: Bot PRs
description: "Dependabot, Renovate and your own workflows that open PRs: make their PRs pass the check and show up in the changelog."
---

Bots open PRs that nobody writes a changeset for. launchset handles two kinds.

## Dependabot and Renovate

Authors in `check.bots` (default `dependabot[bot]` and `renovate[bot]`) **pass the PR check without a changeset**. launchset never pushes to their branches, because those bots stop rebasing a PR that someone else pushed to.

When it builds the release PR, launchset looks at the PRs merged into the branch since the last release tag. For every one written by a bot that has no changeset, it adds a generated entry: `bump: patch`, and the PR title as the summary, for example `Bump react-native from 0.76.1 to 0.76.3`. These entries appear in the changelog under **Dependencies**.

```md
### Dependencies
- Bump react-native from 0.76.1 to 0.76.3 ([#131](https://github.com/acme/app/pull/131))
```

Merged bot PRs alone are enough to open a release PR.

Add other bots to `check.bots`:

```ts
check: { bots: ["dependabot[bot]", "renovate[bot]", "acme-bot[bot]"] },
```

## Your own workflows that open PRs

A workflow that updates files in the repo (generated code, synced data) and opens a PR has two problems:

1. The PR needs a **changeset**, so the update appears in the changelog (or an explicit "no release needed").
2. The PR must be opened with an **App token**, not the default `GITHUB_TOKEN`. PRs opened with `GITHUB_TOKEN` don't trigger other workflows, so **CI and the launchset check never run on them**, and a required check blocks the merge.

You can handle both in the workflow that opens the PR.

### Write the changeset with the action

The launchset action has an `add` command. It writes a changeset in `.launchset/` of the checkout and outputs its `path`. It needs no npm access.

```yaml title=".github/workflows/sync.yml"
name: Sync
on:
  schedule:
    - cron: "0 6 * * 1"
  workflow_dispatch:

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - id: app-token
        uses: actions/create-github-app-token@v2
        with:
          app-id: ${{ secrets.LAUNCHSET_APP_ID }}
          private-key: ${{ secrets.LAUNCHSET_APP_PRIVATE_KEY }}
      - uses: actions/checkout@v5
        with:
          token: ${{ steps.app-token.outputs.token }}
      # Your own step: update the files in the repo.
      - name: Update files
        run: ./scripts/sync.sh
      - id: changeset
        uses: demonsters/launchset-action@v1
        with:
          command: add
          bump: patch            # or: none, if the update needs no release
          message: Update generated files.
      - uses: peter-evans/create-pull-request@v7
        with:
          token: ${{ steps.app-token.outputs.token }}
          branch: sync/update
          title: Update generated files
          commit-message: Update generated files
          body: Files from the weekly sync.
          add-paths: |
            generated/**
            .launchset/**
```

The pieces:

- The **App token** goes to `actions/checkout` and to the PR action. The PR is then opened by the App, and workflows run on it.
- `command: add` takes `bump` (`major`, `minor`, `patch` or `none`) and `message`. It writes the file and sets the output `path` (for example `.launchset/brave-lions-sing.md`).
- With `bump: none` the summary is not needed. The change satisfies the check, never starts a release and doesn't appear in the changelog.
- The changeset must be part of the PR. If the PR action only commits certain paths, include `.launchset/**`.

### Or write the file by hand

You can also create the file in your script:

```sh
cat > ".launchset/sync-$(date +%Y%m%d).md" <<'MD'
---
bump: patch
---

Update generated files.
MD
```

A file name can be any name ending in `.md`, except `README.md`.

### Avoid a pile of changesets

If the workflow opens a new PR every week and nobody merges them all, the changesets add up as separate entries. Either update the same branch (as in the example: `branch: sync/update` reuses one PR) or give the bot's PRs a `bump: none` changeset and let one human changeset describe the release.

### Make the check pass without a changeset

If you'd rather not write a changeset, add the bot's login to `check.bots`. The PR passes the check without one. Bot PRs from that author get a generated patch entry under **Dependencies** in the next release, as for Dependabot. Note that the entry text is the PR title.
