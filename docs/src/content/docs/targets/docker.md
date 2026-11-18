---
title: Docker
description: Build and push images with tags and labels that launchset renders from templates.
---

A `docker` target is an image. launchset doesn't build it. It tells your `docker/build-push-action` step which tags and labels to use.

```ts
targets: {
  "docker-api": {
    type: "docker",
    image: "ghcr.io/acme/api",
    verify: ["registry"],
  },
}
```

`image` is the name without a tag or digest. Pass a list to push to several registries.

## Build step

The generated workflow contains this:

```yaml
- id: stamp
  uses: demonsters/launchset-action@v1
  with:
    command: stamp
    target: ${{ matrix.target }}
    plan: ${{ needs.launchset.outputs.plan }}
- name: Build and push api
  if: matrix.target == 'docker-api' && steps.verify.outputs.already-published != 'true'
  uses: docker/build-push-action@v6
  with:
    context: apps/api
    push: true
    tags: ${{ steps.stamp.outputs.docker-tags }}
    labels: ${{ steps.stamp.outputs.docker-labels }}
```

The `stamp` step sets these outputs for a docker target:

| Output | Content |
| --- | --- |
| `docker-tags` | Full image references (`image:tag`), one per line. |
| `docker-refs-json` | The same, as a JSON array. |
| `docker-labels` | `org.opencontainers.image.version`, `.revision` and `.created`, one `key=value` per line. |
| `version`, `build-number`, `channel` | The usual outputs. |

## Tag templates

`tags` is either a list (the release tags) or an object with `release`, `preview` and `prerelease` lists. Each entry is a template.

| Placeholder | Value |
| --- | --- |
| `{version}` | The version of this run: the release, preview or prerelease version. |
| `{major}`, `{minor}`, `{patch}` | Parts of the plain `X.Y.Z` (for previews and prereleases: of the next version). |
| `{preid}` | The prerelease id (prereleases only). |
| `{prNumber}` | The PR number (PR previews only). |
| `{branchSlug}` | The branch slug (branch previews and prereleases only). |
| `{sha}`, `{shortSha}` | Full and 7-character commit sha. |
| `{buildNumber}` | The run's build number. |

Defaults:

| List | Default | Example result |
| --- | --- | --- |
| `release` | `["{version}", "{major}.{minor}", "{major}", "latest"]` | `1.5.0`, `1.5`, `1`, `latest` |
| `preview` | `["{version}", "pr-{prNumber}", "{branchSlug}"]` | `1.5.0-pr.123.4`, `pr-123` |
| `prerelease` | `["{version}", "{branchSlug}"]` | `1.5.0-alpha.3`, `next-new-form` |

Rules:

- A template with a placeholder that has no value in this run is skipped. `{prNumber}` on a branch preview, for example.
- On a **maintenance branch**, templates with neither `{version}` nor `{minor}` are dropped. A hotfix never moves `latest` or `{major}`. This applies to custom lists too.
- While the major version is **0**, templates with neither `{version}` nor `{minor}` are skipped, except the literal `latest`. A moving `:0` tag means nothing.
- The `release` list needs at least one template with `{version}`. `preview` and `prerelease` lists can't contain `latest` or a template that renders a plain `X.Y.Z`.
- Unknown `{placeholders}` are an error at config load.

### Keep a `v` prefix

Many existing setups tag images `v1.5.0`. Keep that:

```ts
tags: ["v{version}", "v{major}.{minor}", "v{major}", "latest"],
```

`launchset init` reads the current tags from your workflows and proposes this.

## Verify

`verify: ["registry"]` checks whether the **verify tag** already exists. That is the first release template containing `{version}`, rendered: `image:1.5.0` by default, `image:v1.5.0` with the list above. If it exists, `already-published` is `true` and your steps skip the build.

It uses the registry HTTP API. ghcr.io, Docker Hub and generic registries work. Credentials, in this order:

1. `LAUNCHSET_REGISTRY_USERNAME` and `LAUNCHSET_REGISTRY_PASSWORD`. They belong to `LAUNCHSET_REGISTRY_HOST`, or to the registry of the first image, and are never sent anywhere else.
2. The Docker config file (`$DOCKER_CONFIG/config.json` or `~/.docker/config.json`), per registry host.
3. Anonymous access.

For a private GHCR package, run a `docker/login-action` step **before** `verify`. The generated workflow does this and gives the job `packages: write`.

A failed check (auth, network) fails the step. It is never treated as "not published".

## Deploy manifests that pin the image

Kubernetes, Compose or Helm files often pin an image tag. Add an `image` file entry and the release PR updates the tag:

```ts
files: [{ path: "deploy/k8s/*.yaml", kind: "image" }],
```

Every `image:tag` reference to this target's image in those files gets the verify tag, for example `image: ghcr.io/acme/api:v1.5.0`. A glob may match files without a reference, but it must match at least one reference overall. Leave out manifests that hold deploy state you promote by hand, like a production overlay.

Untagged references and templated ones (`:${TAG}`) are skipped. A digest pin (`@sha256:...`) makes the stamp fail. Kustomize `images[].newTag` isn't covered.
