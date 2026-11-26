---
bump: minor
---

launchset is open source under the MIT license, and the npm package is now `launchset` (it was `@demonsters/launchset`). Run it with `npx launchset`; the package is public, so no npm token is needed to install it. Existing setups keep working:
    - Configs that import `defineConfig` from `@demonsters/launchset` still load. New configs written by `launchset init` import it from `launchset`. To switch an existing config, change the import and, if the repo installs the package, the dependency in `package.json`.
    - A pre-push hook that runs `npx @demonsters/launchset check --push` still counts as installed, so `init` doesn't add a second one. It keeps running the old package, which gets no new versions: change it to `npx launchset check --push`.
    - On GitLab, jobs written by this version install `launchset@<version>` and no longer log in to npm with `NPM_TOKEN`, so the `NPM_TOKEN` variable isn't needed any more. Files written by an earlier `init` keep installing `@demonsters/launchset` at the version that wrote them: to move on, change `LAUNCHSET_CLI` in the `.launchset-cli` job of `.gitlab/launchset.yml` to `launchset@<version>`.
    - The GitHub Action `demonsters/launchset-action@v1` doesn't change, and is MIT licensed too. It now ships the licenses of the packages bundled into it, in `dist/THIRD_PARTY_LICENSES.txt`.
