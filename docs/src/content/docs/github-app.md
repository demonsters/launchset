---
title: GitHub App setup
description: Create the GitHub App that lets launchset open release PRs and push tags, step by step.
---

launchset needs a GitHub App. You create it once per org (or per user account), in the browser. An agent can't do this for you: it needs an org owner.

On GitLab? You need an access token instead: see [Token and permissions](/gitlab/token/).

## Why an App

Events caused by the default `GITHUB_TOKEN` don't start other workflows. That is a GitHub rule to stop endless loops. Two things in launchset would break because of it:

- The **release PR** is opened by launchset. If it used `GITHUB_TOKEN`, the PR would get no CI runs, and required checks would block the merge forever.
- **Tags and branches** pushed by launchset would not start the workflows that listen to them.

A token from a GitHub App has no such limit. The workflows mint one with `actions/create-github-app-token` and pass it to the launchset action as `token`.

The PR check (`command: check`) only reads and comments, so it uses the normal `GITHUB_TOKEN`.

## Works for any org

The launchset action is public (`demonsters/launchset-action`). Any repo in any org can use it. The only thing each org needs is its own App, with its Client ID and private key stored in the org. No org access settings, no tokens to share between orgs.

## Create the App

1. Go to your organization's **Settings → Developer settings → GitHub Apps** and click **New GitHub App**. (For a personal account: **Settings → Developer settings → GitHub Apps**.)
2. **GitHub App name**: `launchset` (names are unique across GitHub, so add your org name if it is taken).
3. **Homepage URL**: any URL, for example your repo's URL. GitHub requires one.
4. **Webhook**: untick **Active**. launchset doesn't use webhooks.
5. **Repository permissions**: set the ones in the table [below](#permissions) and leave every other permission at **No access**.
6. **Where can this GitHub App be installed?** Choose **Only on this account**.
7. Click **Create GitHub App**.

### Permissions

<!-- generated:app-permissions:start -->
| Repository permission | Access | Why launchset needs it |
| --- | --- | --- |
| Contents | read & write | Push the release branch, marker, release, partial and prerelease tags; create and update GitHub Releases; read commits and their associated pull requests. |
| Pull requests | read & write | Open, update and close the release PR and the changelog backport PR; post the sticky check and preview comments (PR comments use the issues API, which accepts Pull requests: write); list PR files for bot-PR detection. |
| Workflows | read & write | The release branch is rebuilt from the base branch and force-pushed. GitHub rejects an App's push that brings in commits changing .github/workflows/* ("refusing to allow a GitHub App to create or update workflow … without `workflows` permission"), which happens whenever the base branch changed a workflow since the last release-PR push. |
| Actions | read | List the jobs of the current workflow run, for per-target links in the preview comment and the job summary. |
| Metadata | read | Mandatory for every GitHub App (granted automatically). |
<!-- generated:app-permissions:end -->

Issues and Checks are not needed. The Metadata permission is granted automatically.

## Save the Client ID and a private key

1. On the App's settings page (**General**), note the **Client ID** (it starts with `Iv`). It is not secret: it only identifies the App.
2. Scroll to **Private keys** and click **Generate a private key**. A `.pem` file downloads. Keep it safe: it is the App's password.

## Install the App

1. In the App's settings, open **Install App** and click **Install** next to your organization.
2. Choose **Only select repositories** and pick the repos that use launchset. Choose carefully: see the warning below.
3. Click **Install**.

:::caution
The **Workflows** permission lets the App change `.github/workflows/*` in every repo it is installed on. launchset needs it, because the release branch is rebuilt from the base branch and force-pushed, and GitHub rejects an App's push that brings in workflow changes without it. Install the App on selected repositories only, and treat the private key like a deploy key.
:::

## Add the Client ID and the private key

Create an **organization variable** and an **organization secret** (Settings → Secrets and variables → Actions):

| Name | Kind | Value |
| --- | --- | --- |
| `LAUNCHSET_APP_CLIENT_ID` | Variable (**Variables** tab) | The Client ID, for example `Iv23liAbCdEf123456`. |
| `LAUNCHSET_APP_PRIVATE_KEY` | Secret (**Secrets** tab) | The whole contents of the `.pem` file, including the `-----BEGIN` and `-----END` lines. |

Under **Repository access**, allow the repos that use launchset. For a personal account, which has no org variables or secrets, add the same two to each repo (Settings → Secrets and variables → Actions, the **Variables** and **Secrets** tabs).

The Client ID is a variable, not a secret, because it isn't sensitive: anyone who knows it still needs the private key. As a variable it stays readable in the settings and in logs.

The generated workflows already read them:

```yaml
- id: app-token
  uses: actions/create-github-app-token@v3
  with:
    client-id: ${{ vars.LAUNCHSET_APP_CLIENT_ID || secrets.LAUNCHSET_APP_ID }}
    private-key: ${{ secrets.LAUNCHSET_APP_PRIVATE_KEY }}
```

### Older setups: the secret `LAUNCHSET_APP_ID`

Earlier setups stored the numeric **App ID** as the secret `LAUNCHSET_APP_ID`, passed to the action's `app-id` input. `actions/create-github-app-token@v3` deprecates `app-id` in favour of `client-id`. Nothing breaks:

- The workflows fall back to `secrets.LAUNCHSET_APP_ID` when the variable `LAUNCHSET_APP_CLIENT_ID` doesn't exist. GitHub accepts the App ID wherever it accepts the Client ID (as the issuer of the App's JWT), so the token is the same and there is no deprecation warning.
- Workflows generated earlier still use `actions/create-github-app-token@v2` with `app-id`. They keep working: launchset never rewrites them. To move them to v3, change `@v2` to `@v3` and `app-id: ${{ secrets.LAUNCHSET_APP_ID }}` to the `client-id` line above, in every `app-token` and `mark-token` step.

To finish the move, add the variable `LAUNCHSET_APP_CLIENT_ID` (App settings → General → Client ID). Once every repo's workflows use the `client-id` line, you can delete the secret `LAUNCHSET_APP_ID`.

## Check that it works

1. Merge a PR with a changeset into the base branch.
2. The **Launchset release** workflow runs. The `launchset` job should open a PR titled `Release vX.Y.Z`.
3. The release PR should show CI checks running, including **Changeset check**. If it shows none, see [Troubleshooting](/reference/troubleshooting/).

## Branch and tag protection

If your repo uses rulesets or branch protection:

- Allow the App to push to `launchset/release/*` (force pushes included). Don't protect those branches against force pushes.
- If tag rules protect `v*`, `launchset/*` or prerelease tags, add the App to the bypass list. launchset creates marker, release, partial and prerelease tags with the App token.
- Require the **Changeset check** status on the base branch if you like. The release PR is exempt from needing a changeset.

## Rotate the key

Generate a new private key on the App's settings page, update `LAUNCHSET_APP_PRIVATE_KEY`, then delete the old key.

## Used by hand

When you run GitHub-facing commands locally (`launchset mark`, `launchset hotfix`), pass a token with `--token`, or set `LAUNCHSET_TOKEN` or `GITHUB_TOKEN`. A personal access token or the App's installation token works.
