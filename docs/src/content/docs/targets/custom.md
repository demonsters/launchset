---
title: Custom
description: "Anything that isn't Docker, web, Android or iOS: an npm package, a Helm chart, a version file."
---

A `custom` target is an entry in the build matrix plus a marker. The release PR has already bumped the root version, and your build step does the rest.

```ts
npm: {
  type: "custom",
  verify: ["npm"],
},
```

launchset releases itself this way: an `npm` target and an `action` target, both `custom`, with no `files`.

## Build steps

A custom target with `verify: ["npm"]` gets working npm publish steps. Any other custom target gets commented examples and a failing step named **Build steps missing (<target>)**. Add your steps, then delete it.

## Extra files

Any target can list `files`. A `custom` target with files stamps them, and other targets stamp these extra files in addition to their own.

```ts
helm: {
  type: "custom",
  files: [
    { path: "charts/app/Chart.yaml", kind: "yaml", key: "appVersion" },
    { path: "packages/sdk/package.json", kind: "json", key: "version" },
    {
      path: "src/version.ts",
      kind: "regex",
      pattern: 'export const VERSION = "[^"]+"',
      replace: 'export const VERSION = "{version}"',
    },
  ],
}
```

| `kind` | What it edits | Notes |
| --- | --- | --- |
| `json` | A dotted `key` in a JSON file. | Text-preserving: only that value changes. Duplicate keys are an error. |
| `yaml` | A dotted `key` in a YAML file, such as `Chart.yaml`. | Keeps quote style. A key in several documents is an error. |
| `regex` | Text matched by `pattern`. | The pattern must match exactly once. `flags` may contain `i`, `m`, `s`, `u`. |
| `image` | Image references in deploy manifests. | Docker targets only. See [Docker](/targets/docker/#deploy-manifests-that-pin-the-image). |

Placeholders in a regex `replace`: `{version}`, `{major}`, `{minor}`, `{patch}` and `{buildNumber}`. Other `{...}` stays as it is, so JSON and code in the replacement are fine. `$1`, `$<name>` and `$&` work like in `String.prototype.replace`. A `replace` with `{buildNumber}` is only stamped in CI, never by the release PR.

## npm packages

Add `verify: ["npm"]` so a re-run never fails on a version that is already published.

```ts
npm: {
  type: "custom",
  verify: ["npm"],
  npm: { package: "package.json" },   // the default
},
```

`verify` reads the package name from that `package.json`, and the registry from `publishConfig.registry`, then `.npmrc`, then `https://registry.npmjs.org`. It looks up the exact version.

- The version exists: `already-published` is `true`. Skip `npm publish`.
- The version or the package doesn't exist (404): `false`.
- Any other error (auth, network) fails the step. It is never treated as "not published".

Private packages need read access. Two ways:

- **npm trusted publishing (recommended, no token to rotate).** On npmjs.com, open the package's **Settings → Trusted publishing**, add GitHub Actions with your repository and the release workflow's file name, and give the build job `permissions: id-token: write`. `npm publish` then authenticates through the workflow's OIDC token, and `verify` exchanges the same token for a short-lived read token. Trusted publishing can only be set up for a package that exists, so publish the first version once by hand (or with a token).
- **A token:** set `LAUNCHSET_NPM_TOKEN` or `NODE_AUTH_TOKEN` (the first wins) for `verify`, and `NODE_AUTH_TOKEN` for `npm publish`.

Publish with the `dist-tag` output, so a hotfix doesn't move `latest`:

```yaml
- uses: actions/setup-node@v5
  if: matrix.target == 'npm' && steps.verify.outputs.already-published != 'true'
  with:
    node-version: 24
    registry-url: https://registry.npmjs.org
- run: npm publish --tag ${{ steps.stamp.outputs.dist-tag }}
  if: matrix.target == 'npm' && steps.verify.outputs.already-published != 'true'
  # With a token instead of trusted publishing:
  # env:
  #   NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

`dist-tag` is `latest` for base-branch releases, `release-<major>.<minor>` on maintenance branches, the prerelease id for prereleases and `pr-<n>` or the branch slug for previews.

If the root `package.json` is published, a `package-lock.json` or `npm-shrinkwrap.json` next to it gets its root version updated together with `package.json`. pnpm, Yarn and Bun lockfiles don't store the root version and need nothing.
