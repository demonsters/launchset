---
title: "Google Play: upload key and service account"
description: Everything Android builds from CI need, step by step.
---

For Android builds from CI you need two things from Google:

1. an **upload key**, a keystore your CI signs the app bundle with,
2. a **service account** with access to your app in the Play Console, whose JSON key CI uses to upload and that launchset uses for `verify`.

You need a Google Play Console developer account, and the **Account owner** or **Admin** role to invite users.

## 1. Create the app in the Play Console

1. Open the [Play Console](https://play.google.com/console) → **Create app**.
2. Enter the name, language, app or game, and free or paid. Accept the declarations.
3. The **package name** (`applicationId`) is set by the first bundle you upload. It is the `store.packageName` in your launchset config.

A brand-new app can usually not be uploaded through the API until a first release exists. If the first upload from CI is rejected, upload one bundle by hand to the **Internal testing** track in the Play Console, then run CI again.

## 2. Create the upload key

Play App Signing is the default for new apps: Google holds the key that signs what users install, and you sign your uploads with an **upload key**.

On your machine:

```sh
keytool -genkeypair -v -storetype PKCS12 \
  -keystore upload.keystore -alias upload \
  -keyalg RSA -keysize 2048 -validity 10000
```

It asks for a password and some details. Remember the alias (`upload`), the store password and the key password. Back the keystore up in your password manager. If you lose it, an upload key can be reset through Play support.

In the Play Console, under **Test and release → Setup → App signing**, enrol in Play App Signing. When it asks for the upload certificate, export it from your keystore:

```sh
keytool -export -rfc -keystore upload.keystore -alias upload -file upload_certificate.pem
```

(An app that already uses an existing signing key has its own enrolment flow. Follow what the Console says.)

## 3. Create the service account

1. Open the [Google Cloud Console](https://console.cloud.google.com). Choose or create a project (any project works, for example `acme-play-ci`).
2. **APIs & Services → Library**: search for **Google Play Android Developer API** and click **Enable**.
3. **IAM & Admin → Service Accounts → Create service account**. Name it, for example `launchset-play`. No project roles are needed.
4. Open the new service account → **Keys → Add key → Create new key → JSON**. A `.json` file downloads. This is the secret. Note the service account's email (`launchset-play@acme-play-ci.iam.gserviceaccount.com`).

## 4. Give it access in the Play Console

1. Play Console → **Users and permissions → Invite new users**.
2. Enter the service account's email.
3. Under **App permissions**, add your app and grant:
   - **View app information and download bulk reports (read-only)**,
   - **Release to testing tracks**,
   - **Release to production, exclude devices, and use Play App Signing** (only if CI releases to production).
4. Click **Invite user**. A service account is active right away, but permission changes can take some time to apply.

## 5. Store the secrets

On your machine, with the GitHub CLI (see [how to add a secret](/store-pipelines/#add-a-secret)):

```sh
base64 < upload.keystore | tr -d '\n' | gh secret set ANDROID_KEYSTORE_BASE64 --repo acme/app
gh secret set ANDROID_KEYSTORE_PASSWORD --repo acme/app
gh secret set ANDROID_KEY_ALIAS --repo acme/app
gh secret set ANDROID_KEY_PASSWORD --repo acme/app
gh secret set LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON --repo acme/app < service-account.json
```

`LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON` takes the whole file. `verify` also accepts a base64-encoded copy, but store the JSON **raw**: fastlane `supply` reads the same secret as `SUPPLY_JSON_KEY_DATA` and needs the raw JSON. It must be a service account key of type `service_account`, not an OAuth client file.

## 6. Configure the workflow

1. Set `store.packageName` and `verify: ["store"]` on the `android` target. See [Android](/targets/android/#verify-against-google-play).
2. Put the keystore, Gradle and upload steps from [Workflow recipes](/guides/recipes/#android-with-gradle) into the release and preview workflows, and delete the failing **Build steps missing (android)** step.
3. Make `app/build.gradle` read the signing values from the environment (the recipe shows how).
4. Run a [preview build](/store-pipelines/#test-with-a-preview-build). A `preview` goes to the **internal** track.

## Checks

| Check | How |
| --- | --- |
| The secrets exist | `gh secret list --repo acme/app` shows the five names. |
| The workflow uses them | `grep -n "ANDROID_\|LAUNCHSET_PLAY" .github/workflows/launchset-*.yml` |
| The service account works | The `verify` step prints a line like `android: not published yet (Google Play (com.acme.app): highest versionCode is 12, below this run's 217175105: not published yet)`, or `android: already published: skip the upload and go straight to mark (...)`. |
| The upload worked | The release shows up under **Testing → Internal testing**. |

Common failures:

| Message | Cause |
| --- | --- |
| `LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON isn't valid JSON ...` | The secret holds something else than the JSON key file. |
| `... is missing client_email and private_key` | An OAuth client file was used. Create a service account key. |
| HTTP `401` or `403` | The service account isn't invited, lacks access to this app, the permission hasn't applied yet, or the Google Play Android Developer API isn't enabled in its Cloud project. |
| HTTP `404` | `store.packageName` doesn't match the app, or the app was never uploaded by hand (see step 1). |
| "already has versionCode ..." | The store is ahead of the build number. Raise `buildNumber.offset` as the message says. |
