---
title: "Apple: certificates, profiles and the API key"
description: Everything iOS builds from CI need, step by step.
---

For iOS builds from CI you need four things from Apple:

1. an **App ID** (bundle identifier) and an app record in App Store Connect,
2. a **distribution certificate**, as a `.p12` file,
3. an **App Store provisioning profile**, as a `.mobileprovision` file,
4. an **App Store Connect API key**, as a `.p8` file.

The certificate and the profile sign the build. The API key uploads it to TestFlight and lets launchset look at the builds that already exist.

You need a paid **Apple Developer Program** membership. Creating certificates, profiles and API keys needs the **Account Holder** or **Admin** role.

## 1. Register the App ID

1. Open [developer.apple.com/account](https://developer.apple.com/account) → **Certificates, Identifiers & Profiles** → **Identifiers**.
2. Click **+**, choose **App IDs** → **App**.
3. Enter a description and the **Bundle ID** (explicit, for example `com.acme.app`). It must equal `PRODUCT_BUNDLE_IDENTIFIER` in Xcode.
4. Tick the capabilities the app uses (push notifications, sign in with Apple, ...). Click **Register**.
5. Repeat for every extension or widget target. Each has its own bundle ID, for example `com.acme.app.widget`.

## 2. Create the app in App Store Connect

1. Open [appstoreconnect.apple.com](https://appstoreconnect.apple.com) → **Apps** → **+** → **New App**.
2. Choose iOS, a name, the primary language, the bundle ID from step 1 and a SKU.
3. Open the app → **App Information**. The numeric **Apple ID** (for example `1234567890`) is the `store.appId` in your launchset config.

## 3. Create the distribution certificate

Apple limits the number of distribution certificates per team. If your team already has an **Apple Distribution** certificate whose private key you have, export that one (step 3c) and skip to 3c.

**3a. Make a certificate signing request (CSR)** on a Mac:

1. Open **Keychain Access** → menu **Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority**.
2. Enter your email and a common name. Choose **Saved to disk**. Save the `.certSigningRequest` file.

**3b. Create the certificate:**

1. In **Certificates, Identifiers & Profiles → Certificates**, click **+**.
2. Choose **Apple Distribution**. Upload the CSR. Download the `.cer`.
3. Double-click the `.cer` to add it to your login keychain. It sits next to the private key from the CSR.

**3c. Export it as a `.p12`:**

1. In Keychain Access → **My Certificates**, find "Apple Distribution: Your Team (TEAMID)".
2. Right-click → **Export**. Choose the `.p12` format. Set a strong password. You'll store it as `IOS_CERTIFICATE_PASSWORD`.

## 4. Create the provisioning profile

1. **Certificates, Identifiers & Profiles → Profiles** → **+**.
2. Under **Distribution**, choose **App Store Connect** (older name: **App Store**). Continue.
3. Pick the App ID from step 1.
4. Pick the distribution certificate from step 3.
5. Name it, for example `Acme App Store`. This is the name you put in `ExportOptions.plist`.
6. Download the `.mobileprovision`.

Make one profile per bundle ID that you ship, extensions and widgets included.

When the certificate is renewed or revoked, profiles that use it become invalid. Create new ones and update the secret.

## 5. Create the App Store Connect API key

1. In App Store Connect: **Users and Access → Integrations → App Store Connect API → Team Keys**.
2. Click **+** (or **Generate API Key**). Name it, for example `launchset CI`. Choose the access role **App Manager**.
3. Click **Generate**, then **Download API Key**. You get `AuthKey_XXXXXXXXXX.p8`. **You can download it only once.**
4. Note two values on the same page: the **Key ID** (also in the file name) and the **Issuer ID** (at the top of the page).

## 6. Store the secrets

On your machine, with the GitHub CLI (see [how to add a secret](/store-pipelines/#add-a-secret)):

```sh
base64 < Certificates.p12 | tr -d '\n' | gh secret set IOS_CERTIFICATE_BASE64 --repo acme/app
gh secret set IOS_CERTIFICATE_PASSWORD --repo acme/app
base64 < Acme_App_Store.mobileprovision | tr -d '\n' | gh secret set IOS_PROVISIONING_PROFILE_BASE64 --repo acme/app
gh secret set LAUNCHSET_ASC_KEY_ID --repo acme/app
gh secret set LAUNCHSET_ASC_ISSUER_ID --repo acme/app
gh secret set LAUNCHSET_ASC_PRIVATE_KEY --repo acme/app < AuthKey_XXXXXXXXXX.p8
```

`gh secret set NAME` without input asks for the value without echoing it. `verify` accepts `LAUNCHSET_ASC_PRIVATE_KEY` as the raw `.p8` contents or a base64-encoded copy. **Store it raw** (as in the command above): the fastlane lane in the recipes reads the same secret as `key_content`, which needs the raw text.

## 7. Configure the workflow

1. Set `store.appId` and `verify: ["store"]` on the `ios` target. See [iOS](/targets/ios/#verify-against-app-store-connect).
2. Put the signing, archive, export and fastlane upload steps from [Workflow recipes](/guides/recipes/#ios-with-xcodebuild) into the release and preview workflows (the generated workflow has the archive and upload steps as comments), and delete the failing **Build steps missing (ios)** step.
3. Set the app target to **manual signing** with the profile name from step 4 in Xcode (**Signing & Capabilities**, untick *Automatically manage signing*). Use the team ID in `ExportOptions.plist` (**Membership details** in the developer account).
4. Run a [preview build](/store-pipelines/#test-with-a-preview-build).

## Checks

| Check | How |
| --- | --- |
| The secrets exist | `gh secret list --repo acme/app` shows the six names. |
| The workflow uses them | `grep -n "IOS_\|LAUNCHSET_ASC" .github/workflows/launchset-*.yml` |
| The API key works | The `verify` step prints a line like `ios: not published yet (App Store Connect (app 1234567890): highest build is 12, below this run's 217175105: not published yet)`, or `ios: already published: skip the upload and go straight to mark (...)`. An HTTP `401` means key ID, issuer ID and key don't belong together. A `403` means the key's role has no access to the app (use App Manager). A `404` means `store.appId` is wrong. |
| The certificate and profile work | The archive and export step passes. "No profiles for ... were found" means the profile name or bundle ID doesn't match. |
| The upload worked | The build appears in **TestFlight** within a few minutes. |

## Alternatives

- **fastlane match** keeps certificates and profiles in a private git repo or cloud storage and signs from there. It replaces steps 3 and 4 as secrets. It needs its own secrets (`MATCH_PASSWORD` and access to the storage).
- **Automatic signing with the API key** (`xcodebuild -allowProvisioningUpdates` with `-authenticationKeyPath`, `-authenticationKeyID` and `-authenticationKeyIssuerID`) lets Xcode create profiles itself. It needs a key with the Admin role. Manual signing is easier to reason about in CI.

## Export compliance

TestFlight asks about encryption for every build. Set `ITSAppUsesNonExemptEncryption` to `NO` in `Info.plist` if your app only uses the encryption built into iOS. Otherwise every build waits for a manual answer in App Store Connect.
