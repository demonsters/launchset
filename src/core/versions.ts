/**
 * Versions (spec 8, 10): bumps, next (free) version, maintenance lines, preview and
 * prerelease versions, branch slugs, npm dist-tags. Pure.
 */

import semver from "semver";
import type { TargetType } from "./config/schema.ts";
import { LaunchsetError } from "./errors.ts";
import { escapeRegExp } from "./regex.ts";
import { BUMPS, type Bump, type Changeset } from "./types.ts";

/** A plain `X.Y.Z` version (no prerelease, no build metadata). */
const PLAIN_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export type ReleaseBump = Exclude<Bump, "none">;

/** True for a plain `X.Y.Z` version (no `v`, no prerelease, no build metadata). */
export function isPlainVersion(version: string): boolean {
  return PLAIN_VERSION.test(version);
}

/** `major.minor.patch` of a semver version: `1.5.0-pr.12.3` → `1.5.0`. */
export function baseVersionOf(version: string): string {
  const parsed = semver.parse(version);
  if (!parsed) {
    throw new LaunchsetError("invalid-version", `"${version}" is not a valid semver version`);
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

/** Major, minor and patch of a version. */
export function versionParts(version: string): { major: number; minor: number; patch: number } {
  const parsed = semver.parse(version);
  if (!parsed) {
    throw new LaunchsetError("invalid-version", `"${version}" is not a valid semver version`);
  }
  return { major: parsed.major, minor: parsed.minor, patch: parsed.patch };
}

/** Semver order (prereleases before their release). For `Array.prototype.sort`. */
export function compareVersions(a: string, b: string): number {
  return semver.compare(a, b);
}

// ---------------------------------------------------------------------------
// Bumps (spec 4.3)

/** The highest bump (`major` > `minor` > `patch` > `none`); `none` for an empty list. */
export function highestBump(bumps: Iterable<Bump>): Bump {
  let highest: Bump = "none";
  for (const bump of bumps) {
    if (BUMPS.indexOf(bump) > BUMPS.indexOf(highest)) highest = bump;
  }
  return highest;
}

/**
 * The release bump for pending changesets: the highest bump, or `null` when nothing would
 * be released (no changesets, or only `none` ones).
 */
export function releaseBump(changesets: Iterable<Pick<Changeset, "bump">>): ReleaseBump | null {
  const bump = highestBump(Array.from(changesets, (c) => c.bump));
  return bump === "none" ? null : bump;
}

// ---------------------------------------------------------------------------
// Next version (spec 8.1)

function assertPlain(version: string, what: string): void {
  if (!isPlainVersion(version)) {
    throw new LaunchsetError(
      "invalid-version",
      `${what} "${version}" is not a plain X.Y.Z version`,
      { hint: "The root version must look like 1.4.0 (no v prefix, no prerelease suffix)." },
    );
  }
}

/** `semver.inc(current, bump)`; `none` returns `current`. `current` must be plain `X.Y.Z`. */
export function nextVersion(current: string, bump: Bump): string {
  assertPlain(current, "version");
  if (bump === "none") return current;
  const next = semver.inc(current, bump);
  if (!next) throw new LaunchsetError("invalid-version", `can't bump "${current}" (${bump})`);
  return next;
}

/** Something that says whether a version is taken (a set of versions works). */
export type TakenVersions = ReadonlySet<string> | ((version: string) => boolean);

function isTaken(taken: TakenVersions, version: string): boolean {
  return typeof taken === "function" ? taken(version) : taken.has(version);
}

/**
 * Next free version (spec 8.1): while `version` is taken (it has a release tag or any
 * marker tag, see `takenVersions` in `tags.ts`), increase the patch. Prerelease tags never
 * make a version taken; pass only plain versions.
 */
export function nextFreeVersion(version: string, taken: TakenVersions): string {
  assertPlain(version, "version");
  let candidate = version;
  while (isTaken(taken, candidate)) {
    candidate = semver.inc(candidate, "patch") as string;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Maintenance branches (spec 8.2)

export interface VersionLine {
  major: number;
  minor: number;
}

export const DEFAULT_MAINTENANCE_PATTERN = "release/*.x";

/**
 * The version line of a maintenance branch, or `null` when `branch` isn't one. The single
 * `*` in `pattern` stands for `<major>.<minor>`: `release/1.4.x` → `{ major: 1, minor: 4 }`.
 */
export function parseMaintenanceBranch(
  branch: string,
  pattern: string = DEFAULT_MAINTENANCE_PATTERN,
): VersionLine | null {
  const parts = pattern.split("*");
  if (parts.length !== 2) {
    throw new LaunchsetError(
      "invalid-config",
      `maintenanceBranches "${pattern}" must contain exactly one "*" (it stands for <major>.<minor>)`,
    );
  }
  const regex = new RegExp(
    `^${escapeRegExp(parts[0] as string)}(0|[1-9]\\d*)\\.(0|[1-9]\\d*)${escapeRegExp(parts[1] as string)}$`,
  );
  const match = regex.exec(branch);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/** The maintenance branch name for a line: `(1, 4)` → `release/1.4.x`. */
export function maintenanceBranchName(
  line: VersionLine,
  pattern: string = DEFAULT_MAINTENANCE_PATTERN,
): string {
  if (pattern.split("*").length !== 2) {
    throw new LaunchsetError(
      "invalid-config",
      `maintenanceBranches "${pattern}" must contain exactly one "*" (it stands for <major>.<minor>)`,
    );
  }
  return pattern.replace("*", `${line.major}.${line.minor}`);
}

/** True when `version` is in the line (`1.4.*` for `{ major: 1, minor: 4 }`). */
export function isInLine(version: string, line: VersionLine): boolean {
  const parts = versionParts(version);
  return parts.major === line.major && parts.minor === line.minor;
}

export interface MaintenanceViolation {
  /** Changeset path. */
  path: string;
  bump: "minor" | "major";
  message: string;
}

/**
 * Changesets that aren't allowed on a maintenance branch (spec 8.2: only `patch` and
 * `none`). Used by the PR check; an empty list means everything is fine.
 */
export function maintenanceViolations(
  changesets: Iterable<Pick<Changeset, "path" | "bump">>,
  branch: string,
  baseBranch: string,
): MaintenanceViolation[] {
  const violations: MaintenanceViolation[] = [];
  for (const changeset of changesets) {
    if (changeset.bump === "minor" || changeset.bump === "major") {
      violations.push({
        path: changeset.path,
        bump: changeset.bump,
        message: `${changeset.path}: bump "${changeset.bump}" isn't allowed on the maintenance branch ${branch} (only patch and none). A ${changeset.bump} change belongs on ${baseBranch}: open this PR against ${baseBranch} instead.`,
      });
    }
  }
  return violations;
}

/** Throws when `version` would leave the maintenance line (spec 8.2). */
export function assertInLine(version: string, line: VersionLine, branch: string): void {
  if (!isInLine(version, line)) {
    throw new LaunchsetError(
      "outside-maintenance-line",
      `version ${version} is outside the ${line.major}.${line.minor} line of the maintenance branch ${branch}`,
      { hint: `Releases from ${branch} must stay ${line.major}.${line.minor}.*.` },
    );
  }
}

export interface ReleaseVersionInput {
  /** Root version, plain `X.Y.Z`. */
  current: string;
  bump: ReleaseBump;
  /** Versions that already have a release tag or a marker (see `takenVersions`). */
  taken: TakenVersions;
  /** Set on a maintenance branch: the next version must stay in this line. */
  maintenance?: { line: VersionLine; branch: string; baseBranch: string };
}

/**
 * The version a release PR sets (spec 8.1, 8.2): bump, then skip taken versions. On a
 * maintenance branch only `patch` is allowed and the result must stay in the line.
 */
export function releaseVersion(input: ReleaseVersionInput): string {
  const { maintenance } = input;
  if (maintenance && input.bump !== "patch") {
    throw new LaunchsetError(
      "maintenance-bump",
      `bump "${input.bump}" isn't allowed on the maintenance branch ${maintenance.branch} (only patch and none)`,
      { hint: `A ${input.bump} change belongs on ${maintenance.baseBranch}.` },
    );
  }
  const version = nextFreeVersion(nextVersion(input.current, input.bump), input.taken);
  if (maintenance) assertInLine(version, maintenance.line, maintenance.branch);
  return version;
}

// ---------------------------------------------------------------------------
// Previews and prereleases (spec 8.3, 9.9)

export interface PreviewBaseInput {
  current: string;
  /** Bump of the changesets on the PR/branch; `null`/`none` → a patch bump. */
  bump: Bump | null;
  taken?: TakenVersions;
}

/** `{next}` for previews and prereleases (spec 8.3): a patch bump when nothing is pending. */
export function previewBaseVersion(input: PreviewBaseInput): string {
  const bump: ReleaseBump = input.bump && input.bump !== "none" ? input.bump : "patch";
  const next = nextVersion(input.current, bump);
  return input.taken ? nextFreeVersion(next, input.taken) : next;
}

function assertInteger(value: number, what: string, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new LaunchsetError(
      "invalid-number",
      `${what} must be an integer >= ${min}, got ${value}`,
    );
  }
}

function assertValid(version: string, why: string): string {
  if (!semver.valid(version)) {
    throw new LaunchsetError(
      "invalid-version",
      `"${version}" is not a valid semver version (${why})`,
    );
  }
  return version;
}

/** PR preview version: `{next}-pr.{prNumber}.{runNumber}` → `1.5.0-pr.123.4`. */
export function prPreviewVersion(next: string, prNumber: number, runNumber: number): string {
  assertPlain(next, "preview base version");
  assertInteger(prNumber, "PR number", 1);
  assertInteger(runNumber, "run number", 1);
  return `${next}-pr.${prNumber}.${runNumber}`;
}

/** Branch preview version: `{next}-{branchSlug}.{runNumber}` → `1.5.0-develop.17`. */
export function branchPreviewVersion(next: string, slug: string, runNumber: number): string {
  assertPlain(next, "preview base version");
  assertInteger(runNumber, "run number", 1);
  if (slug === "") {
    throw new LaunchsetError(
      "invalid-branch",
      "the branch name has no letters or digits, so it can't be used in a preview version",
    );
  }
  return assertValid(`${next}-${slug}.${runNumber}`, `branch slug "${slug}"`);
}

/**
 * The next prerelease number `n` for `{next}-{preid}.{n}` (spec 9.9): one higher than the
 * highest existing `{next}-{preid}.<n>` version, starting at 0. Gaps are fine.
 */
export function nextPrereleaseNumber(
  next: string,
  preid: string,
  existingVersions: Iterable<string>,
): number {
  const regex = new RegExp(`^${escapeRegExp(next)}-${escapeRegExp(preid)}\\.(0|[1-9]\\d*)$`);
  let highest = -1;
  for (const version of existingVersions) {
    const match = regex.exec(version);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

/** Prerelease version `{next}-{preid}.{n}` (spec 8.3, 9.9). */
export function prereleaseVersion(next: string, preid: string, n: number): string {
  assertPlain(next, "prerelease base version");
  assertInteger(n, "prerelease number", 0);
  return assertValid(`${next}-${preid}.${n}`, `prerelease id "${preid}"`);
}

/**
 * Branch slug (spec 8.3): lowercase, only `[a-z0-9-]` (other characters become dashes,
 * repeated dashes collapse), at most 30 characters, no leading or trailing dash.
 * `feature/New_Form` → `feature-new-form`. An all-digit slug gets a `b-` prefix
 * (`007` → `b-007`): a numeric prerelease identifier with a leading zero isn't valid
 * semver, and a numeric one would sort as a number.
 */
export function branchSlug(branch: string): string {
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .slice(0, 30)
    .replace(/-+$/, "");
  return /^\d+$/.test(slug) ? `b-${slug}`.slice(0, 30) : slug;
}

// ---------------------------------------------------------------------------
// npm dist-tag (spec 10)

export type DistTagInput =
  | { channel: "release"; version: string; maintenance: boolean }
  | { channel: "prerelease"; preid: string }
  | { channel: "preview"; prNumber?: number; branchSlug?: string };

/**
 * npm dist-tag suggestion (spec 10): `latest` for base-branch releases,
 * `release-<major>.<minor>` on maintenance branches, `<preid>` for prereleases,
 * `pr-<n>` / `<branchSlug>` for previews.
 */
export function distTag(input: DistTagInput): string {
  switch (input.channel) {
    case "release": {
      if (!input.maintenance) return "latest";
      const { major, minor } = versionParts(input.version);
      return `release-${major}.${minor}`;
    }
    case "prerelease":
      return input.preid;
    case "preview":
      if (input.prNumber !== undefined) return `pr-${input.prNumber}`;
      if (input.branchSlug) return input.branchSlug;
      throw new LaunchsetError(
        "invalid-preview",
        "a preview needs a PR number or a branch slug for its dist-tag",
      );
  }
}

/**
 * The version written into a target's marketing-version fields: the plain base version for
 * iOS (Apple accepts only `X.Y.Z`, spec 6.4), the run version everywhere else.
 */
export function marketingVersion(type: TargetType, version: string): string {
  return type === "ios" ? baseVersionOf(version) : version;
}
