---
title: Setting up native store pipelines
description: The one-time work to get Android and iOS builds from CI into Google Play and TestFlight.
---

launchset doesn't sign or upload apps. Your workflow does, with credentials you create once. This section walks through creating them, storing them as GitHub secrets and testing the pipeline with a preview build.

It is written so that **a person can follow it, with an agent guiding**. Most steps happen in a browser, in the Apple, Google and GitHub UIs. Those steps need a person with the right role. An agent can explain each step, run the checks and fill in the workflow, but it should never see a secret value.

- [Apple: certificates, provisioning profiles and the App Store Connect API key](/store-pipelines/apple/)
- [Google Play: the upload key and a service account](/store-pipelines/google-play/)

## Which secrets exist

| Secret | Used by | What it is |
| --- | --- | --- |
| `LAUNCHSET_APP_ID`, `LAUNCHSET_APP_PRIVATE_KEY` | Every workflow | The GitHub App. See [GitHub App setup](/github-app/). |
| `ANDROID_KEYSTORE_BASE64` | Android build | The upload keystore, base64-encoded. |
| `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | Android build | Its passwords and alias. |
| `LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON` | `verify`, and the Play upload | The service account key (JSON). |
| `IOS_CERTIFICATE_BASE64`, `IOS_CERTIFICATE_PASSWORD` | iOS build | The distribution certificate as a `.p12`, base64-encoded, and its password. |
| `IOS_PROVISIONING_PROFILE_BASE64` | iOS build | The App Store provisioning profile, base64-encoded. |
| `LAUNCHSET_ASC_KEY_ID`, `LAUNCHSET_ASC_ISSUER_ID`, `LAUNCHSET_ASC_PRIVATE_KEY` | `verify`, and the TestFlight upload | The App Store Connect API key. |

The names starting with `LAUNCHSET_` are what launchset itself reads. The others are the names used in the [recipes](/guides/recipes/). You can rename them, as long as the workflow uses the same names.

## Add a secret

Never paste a secret value into a chat, an issue or a PR. Use the browser (Settings → Secrets and variables → Actions) or the GitHub CLI on your own machine:

```sh
# Text values: gh asks for the value without echoing it
gh secret set ANDROID_KEY_ALIAS --repo acme/app

# Files: pipe the file, base64-encoded on one line
base64 < upload.keystore | tr -d '\n' | gh secret set ANDROID_KEYSTORE_BASE64 --repo acme/app

# A file used as is
gh secret set LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON --repo acme/app < service-account.json

# Organization-wide, for selected repos
gh secret set LAUNCHSET_ASC_KEY_ID --org acme --visibility selected --repos app,other-app
```

Delete the downloaded key files from your machine afterwards, or store them in your team's password manager.

Check which secrets exist (names only, never values):

```sh
gh secret list --repo acme/app
gh secret list --org acme
```

## Test with a preview build

Test the pipeline before the first real release. A preview has no side effects in your repo, and goes to **internal** channels only.

1. Make sure the platforms are in `preview.targets` (the default `"all"` includes them).
2. Add your build and upload steps to `launchset-preview.yml`. Use the same steps as in the release workflow, without the `already-published` condition. Upload to the Play **internal** track and to TestFlight.
3. Put the workflow changes in the PR you test with. A `pull_request` workflow runs from the PR's own merge commit, so the PR tests its own copy of the workflow.
4. Open (or reuse) a PR with a changeset, and add the label `launchset:preview`.
5. Watch **Launchset preview**. The `plan` job prints the version, for example `1.5.0-pr.123.4`. Each `Preview <target>` job runs `stamp`, builds and uploads.
6. Read the sticky PR comment: one line per target with success or failure and a link to the job log.
7. Check the stores:
   - **Play Console → Testing → Internal testing**: a new release with the build number from the comment.
   - **App Store Connect → TestFlight**: a new build, status "Processing" and later ready.

Fix whatever fails and push again. Each push builds a new preview with a higher build number.

### Add store verification

Once uploads work, turn on the safety check in `launchset.config.ts`:

```ts
android: {
  type: "android",
  source: { kind: "gradle", file: "apps/mobile/android/app/build.gradle" },
  verify: ["store"],
  store: { packageName: "com.acme.app" },
},
ios: {
  type: "ios",
  source: { kind: "xcodeproj", file: "apps/mobile/ios/App.xcodeproj" },
  verify: ["store"],
  store: { appId: "1234567890" },
},
```

Add the `env:` block with the `LAUNCHSET_*` secrets to the `verify` step of the release workflow (see [recipes](/guides/recipes/#the-verify-steps-environment)). Previews don't run `verify`.

Run a release or `launchset verify` to see it work. Store verification is described in [Build numbers](/guides/build-numbers/).

## For the agent guiding a human

- Walk through one step at a time. Say where the human has to click, and what they should see.
- Tell the human which commands to run on their own machine. Never ask them to paste a key, password, certificate or token.
- Check progress by **names**: `gh secret list`, secret names in the workflow YAML (`grep -n "secrets\." .github/workflows/*.yml`), the config (`verify`, `store.packageName`, `store.appId`).
- Check the pipeline by **results**: the preview run, the PR comment, the job logs. A failing `verify` step prints what is wrong: a missing variable, a bad key, a store that is ahead.
- Never store a secret in the repo, in a file you create or in a log. Treat anything under `~/Downloads` with `.p8`, `.p12`, `.pem`, `.keystore` or `service-account` in its name as secret.
