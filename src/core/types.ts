/**
 * Shared types for launchset. This file is a contract between modules: change it only
 * deliberately, and update every user.
 *
 * Everything in `src/core` is pure (no I/O). I/O lives in `src/config`, `src/platforms`,
 * `src/git`, `src/forge`, `src/verify` and `src/flow`.
 */

import type { ResolvedTarget, TargetType } from "./config/schema.ts";

/** Changeset bump types, lowest first. */
export const BUMPS = ["none", "patch", "minor", "major"] as const;
export type Bump = (typeof BUMPS)[number];

/** A parsed changeset file (spec 4.1). */
export interface Changeset {
  /** File name, e.g. `brave-lions-sing.md`. */
  name: string;
  /** Repo-relative POSIX path, e.g. `.launchset/brave-lions-sing.md`. */
  path: string;
  bump: Bump;
  /** Markdown body with surrounding blank lines trimmed. Empty only when `bump` is `none`. */
  summary: string;
  /** `bot` for changesets generated from bot PRs (spec 9.4). */
  source?: "bot";
  /** PR number, set on generated bot changesets. */
  pr?: number;
  /** Unknown frontmatter keys, kept as parsed (spec 4.1, issue #2). */
  extra: Record<string, unknown>;
}

/**
 * Release workflow mode (spec 9.3). `preview` is the mode of a `preview-plan` plan
 * (spec 9.7, 9.9); the action's `mode` output is only set by `release`.
 */
export type Mode = "publish" | "ship" | "release-pr" | "none" | "preview";

/** Where a build job uploads to (glossary). */
export type Channel = "release" | "prerelease" | "preview";

/** OCI image data for a docker target in a plan (spec 6.1). */
export interface DockerPlan {
  /** Image names without tag, e.g. `ghcr.io/demonsters/api`. */
  images: string[];
  /** Rendered tags for this run, after skipping and maintenance filtering (spec 6.1). */
  tags: string[];
  /** Every `image:tag` combination, images outer loop, tags inner loop. */
  refs: string[];
  /** The verify tag (spec 7.4): first rendered tag whose template contains `{version}`. */
  verifyTag: string;
  /** OCI label values: `org.opencontainers.image.version`, `.revision`, `.created`. */
  labels: Record<string, string>;
}

/** Per-target data in a plan. */
export interface TargetPlan {
  name: string;
  type: TargetType;
  release: ResolvedTarget["release"];
  /**
   * Version written into this target's marketing-version fields: the plain `X.Y.Z`
   * base version for iOS (spec 6.4), the full run version everywhere else.
   */
  marketingVersion: string;
  /** Build number for this target (its own `buildNumber` override applies). `null` for `eas`. */
  buildNumber: number | null;
  /** Marker tag to create after shipping (release channel only, spec 9.3 / 9.8). */
  marker?: string;
  docker?: DockerPlan;
}

/** Information about the release PR computed in `release-pr` mode (spec 9.3). */
export interface ReleasePrPlan {
  /** Version the release PR will set, e.g. `1.5.0`. */
  version: string;
  bump: Exclude<Bump, "none">;
  /** Repo-relative paths of the changesets the PR consumes (including `none` ones). */
  changesets: string[];
  /** Bot PRs that get a generated changeset (spec 9.4). */
  botPrs: number[];
}

/** GitHub Actions run info, when known. Used for links and build numbers. */
export interface RunInfo {
  id?: number;
  number?: number;
  attempt?: number;
  /** Link to the workflow run. */
  url?: string;
}

/**
 * The plan: the JSON passed between workflow jobs (`plan` output, spec 9.3 / 9.7).
 * Later steps (`stamp`, `verify`, `mark`, `finalize`, `preview-comment`) read it and
 * never recompute version or build number.
 */
export interface Plan {
  schemaVersion: 1;
  mode: Mode;
  channel: Channel;
  /** The version of this run: release version, preview version (8.3) or prerelease version (9.9). */
  version: string;
  /** Plain `X.Y.Z` part of `version` (`{next}` for previews and prereleases). */
  baseVersion: string;
  /** Build number from the root `buildNumber` config; `null` with `eas`. Targets may differ. */
  buildNumber: number | null;
  /** Commit every build job checks out (spec 9.3). Empty string in `none` / `release-pr` mode. */
  releaseSha: string;
  /** Branch the plan was made on (base, maintenance, prerelease or preview branch). */
  branch: string;
  /** True when `branch` matches `maintenanceBranches`. */
  maintenance: boolean;
  /** npm dist-tag suggestion (spec 10). */
  distTag: string;
  /** Git tag of this version: `v{version}` (publish/ship) or the prerelease tag (9.9). */
  tag?: string;
  prNumber?: number;
  branchSlug?: string;
  preid?: string;
  /** Target names to build, in config order. Empty when nothing is built. */
  matrix: string[];
  /** Data for every target in `matrix`. */
  targets: Record<string, TargetPlan>;
  /** Set in `release-pr` mode. */
  releasePr?: ReleasePrPlan;
  /** `owner/repo`, when known. */
  repository?: string;
  run?: RunInfo;
  /** ISO 8601 time the plan was created; also the OCI `created` label. */
  createdAt: string;
}
