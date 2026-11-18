# launchset docs

The documentation site, built with [Astro Starlight](https://starlight.astro.build). Pages are in `src/content/docs/`.

```sh
pnpm --filter docs dev      # local preview
pnpm --filter docs build    # production build into docs/dist
```

Some blocks are generated from the code, so they can't drift: the configuration options (from the zod schema), the CLI reference (the real `--help` output), the action inputs and outputs (`action/action.yml`) and the GitHub App permissions (`src/github/permissions.ts`). They sit between `<!-- generated:NAME:start -->` and `<!-- generated:NAME:end -->` markers. `dev` and `build` regenerate them first (`scripts/generate.ts`). `pnpm --filter docs check:generated` fails when a committed page is out of date.

The generator fails when a config option has no description in `scripts/descriptions.ts`, or a CLI command none in `scripts/cli-intros.ts`. That is how a change in the code shows up here.

Hosting isn't decided: nothing deploys from here.
