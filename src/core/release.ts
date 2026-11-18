/**
 * The release mode decision (spec 9.3, 9.8): `publish`, `ship`, `release-pr` or `none`, and
 * the plan the build jobs use. Pure: the I/O layer (src/flow) gathers the inputs from git and
 * GitHub and carries out what the plan says.
 */

import { isMaintenanceBranch } from "./branches.ts";
import type { ResolvedConfig } from "./config/schema.ts";
import { LaunchsetError } from "./errors.ts";
import {
  type BotPrInfo,
  buildTargetPlans,
  type CommitInfo,
  code,
  firstLine,
  highestVersion,
  isoTime,
  joinWords,
  normalizeVersionInput,
  planBuildNumber,
  plural,
  renderSummary,
  type TagSnapshot,
  unknownTarget,
} from "./plan-common.ts";
import {
  hasMarker,
  highestMarkerVersion,
  isReleased,
  lastReleaseTag,
  latestRelease,
  missingAutoTargets,
  releaseTag,
  takenVersions,
  versionTagShas,
} from "./tags.ts";
import type { Changeset, Plan, RunInfo } from "./types.ts";
import {
  compareVersions,
  distTag,
  isPlainVersion,
  parseMaintenanceBranch,
  releaseBump,
  releaseVersion,
} from "./versions.ts";

/** What started the release workflow. */
export type ReleaseEvent =
  | { kind: "push" }
  | {
      kind: "dispatch";
      /** `target` input: ship this manual target (spec 9.8). */
      target?: string;
      /** `version` input (with `target`): the released version to ship; default the latest. */
      version?: string;
      /** Allow shipping a version lower than the target's highest marker (spec 9.8). */
      force?: boolean;
    };

export interface ReleaseInput {
  config: ResolvedConfig;
  /** The branch the workflow runs on (`github.ref_name`). */
  branch: string;
  event: ReleaseEvent;
  /** HEAD commit (`github.sha`). */
  headSha: string;
  /** Root version at HEAD. */
  version: string;
  /**
   * True when HEAD's root version differs from its first parent's (HEAD is the release
   * commit of `version`). `git/release-commit.headIsReleaseCommit`.
   */
  headIsReleaseCommit: boolean;
  /**
   * Release commit of `version`: the commit of an existing marker tag for this version, else
   * the first-parent search (`git/release-commit.findReleaseCommit`). Required for a
   * `workflow_dispatch` retry (spec 9.3). On a push, pass it whenever `version` has no
   * release tag: commits up to and including it are left out of the no-changeset warning
   * (without it the marker tags' commit is used, else that warning is skipped).
   */
  releaseCommit?: string;
  tags: TagSnapshot;
  /**
   * Plain versions whose release tag is reachable from HEAD (`git tag --merged HEAD`). The
   * default version for `ship` is the highest, and it names the last release in warnings.
   */
  reachableReleases: readonly string[];
  /** Pending changesets at HEAD (parsed), including `none` ones. */
  changesets: readonly Changeset[];
  /** Merged bot PRs since the last release without a changeset (spec 9.4). */
  botPrs: readonly BotPrInfo[];
  /**
   * Commits after the last release tag reachable from HEAD (newest first), for the
   * no-changeset warning.
   */
  commitsSinceRelease: readonly CommitInfo[];
  now: Date | number;
  run?: RunInfo;
  /** `owner/repo`. */
  repository?: string;
}

export interface ReleaseDecision {
  plan: Plan;
  /** Things to know (shown as notes in the job summary). */
  notices: string[];
  /** Things to act on (shown as warnings in the job summary and the log). */
  warnings: string[];
  /** Set in `none` mode when commits since the last release have no changeset at all. */
  unreleasedCommits?: { since: string | null; commits: CommitInfo[] };
  /** Markdown for `$GITHUB_STEP_SUMMARY`. */
  summary: string;
}

/** How many commits the warning lists before "and N more". */
const LISTED_COMMITS = 20;

/**
 * Warning text for commits without any pending changeset (spec 9.3 `none`, 11 `check
 * --push`): "N commits since v1.4.0 and no pending changeset: they won't be released".
 */
export function commitsWithoutChangesetWarning(
  commits: readonly CommitInfo[],
  since: string | null,
): string {
  const where = since ? `since ${since}` : "and no release yet";
  const lines = commits
    .slice(0, LISTED_COMMITS)
    .map((c) => `- ${c.sha.slice(0, 7)} ${firstLine(c.subject)}`);
  if (commits.length > LISTED_COMMITS) {
    lines.push(`- … and ${commits.length - LISTED_COMMITS} more`);
  }
  return [
    `${plural(commits.length, "commit")} ${where} and no pending changeset: they won't be released.`,
    "",
    ...lines,
    "",
    "Add a changeset (`npx @demonsters/launchset add`) to release them, or `--empty` if they need no release.",
  ].join("\n");
}

function assertPlainRoot(version: string, file: string): void {
  if (!isPlainVersion(version)) {
    throw new LaunchsetError(
      "invalid-version",
      `the root version "${version}" in ${file} is not a plain X.Y.Z version`,
      {
        hint: "Releases need a plain version like 1.4.0. Prerelease versions are never committed: set it back with a normal PR.",
      },
    );
  }
}

interface BasePlanFields {
  input: ReleaseInput;
  mode: Plan["mode"];
  version: string;
  maintenance: boolean;
}

function basePlan({ input, mode, version, maintenance }: BasePlanFields): Plan {
  const plan: Plan = {
    schemaVersion: 1,
    mode,
    channel: "release",
    version,
    baseVersion: version,
    buildNumber: null,
    releaseSha: "",
    branch: input.branch,
    maintenance,
    distTag: distTag({ channel: "release", version, maintenance }),
    matrix: [],
    targets: {},
    createdAt: isoTime(input.now),
  };
  if (input.repository !== undefined) plan.repository = input.repository;
  if (input.run !== undefined) plan.run = { ...input.run };
  return plan;
}

/** A plan that builds `matrix` from `releaseSha` (publish or ship). */
function buildPlan(
  input: ReleaseInput,
  fields: BasePlanFields & { matrix: string[]; releaseSha: string; tagMaintenance?: boolean },
): Plan {
  const plan = basePlan(fields);
  plan.releaseSha = fields.releaseSha;
  plan.tag = releaseTag(input.config.tags, fields.version);
  plan.matrix = fields.matrix;
  plan.targets = buildTargetPlans(input.config, fields.matrix, {
    channel: "release",
    version: fields.version,
    baseVersion: fields.version,
    maintenance: fields.tagMaintenance ?? fields.maintenance,
    now: input.now,
    ...(input.run ? { run: input.run } : {}),
    sha: fields.releaseSha,
    createdAt: plan.createdAt,
    markerTemplate: { tags: input.config.tags },
  });
  plan.buildNumber = planBuildNumber(input.config, plan, {
    now: input.now,
    version: fields.version,
    ...(input.run ? { run: input.run } : {}),
  });
  return plan;
}

function finish(
  plan: Plan,
  extra: Omit<ReleaseDecision, "plan" | "summary" | "notices" | "warnings"> & {
    notices?: string[];
    warnings?: string[];
  },
): ReleaseDecision {
  const decision: ReleaseDecision = {
    plan,
    notices: extra.notices ?? [],
    warnings: extra.warnings ?? [],
    summary: "",
  };
  if (extra.unreleasedCommits) decision.unreleasedCommits = extra.unreleasedCommits;
  decision.summary = renderReleaseSummary(decision);
  return decision;
}

/**
 * Decide the release mode (spec 9.3) and build the plan.
 *
 * - `ship`: a `workflow_dispatch` with `target` (spec 9.8).
 * - `publish`: on a push, HEAD is the release commit and `v{version}` doesn't exist; on a
 *   dispatch without `target`, the current version isn't released yet. Never for a version
 *   with a partial tag (superseded, spec 9.6). Publish wins over pending changesets. Below
 *   the latest release it doesn't move `latest` (maintenance-style Docker tags, `release-X.Y`).
 * - Otherwise (also a dispatch when the version is released or superseded):
 *   - `release-pr`: pending non-`none` changesets or bot PRs.
 *   - `none`: otherwise, with a warning for commits that no changeset covers.
 *   A push while the current version is unfinished warns that pushes don't retry it.
 *
 * Throws `LaunchsetError` for requests that can't be served (unknown or auto target for
 * `ship`, unreleased version, going backwards, minor/major on a maintenance branch, …).
 */
export function planRelease(input: ReleaseInput): ReleaseDecision {
  const { config, event } = input;
  if (event.kind === "dispatch" && event.target !== undefined && event.target !== "") {
    return planShip(input, event.target, event);
  }
  if (event.kind === "dispatch" && event.version) {
    throw new LaunchsetError(
      "version-without-target",
      `the version input (${event.version}) only works together with the target input`,
      {
        hint: "To ship a manual target, set both target and version. To retry the current release, start the workflow without inputs.",
      },
    );
  }

  const maintenance = isMaintenanceBranch(config, input.branch);
  if (!maintenance && input.branch !== config.baseBranch) {
    throw new LaunchsetError(
      "not-a-release-branch",
      `${input.branch} is neither the base branch (${config.baseBranch}) nor a maintenance branch (${config.maintenanceBranches}), so nothing is released from it`,
      {
        hint: `Run the release workflow on ${config.baseBranch} or a maintenance branch. To ship a manual target, pass the target input.`,
      },
    );
  }
  assertPlainRoot(input.version, config.version.file);
  const index = input.tags.index;
  const version = input.version;
  const released = isReleased(index, version);
  // A superseded version (partial tag, spec 9.6) is never published and never released.
  const partial = index.partials.get(version);
  const pending = input.changesets;
  const pendingNote = (): string[] =>
    releaseBump(pending) !== null || input.botPrs.length > 0
      ? [
          `${plural(pending.length, "pending changeset")}${input.botPrs.length > 0 ? ` and ${plural(input.botPrs.length, "bot PR")}` : ""} wait for the next release PR, which is opened on the next push (publish goes first).`,
        ]
      : [];

  // publish
  if (event.kind === "push" && input.headIsReleaseCommit && !released && partial === undefined) {
    return planPublish(input, maintenance, input.headSha, pendingNote());
  }
  if (event.kind === "dispatch" && !released && partial === undefined) {
    if (!input.releaseCommit) {
      throw new LaunchsetError(
        "no-release-commit",
        `can't find the release commit of ${version} on ${input.branch}: no marker tag for it and no first-parent commit that changed the root version`,
        { hint: "Fetch the full history (actions/checkout with fetch-depth: 0) and try again." },
      );
    }
    const missing = missingAutoTargets(index, config, version);
    return planPublish(input, maintenance, input.releaseCommit, [
      `Retrying the release of ${version} from its release commit ${input.releaseCommit.slice(0, 7)}${missing.length > 0 ? `: building ${joinWords(missing.map(code))}` : ""}.`,
      ...pendingNote(),
    ]);
  }

  // Not a publish: explain the state of the current version, then release-pr or none.
  const notices: string[] = [];
  const warnings: string[] = [];
  /** Commit the current version's release state starts at; commits up to it aren't "unreleased work". */
  let currentReleaseCommit: string | undefined;
  /** False when the commit list can't be trusted for the no-changeset warning. */
  let commitsUsable = true;
  if (partial !== undefined) {
    warnings.push(
      `${version} was superseded: it has the partial tag ${partial}, so it is never published and never gets ${releaseTag(config.tags, version)}. Pending changesets release a newer version.`,
    );
    currentReleaseCommit = input.tags.shas.get(partial) ?? input.releaseCommit;
  } else if (!released && event.kind === "push") {
    const missing = missingAutoTargets(index, config, version);
    warnings.push(
      `${version} is not released (missing ${joinWords(missing.map(code))}); pushes don't retry it: re-run the failed jobs, or start the release workflow by hand (workflow_dispatch without inputs). A newer release supersedes it.`,
    );
    currentReleaseCommit = input.releaseCommit ?? markerCommit(input, version);
    // Without the release commit the list would include the release itself.
    if (currentReleaseCommit === undefined) commitsUsable = false;
  } else if (released && event.kind === "dispatch") {
    notices.push(
      `${releaseTag(config.tags, version)} is already released: there is nothing to retry. To ship a manual target, start the workflow with the target input (and optionally version).`,
    );
  }
  const commits = commitsUsable
    ? commitsAfter(input.commitsSinceRelease, currentReleaseCommit)
    : [];

  // release-pr
  const bump = releaseBump(pending);
  if (bump !== null || input.botPrs.length > 0) {
    const releaseBumpValue = bump ?? "patch";
    const line = parseMaintenanceBranch(input.branch, config.maintenanceBranches);
    if (line && (releaseBumpValue === "minor" || releaseBumpValue === "major")) {
      const offending = pending
        .filter((c) => c.bump === "minor" || c.bump === "major")
        .map((c) => `${c.path} (${c.bump})`);
      throw new LaunchsetError(
        "maintenance-bump",
        `${input.branch} is a maintenance branch: only patch and none changesets are allowed, but ${joinWords(offending)} ${offending.length === 1 ? "is" : "are"} pending`,
        {
          hint: `A minor or major change belongs on ${config.baseBranch}. Change the bump to patch, or move the change to ${config.baseBranch}.`,
        },
      );
    }
    const maintenanceLine = line
      ? { maintenance: { line, branch: input.branch, baseBranch: config.baseBranch } }
      : {};
    const next = releaseVersion({
      current: version,
      bump: releaseBumpValue,
      taken: takenVersions(index),
      ...maintenanceLine,
    });
    const plan = basePlan({ input, mode: "release-pr", version: next, maintenance });
    plan.releasePr = {
      version: next,
      bump: releaseBumpValue,
      changesets: pending.map((c) => c.path),
      botPrs: input.botPrs.map((p) => p.number),
    };
    const plainNext = releaseVersion({
      current: version,
      bump: releaseBumpValue,
      taken: new Set(),
      ...maintenanceLine,
    });
    if (plainNext !== next) {
      notices.push(
        `${plainNext} is already taken (released or partly shipped, for example from a maintenance branch), so the release PR uses ${next}.`,
      );
    }
    return finish(plan, { notices, warnings });
  }

  // none
  const plan = basePlan({ input, mode: "none", version, maintenance });
  if (pending.length > 0) {
    notices.push(
      `Only bump: none changesets are pending (${plural(pending.length, "changeset")}): nothing to release. They are removed by the next release.`,
    );
    return finish(plan, { notices, warnings });
  }
  if (commits.length > 0) {
    const since = lastReleaseTag(input.config.tags, input.reachableReleases);
    warnings.push(commitsWithoutChangesetWarning(commits, since));
    return finish(plan, { notices, warnings, unreleasedCommits: { since, commits } });
  }
  if (notices.length === 0 && warnings.length === 0) {
    notices.push("Nothing to release: no pending changesets.");
  }
  return finish(plan, { notices, warnings });
}

/** The publish plan: missing auto targets from `releaseSha`. */
function planPublish(
  input: ReleaseInput,
  maintenance: boolean,
  releaseSha: string,
  notices: string[],
): ReleaseDecision {
  const { config } = input;
  const index = input.tags.index;
  const version = input.version;
  const matrix = missingAutoTargets(index, config, version);
  // A version below the latest release (e.g. after a revert) must not move `latest`,
  // `{major}` or npm `latest` (spec 6.1, 10); finalize doesn't mark it latest either.
  const latest = latestRelease(index);
  const notLatest = latest !== null && compareVersions(version, latest) < 0;
  const plan = buildPlan(input, {
    input,
    mode: "publish",
    version,
    maintenance,
    tagMaintenance: maintenance || notLatest,
    matrix,
    releaseSha,
  });
  if (notLatest) {
    plan.distTag = distTag({ channel: "release", version, maintenance: true });
    notices.push(
      `${version} is lower than the latest release ${latest}: it doesn't move latest (Docker latest/major tags, npm dist-tag, GitHub latest).`,
    );
  }
  if (matrix.length === 0) {
    notices.push(
      `Every auto target already has a marker for ${version}: nothing to build, finalize creates ${plan.tag}.`,
    );
  }
  return finish(plan, { notices });
}

/** Commit of a marker tag of `version` (markers sit on the release commit). */
function markerCommit(input: ReleaseInput, version: string): string | undefined {
  return versionTagShas(input.tags, version, { partial: false })[0];
}

/** Commits newer than `sha` (the list is newest first); all of them when `sha` isn't in it. */
function commitsAfter(commits: readonly CommitInfo[], sha: string | undefined): CommitInfo[] {
  if (sha === undefined) return [...commits];
  const at = commits.findIndex((c) => c.sha === sha);
  return at === -1 ? [...commits] : commits.slice(0, at);
}

/** `ship` (spec 9.8): build one manual target for an already released version. */
function planShip(
  input: ReleaseInput,
  targetName: string,
  event: Extract<ReleaseEvent, { kind: "dispatch" }>,
): ReleaseDecision {
  const { config } = input;
  const index = input.tags.index;
  const target = config.targets[targetName];
  if (!target) throw unknownTarget(config, targetName);
  if (target.release !== "manual") {
    throw new LaunchsetError(
      "ship-auto-target",
      `${targetName} is an auto target: it ships with every release, so it can't be shipped on its own`,
      {
        hint: 'To retry an unfinished release, start the workflow without the target input. Only targets with release: "manual" are shipped on demand.',
      },
    );
  }
  let version: string;
  if (event.version) {
    version = normalizeVersionInput(event.version);
  } else {
    const latest = highestVersion(input.reachableReleases);
    if (latest === null) {
      throw new LaunchsetError(
        "no-release",
        `there is no release on ${input.branch} yet, so there is nothing to ship for ${targetName}`,
        {
          hint: "Ship only released versions. For unreleased commits use a preview build.",
        },
      );
    }
    version = latest;
  }
  const tag = releaseTag(config.tags, version);
  if (!isReleased(index, version)) {
    throw new LaunchsetError(
      "not-released",
      `${version} isn't released (there is no ${tag} tag), so ${targetName} can't ship it`,
      {
        hint: "Ship only released versions. For unreleased commits, use a preview build.",
      },
    );
  }
  const maintenance = isMaintenanceBranch(config, input.branch);
  if (hasMarker(index, targetName, version)) {
    const plan = basePlan({ input, mode: "none", version, maintenance });
    plan.tag = tag;
    return finish(plan, {
      notices: [`${targetName} ${version} is already shipped: nothing to do.`],
    });
  }
  const highest = highestMarkerVersion(index, targetName);
  const notices: string[] = [];
  if (highest !== null && compareVersions(version, highest) < 0) {
    if (!event.force) {
      throw new LaunchsetError(
        "ship-backwards",
        `${targetName} already shipped ${highest}, which is higher than ${version}: shipping a lower version goes backwards (stores reject lower versions)`,
        {
          hint: `Ship ${highest} or newer. To ship ${version} anyway: --force (CLI), or the force option when starting the release workflow by hand.`,
        },
      );
    }
    notices.push(`Shipping ${version} although ${targetName} already shipped ${highest} (force).`);
  }
  const releaseSha = input.tags.shas.get(tag);
  if (!releaseSha) {
    throw new LaunchsetError("missing-tag-sha", `the commit of tag ${tag} is unknown`, {
      hint: "Fetch the tags (actions/checkout with fetch-depth: 0) and try again.",
    });
  }
  // An older version must not move the line's moving tags or npm `latest` (spec 6.1, 10).
  const latest = latestRelease(index);
  const notLatest = latest !== null && compareVersions(version, latest) < 0;
  const plan = buildPlan(input, {
    input,
    mode: "ship",
    version,
    maintenance,
    tagMaintenance: maintenance || notLatest,
    matrix: [targetName],
    releaseSha,
  });
  plan.distTag = distTag({ channel: "release", version, maintenance: maintenance || notLatest });
  return finish(plan, { notices });
}

/** `, build number N` of the shipped target (its own value, also when `eas` makes it null). */
function shipBuild(plan: Plan): string {
  const target = plan.targets[plan.matrix[0] ?? ""];
  const build = target ? target.buildNumber : plan.buildNumber;
  return build === null ? "" : `, build number ${build}`;
}

function renderReleaseSummary(decision: ReleaseDecision): string {
  const { plan } = decision;
  const paragraphs: string[] = [];
  switch (plan.mode) {
    case "publish":
      paragraphs.push(
        `Publishing **${plan.version}** from ${code(plan.releaseSha.slice(0, 7))} on ${code(plan.branch)}.`,
        plan.matrix.length > 0
          ? `Building: ${joinWords(plan.matrix.map(code))}${plan.buildNumber !== null ? ` (build number ${plan.buildNumber})` : ""}.`
          : "",
      );
      break;
    case "ship":
      paragraphs.push(
        `Shipping ${code(plan.matrix[0] ?? "")} **${plan.version}** from ${code(plan.tag ?? "")} (${code(plan.releaseSha.slice(0, 7))})${shipBuild(plan)}.`,
      );
      break;
    case "release-pr":
      if (plan.releasePr) {
        const bots = plan.releasePr.botPrs.length;
        paragraphs.push(
          `Updating the release PR for **${plan.version}** (${plan.releasePr.bump}): ${plural(plan.releasePr.changesets.length, "changeset")}${bots > 0 ? ` and ${plural(bots, "bot PR")}` : ""}.`,
        );
      }
      break;
    default:
      paragraphs.push("Nothing to build.");
  }
  return renderSummary({
    title: `launchset: ${plan.mode}`,
    paragraphs,
    warnings: decision.warnings,
    notices: decision.notices,
  });
}
