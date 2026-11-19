---
name: launchset-adopt
description: Use when asked to set up launchset in a repo, move a repo to launchset, migrate a repo from Changesets, tag-triggered release workflows or hand-made release scripts to launchset, or adopt "one version, many targets" releases (Docker, Android, iOS, web), including repos that also publish independently versioned npm packages with Changesets. Covers the whole procedure: detect, ask the human the right questions, retire conflicting release machinery, run launchset init with decisions, and open one PR. Not for working in a repo that already uses launchset (that is the launchset skill).
---

# Move a repo to launchset

launchset releases repos where **one version** drives **many targets** (Docker images, Android, iOS and web apps) from one repo. Developers add a small changeset file to each PR. launchset collects them into a release PR. Merging it releases every target. launchset builds nothing: the team's own workflow steps do.

You are moving an **existing** repo onto it. This works on GitHub and on GitLab (GitLab.com or self-managed 18.2+); the steps below name both where they differ. The CLI does the detecting and the writing. Your job is to ask the human the right questions, deal with what conflicts, move the team's build steps, and deliver one reviewable PR.

Use `npx @demonsters/launchset` (Node 26 or newer; the package is private, so npm needs access to the `@demonsters` scope. If `npx` fails with 401 or 404, tell the human and stop).

## The rules

1. **Detect first. Write nothing until the human has seen the decisions.** `init --detect` never writes.
2. **Ask only what matters**, with the evidence. Don't ask about decisions whose default is clearly right.
3. **Never handle secret values.** Certificates, keys, passwords, tokens and service accounts are created and stored by a human. You check names, never values.
4. **Never lower a version, and never create a baseline tag, without the human's explicit answer.**
5. **Keep existing conventions** (tag format, Docker image tags) unless the human decides otherwise. Deploy tooling depends on them.
6. **Remove or adapt conflicting machinery only after the human agrees.**
7. **Don't migrate what doesn't fit**, and say why (see the end).

## Step 1: Detect

```sh
npx @demonsters/launchset init --detect --json > /tmp/launchset-init.json
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
| `tags.release` | template with `{version}` | The release tag format. Keep the existing one, for example `{version}` without a `v`. |
| `target.<name>` | `auto`, `manual`, `none` | How a detected platform is released. |
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
- **Scripts that write version or build numbers** (`MARKETING_VERSION`, `CURRENT_PROJECT_VERSION`, `versionCode`, `versionName`, fastlane version actions): they would overwrite the numbers stamped in CI.
- **Docker pushes of `latest` on branch pushes**: launchset moves `latest` only when a release ships.
- **On GitLab:** the same kinds of machinery in `.gitlab-ci.yml` and the local files it includes: jobs that run on tags (`$CI_COMMIT_TAG`), `glab release create`, the `release:` keyword, `npm publish`, Docker pushes of `latest` from branch pushes. Remote, project and template includes aren't scanned: read them yourself.
- **Release instructions** in `CLAUDE.md`, `AGENTS.md` and the README (`npm version`, `git tag`, `changeset`): they describe the old process.

For each, propose `disable` (remove only the conflicting trigger or step, never the file), `remove` (delete the file or script) or `keep`, and why. Do it only after the human agrees. Where `disable` isn't offered, no minimal edit exists: the choice is `keep` or `remove`.

Also check, by reading the repo:

- **Long-lived Changesets pre-mode branches** (`.changeset/pre.json` on a branch): propose a prerelease branch entry (`preview.branches: [{ branch: "next", prerelease: "beta" }]`) and, on that branch, `npx @demonsters/launchset init --convert-only`. `pre.json` is ignored with a warning.
- **Deploy manifests that pin an image tag** (`imagePins[]`): ask per file. `image.<path>=stamp` makes the release PR update it to each release. `leave` keeps it as deploy state that is promoted by hand (for example a production overlay).
- **Docker image names and tags**: keep what deploy tooling pulls (`v{version}`).

## Step 4: Native store pipelines

Signing certificates, provisioning profiles, the Google Play upload key, the App Store Connect API key, the Play service account and the GitHub secrets are set up by a **human**. Guide them step by step with the docs pages "Setting up native store pipelines" (Apple and Google Play). Check each step without seeing a secret:

- Secret **names** exist: `gh secret list --repo <owner/repo>` (and `--org <org>`).
- The workflow uses the same names: `grep -n "secrets\." .github/workflows/launchset-*.yml`.
- The config has `verify: ["store"]` with `store.packageName` or `store.appId`.
- A **preview build** passes: label a PR with `launchset:preview`, and read the PR comment and the job logs. A failing `verify` step prints what is wrong.

Never ask for, read or store a key, password, certificate, token or service account file. If one is pasted into the chat, tell the human to rotate it.

The **GitHub App** (secrets `LAUNCHSET_APP_ID` and `LAUNCHSET_APP_PRIVATE_KEY`) is also created by a human, an org owner. Point to the docs page "GitHub App setup". Permissions: Contents (read & write), Pull requests (read & write), Workflows (read & write), Actions (read), Metadata (read).

**On GitLab** a human creates a project or group access token (role Maintainer, scopes `api` and `write_repository`) and stores it as the masked, **not Protected** CI/CD variable `LAUNCHSET_TOKEN`, plus `NPM_TOKEN` (masked) for the private package. Point to the docs page "Token and permissions" (GitLab). You check variable names (`glab variable list` or the Settings page), never values. Protected branches and tags must let the token's bot push; "Minimum role to use pipeline variables" must allow manual runs.

## Step 5: Run init with the answers

```sh
npx @demonsters/launchset init --yes \
  --decide version=1.4.0 \
  --decide target.android=manual \
  --decide docker.api.tags='v{version}, v{major}.{minor}, v{major}, latest' \
  --decide 'machinery..github/workflows/release.yml#1=disable'
```

- `--yes` accepts the default of every decision you don't give. Never leave a conflict in place silently: give an answer for each.
- Quote values that have spaces or braces. An invalid value fails before anything is written (`expected one of ...`). An unknown id lists the valid ones.
- `--baseline`, `--skill` and `--hook` (and the `--no-` forms) are shortcuts for the three yes/no decisions.

Then look at the result: `git status`, `git diff`. Init writes (files that already exist are kept unless `file.<path>=overwrite`) `launchset.config.ts`, `.launchset/README.md`, `.github/workflows/launchset-check.yml`, `launchset-release.yml` and `launchset-preview.yml` (on GitLab instead `.gitlab/launchset.yml`, `.gitlab/launchset-targets.yml` and a `.gitlab-ci.yml`, or only an `include:` added to yours; init doesn't edit your `workflow:` and prints the recommended `workflow: rules` as a manual step), `CHANGELOG.md` (only if missing), converted changesets (`.changeset/*.md` to `.launchset/`, the folder is left in place), and the agent skill and `AGENTS.md` section.

Run `npx @demonsters/launchset status`, `version --dry-run` and `plan` to see that the config loads and the files are consistent.

## Step 6: Move the team's build steps

The generated workflows have commented examples where the team's build steps go. Move the existing steps from the old workflows, keeping secrets and environments as they are:

- Docker: the `docker/build-push-action` settings (`context`, `file`, `platforms`, build args). The tags and labels come from `steps.stamp.outputs.docker-tags` and `docker-labels`.
- Android and iOS: Gradle or `xcodebuild`, signing, fastlane. iOS runs on macOS.
- Deploys, npm publishing and other steps.
- Give every step `if: matrix.target == '<name>' && steps.verify.outputs.already-published != 'true'` in the release workflow.

**On GitLab** the build steps go in `.gitlab/launchset-targets.yml`, in the hidden job `.launchset-<target>` of each target (init adds comments naming the old jobs that built each Docker image). Rules for those jobs: no `rules`, `when`, `needs` or `stage`; the image needs Node 24+, npm and git; one command per line (never `a && b`); no early `exit` (it would skip `mark`). `LAUNCHSET_VERSION`, `LAUNCHSET_BUILD_NUMBER`, `LAUNCHSET_CHANNEL`, `LAUNCHSET_DOCKER_TAGS` and `LAUNCHSET_DOCKER_LABELS` are set. There is no `if: matrix.target` guard to write: each target has its own job. Secrets are CI/CD variables.

**The "Build steps missing" guard.** For Android, iOS, web and custom targets without npm publishing, the generated workflows contain a step named `Build steps missing (<target>)` that always fails (`exit 1`), so `mark` never records a target that nothing builds. When the team's real build and upload steps for a target are in, **remove that target's guard step**, in both `launchset-release.yml` and `launchset-preview.yml` (on GitLab: the `echo "No build steps for <target> yet..."; exit 1` line in `.launchset-<target>`). Removing a guard without adding steps lets the release complete without building the target: check that every `auto` target has working steps before the PR is merged. Docker targets and npm custom targets have no guard.

## Step 7: Open one PR

Everything goes in **one PR**. Its description lists:

- The decisions and what was chosen (and why, for the ones the human decided).
- What was removed or disabled, with `path:line`.
- Changes to versions (files that moved to the canonical version) and any lowered version.
- The remaining manual steps: create the GitHub App and install it on the repo, add `LAUNCHSET_APP_ID` and `LAUNCHSET_APP_PRIVATE_KEY` (on GitLab: `LAUNCHSET_TOKEN` and `NPM_TOKEN`, protected branches and tags, pipeline variables, `workflow: rules` if init printed them), store credentials (`LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON`, `LAUNCHSET_ASC_KEY_ID`, `LAUNCHSET_ASC_ISSUER_ID`, `LAUNCHSET_ASC_PRIVATE_KEY`, keystore and signing secrets), and mark the **Changeset check** job as required once it runs (on GitLab: require the MR pipeline to succeed).
- That the PR itself needs a changeset: add one (`npx @demonsters/launchset add --bump patch --message "Set up releases with launchset"`, or `--empty`).

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
