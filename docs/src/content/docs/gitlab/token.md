---
title: Token and permissions
description: Create the LAUNCHSET_TOKEN access token launchset needs on GitLab, and set up NPM_TOKEN, protected branches and pipeline variables.
---

launchset needs a token that can write to your project. You create it once per project (or per group), in the browser. An agent can't do this for you: it needs a Maintainer or Owner.

## Why a token

On GitLab the CI job token (`CI_JOB_TOKEN`) is not enough. Two things in launchset break because of it:

- **Pushes made with `CI_JOB_TOKEN` never start pipelines.** The release branch is pushed by launchset. If it used the job token, the release MR would get no pipeline, and a required pipeline would block the merge forever. The same holds for tags.
- **`CI_JOB_TOKEN` can mostly read.** It can read merge requests and notes and use the Releases API. It can't post notes, create or update MRs, or list pipeline jobs. (Since GitLab 18.4 a project may let it push, when "Allow Git push requests to the repository" is on, but those pushes still start no pipelines.)

A project or group access token has no such limit. launchset reads it from the CI/CD variable `LAUNCHSET_TOKEN`. When that variable is missing, launchset falls back to `CI_JOB_TOKEN` for reads only, and writes fail with an error that names the variable. It also accepts `GITLAB_TOKEN`.

## Create the token

1. Go to the project's **Settings → Access tokens** and click **Add new token**. For several projects, use the group's **Settings → Access tokens** instead.
2. **Token name**: `launchset`.
3. **Expiration**: pick one. Tokens expire (GitLab requires a date), so note when to rotate.
4. **Role**: **Maintainer**. See [below](#why-maintainer).
5. **Scopes**: tick exactly these two.

| Scope | Why launchset needs it |
| --- | --- |
| `api` | Open, update and close the release MR; post the sticky check and preview notes; create and update releases; read merge requests, commits and pipeline jobs. |
| `write_repository` | Push the release branch, marker, release, partial and prerelease tags with git. |

6. Click **Create project access token** and copy the value. GitLab shows it once.

The token creates a **bot user** (`project_<id>_bot_…`) that appears as a project member with the role you chose. Everything launchset does is done as that user: the release MR, the sticky notes and the release commit author.

## Add the variable

In **Settings → CI/CD → Variables**, add a variable:

| Setting | Value |
| --- | --- |
| Key | `LAUNCHSET_TOKEN` |
| Value | the token |
| Visibility | **Masked** |
| Flags: Protect variable | **off** |

:::caution
Don't mark `LAUNCHSET_TOKEN` as **Protected**. Protected variables are only passed to pipelines of protected branches and tags. MR pipelines run on the source branch, which is usually not protected, so the PR check couldn't post its note and MR previews couldn't comment. If you protect it anyway, the release jobs on the base branch still work, but the checks don't.
:::

Fork MR pipelines run without your project's variables. launchset can't be installed there (see [`NPM_TOKEN`](#npm_token)) and the check fails. That is the same trade-off as a fork PR on GitHub: no secrets for forks. Forks get no previews either.

## Why Maintainer

Developer is enough for the API. The reason for Maintainer is git: by default, only Maintainers may push to protected branches and create protected tags, and launchset pushes the base branch's release branch, marker tags, release tags, partial tags and prerelease tags. See [Protected branches and tags](#protected-branches-and-tags).

## `NPM_TOKEN`

Every launchset job installs the CLI with npm: `npm install --global "$LAUNCHSET_CLI"`, where `LAUNCHSET_CLI` is `@demonsters/launchset@<version>`, the version that wrote the files. The package is private. Add a second variable:

| Setting | Value |
| --- | --- |
| Key | `NPM_TOKEN` |
| Value | an npm token that can read `@demonsters/launchset` |
| Visibility | **Masked** |
| Protect variable | off, for the same reason |

The job sets it as the auth token for `registry.npmjs.org` before it installs. When `launchset` is already on the `PATH` of the image, the install is skipped and so is the login. To use a build from another source (a tarball, a Git URL, another registry), set the CI/CD variable `LAUNCHSET_CLI` to that spec. Then `NPM_TOKEN` may not be needed.

## Protected branches and tags

GitLab protects the default branch by default, and you may protect tags like `v*`. launchset pushes:

- `launchset/release/<branch>`: the release branch, force-pushed on every run.
- marker tags (`launchset/<target>@<version>`), partial tags (`launchset/partial/<version>`), the release tag (`v1.4.1`) and prerelease tags.

Check these:

- **Protected branches** (Settings → Repository): the base branch and maintenance branches (`release/*`) are normally push-protected. launchset doesn't push to them: it pushes `launchset/release/*` and opens an MR. Don't protect `launchset/release/*` against force pushes. If you protect `launchset/*` branches, add the token's bot (or Maintainers) to **Allowed to push and merge** and **Allowed to force push**.
- **Protected tags**: if `v*`, `launchset/*` or prerelease tags are protected, add the token's bot (or the Maintainers role) to **Allowed to create**. With GitLab's default (Maintainers can create), the Maintainer role is enough.
- **Push rules** (Premium): launchset commits as the token's user. If your push rules restrict author email or commit message, allow that user.

A rejected push prints which of these applies. See [Troubleshooting](/reference/troubleshooting/#gitlab).

## Pipeline variables for manual runs

Shipping a manual target, building a preview of any branch and retrying a release with options use pipeline variables (Build → Pipelines → Run pipeline). GitLab may block these. In **Settings → CI/CD → Variables**, **Minimum role to use pipeline variables** decides who can set them. The default is Maintainer on self-managed. **New projects on GitLab.com default to `no_one_allowed`**, which blocks those runs until you change it. A plain Run pipeline without variables works regardless: it retries an unfinished release.

## Commit identity

launchset commits (the release commit on the release branch) as the token's own user, looked up with `GET /user`. The name is the bot's name and the email is the user's email when GitLab shows one, else `<username>@noreply.<your host>`. If the lookup fails it uses `launchset <launchset@noreply.<your host>>`. This is on purpose: push rules that check the author accept the token's user. Don't hand-edit the release MR.

## Rotate the token

Create a new token, update the `LAUNCHSET_TOKEN` variable, then revoke the old one (Settings → Access tokens). Group access tokens work the same way and can serve several projects: the bot must then be a member of each project with Maintainer.

## Used by hand

When you run GitLab-facing commands locally (`launchset mark`, `launchset hotfix`), pass the token with `--token`, or set `LAUNCHSET_TOKEN` or `GITLAB_TOKEN`. Pass `--repo group/project` or let launchset read the `origin` remote. A personal access token with the `api` and `write_repository` scopes works too.
