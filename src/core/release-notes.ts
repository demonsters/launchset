/**
 * GitHub Release bodies (spec 9.3, 9.6, 9.8): the changelog section, the "Manual targets"
 * list kept between hidden markers (updated in place, idempotent), and the body of a
 * superseded partial release. Pure.
 */

import { code, joinWords } from "./plan-common.ts";

/** The state of one manual target for one released version (spec 9.8). */
export type ManualTargetEntry =
  | { target: string; shipped: false }
  | {
      target: string;
      shipped: true;
      /** `null` with the `eas` strategy, or when unknown. */
      buildNumber: number | null;
      /** UTC day it shipped, `2026-11-18`; `null` when unknown (a marker without an entry). */
      date: string | null;
    };

const START = "<!-- launchset:manual-targets";
const END = "<!-- /launchset:manual-targets -->";
const BLOCK =
  /<!-- launchset:manual-targets(?<data>[\s\S]*?)-->[\s\S]*?<!-- \/launchset:manual-targets -->/;

export const MANUAL_TARGETS_HEADING = "### Manual targets";

function renderEntry(entry: ManualTargetEntry, version?: string): string {
  if (!entry.shipped) {
    const how = version
      ? ` (ship it with a release workflow run with target ${code(entry.target)} and version ${code(version)})`
      : "";
    return `- ${code(entry.target)}: not shipped yet${how}`;
  }
  const date = entry.date !== null ? ` ${entry.date}` : "";
  const build = entry.buildNumber !== null ? `, build ${entry.buildNumber}` : "";
  return `- ${code(entry.target)}: shipped${date}${build}`;
}

type StoredEntry =
  | { shipped: false }
  | { shipped: true; buildNumber: number | null; date: string | null };

/**
 * The "Manual targets" block: a heading and one line per target, between hidden markers. The
 * start marker carries the entries as JSON so the list can be updated without parsing prose.
 * Empty string when there are no entries.
 */
export function renderManualTargets(
  entries: readonly ManualTargetEntry[],
  version?: string,
): string {
  if (entries.length === 0) return "";
  const data: Record<string, StoredEntry> = {};
  for (const entry of entries) {
    data[entry.target] = entry.shipped
      ? { shipped: true, buildNumber: entry.buildNumber, date: entry.date }
      : { shipped: false };
  }
  return [
    `${START} ${JSON.stringify(data)} -->`,
    MANUAL_TARGETS_HEADING,
    "",
    ...entries.map((e) => renderEntry(e, version)),
    END,
  ].join("\n");
}

/** The entries of the "Manual targets" block in a body, or `null` when there is none. */
export function parseManualTargets(body: string): ManualTargetEntry[] | null {
  const match = BLOCK.exec(body.replace(/\r\n/g, "\n"));
  if (!match) return null;
  try {
    const data = JSON.parse(match.groups?.data?.trim() || "{}") as Record<string, unknown>;
    const entries: ManualTargetEntry[] = [];
    for (const [target, raw] of Object.entries(data)) {
      const value = raw as Partial<{ shipped: boolean; buildNumber: unknown; date: unknown }>;
      if (value?.shipped === true) {
        entries.push({
          target,
          shipped: true,
          buildNumber: typeof value.buildNumber === "number" ? value.buildNumber : null,
          date: typeof value.date === "string" ? value.date : null,
        });
      } else {
        entries.push({ target, shipped: false });
      }
    }
    return entries;
  } catch {
    // A hand-edited marker: start over with the configured targets.
    return [];
  }
}

const rank = (entry: ManualTargetEntry): number =>
  entry.shipped ? (entry.date !== null ? 2 : 1) : 0;

/**
 * Merge entry lists, highest priority first: per target the most informative entry wins
 * (shipped with a date > shipped without a date > not shipped); on a tie the earlier list
 * wins, so a re-run keeps the original ship date. Order: `order` (the configured manual
 * targets) first, then any other target found in the lists.
 */
export function mergeManualTargets(
  lists: readonly (readonly ManualTargetEntry[])[],
  order: readonly string[],
): ManualTargetEntry[] {
  const byTarget = new Map<string, ManualTargetEntry>();
  for (const list of lists) {
    for (const entry of list) {
      const current = byTarget.get(entry.target);
      if (!current || rank(entry) > rank(current)) byTarget.set(entry.target, entry);
    }
  }
  const names = [...order, ...[...byTarget.keys()].filter((n) => !order.includes(n))];
  return names.flatMap((n) => {
    const entry = byTarget.get(n);
    return entry ? [entry] : [];
  });
}

/**
 * Put the "Manual targets" block into `body`: replaces an existing block in place, else
 * appends it after a blank line. With no entries an existing block is removed.
 */
export function upsertManualTargets(
  body: string,
  entries: readonly ManualTargetEntry[],
  version?: string,
): string {
  const normalized = body.replace(/\r\n/g, "\n");
  const block = renderManualTargets(entries, version);
  if (BLOCK.test(normalized)) {
    return normalized.replace(BLOCK, () => block).replace(/\s+$/, "");
  }
  if (block === "") return normalized;
  const trimmed = normalized.replace(/\s+$/, "");
  return trimmed === "" ? block : `${trimmed}\n\n${block}`;
}

export interface ReleaseBodyInput {
  version: string;
  /** The version's changelog section body (`extractSection`), or `null` when missing. */
  section: string | null;
  /** Changelog file name for the "no section" note. */
  changelogFile: string;
  manualTargets: readonly ManualTargetEntry[];
}

/** Body of a release's GitHub Release (spec 9.3): the changelog section, then the manual targets. */
export function renderReleaseBody(input: ReleaseBodyInput): string {
  const section =
    input.section && input.section.trim() !== ""
      ? input.section.trim()
      : `_No section for ${input.version} in ${input.changelogFile}._`;
  return upsertManualTargets(section, input.manualTargets, input.version);
}

export interface PartialReleaseBodyInput {
  /** The superseded version and its tag text, e.g. `v1.4.0`. */
  version: string;
  tag: string;
  /** The version that superseded it, as a tag, e.g. `v1.4.1`. */
  supersededBy: string;
  shipped: readonly string[];
  missing: readonly string[];
  section: string | null;
  changelogFile: string;
}

/** Title of a superseded partial release (spec 9.6): `v1.4.0 (partial, superseded by v1.4.1)`. */
export function partialReleaseTitle(tag: string, supersededBy: string): string {
  return `${tag} (partial, superseded by ${supersededBy})`;
}

/** Body of a superseded partial release (spec 9.6). */
export function renderPartialReleaseBody(input: PartialReleaseBodyInput): string {
  const list = (names: readonly string[]) =>
    names.length > 0 ? joinWords(names.map(code)) : "none";
  const section =
    input.section && input.section.trim() !== ""
      ? input.section.trim()
      : `_No section for ${input.version} in ${input.changelogFile}._`;
  return [
    `> [!WARNING]`,
    `> ${input.tag} was never fully released: ${input.supersededBy} superseded it before every auto target shipped. It never gets a release tag.`,
    "",
    `- Shipped: ${list(input.shipped)}`,
    `- Not shipped: ${list(input.missing)}`,
    "",
    section,
  ].join("\n");
}
