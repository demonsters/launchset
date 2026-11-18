---
title: Web
description: "A web app target: the version is already in package.json."
---

A `web` target is an entry in the build matrix and a marker. launchset stamps nothing by default, because the root `package.json` already carries the version.

```ts
targets: {
  web: { type: "web" },
}
```

In CI, `launchset stamp` also writes the run's version into the root version file, so a web build or a preview sees the preview version in `package.json`.

If your app reads the version somewhere else, add `files`:

```ts
web: {
  type: "web",
  files: [{ path: "public/version.json", kind: "json", key: "version" }],
}
```

See [Custom targets](/targets/custom/#extra-files) for all kinds.

## Build step

The generated workflow contains a failing step named **Build steps missing (web)**. Add your build and deploy steps, then delete it.

Environment variables from the `stamp` outputs are the simplest way to hand the version to a build:

```yaml
- run: npm ci && npm run build
  if: matrix.target == 'web' && steps.verify.outputs.already-published != 'true'
  env:
    LAUNCHSET_VERSION: ${{ steps.stamp.outputs.version }}
    LAUNCHSET_BUILD_NUMBER: ${{ steps.stamp.outputs.build-number }}
    LAUNCHSET_CHANNEL: ${{ steps.stamp.outputs.channel }}
- name: Deploy (web)
  if: matrix.target == 'web' && steps.verify.outputs.already-published != 'true'
  run: ./scripts/deploy-web.sh
```

`channel` is `release`, `prerelease` or `preview`. Deploy releases to production and previews somewhere internal.

Web targets have no `verify` checks.
