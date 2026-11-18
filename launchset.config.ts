/**
 * launchset releases itself (spec 15). One version (the root package.json) drives two targets:
 *
 *   npm     the CLI and library, `@demonsters/launchset`, published to the private @demonsters
 *           scope on npm.
 *   action  the bundled GitHub Action, published to the public repo demonsters/launchset-action
 *           (commit, tag v{version}, moving major tag).
 *
 * Neither target has files to stamp: the version lives in package.json (the root version file),
 * which launchset updates itself. The workflows in .github/workflows/launchset-*.yml are
 * adapted from the generated templates; see the comments there.
 *
 * The type-only import keeps this file free of runtime imports, so it also loads in jobs that
 * haven't run `pnpm install` (the CI smoke test). Other repos import `defineConfig` from
 * "@demonsters/launchset" instead.
 */

import type { LaunchsetConfig } from "./src/index.ts";

export default {
  baseBranch: "main",

  targets: {
    npm: {
      type: "custom",
      // The root package.json: its name and the registry come from there (spec 7.5). The
      // package is private (`access: restricted`), so the workflow gives `verify` a token.
      npm: { package: "package.json" },
      verify: ["npm"],
    },
    action: {
      type: "custom",
      // No `verify`: the publish script is idempotent by itself (it checks the action
      // repo's `v{version}` tag), see scripts/publish-action.ts.
    },
  },

  // Previews of an npm CLI are only useful as installable prereleases. A PR label preview would
  // build nothing anyone can run, so launchset's own preview workflow has no pull_request
  // trigger. What it does have: pushes to `next/*` publish `X.Y.Z-next.N` to the npm dist-tag
  // `next` (spec 9.9), so other demonsters repos can try a change with
  // `npm i @demonsters/launchset@next` before it is released. The action isn't previewed: its
  // `v1` tag must only ever point at real releases.
  preview: {
    branches: [{ branch: "next/*", prerelease: "next", targets: ["npm"] }],
    targets: ["npm"],
  },
} satisfies LaunchsetConfig;
