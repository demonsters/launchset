/**
 * Finalize (spec 9.3, 9.5, 9.6, 9.8): decide which tags, GitHub Releases and changelog
 * backport PRs to create after the build jobs. Pure and idempotent: re-running with the
 * state the previous run left behind yields no actions (or only the missing ones).
 */

import semver from "semver";
import { extractSection, extractSectionWithHeading, insertSectionSorted } from "./changelog.ts";
import type { ResolvedConfig } from "./config/schema.ts";
import { LaunchsetError } from "./errors.ts";
import { type ForgeHost, forgeWords } from "./forge-links.ts";
import {
  code,
  highestVersion,
  isoDay,
  joinWords,
  manualTargets,
  plural,
  renderSummary,
  type TagSnapshot,
} from "./plan-common.ts";
import {
  type ManualTargetEntry,
  mergeManualTargets,
  parseManualTargets,
  partialReleaseTitle,
  renderPartialReleaseBody,
  renderReleaseBody,
  upsertManualTargets,
} from "./release-notes.ts";
import {
  autoTargets,
  hasMarker,
  markersFor,
  missingAutoTargets,
  partialTag,
  releasesAfter,
  releaseTag,
  versionTagShas,
} from "./tags.ts";
import type { Plan } from "./types.ts";
import { isPlainVersion } from "./versions.ts";

/** A GitHub Release that already exists. */
export interface ExistingRelease {
  id: number;
  name: string;
  body: string;
  prerelease: boolean;
}

/** An older version that has markers but no release or partial tag (spec 9.6). */
export interface UnfinishedVersion {
  version: string;
  /** Its release commit (the commit of its marker tags). */
  sha: string;
}

export interface FinalizeInput {
  config: ResolvedConfig;
  /** The `publish` or `ship` plan of this run. */
  plan: Plan;
  /** Tags as they are now (after the build jobs pushed their markers). */
  tags: TagSnapshot;
  /**
   * Older versions to supersede or complete (`publish` only): `finalizeCandidates(...)`
   * filtered to those whose `sha` is an ancestor of `plan.releaseSha`. It must include
   * versions that have a partial tag but no partial GitHub Release yet, so a failed
   * pre-release creation is retried. Released and newer versions are ignored.
   */
  unfinished?: readonly UnfinishedVersion[];
  /** `changelog.file` at `plan.releaseSha` (`null` when missing). */
  changelog: string | null;
  /**
   * `changelog.file` on the base branch, for the backport (spec 9.5). Needed for a `publish`
   * on a maintenance branch; `null` when the file doesn't exist there.
   */
  baseChangelog?: string | null;
  /** Existing GitHub Releases by tag name: `v{version}`, partial tags, older release tags. */
  releases: ReadonlyMap<string, ExistingRelease>;
  now: Date | number;
  /** Code host, for what releases are called in messages; default `github`. */
  host?: ForgeHost;
}

export type FinalizeAction =
  | { kind: "create-tag"; tag: string; sha: string }
  | {
      kind: "create-release";
      tag: string;
      name: string;
      body: string;
      prerelease: boolean;
      makeLatest: boolean;
    }
  | {
      kind: "update-release";
      id: number;
      tag: string;
      name: string;
      body: string;
      prerelease: boolean;
      /** Leave "latest" alone when undefined. */
      makeLatest?: boolean;
    }
  | {
      /** Open or update a PR to the base branch that only inserts a changelog section (spec 9.5). */
      kind: "backport-changelog";
      version: string;
      /** Target branch (the base branch). */
      base: string;
      /** Head branch, e.g. `launchset/changelog/v1.4.1`. */
      branch: string;
      title: string;
      body: string;
      commitMessage: string;
      /** `changelog.file`. */
      file: string;
      /**
       * The base branch's changelog (`baseChangelog`) with the section inserted. When several
       * backports are open at once, rebuild each branch from the current base with
       * `insertSectionSorted(currentText, section, version)` instead.
       */
      changelog: string;
      /** The section (heading included) for `insertSectionSorted`. */
      section: string;
    };

export interface SupersededVersion {
  version: string;
  /** The partial tag. */
  tag: string;
  shipped: string[];
  missing: string[];
}

export interface FinalizeResult {
  /** False when the job should fail (missing markers). */
  ok: boolean;
  /** `superseded`: the version has a partial tag, so it is never released (spec 9.6). */
  status: "released" | "incomplete" | "superseded" | "shipped" | "not-shipped";
  version: string;
  /** `v{version}`. */
  tag: string;
  /** Auto targets without a marker (`publish`), or the shipped target when unmarked (`ship`). */
  missing: string[];
  /** Older versions superseded by this run (spec 9.6). */
  superseded: SupersededVersion[];
  /** Older versions that turned out complete (every auto marker): released by this run. */
  completed: string[];
  /** In order: tags first, then releases, then the backport. */
  actions: FinalizeAction[];
  failures: string[];
  warnings: string[];
  notices: string[];
  /** Markdown for `$GITHUB_STEP_SUMMARY`. */
  summary: string;
}

/**
 * The candidates for `FinalizeInput.unfinished`: plain versions below `version` with at least
 * one auto marker and no release tag, either without a partial tag, or with one whose GitHub
 * Release is missing. `sha` is the partial tag's commit, else a marker's (markers sit on the
 * release commit). Oldest first.
 *
 * Usage in the I/O layer: call it without `releasesWithTag`, fetch the GitHub Release of each
 * candidate's partial tag (`partialTag(config.tags, version)`) where one exists, call it again
 * with the tags that have a Release (or pass those Releases to `planFinalize`, which skips
 * them), then keep the candidates whose `sha` is an ancestor of `plan.releaseSha`.
 */
export function finalizeCandidates(
  config: Pick<ResolvedConfig, "tags" | "targets">,
  tags: TagSnapshot,
  version: string,
  /** Tag names that have a GitHub Release (only partial tags matter). */
  releasesWithTag?: ReadonlySet<string>,
): UnfinishedVersion[] {
  const auto = new Set(autoTargets(config));
  const candidates: UnfinishedVersion[] = [];
  for (const [v, targets] of tags.index.markers) {
    if (!isPlainVersion(v) || !semver.lt(v, version) || tags.index.releases.has(v)) continue;
    if (![...targets].some((t) => auto.has(t))) continue;
    const partial = tags.index.partials.get(v);
    if (partial !== undefined && releasesWithTag?.has(partial)) continue;
    const sha = versionTagShas(tags, v, { partial: true })[0];
    if (sha !== undefined) candidates.push({ version: v, sha });
  }
  return candidates.sort((a, b) => semver.compare(a.version, b.version));
}

/** Head branch of the changelog backport PR: `launchset/changelog/v1.4.1`. */
export function backportBranch(tag: string): string {
  return `launchset/changelog/${tag}`;
}

/** Title of the changelog backport PR: `Changelog: v1.4.1`. */
export function backportTitle(tag: string): string {
  return `Changelog: ${tag}`;
}

/** Manual-target entries for a version: from the release body, then markers, else "not shipped". */
function manualEntries(
  config: ResolvedConfig,
  tags: TagSnapshot,
  version: string,
  existingBody: string | undefined,
  update?: ManualTargetEntry,
): ManualTargetEntry[] {
  const configured = manualTargets(config);
  const existing = existingBody !== undefined ? (parseManualTargets(existingBody) ?? []) : [];
  const marked = markersFor(tags.index, version);
  const derived: ManualTargetEntry[] = configured.map((target) =>
    marked.has(target)
      ? { target, shipped: true, buildNumber: null, date: null }
      : { target, shipped: false },
  );
  return mergeManualTargets([existing, update ? [update] : [], derived], configured);
}

/** True when no release is higher than `version`. */
function isHighestRelease(tags: TagSnapshot, version: string): boolean {
  return releasesAfter(tags.index, version) === 0;
}

interface ReleaseActionInput {
  tag: string;
  name: string;
  body: string;
  prerelease: boolean;
  makeLatest: boolean;
  existing: ExistingRelease | undefined;
  /** Set `makeLatest` on updates too. */
  updateLatest: boolean;
}

/** Create, update or leave a GitHub Release. */
function releaseAction(input: ReleaseActionInput): FinalizeAction | null {
  const { existing } = input;
  if (!existing) {
    return {
      kind: "create-release",
      tag: input.tag,
      name: input.name,
      body: input.body,
      prerelease: input.prerelease,
      makeLatest: input.makeLatest,
    };
  }
  const sameBody = existing.body.replace(/\r\n/g, "\n").trimEnd() === input.body.trimEnd();
  if (sameBody && existing.name === input.name && existing.prerelease === input.prerelease) {
    return null;
  }
  const action: FinalizeAction = {
    kind: "update-release",
    id: existing.id,
    tag: input.tag,
    name: input.name,
    body: input.body,
    prerelease: input.prerelease,
  };
  if (input.updateLatest) action.makeLatest = input.makeLatest;
  return action;
}

/**
 * Decide what finalize does (spec 9.3):
 *
 * - `publish`, every auto target marked: create `v{version}` at the release commit (unless it
 *   exists) and its GitHub Release (changelog section + "Manual targets"), "latest" only on
 *   the base branch and when no higher release exists; on a maintenance branch also the
 *   changelog backport PR (spec 9.5).
 * - `publish`, markers missing: `ok: false`, listing the missing auto targets.
 * - `publish`, always: supersede older unfinished versions (spec 9.6) with a partial tag and a
 *   pre-release. An older version whose auto targets all have markers is complete: it gets
 *   its release tag and Release instead (not "latest").
 * - `ship`: record the shipped manual target in `v{version}`'s Release body; `ok: false` when
 *   its marker is missing. Never creates tags.
 */
export function planFinalize(input: FinalizeInput): FinalizeResult {
  const { plan } = input;
  if (plan.mode === "ship") return finalizeShip(input);
  if (plan.mode !== "publish") {
    throw new LaunchsetError(
      "invalid-plan",
      `finalize runs only for publish and ship plans, got mode "${plan.mode}"`,
      { hint: "The workflow's finalize job should only run when mode is publish or ship." },
    );
  }
  return finalizePublish(input);
}

function finalizePublish(input: FinalizeInput): FinalizeResult {
  const { config, plan, tags } = input;
  const { releaseName } = forgeWords(input.host);
  const version = plan.version;
  const tag = releaseTag(config.tags, version);
  const tagActions: FinalizeAction[] = [];
  const releaseActions: FinalizeAction[] = [];
  const otherActions: FinalizeAction[] = [];
  const failures: string[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];
  const changelogFile = config.changelog.file;

  // A superseded version (partial tag) never gets a release tag (spec 9.6).
  const ownPartial = tags.index.partials.get(version);
  if (ownPartial !== undefined) {
    const result: FinalizeResult = {
      ok: false,
      status: "superseded",
      version,
      tag,
      missing: missingAutoTargets(tags.index, config, version),
      superseded: [],
      completed: [],
      actions: [],
      failures: [
        `${version} was superseded by a newer release (it has the partial tag ${ownPartial}), so it never gets ${tag}. Release a new version instead.`,
      ],
      warnings,
      notices,
      summary: "",
    };
    result.summary = renderFinalizeSummary(result, input.host);
    return result;
  }

  const missing = missingAutoTargets(tags.index, config, version);
  const complete = missing.length === 0;

  const auto = autoTargets(config);
  const older = [...(input.unfinished ?? [])]
    .filter((u) => isPlainVersion(u.version) && semver.lt(u.version, version))
    .filter((u) => !tags.index.releases.has(u.version))
    .sort((a, b) => semver.compare(a.version, b.version))
    .map((u) => ({
      ...u,
      shipped: auto.filter((t) => hasMarker(tags.index, t, u.version)),
      notShipped: auto.filter((t) => !hasMarker(tags.index, t, u.version)),
      partial: tags.index.partials.has(u.version),
    }));
  // Older versions with every auto marker (and no partial tag) are complete releases.
  const isComplete = (o: (typeof older)[number]) =>
    !o.partial && o.shipped.length > 0 && o.notShipped.length === 0;

  // "latest" (base branch only) goes to the highest release once this run is done.
  const releasing = [
    ...(complete ? [version] : []),
    ...older.filter(isComplete).map((o) => o.version),
  ];
  const highest = highestVersion([...tags.index.releases.keys(), ...releasing]);
  const latestFor = (v: string) => !plan.maintenance && v === highest;

  const release = (v: string, sha: string) => {
    const vTag = releaseTag(config.tags, v);
    if (tags.index.releases.has(v)) {
      const existingSha = tags.shas.get(vTag);
      if (existingSha && existingSha !== sha) {
        warnings.push(
          `${vTag} already exists at ${existingSha.slice(0, 7)}, not at the release commit ${sha.slice(0, 7)}. launchset leaves it as it is.`,
        );
      }
    } else {
      tagActions.push({ kind: "create-tag", tag: vTag, sha });
    }
    const section = input.changelog === null ? null : extractSection(input.changelog, v);
    if (section === null) {
      warnings.push(`${changelogFile} has no section for ${v}: the ${releaseName} has no notes.`);
    }
    const existing = input.releases.get(vTag);
    const body = renderReleaseBody({
      version: v,
      section,
      changelogFile,
      manualTargets: manualEntries(config, tags, v, existing?.body),
      ...(input.host ? { host: input.host } : {}),
    });
    const action = releaseAction({
      tag: vTag,
      name: vTag,
      body,
      prerelease: false,
      makeLatest: latestFor(v),
      existing,
      updateLatest: true,
    });
    if (action) releaseActions.push(action);
    // Every maintenance release gets its changelog backport (spec 9.5).
    if (plan.maintenance) {
      const backportAction = planBackport(input, v, vTag, notices, warnings);
      if (backportAction) otherActions.push(backportAction);
    }
  };

  if (complete) {
    release(version, plan.releaseSha);
  } else {
    failures.push(
      `${tag} is not released: ${plural(missing.length, "auto target")} ${missing.length === 1 ? "has" : "have"} no marker for ${version} yet: ${joinWords(missing.map(code))}.\n\nRe-run the failed build jobs, or start the release workflow by hand (workflow_dispatch without inputs) to retry. A newer release supersedes this one.`,
    );
  }

  // Superseding (spec 9.6): every publish finalize, idempotent.
  const superseded: SupersededVersion[] = [];
  const completed: string[] = [];
  for (const u of older) {
    const { shipped, notShipped } = u;
    if (shipped.length === 0 && !u.partial) {
      notices.push(
        `${u.version} has no auto target marker (only manual or removed targets), so it isn't superseded.`,
      );
      continue;
    }
    if (isComplete(u)) {
      completed.push(u.version);
      notices.push(
        `${u.version} has a marker for every auto target but no release tag: releasing it now.`,
      );
      release(u.version, u.sha);
      continue;
    }
    const pTag = partialTag(config.tags, u.version);
    if (!tags.index.partials.has(u.version)) {
      tagActions.push({ kind: "create-tag", tag: pTag, sha: u.sha });
    }
    if (!input.releases.has(pTag)) {
      const oldTag = releaseTag(config.tags, u.version);
      releaseActions.push({
        kind: "create-release",
        tag: pTag,
        name: partialReleaseTitle(oldTag, tag),
        body: renderPartialReleaseBody({
          version: u.version,
          tag: oldTag,
          supersededBy: tag,
          shipped,
          missing: notShipped,
          section: input.changelog === null ? null : extractSection(input.changelog, u.version),
          changelogFile,
          ...(input.host ? { host: input.host } : {}),
        }),
        prerelease: true,
        makeLatest: false,
      });
    }
    superseded.push({ version: u.version, tag: pTag, shipped, missing: notShipped });
  }

  const result: FinalizeResult = {
    ok: complete,
    status: complete ? "released" : "incomplete",
    version,
    tag,
    missing,
    superseded,
    completed,
    actions: [...tagActions, ...releaseActions, ...otherActions],
    failures,
    warnings,
    notices,
    summary: "",
  };
  result.summary = renderFinalizeSummary(result, input.host);
  return result;
}

function planBackport(
  input: FinalizeInput,
  version: string,
  tag: string,
  notices: string[],
  warnings: string[],
): FinalizeAction | null {
  const { config } = input;
  if (input.baseChangelog === undefined) {
    throw new LaunchsetError(
      "missing-input",
      `finalize of a maintenance release needs ${config.changelog.file} from ${config.baseBranch} for the changelog backport`,
    );
  }
  const section =
    input.changelog === null ? null : extractSectionWithHeading(input.changelog, version);
  if (section === null) {
    warnings.push(
      `No changelog backport for ${version}: ${config.changelog.file} at the release commit has no section for it.`,
    );
    return null;
  }
  const updated = insertSectionSorted(input.baseChangelog, section, version);
  if (updated === input.baseChangelog) {
    notices.push(
      `${config.changelog.file} on ${config.baseBranch} already has the ${version} section: no backport needed.`,
    );
    return null;
  }
  const title = backportTitle(tag);
  return {
    kind: "backport-changelog",
    version,
    base: config.baseBranch,
    branch: backportBranch(tag),
    title,
    body: `Adds the ${version} section, released from ${code(input.plan.branch)}, to ${code(config.changelog.file)}. It changes nothing else: no version files, no changesets.\n\n${section.trimEnd()}\n`,
    commitMessage: title,
    file: config.changelog.file,
    changelog: updated,
    section,
  };
}

function finalizeShip(input: FinalizeInput): FinalizeResult {
  const { config, plan, tags } = input;
  const { releaseName } = forgeWords(input.host);
  const version = plan.version;
  const tag = releaseTag(config.tags, version);
  const target = plan.matrix[0];
  if (!target || plan.matrix.length !== 1) {
    throw new LaunchsetError("invalid-plan", "a ship plan must have exactly one target");
  }
  const actions: FinalizeAction[] = [];
  const failures: string[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];
  const marked = hasMarker(tags.index, target, version);
  if (!marked) {
    failures.push(
      `${target} ${version} has no marker yet, so it didn't ship: the build job failed or didn't reach the mark step.\n\nFix the build and start the ship again (same target and version).`,
    );
  } else {
    const existing = input.releases.get(tag);
    const update: ManualTargetEntry = {
      target,
      shipped: true,
      // The target's own value, also when `eas` makes it null.
      buildNumber:
        target in plan.targets ? (plan.targets[target]?.buildNumber ?? null) : plan.buildNumber,
      date: isoDay(input.now),
    };
    const entries = manualEntries(config, tags, version, existing?.body, update);
    if (existing) {
      const body = upsertManualTargets(existing.body, entries, version, input.host);
      const action = releaseAction({
        tag,
        name: existing.name || tag,
        body,
        prerelease: existing.prerelease,
        makeLatest: false,
        existing,
        updateLatest: false,
      });
      if (action) actions.push(action);
      else
        notices.push(
          `The ${tag} ${input.host === "gitlab" ? releaseName : "Release"} already lists ${target} as shipped.`,
        );
    } else {
      const section = input.changelog === null ? null : extractSection(input.changelog, version);
      notices.push(`${tag} had no ${releaseName}: creating it.`);
      actions.push({
        kind: "create-release",
        tag,
        name: tag,
        body: renderReleaseBody({
          version,
          section,
          changelogFile: config.changelog.file,
          manualTargets: entries,
          ...(input.host ? { host: input.host } : {}),
        }),
        prerelease: false,
        makeLatest: !plan.maintenance && isHighestRelease(tags, version),
      });
    }
  }
  const result: FinalizeResult = {
    ok: marked,
    status: marked ? "shipped" : "not-shipped",
    version,
    tag,
    missing: marked ? [] : [target],
    superseded: [],
    completed: [],
    actions,
    failures,
    warnings,
    notices,
    summary: "",
  };
  result.summary = renderFinalizeSummary(result, input.host, target);
  return result;
}

function describeAction(action: FinalizeAction, releaseName: string): string {
  switch (action.kind) {
    case "create-tag":
      return `Create tag ${code(action.tag)} at ${code(action.sha.slice(0, 7))}`;
    case "create-release":
      return `Create ${action.prerelease ? "pre-release" : releaseName} ${code(action.name)}${action.makeLatest ? " (latest)" : ""}`;
    case "update-release":
      return `Update ${releaseName} ${code(action.name)}`;
    case "backport-changelog":
      return `Open the changelog backport PR ${code(action.title)} to ${code(action.base)}`;
  }
}

function renderFinalizeSummary(
  result: FinalizeResult,
  host: ForgeHost | undefined,
  shipTarget?: string,
): string {
  const { releaseName } = forgeWords(host);
  const paragraphs: string[] = [];
  switch (result.status) {
    case "released":
      paragraphs.push(`**${result.tag}** is released: every auto target shipped.`);
      break;
    case "incomplete":
      paragraphs.push(`**${result.tag}** is not complete yet.`);
      break;
    case "superseded":
      paragraphs.push(`**${result.version}** was superseded: it never gets ${result.tag}.`);
      break;
    case "shipped":
      paragraphs.push(`${code(shipTarget ?? "")} shipped **${result.version}**.`);
      break;
    case "not-shipped":
      paragraphs.push(`${code(shipTarget ?? "")} did not ship **${result.version}**.`);
      break;
  }
  for (const s of result.superseded) {
    paragraphs.push(
      `${s.version} is superseded (partial tag ${code(s.tag)}): shipped ${s.shipped.length > 0 ? joinWords(s.shipped.map(code)) : "nothing"}, not shipped ${joinWords(s.missing.map(code))}.`,
    );
  }
  if (result.actions.length > 0) {
    paragraphs.push(result.actions.map((a) => `- ${describeAction(a, releaseName)}`).join("\n"));
  } else {
    paragraphs.push(
      host === "gitlab"
        ? "Nothing to change: tags and releases are up to date."
        : "Nothing to change: tags and Releases are up to date.",
    );
  }
  return renderSummary({
    title: "launchset: finalize",
    paragraphs,
    failures: result.failures,
    warnings: result.warnings,
    notices: result.notices,
    ...(host ? { host } : {}),
  });
}
