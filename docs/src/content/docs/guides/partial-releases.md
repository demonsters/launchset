---
title: Partial releases
description: What happens when a release is only partly shipped and a newer one replaces it.
---

A release is **complete** when every `auto` target has a marker tag. Sometimes it isn't: the iOS job failed on a signing problem, and nobody has fixed it yet. That version is **unfinished**.

## What launchset does

- The release tag `v1.4.0` is **not** created while a target is missing. `finalize` fails and lists the missing targets.
- Later pushes don't retry it. You can re-run the failed job, or start **Launchset release** by hand without inputs.
- `launchset status` shows it under "Unfinished releases" with what shipped and what is missing.

## Superseding

Only the newest version is ever published. When a newer version, say `1.4.1`, reaches `finalize`, and `1.4.0` has marker tags but no release tag, then `1.4.0` is **superseded**:

1. launchset creates the **partial tag** `launchset/partial/1.4.0` at the old release commit (`tags.partial`).
2. It creates a GitHub Release for it, marked **pre-release**, titled `v1.4.0 (partial, superseded by v1.4.1)`. The body lists which targets shipped and which didn't, plus the changelog section.
3. `1.4.0` never gets a release tag.

The partial tag sits outside the `v*` namespace on purpose, so existing `on: push: tags: ["v*"]` workflows don't fire for it. Keep `tags.partial` that way if you change it. It must differ from `tags.release`.

## Details

- Only **auto targets** count. A version that has every auto marker is a normal release, whether or not its manual targets were ever shipped.
- A superseded version is never published again. The release workflow warns about it, and pending changesets release a newer version.
- An older version that completes late (all auto markers exist) still gets its release tag and Release at the next `finalize`, unless it already has a partial tag. It isn't marked "latest" if a newer release exists.
- The decision is idempotent. Running `finalize` again changes nothing.

## What to do

| Situation | Action |
| --- | --- |
| One target failed, the cause is fixed | Re-run the failed job. `finalize` then creates the tag. |
| You want to rebuild what has no marker | Start the release workflow by hand with no inputs. |
| The version is broken and you have a fix | Merge a fix with a changeset. The new release supersedes the old one. |
