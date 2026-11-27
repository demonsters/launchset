---
name: launchset-adopt
description: Use when asked to set up launchset in a repo, move a repo to launchset, migrate a repo from Changesets, tag-triggered release workflows or hand-made release scripts to launchset, or adopt "one version, many targets" releases (Docker, Android, iOS, web), including repos that also publish independently versioned npm packages with Changesets. Covers the whole procedure: detect, ask the human the right questions, retire conflicting release machinery, run launchset init with decisions, and open one PR. Not for working in a repo that already uses launchset (that is the launchset skill).
---

# Move a repo to launchset

launchset releases repos where **one version** drives **many targets** (Docker images, Android, iOS and web apps) from one repo. Developers add a small changeset file to each PR. launchset collects them into a release PR. Merging it releases every target. launchset builds nothing: the team's own workflow steps do.

You are moving an **existing** repo onto it. This works on GitHub and on GitLab (GitLab.com or self-managed 18.2+); the steps below name both where they differ. The CLI does the detecting and the writing. Your job is to ask the human the right questions, deal with what conflicts, move the team's build steps, and deliver one reviewable PR.

Use `npx launchset` (Node 24 or newer). If `npx` can't run it, tell the human and stop.

## The rules

1. **Detect first. Write nothing until the human has seen the decisions.** `init --detect` never writes.
2. **Ask only what matters**, with the evidence. Don't ask about decisions whose default is clearly right.
3. **Never handle secret values.** Certificates, keys, passwords, tokens and service accounts are created and stored by a human. You check names, never values.
4. **Never lower a version, and never create a baseline tag, without the human's explicit answer.**
5. **Keep existing conventions** (tag format, Docker image tags) unless the human decides otherwise. Deploy tooling depends on them.
6. **Remove or adapt conflicting machinery only after the human agrees.**
7. **Don't migrate what doesn't fit**, and say why (see the end).
8. **Look up action versions; don't trust what you remember.** Your knowledge of the latest GitHub Action releases is months or years old. Before you write or keep a `uses: owner/repo@vN`, check the latest release, and bump only after you've checked compatibility (see "Check the action versions" in Step 6).

## Step 1: Detect

```sh
npx launchset init --detect --json > /tmp/launchset-init.json
```

(For a human-readable summary: `init --detect`.) Read the JSON. Its shape:

- `schemaVersion`: `1`.
- `detection`: what was found.
  - `versions[]` and `tags[]`: every version found, per file (`source` is `root`, `docker-package`, `native` or `tag`, with `path`, `line`, `key`, `value`, `plain`) and every release-like tag.
  - `canonical`: the proposed version, `reason` and `evidence`.
  - `targets[]`: detected platforms (`name`, `type` `docker|android|ios|web`, `dir`, `source`, `files`, `builtBy`, `proposed` `auto|manual|none`, `reason`, `ask`, and for Docker `docker` with `dockerfile`, `context`, `image`, `tags`).
  - `workflows[]`: existing workflow files and what they build.
  - `machinery[]`: existing release machinery that conflicts, each with `id`, `kinds`, `path`, `line`, `what`, `reasons`, `actions` and `effects`.
  - `imagePins[]`: deploy manifests that pin a Docker image tag (`path`, `target`, `image`, `refs`).
  - `buildNumbers`: the highest build number found, `strategyNow`, and the proposed `offset`.
  - `changesets`: `.changeset/*.md` files to convert, and `preMode`.
  - `hooks[]`: husky, simple-git-hooks or lefthook setups.
  - `notes[]`: warnings and info.
  - `existingConfig`: set when a `launchset.config.*` exists. `init` refuses to overwrite it.
- `decisions[]`: each with `id`, `question`, `options[]` (`value`, `label`), `freeform` (other values accepted), `default`, `evidence[]` (`path`, `line`, `note`), `ask` (`true` when the default is a guess or a risk) and `onlyIf` (the decision only matters for certain answers to another).

If `init` fails with `already-initialized`, the repo already has a config: don't continue. Tell the human.

## Step 2: Decide with the human

Group the decisions for the human. Ask the ones with `"ask": true`, and these three **always**:

1. **Lowering any version.** The default is the highest version found, and it never lowers one. If the human wants a lower one, `--decide version=<lower>` is the only way, and init warns about each file that goes down. Explain: stores reject lower marketing versions, and image tags would go backwards.
2. **A baseline tag** for a version that has no release tag (`baseline`). A baseline tag makes launchset treat the version as already released, so it never builds it, and pinned images might not exist. Default `yes` only when a tag in another format already marks it as released. Without a baseline tag, if the PR changes the root version, merging it is read as a release of that version and builds every target.
3. **Native projects that no workflow builds** (`target.<name>`, proposed `manual`). Suggest `release: "manual"` and explain: the version is stamped by every release so native files never drift, but the store build is shipped on demand with a workflow run or `launchset ship`, and the release tag doesn't wait for it. The alternatives are `auto` (every release builds and uploads it) and `none` (not a target).

The decision ids and values:

| Id | Values | Meaning |
| --- | --- | --- |
| `host` | `github`, `gitlab` | The code host. Only listed when something points at GitLab (a GitLab remote, `.gitlab-ci.yml`). Check it: it decides which CI files init writes. |
| `version` | plain `X.Y.Z` | The version the repo is on. |
| `version.file` | a Flutter app's `pubspec.yaml`, or `package.json` | Only when the repo has no `package.json` and has a Flutter app. Default: the app's `pubspec.yaml` holds the version. `package.json` makes init create one that only holds the version. Ask when there are several Flutter apps. |
| `tags.release` | template with `{version}` | The release tag format. Keep the existing one, for example `{version}` without a `v`. |
| `target.<name>` | `auto`, `manual`, `none` (`custom`: declare a target init didn't detect) | How a detected platform is released. This includes custom targets from jobs that run on release tags and keep artifacts, deploy or publish: on GitLab named after the job (`package:windows` is `windows`), on GitHub after the workflow file (`desktop-linux.yml` is `desktop-linux`). Their tag trigger is retired, so without the target the build would stop running for releases. `--decide target.<name>=custom` adds a custom target nothing detected, for a project init finds nothing in. |
| `gitlab.<name>.shell` | `sh`, `powershell` | GitLab custom targets from a job: the runner's shell. `powershell` when the job's scripts use PowerShell or it runs on a `windows`-tagged runner. |
| `gitlab.templates` | `move`, `keep` | GitLab: move the hidden templates the target jobs extend from `.gitlab-ci.yml` to `.gitlab/ci-templates.yml` (default), which `.gitlab-ci.yml` and the child pipeline (`gitlab.include`) both include. With `keep`, the copied target jobs can't extend them in the child pipeline. |
| `docker.<name>.image` | image name without a tag | Read from existing workflows, otherwise a guess (`ask`). |
| `docker.<name>.tags` | `default` or a comma-separated list of templates | Keep the existing tag pattern, for example `v{version}, v{major}.{minor}, v{major}, latest`. |
| `docker.<name>.verify` | `yes`, `no` | Default `yes`: `verify: ["registry"]`, so a re-run skips an image that is already pushed. |
| `machinery.<path>#<n>` | `remove`, `disable`, `keep` | What to do with one piece of conflicting machinery. Copy the exact `id` from the JSON (a path starting with a dot gives `machinery..github/workflows/x.yml#1`). |
| `image.<path>` | `stamp`, `leave` | Whether the release PR updates the image tag a deploy manifest pins. |
| `file.<path>` | `keep`, `overwrite` | A file init would write already exists (`.launchset/README.md`, `launchset-*.yml`). Default `keep`: it stays as it is. `overwrite` replaces it with the newly generated file. Ask only if the existing file looks hand-edited and should be regenerated. |
| `baseline` | `yes`, `no` | Create the release tag for the version at HEAD. |
| `offset` | integer `>= 0` | `buildNumber.offset`, so new build numbers stay above the existing ones. |
| `skill` | `yes`, `no` | Install the `launchset` skill and an `AGENTS.md` section. |
| `hook` | `yes`, `no` | Add `launchset check --push` to the existing pre-push hook. Only exists when a hook setup was found. |

## Step 3: Find and explain what conflicts

launchset pushes its tags and creates GitHub Releases with a GitHub App token, which **does** start other workflows. Look at `detection.machinery[]` and read the files. Explain each in plain words, with `path:line`:

- **Tag-triggered workflows** (`on: push: tags: v*` and similar): they would fire again on launchset's release tag and build or publish twice.
- **Changesets**: `changesets/action`, `changeset version|status|publish|tag` in workflows or `package.json` scripts, `@changesets/write`. launchset's release PR replaces them. Exception: when Changesets also publishes npm packages that have their own versions, it stays for those packages (see "Repos that also publish npm packages" below).
- **Other release tools** (semantic-release, release-it, standard-version, release-please) and steps that create tags or GitHub Releases (`git tag`, `gh release create`): launchset's finalize creates `v<version>`.
- **Scripts that write version or build numbers** (`MARKETING_VERSION`, `CURRENT_PROJECT_VERSION`, `versionCode`, `versionName`, fastlane version actions, and for Flutter `cider`, `pubver`, `sed -i` / `yq -i` on `pubspec.yaml` or a Dart script in `tool/` that rewrites its `version`): they would overwrite the numbers stamped in CI. `melos version` counts as another release tool.
- **Docker pushes of `latest` on branch pushes**: launchset moves `latest` only when a release ships.
- **On GitLab:** the same kinds of machinery in `.gitlab-ci.yml` and the local files it includes: jobs that run on tags (`$CI_COMMIT_TAG`), `glab release create`, the `release:` keyword, `npm publish`, Docker pushes of `latest` from branch pushes. Remote, project and template includes aren't scanned: read them yourself. For a tag job that something else starts too (`- when: manual` for a trial build, a branch rule), `disable` removes only its tag rule; a job that only other removed jobs need can go with them (its decision is only offered while those are disabled). A note says when `workflow: rules` let tag pipelines run: launchset's own tags start none (it pushes them with `-o ci.skip`), but explain that other tag pushes still do, and that the rule may only have served the release jobs being retired.
- **Release instructions** in `CLAUDE.md`, `AGENTS.md` and the README (`npm version`, `git tag`, `changeset`): they describe the old process.

For each, propose `disable` (remove only the conflicting trigger or step, never the file), `remove` (delete the file or script) or `keep`, and why. Do it only after the human agrees. Where `disable` isn't offered, no minimal edit exists: the choice is `keep` or `remove`.

Also check, by reading the repo:

- **Long-lived Changesets pre-mode branches** (`.changeset/pre.json` on a branch): propose a prerelease branch entry (`preview.branches: [{ branch: "next", prerelease: "beta" }]`) and, on that branch, `npx launchset init --convert-only`. `pre.json` is ignored with a warning.
- **Deploy manifests that pin an image tag** (`imagePins[]`): ask per file. `image.<path>=stamp` makes the release PR update it to each release. `leave` keeps it as deploy state that is promoted by hand (for example a production overlay).
- **Docker image names and tags**: keep what deploy tooling pulls (`v{version}`).
- **Flutter apps** (`detection.flutterApps`): their targets use `source: { kind: "flutter", dir }` and stamp only `pubspec.yaml`. Show the human every warning note about native projects that don't read Flutter's numbers (`versionCode` not `flutter.versionCode`, `CFBundleVersion` not `$(FLUTTER_BUILD_NUMBER)`): without a fix, the stamped numbers never reach the app. Propose the fix the note names, and make it only after the human agrees. A note about Codemagic or Bitrise means the app is built outside GitHub Actions and GitLab CI: launchset can't run there, so ask whether the builds move or the apps become manual targets.

## Step 4: Native store pipelines

Signing certificates, provisioning profiles, the Google Play upload key, the App Store Connect API key, the Play service account and the GitHub secrets are set up by a **human**. Guide them step by step with the docs pages "Setting up native store pipelines" (Apple and Google Play). Check each step without seeing a secret:

- Secret **names** exist: `gh secret list --repo <owner/repo>` (and `--org <org>`). Variables: `gh variable list --repo <owner/repo>` (and `--org <org>`).
- The workflow uses the same names: `grep -n "secrets\." .github/workflows/launchset-*.yml`.
- The config has `verify: ["store"]` with `store.packageName` or `store.appId`.
- A **preview build** passes: label a PR with `launchset:preview`, and read the PR comment and the job logs. A failing `verify` step prints what is wrong.

Never ask for, read or store a key, password, certificate, token or service account file. If one is pasted into the chat, tell the human to rotate it.

The **GitHub App** (the variable `LAUNCHSET_APP_CLIENT_ID` and the secret `LAUNCHSET_APP_PRIVATE_KEY`; older setups have the secret `LAUNCHSET_APP_ID` instead of the variable, which the workflows still accept) is also created by a human, an org owner. Point to the docs page "GitHub App setup". Permissions: Contents (read & write), Pull requests (read & write), Workflows (read & write), Actions (read), Metadata (read).

**On GitLab** a human creates a project or group access token (role Maintainer, scopes `api` and `write_repository`) and stores it as the masked, **not Protected** CI/CD variable `LAUNCHSET_TOKEN`, plus `NPM_TOKEN` (masked) for the private package. Point to the docs page "Token and permissions" (GitLab). You check variable names (`glab variable list` or the Settings page), never values. Protected branches and tags must let the token's bot push; "Minimum role to use pipeline variables" must allow manual runs.

## Step 5: Run init with the answers

```sh
npx launchset init --yes \
  --decide version=1.4.0 \
  --decide target.android=manual \
  --decide docker.api.tags='v{version}, v{major}.{minor}, v{major}, latest' \
  --decide 'machinery..github/workflows/release.yml#1=disable'
```

- `--yes` accepts the default of every decision you don't give. Never leave a conflict in place silently: give an answer for each.
- Quote values that have spaces or braces. An invalid value fails before anything is written (`expected one of ...`). An unknown id lists the valid ones.
- `--baseline`, `--skill` and `--hook` (and the `--no-` forms) are shortcuts for the three yes/no decisions.

Then look at the result: `git status`, `git diff`. Init writes (files that already exist are kept unless `file.<path>=overwrite`) `launchset.config.ts`, `.launchset/README.md`, `.github/workflows/launchset-check.yml`, `launchset-release.yml` and `launchset-preview.yml` (on GitLab instead `.gitlab/launchset.yml`, `.gitlab/launchset-targets.yml`, `.gitlab/ci-templates.yml` when templates moved, and a `.gitlab-ci.yml`, or only `include:` entries added to yours; init doesn't edit your `workflow:` and prints the recommended `workflow: rules` as a manual step), `CHANGELOG.md` (only if missing), converted changesets (`.changeset/*.md` to `.launchset/`, the folder is left in place), and the agent skill and `AGENTS.md` section.

Run `npx launchset status`, `version --dry-run` and `plan` to see that the config loads and the files are consistent.

## Step 6: Move the team's build steps

The generated workflows have commented examples where the team's build steps go. Move the existing steps from the old workflows, keeping secrets and environments as they are:

- Docker: the `docker/build-push-action` settings (`context`, `file`, `platforms`, build args). The tags and labels come from `steps.stamp.outputs.docker-tags` and `docker-labels`.
- Android and iOS: Gradle or `xcodebuild`, signing, fastlane. iOS runs on macOS.
- Flutter: `flutter build appbundle` / `flutter build ipa`, with `--build-name` and `--build-number` from the stamp step (the generated examples show how). Drop the old step's own `--build-number` (a run number, a date): a note names those lines.
- Deploys, npm publishing and other steps.
- Give every step `if: matrix.target == '<name>' && steps.verify.outputs.already-published != 'true'` in the release workflow.
- Custom targets from a GitHub workflow that release tags started: init already copied that job's steps, commented out, under the target's `Build steps missing` step in `launchset-release.yml` (and `launchset-preview.yml`), each with the `if:`. The `actions/checkout` step is left out: launchset's checks out the release commit, so add what the old one set (`lfs: true`, the note says) to it. Uncomment the steps, check them, then remove the guard. Previews run them too.

### Check the action versions

Do this for every `uses:` in the workflows the PR adds or changes: the steps init generated, the team's steps you moved, and anything you added. The generated pins were current when the launchset version you ran was released, which may be months ago. The team's pins are often older. Your own memory is older still.

1. **Find the latest release** of each action:
   ```sh
   gh api repos/<owner>/<repo>/releases/latest --jq .tag_name
   ```
   A 404 means the action publishes tags only: `gh api repos/<owner>/<repo>/tags --jq '.[].name'`, or `git ls-remote --tags https://github.com/<owner>/<repo>` without `gh`. Compare majors (`v7` against `v7.1.0`). Pins to a SHA or branch are the team's choice: leave them.
2. **Check compatibility before you bump.** For each major between the pin and the latest, read the release notes (`gh api repos/<owner>/<repo>/releases/tags/<tag> --jq .body`, or the action's CHANGELOG), and look for:
   - **Inputs.** Every input the step passes must still exist and mean the same thing. Read `action.yml` at the new tag (`gh api 'repos/<owner>/<repo>/contents/action.yml?ref=<tag>' --jq .content | base64 -d`), and look for removed, renamed or `deprecationMessage` inputs and changed defaults.
   - **Outputs** that later steps read (`steps.<id>.outputs.*`).
   - **Behaviour** the workflow depends on: triggers it now refuses (for example `actions/checkout@v7` won't check out fork PRs under `pull_request_target` or `workflow_run`), where credentials are kept, caching, path layouts, and failures that used to be warnings.
   - **Runner requirements**: the minimum runner version for self-hosted runners, and the Node runtime.
3. **Work out a recommendation per action.**
   - Compatible: update.
   - Needs a small edit: update and adapt the step (a renamed input, an output name).
   - Needs something only the human can provide (a new secret or variable, a runner upgrade), or breaks a step: keep the working major for now, and say what the update would take.

   Never make a step depend on a secret the repo may not have. For example, `actions/create-github-app-token@v3` deprecates `app-id` for `client-id`. The generated workflows pass `vars.LAUNCHSET_APP_CLIENT_ID || secrets.LAUNCHSET_APP_ID`, so an org with only the older secret keeps working.
4. **Apply it to launchset's own steps** (`stamp`, `verify`, `mark`, the token and checkout steps init generated): update the compatible ones without asking. They are launchset's, and the human approved launchset's workflows.
5. **Ask about the team's steps.** The steps you moved over are the team's, and so are the workflows the migration doesn't touch. Outdated pins there are common, often several majors behind. Don't update them silently, and don't leave them silently either. Ask the human once, in one question that lists every outdated action: where it is (`path:line`), the old and new major, what changes for that step, and your recommendation. For example:

   > The build steps you moved use outdated actions. I recommend updating them in this PR:
   > - `docker/build-push-action` v5 → v7 (`launchset-release.yml:142`): compatible, the inputs you use are unchanged.
   > - `actions/setup-java` v3 → v6 (`launchset-release.yml:160`): compatible.
   > - `ruby/setup-ruby` v1: current.
   >
   > `ci.yml` and `deploy.yml` (not part of the migration) also use `actions/checkout@v3` and `actions/setup-node@v3`; both are compatible. Shall I update those too, in a separate commit in this PR?
   >
   > Hold back: `some/action` v2 → v3 needs a new secret `X`.

   Recommend updating everything that is compatible. Do what the human answers: update the steps they accept, in a separate commit so the review can tell the version updates apart from the migration, and leave the rest as it was.
6. **Report it.** In the PR description, list each action you checked: the old major, the new major and what you verified. Name the ones you held back and why, and the ones the human chose to keep.

To keep the pins current after the migration, suggest Dependabot for `github-actions`. init lists it as a manual step when the repo has no Dependabot or Renovate configuration. A Dependabot PR for a new major needs the same check: it bumps the version, not the inputs.

**On GitLab** the build steps go in `.gitlab/launchset-targets.yml`, in the hidden job `.launchset-<target>` of each target (init adds comments naming the old jobs that built each Docker image). Rules for those jobs: no `rules`, `when`, `needs` or `stage`; the image needs Node 24+, npm and git; one command per line (never `a && b`); no early `exit` (it would skip `mark`). `LAUNCHSET_VERSION`, `LAUNCHSET_BUILD_NUMBER`, `LAUNCHSET_CHANNEL`, `LAUNCHSET_DOCKER_TAGS` and `LAUNCHSET_DOCKER_LABELS` are set. There is no `if: matrix.target` guard to write: each target has its own job. Secrets are CI/CD variables.

For custom targets from tag jobs, init already copied the job's keys into `.launchset-<target>` (not `rules`, `needs`, `stage`; `$CI_COMMIT_TAG` became `$LAUNCHSET_TAG`), turned a `needs` between them into `after`, and moved the templates they extend to `.gitlab/ci-templates.yml`. Check with the human:

- **Node in the image.** launchset runs in every target job. Images like `ubuntu:22.04` or `nginx:alpine` lack Node 24+: add it to the job's `before_script` (careful: a `before_script` on the job replaces the one it extends) or to the template. On a PowerShell runner, Node, npm and git must be on the runner's PATH.
- **The version in files.** Add `files` to the target (`kind: "regex"` for `Cargo.toml`, `pyproject.toml`, lock files) so `stamp` writes the version in CI; init can't tell which files the build reads.
- **Previews.** Previews run the same steps with `LAUNCHSET_CHANNEL=preview`: publishing steps (an image tagged `latest`, an upload) must only run for `release`, or the target goes out of `preview.targets`.
- **After and retries.** A target with `after` gets the other targets' artifacts in the same pipeline only. On a retry that only rebuilds it they are missing: have the other targets also upload their output to a durable place (GitLab's generic package registry; the custom target template shows it) and fetch it from there.

**The "Build steps missing" guard.** For Android, iOS, web and custom targets without npm publishing, the generated workflows contain a step named `Build steps missing (<target>)` that always fails (`exit 1`), so `mark` never records a target that nothing builds. When the team's real build and upload steps for a target are in, **remove that target's guard step**, in both `launchset-release.yml` and `launchset-preview.yml` (on GitLab: the `echo "No build steps for <target> yet..."; exit 1` line in `.launchset-<target>`). Removing a guard without adding steps lets the release complete without building the target: check that every `auto` target has working steps before the PR is merged. Docker targets and npm custom targets have no guard.

## Step 7: Open one PR

Everything goes in **one PR**. Its description lists:

- The decisions and what was chosen (and why, for the ones the human decided).
- What was removed or disabled, with `path:line`.
- The action versions you checked, what you bumped and what you held back (see "Check the action versions").
- Changes to versions (files that moved to the canonical version) and any lowered version.
- The remaining manual steps: create the GitHub App and install it on the repo, add the variable `LAUNCHSET_APP_CLIENT_ID` and the secret `LAUNCHSET_APP_PRIVATE_KEY` (unless the org already has them, or the older secret `LAUNCHSET_APP_ID`; on GitLab: `LAUNCHSET_TOKEN` and `NPM_TOKEN`, protected branches and tags, pipeline variables, `workflow: rules` if init printed them), store credentials (`LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON`, `LAUNCHSET_ASC_KEY_ID`, `LAUNCHSET_ASC_ISSUER_ID`, `LAUNCHSET_ASC_PRIVATE_KEY`, keystore and signing secrets), and mark the **Changeset check** job as required once it runs (on GitLab: require the MR pipeline to succeed).
- That the PR itself needs a changeset: add one (`npx launchset add --bump patch --message "Set up releases with launchset"`, or `--empty`).

Don't merge it. Merging may start a release if the PR changed the root version of a version without a release tag.

## Repos that also publish npm packages

Some repos have something launchset should release (a Docker image, web or mobile apps) **and** npm packages that each have their own version, usually published with Changesets (public SDKs, a CLI, plugins). Don't stop, and don't put those packages on the one version: their version numbers would stop meaning anything to the people who install them. Propose the hybrid setup from the docs page "Alongside Changesets": launchset releases the one version and its targets, Changesets keeps versioning and publishing the npm packages. Each package is released by one tool, never both, so an npm package that Changesets publishes is never a launchset target.

Tell the human what this means and ask them to confirm. Then:

- **Version file.** Ask which `package.json` holds the one version: the workspace root (the default; Changesets never versions the root) or the app's own private package. For the second, set `version.file` and `changelog.file` in `launchset.config.ts` after init (for example `apps/app/package.json` and `apps/app/CHANGELOG.md`). `init` always writes the root.
- **Machinery.** Answer `keep` for every Changesets step and script that versions, checks or publishes the npm packages (`changesets/action`, `changeset version|status|publish`, pre-mode checks). Then edit those workflows by hand and move what launchset does now into `launchset-release.yml`: Docker build and push, deploys, tags and GitHub Releases for the app, steps that read the app version from a `package.json`. Other machinery (tag triggers, release scripts for the app) is handled as in Step 3.
- **Changesets config.** In `.changeset/config.json`, set `"privatePackages": { "version": false, "tag": false }`, so Changesets stops versioning and tagging the private app packages and `changeset status` only asks for a `.changeset` file when a public package changed.
- **Converted changesets.** `init` converts every pending `.changeset/*.md`. Delete the `.launchset/` copies of files that only named npm packages (or set them to `bump: none`), and check the bump of files that named the app. The originals stay in `.changeset/`. Don't follow init's hint to delete that folder.
- **The PR check.** Add `if: ${{ !startsWith(github.head_ref, 'changeset-release/') }}` to the `check` job in `launchset-check.yml`, so Changesets' Version Packages PR passes. A job `if`, not a `branches-ignore` filter: a skipped job counts as passed for a required check. Don't add `github-actions[bot]` to `check.bots`: every merged bot PR gets a `patch` entry and would release the app.
- **The PR description** says that Changesets stays for the npm packages, and how a PR that changes a package now needs both a `.changeset/` file and a `.launchset/` changeset.

## Out of scope: say why, don't migrate

- **Only independently versioned packages** (per-package npm releases in a workspace, like Changesets does), with nothing that shares one version: launchset has one version per repo. A repo with an app as well gets the hybrid setup above.
- **Build services outside GitHub Actions** (Xcode Cloud, Codemagic) and CI systems other than GitHub Actions and GitLab CI. Expo EAS is supported with `buildNumber: { strategy: "eas" }`.
- Repos with no shared version for their parts.

If the repo is out of scope, tell the human which of these applies and stop.
