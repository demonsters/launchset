/**
 * Input gathering for the pure decision layer (src/core): tags, changesets, the root version,
 * the branch, the release commit, commits since the last release, bot PRs and changelog
 * origins. Shared by every flow command (and the preview flow), so the names here are stable.
 *
 * Paths: changeset paths are **repo-relative** (as `Changeset.path` documents), even when the
 * config lives in a subdirectory. Config paths (`version.file`, `changelog.file`) are relative
 * to the config root; convert them with `context.git.toRepoPath`.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CHANGESET_DIR, isChangesetPath } from "../core/changesets.ts";
import { LaunchsetError } from "../core/errors.ts";
import { finalizeCandidates, type UnfinishedVersion } from "../core/finalize.ts";
import {
  type BotPrInfo,
  type ChangesetFile,
  type CommitInfo,
  invalidChangesetFiles,
  readChangesetFile,
  snapshotTags,
  type TagSnapshot,
  validChangesets,
} from "../core/plan-common.ts";
import type { ReleaseEvent, ReleaseInput } from "../core/release.ts";
import type { ChangesetOrigin } from "../core/release-pr.ts";
import { lastReleaseTag, versionTagShas } from "../core/tags.ts";
import type { Changeset } from "../core/types.ts";
import { findBotPrsWithoutChangeset } from "../forge/bot-prs.ts";
import { changelogInfoFor } from "../forge/changelog-info.ts";
import type { TagRef } from "../git/index.ts";
import {
  findReleaseCommit,
  headIsReleaseCommit,
  type ReadVersion,
  versionReader,
} from "../git/release-commit.ts";
import { readRootVersion } from "../platforms/index.ts";
import { branchFromRef, type FlowContext } from "./context.ts";

// ---------------------------------------------------------------------------
// Remote and tags

/**
 * Fetch every tag from the remote (`git fetch --tags`) when a remote exists and `fetch` isn't
 * false. Returns true when it fetched.
 */
export async function syncTags(context: FlowContext, fetch = true): Promise<boolean> {
  if (!fetch || !(await context.git.hasRemote())) return false;
  await context.git.fetchTags();
  return true;
}

/**
 * The ref the base branch (default: the configured one) is compared with: the remote-tracking
 * `<remote>/<branch>` when the repo has a remote, else the local `<branch>`.
 */
export async function baseBranchRef(
  context: FlowContext,
  branch = context.config.baseBranch,
): Promise<string> {
  const { git } = context;
  return (await git.hasRemote()) ? `${git.remote}/${branch}` : branch;
}

/** The repo's local tags, classified with the configured templates. */
export async function readTagSnapshot(context: FlowContext): Promise<TagSnapshot> {
  return snapshotTags(await context.git.tags(), context.config);
}

/** Plain versions whose release tag is reachable from `ref` (`git tag --merged`). */
export async function reachableReleaseVersions(
  context: FlowContext,
  ref = "HEAD",
): Promise<string[]> {
  const merged: TagRef[] = await context.git.tagsMerged(ref);
  return [...snapshotTags(merged, context.config).index.releases.keys()];
}

/** The tag of the highest version in `versions`, or `null`. */
export function lastReleaseTagOf(context: FlowContext, versions: readonly string[]): string | null {
  return lastReleaseTag(context.config.tags, versions);
}

// ---------------------------------------------------------------------------
// Paths and changesets

/** The changeset folder, repo-relative (`.launchset`, or `apps/web/.launchset`). */
export async function changesetDir(context: FlowContext): Promise<string> {
  return context.git.toRepoPath(CHANGESET_DIR);
}

/** `version.file`, repo-relative. */
export async function versionFilePath(context: FlowContext): Promise<string> {
  return context.git.toRepoPath(context.config.version.file);
}

/** `changelog.file`, repo-relative. */
export async function changelogFilePath(context: FlowContext): Promise<string> {
  return context.git.toRepoPath(context.config.changelog.file);
}

/** A predicate for repo-relative changeset paths of this config root. */
export async function changesetPathMatcher(
  context: FlowContext,
): Promise<(path: string) => boolean> {
  const dir = await changesetDir(context);
  return (path) => isChangesetPath(path, dir);
}

export interface ReadChangesetsOptions {
  /**
   * Read the files at this commit (`HEAD` in CI). Without it, the working tree is read, so
   * uncommitted changesets count (local commands: `status`, `version`, `check --push`).
   */
  ref?: string;
}

/** Every changeset file in `.launchset/`, parsed or not, sorted by path. */
export async function readChangesetFiles(
  context: FlowContext,
  options: ReadChangesetsOptions = {},
): Promise<ChangesetFile[]> {
  const dir = await changesetDir(context);
  const files: ChangesetFile[] = [];
  if (options.ref !== undefined) {
    const listed = (await context.git.listFiles(options.ref, dir)).filter((f) =>
      isChangesetPath(f.path, dir),
    );
    const texts = await context.git.readBlobs(listed.map((f) => f.blob));
    for (const { path, blob } of listed) {
      const text = texts.get(blob);
      if (text !== undefined) files.push(readChangesetFile(text, path));
    }
  } else {
    const absolute = join(context.cwd, CHANGESET_DIR);
    let names: string[];
    try {
      names = await readdir(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    for (const name of names) {
      const path = `${dir}/${name}`;
      if (!isChangesetPath(path, dir)) continue;
      const text = await readFile(join(absolute, name), "utf8");
      files.push(readChangesetFile(text, path));
    }
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The `invalid-changeset` error for unparsable files, or undefined when there are none. */
export function invalidChangesetsError(
  files: readonly { path: string; error: string }[],
): LaunchsetError | undefined {
  const invalid = files.map((f) => f.error);
  if (invalid.length > 0) {
    return new LaunchsetError(
      "invalid-changeset",
      `${invalid.length === 1 ? "a changeset can't" : `${invalid.length} changesets can't`} be read:\n${invalid.map((e) => `  ${e}`).join("\n")}`,
      { hint: "Fix the files in .launchset/ (the PR check reports this too) and push again." },
    );
  }
  return undefined;
}

/** Warning lines for unparsable changesets in modes that don't consume them. */
export function invalidChangesetWarnings(
  files: readonly { path: string; error: string }[],
): string[] {
  return files.map(
    (f) =>
      `Ignored the changeset ${f.path}: it can't be read (${f.error}). Fix it before the next release PR.`,
  );
}

/** Warnings from parsing (unknown frontmatter keys). */
export function changesetWarnings(files: readonly ChangesetFile[]): string[] {
  return files.flatMap((f) => (f.ok ? f.warnings : []));
}

// ---------------------------------------------------------------------------
// Branch, event and versions

/**
 * The branch this run is on: `explicit`, else the CI ref (`GITHUB_REF` when it's a
 * branch, outside PR runs), else git's current branch. Throws `no-branch` on a detached HEAD without either.
 */
export async function resolveBranch(context: FlowContext, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const fromEnv = branchFromRef(context.ci.ref);
  if (fromEnv && context.ci.event?.kind !== "pr") return fromEnv;
  const current = await context.git.currentBranch();
  if (current) return current;
  throw new LaunchsetError(
    "no-branch",
    "can't tell which branch this is: HEAD is detached and GITHUB_REF isn't a branch",
    { hint: "Check out the branch (`launchset plan` also takes --branch)." },
  );
}

/** The branch name, or undefined on a detached HEAD outside Actions. */
export async function tryResolveBranch(context: FlowContext): Promise<string | undefined> {
  try {
    return await resolveBranch(context);
  } catch (error) {
    if (error instanceof LaunchsetError && error.code === "no-branch") return undefined;
    throw error;
  }
}

export interface ReleaseEventOptions {
  event?: ReleaseEvent;
  target?: string;
  version?: string;
  force?: boolean;
}

/**
 * The release event (spec 9.3): explicit, else `workflow_dispatch` (inputs `target`,
 * `version`, `force` from the payload, overridden by explicit options), else a push. A
 * `target` option without an event means a dispatch (shipping a manual target).
 */
export function releaseEventFor(
  context: FlowContext,
  options: ReleaseEventOptions = {},
): ReleaseEvent {
  if (options.event) return options.event;
  const dispatch = context.ci.event?.kind === "dispatch";
  if (!dispatch && !options.target) return { kind: "push" };
  const inputs = dispatch ? (context.ci.event?.inputs ?? {}) : {};
  const event: ReleaseEvent = { kind: "dispatch" };
  const target = options.target || inputs.target;
  const version = options.version || inputs.version;
  if (target) event.target = target;
  if (version) event.version = version;
  const force = options.force ?? (inputs.force === "true" ? true : undefined);
  if (force) event.force = true;
  return event;
}

/** A cached reader of the root version at any commit. */
export async function rootVersionReader(context: FlowContext): Promise<ReadVersion> {
  return versionReader(context.git, await versionFilePath(context));
}

/**
 * The release commit of `version` (spec 9.3 `release-sha` on a retry): the commit of an
 * existing marker tag for it that is an ancestor of `head`, else the newest first-parent
 * commit that changed the root version.
 */
export async function findReleaseCommitFor(
  context: FlowContext,
  tags: TagSnapshot,
  version: string,
  head = "HEAD",
): Promise<string | undefined> {
  const tagged = await taggedReleaseCommit(context, tags, version, head);
  if (tagged) return tagged;
  return findReleaseCommit(context.git, head, await rootVersionReader(context), {
    paths: [await versionFilePath(context)],
  });
}

/**
 * The commit a partial tag or a marker tag of `version` points to, when it's an ancestor of
 * (or equal to) `head`. Markers and partial tags sit on the release commit, so this is the
 * release commit once any target shipped.
 */
export async function taggedReleaseCommit(
  context: FlowContext,
  tags: TagSnapshot,
  version: string,
  head = "HEAD",
): Promise<string | undefined> {
  for (const sha of versionTagShas(tags, version, { partial: true })) {
    if (await context.git.isAncestor(sha, head)) return sha;
  }
  return undefined;
}

/** First-parent commits after the last reachable release tag (newest first). */
export async function commitsSince(
  context: FlowContext,
  tag: string | null,
  head = "HEAD",
): Promise<CommitInfo[]> {
  const log = await context.git.logRange(tag ? `${tag}..${head}` : head, { firstParent: true });
  return log.map((entry) => ({ sha: entry.sha, subject: entry.subject }));
}

/** Merged bot PRs since `since` without a changeset (spec 9.4); empty without a forge client. */
export async function botPrsSince(
  context: FlowContext,
  branch: string,
  since: string | undefined,
): Promise<BotPrInfo[]> {
  if (!context.forge) return [];
  const prs = await findBotPrsWithoutChangeset({
    git: context.git,
    forge: context.forge,
    ...(since ? { since } : {}),
    head: "HEAD",
    branch,
    bots: context.config.check.bots,
    isChangesetPath: await changesetPathMatcher(context),
  });
  return prs.map((pr) => ({ number: pr.number, title: pr.title, author: pr.author }));
}

/** PR and author per changeset path (spec 12), when `changelog.links` and a client exist. */
export async function changelogOrigins(
  context: FlowContext,
  paths: readonly string[],
  branch: string,
): Promise<Map<string, ChangesetOrigin>> {
  const origins = new Map<string, ChangesetOrigin>();
  if (!context.config.changelog.links || !context.forge || paths.length === 0) return origins;
  const info = await changelogInfoFor(paths, {
    git: context.git,
    forge: context.forge,
    branch,
    head: "HEAD",
    log: context.log,
  });
  for (const [path, entry] of info) origins.set(path, { pr: entry.pr, author: entry.author });
  return origins;
}

/**
 * Older versions finalize supersedes or completes (spec 9.6): `finalizeCandidates` (markers,
 * no release tag; partial-tagged ones only while their pre-release is missing, see
 * `releasesWithTag`), keeping those whose commit is an ancestor of `releaseSha`.
 */
export async function unfinishedVersionsBefore(
  context: FlowContext,
  tags: TagSnapshot,
  releaseSha: string,
  version: string,
  releasesWithTag?: ReadonlySet<string>,
): Promise<UnfinishedVersion[]> {
  const result: UnfinishedVersion[] = [];
  for (const candidate of finalizeCandidates(context.config, tags, version, releasesWithTag)) {
    if (await context.git.isAncestor(candidate.sha, releaseSha)) result.push(candidate);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Everything at once

/**
 * `Promise.all` for independent reads, but a failure is the first failing one in argument
 * order (as if they ran one after another), whichever failed first in time.
 */
export async function allInOrder<const T extends readonly unknown[]>(
  promises: { [K in keyof T]: Promise<T[K]> },
): Promise<T> {
  const settled = await Promise.allSettled(promises);
  for (const result of settled) if (result.status === "rejected") throw result.reason;
  return settled.map((r) => (r as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

/** The repo state most commands look at. */
export interface RepoState {
  branch: string;
  headSha: string;
  /** Root version (working tree, which is HEAD in CI). */
  version: string;
  changesetFiles: ChangesetFile[];
  tags: TagSnapshot;
  reachableReleases: string[];
  /** Tag of the highest reachable release, or `null`. */
  lastReleaseTag: string | null;
  commitsSinceRelease: CommitInfo[];
}

export interface GatherOptions {
  /** Default: the Actions ref, else git's current branch. */
  branch?: string;
  /** `git fetch --tags` first when a remote exists. Default true. */
  fetch?: boolean;
  /** Read changesets from the working tree instead of HEAD. Default false. */
  worktree?: boolean;
}

/** Gather the common repo state (fetching tags first, see `GatherOptions.fetch`). */
export async function gatherRepoState(
  context: FlowContext,
  options: GatherOptions = {},
): Promise<RepoState> {
  await syncTags(context, options.fetch ?? true);
  const [branch, headSha, version, changesetFiles, tags, reachableReleases] = await allInOrder([
    resolveBranch(context, options.branch),
    context.git.headSha(),
    readRootVersion(context.config, context.cwd),
    readChangesetFiles(context, options.worktree ? {} : { ref: "HEAD" }),
    readTagSnapshot(context),
    reachableReleaseVersions(context),
  ]);
  const lastReleaseTag = lastReleaseTagOf(context, reachableReleases);
  const commitsSinceRelease = await commitsSince(context, lastReleaseTag);
  return {
    branch,
    headSha,
    version,
    changesetFiles,
    tags,
    reachableReleases,
    lastReleaseTag,
    commitsSinceRelease,
  };
}

export interface ReleaseState extends RepoState {
  /** The valid changesets (unparsable ones are in `invalidChangesets`). */
  changesets: Changeset[];
  /** Changeset files that can't be parsed: a release PR refuses them, other modes warn. */
  invalidChangesets: { path: string; error: string }[];
  headIsReleaseCommit: boolean;
  /** Release commit of `version` (marker, else first-parent search); undefined when none. */
  releaseCommit?: string;
  botPrs: BotPrInfo[];
}

export interface GatherReleaseOptions extends GatherOptions {
  /** Look up merged bot PRs (needs a GitHub client). Default: when a client exists. */
  botPrs?: boolean;
  /**
   * Check whether HEAD is the release commit (`headIsReleaseCommit`). Default true; `false`
   * skips it (`version` never publishes, so HEAD is never treated as one).
   */
  releaseHead?: boolean;
}

/**
 * Everything `planRelease` needs. Unparsable changesets don't stop a publish, ship or retry:
 * they're listed in `invalidChangesets` (the release PR refuses them, see
 * `invalidChangesetsError`).
 *
 * HEAD is the release commit only when it changed the root version along first-parent
 * history **and** no marker or partial tag of the current version sits on another commit. A
 * pushed `git pull` merge after the release commit changes the version compared with its
 * first parent too, but the markers on the real release commit show it isn't one.
 */
export async function gatherReleaseState(
  context: FlowContext,
  options: GatherReleaseOptions = {},
): Promise<ReleaseState> {
  const repo = await gatherRepoState(context, options);
  const changesets = validChangesets(repo.changesetFiles);
  const invalidChangesets = invalidChangesetFiles(repo.changesetFiles);
  const reader = await rootVersionReader(context);
  const tagged = await taggedReleaseCommit(context, repo.tags, repo.version);
  const isRelease =
    (options.releaseHead ?? true) &&
    (tagged === undefined || tagged === repo.headSha) &&
    (await headIsReleaseCommit(context.git, reader, repo.headSha));
  const releaseCommit =
    tagged ??
    (await findReleaseCommit(context.git, "HEAD", reader, {
      paths: [await versionFilePath(context)],
    }));
  const wantBots = options.botPrs ?? context.forge !== undefined;
  const since = releaseCommit ?? repo.lastReleaseTag ?? undefined;
  const botPrs = wantBots ? await botPrsSince(context, repo.branch, since) : [];
  const state: ReleaseState = {
    ...repo,
    changesets,
    invalidChangesets,
    headIsReleaseCommit: isRelease,
    botPrs,
  };
  if (releaseCommit) state.releaseCommit = releaseCommit;
  return state;
}

/** The `planRelease` input for a gathered state. */
export function releaseInputFor(
  context: FlowContext,
  state: Pick<
    ReleaseState,
    | "branch"
    | "headSha"
    | "version"
    | "headIsReleaseCommit"
    | "tags"
    | "reachableReleases"
    | "changesets"
    | "botPrs"
    | "commitsSinceRelease"
    | "releaseCommit"
  >,
  event: ReleaseEvent,
): ReleaseInput {
  const input: ReleaseInput = {
    config: context.config,
    branch: state.branch,
    event,
    headSha: state.headSha,
    version: state.version,
    headIsReleaseCommit: state.headIsReleaseCommit,
    tags: state.tags,
    reachableReleases: state.reachableReleases,
    changesets: state.changesets,
    botPrs: state.botPrs,
    commitsSinceRelease: state.commitsSinceRelease,
    now: context.now,
  };
  if (state.releaseCommit) input.releaseCommit = state.releaseCommit;
  if (context.run) input.run = context.run;
  if (context.repository) input.repository = context.repository;
  return input;
}
