/**
 * Git tags (spec 2, 8.1, 9.6, 9.8, 9.9): render the configured templates, parse tag names
 * back, and index a repo's tags into releases, prereleases, markers and partials. Pure.
 */

import semver from "semver";
import type { ResolvedConfig } from "./config/schema.ts";
import { LaunchsetError } from "./errors.ts";
import { escapeRegExp } from "./regex.ts";
import { highestVersion, isPlainVersion, type VersionLine, versionParts } from "./versions.ts";

export type TagTemplates = ResolvedConfig["tags"];

/** Render a tag template: `{version}` and `{target}`. */
export function renderTag(template: string, values: { version: string; target?: string }): string {
  return template.replace(/\{(version|target)\}/g, (match, key: "version" | "target") => {
    const value = values[key];
    if (value === undefined) {
      throw new LaunchsetError(
        "invalid-tag-template",
        `tag template "${template}" needs a value for ${match}`,
      );
    }
    return value;
  });
}

export const releaseTag = (tags: TagTemplates, version: string): string =>
  renderTag(tags.release, { version });
export const markerTag = (tags: TagTemplates, target: string, version: string): string =>
  renderTag(tags.marker, { target, version });
export const partialTag = (tags: TagTemplates, version: string): string =>
  renderTag(tags.partial, { version });

/** Semver with optional prerelease and build metadata; validated with `semver` afterwards. */
const VERSION_SOURCE = "\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?";
const TARGET_SOURCE = "[a-z0-9][a-z0-9-]*";

const matcherCache = new Map<string, RegExp>();

/** Matcher for a template; with `target`, `{target}` must be exactly that name. */
function templateMatcher(template: string, target?: string): RegExp {
  const key = target === undefined ? template : `${template}\u0000${target}`;
  let regex = matcherCache.get(key);
  if (!regex) {
    const targetSource =
      target === undefined ? `(?<target>${TARGET_SOURCE})` : `(?<target>${escapeRegExp(target)})`;
    // A placeholder that comes back (`release/{version}/v{version}`) must repeat the same
    // value: a second named group with the same name isn't valid, so it's a backreference.
    const seen = new Set<string>();
    const source = template
      .split(/(\{version\}|\{target\})/)
      .map((part) => {
        if (part !== "{version}" && part !== "{target}") return escapeRegExp(part);
        const name = part.slice(1, -1);
        if (seen.has(name)) return `\\k<${name}>`;
        seen.add(name);
        return name === "version" ? `(?<version>${VERSION_SOURCE})` : targetSource;
      })
      .join("");
    regex = new RegExp(`^${source}$`);
    matcherCache.set(key, regex);
  }
  return regex;
}

function matchTemplate(name: string, template: string, target?: string): ParsedTag | null {
  const match = templateMatcher(template, target).exec(name);
  const version = match?.groups?.version;
  if (!match || !version || !semver.valid(version)) return null;
  const found = match.groups?.target;
  return found === undefined ? { version } : { version, target: found };
}

export interface ParsedTag {
  version: string;
  target?: string;
}

/**
 * Parse a tag name with a template (regex metacharacters in the template are literal).
 * Returns `null` when the name doesn't fit the template or the version isn't valid semver.
 *
 * With `targets` (the configured target names) and a `{target}` template, each name is
 * tried literally first, longest first, so `{version}-{target}` parses `1.4.0-docker-api`
 * as target `docker-api`, not version `1.4.0-docker` + target `api`. Only when no
 * configured name fits does the generic pattern apply.
 */
export function parseTag(
  name: string,
  template: string,
  targets?: Iterable<string>,
): ParsedTag | null {
  if (targets && template.includes("{target}")) {
    const names = [...targets].sort((a, b) => b.length - a.length);
    for (const target of names) {
      const parsed = matchTemplate(name, template, target);
      if (parsed) return parsed;
    }
  }
  return matchTemplate(name, template);
}

export interface MarkerTag {
  tag: string;
  target: string;
  version: string;
}

/** A repo's tags, classified with the configured templates. Versions are without `v`. */
export interface TagIndex {
  /** Release tags: version (plain `X.Y.Z` only) → tag name. */
  releases: Map<string, string>;
  /** Release-template tags with a prerelease version (spec 9.9): version → tag name. */
  prereleases: Map<string, string>;
  /** Marker tags: version → target names (including targets no longer in the config). */
  markers: Map<string, Set<string>>;
  /** Every marker tag, in input order. */
  markerTags: MarkerTag[];
  /** Marker tags whose target isn't in the config (renamed or removed targets). */
  unknownMarkers: MarkerTag[];
  /** Partial tags (spec 9.6): version → tag name. */
  partials: Map<string, string>;
}

export interface IndexTagsConfig {
  tags: TagTemplates;
  /** Configured targets; markers of other targets end up in `unknownMarkers`. */
  targets?: Record<string, unknown>;
}

/**
 * Classify tag names (spec 2): only release-template tags with a plain `X.Y.Z` version are
 * releases; prerelease and partial tags never are. Unrelated tags are ignored.
 */
export function indexTags(tagNames: Iterable<string>, config: IndexTagsConfig): TagIndex {
  const index: TagIndex = {
    releases: new Map(),
    prereleases: new Map(),
    markers: new Map(),
    markerTags: [],
    unknownMarkers: [],
    partials: new Map(),
  };
  const addMarker = (name: string, marker: ParsedTag & { target: string }) => {
    const entry: MarkerTag = { tag: name, target: marker.target, version: marker.version };
    index.markerTags.push(entry);
    let targets = index.markers.get(marker.version);
    if (!targets) {
      targets = new Set();
      index.markers.set(marker.version, targets);
    }
    targets.add(marker.target);
    if (config.targets && !Object.hasOwn(config.targets, marker.target)) {
      index.unknownMarkers.push(entry);
    }
  };
  const targetNames = config.targets ? Object.keys(config.targets) : undefined;
  const known = (target: string) => !config.targets || Object.hasOwn(config.targets, target);

  // With custom templates a name can fit several of them. Most specific first: partial
  // tags, then markers of configured targets, then release tags, then other markers.
  for (const name of tagNames) {
    const partial = parseTag(name, config.tags.partial);
    if (partial && isPlainVersion(partial.version)) {
      index.partials.set(partial.version, name);
      continue;
    }
    const marker = parseTag(name, config.tags.marker, targetNames);
    if (marker?.target !== undefined && known(marker.target)) {
      addMarker(name, { ...marker, target: marker.target });
      continue;
    }
    const release = parseTag(name, config.tags.release);
    if (release) {
      if (isPlainVersion(release.version)) index.releases.set(release.version, name);
      else if (semver.prerelease(release.version) && !release.version.includes("+")) {
        index.prereleases.set(release.version, name);
      }
      continue;
    }
    if (marker?.target !== undefined) addMarker(name, { ...marker, target: marker.target });
  }
  return index;
}

/** The release tag of the highest version in `versions`, or `null`. */
export function lastReleaseTag(tags: TagTemplates, versions: Iterable<string>): string | null {
  const last = highestVersion(versions);
  return last === null ? null : releaseTag(tags, last);
}

/**
 * Commits the tags of `version` point to: its partial tag's first (with `partial`), then each
 * marker tag's, in tag order. Markers and partial tags sit on the release commit.
 */
export function versionTagShas(
  tags: { index: TagIndex; shas: ReadonlyMap<string, string> },
  version: string,
  options: { partial: boolean },
): string[] {
  const names: string[] = [];
  const partial = options.partial ? tags.index.partials.get(version) : undefined;
  if (partial !== undefined) names.push(partial);
  for (const marker of tags.index.markerTags) {
    if (marker.version === version) names.push(marker.tag);
  }
  return names.flatMap((name) => {
    const sha = tags.shas.get(name);
    return sha ? [sha] : [];
  });
}

/** Released versions, newest first. */
export function releasedVersions(index: TagIndex): string[] {
  return [...index.releases.keys()].sort(semver.rcompare);
}

/** The highest released version, or `null`. Prerelease and partial tags never count. */
export function latestRelease(index: TagIndex): string | null {
  return highestVersion(index.releases.keys());
}

/** The highest released version in a `major.minor` line (hotfix base, spec 9.5). */
export function latestReleaseInLine(index: TagIndex, line: VersionLine): string | null {
  return highestVersion(
    [...index.releases.keys()].filter((v) => {
      const parts = versionParts(v);
      return parts.major === line.major && parts.minor === line.minor;
    }),
  );
}

/** True when `version` has a release tag. */
export function isReleased(index: TagIndex, version: string): boolean {
  return index.releases.has(version);
}

/** Number of releases newer than `version` ("9 releases behind", spec 9.8). */
export function releasesAfter(index: TagIndex, version: string): number {
  let count = 0;
  for (const released of index.releases.keys()) {
    if (semver.gt(released, version)) count++;
  }
  return count;
}

/**
 * Versions that next-free-version skips (spec 8.1): every plain version with a release tag,
 * a marker tag or a partial tag. Prerelease tags never make a version taken.
 */
export function takenVersions(index: TagIndex): Set<string> {
  const taken = new Set<string>(index.releases.keys());
  for (const version of index.markers.keys()) {
    if (isPlainVersion(version)) taken.add(version);
  }
  for (const version of index.partials.keys()) taken.add(version);
  return taken;
}

/** Targets with a marker for `version` (empty set when none). */
export function markersFor(index: TagIndex, version: string): ReadonlySet<string> {
  return index.markers.get(version) ?? new Set();
}

/** True when `target` has a marker for `version`. */
export function hasMarker(index: TagIndex, target: string, version: string): boolean {
  return index.markers.get(version)?.has(target) ?? false;
}

/** The highest version `target` has a marker for ("never backwards", spec 9.8), or `null`. */
export function highestMarkerVersion(index: TagIndex, target: string): string | null {
  return highestVersion(
    [...index.markers.entries()].filter(([, targets]) => targets.has(target)).map(([v]) => v),
  );
}

/** Prerelease versions with a tag (spec 9.9), for `nextPrereleaseNumber`. */
export function prereleaseVersions(index: TagIndex): string[] {
  return [...index.prereleases.keys()];
}

type TargetsConfig = { targets: Record<string, { release: "auto" | "manual" }> };

/** Names of the auto targets (spec 9.8), in config order. */
export function autoTargets(config: TargetsConfig): string[] {
  return Object.entries(config.targets)
    .filter(([, target]) => target.release === "auto")
    .map(([name]) => name);
}

/** Auto targets without a marker for `version`, in config order. */
export function missingAutoTargets(
  index: TagIndex,
  config: TargetsConfig,
  version: string,
): string[] {
  const marked = markersFor(index, version);
  return autoTargets(config).filter((name) => !marked.has(name));
}

/**
 * Unfinished releases (spec 9.6): versions with at least one marker but no release tag and
 * no partial tag, oldest first. Only plain versions count.
 */
export function unfinishedReleases(index: TagIndex): string[] {
  return [...index.markers.keys()]
    .filter((v) => isPlainVersion(v) && !index.releases.has(v) && !index.partials.has(v))
    .sort(semver.compare);
}
