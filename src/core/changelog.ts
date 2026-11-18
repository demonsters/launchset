/**
 * Changelog (spec 12): render a release section, insert it into an existing changelog
 * without touching anything else, place backported sections by version, and extract a
 * section for GitHub Release bodies. Pure.
 */

import semver from "semver";
import { LaunchsetError } from "./errors.ts";
import type { Changeset } from "./types.ts";

export const CHANGELOG_TITLE = "# Changelog";

export interface ChangelogEntry {
  changeset: Pick<Changeset, "bump" | "summary" | "source" | "pr">;
  /** PR that added the changeset (overrides `changeset.pr`), when known. */
  pr?: number;
  /** GitHub login of the PR author, with or without `@`, when known. */
  author?: string;
}

export interface SectionInput {
  version: string;
  /** Release date; a `Date` is written as its UTC day. */
  date: Date | string;
  /** Entries in the order they should appear within each group. */
  entries: ChangelogEntry[];
  /** `owner/repo`; without it PR numbers are written without links. */
  repository?: string;
  /** Default `https://github.com`. */
  serverUrl?: string;
}

const GROUPS = [
  { key: "major", heading: "### Major changes" },
  { key: "minor", heading: "### Minor changes" },
  { key: "patch", heading: "### Patch changes" },
  { key: "dependencies", heading: "### Dependencies" },
] as const;

function formatDate(date: Date | string): string {
  if (typeof date !== "string") return date.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new LaunchsetError("invalid-date", `expected a date like 2026-11-18, got "${date}"`);
  }
  return date;
}

function entrySuffix(entry: ChangelogEntry, input: SectionInput): string {
  const pr = entry.pr ?? entry.changeset.pr;
  const parts: string[] = [];
  if (pr !== undefined) {
    const server = (input.serverUrl ?? "https://github.com").replace(/\/+$/, "");
    parts.push(input.repository ? `[#${pr}](${server}/${input.repository}/pull/${pr})` : `#${pr}`);
  }
  // Bot entries (Dependencies) show only the PR, like the spec's example.
  if (entry.author && entry.changeset.source !== "bot") {
    parts.push(`@${entry.author.replace(/^@/, "")}`);
  }
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/** One bullet: the first summary line, the rest indented under it. */
function renderEntry(entry: ChangelogEntry, input: SectionInput): string {
  const lines = entry.changeset.summary.replace(/\r\n/g, "\n").trim().split("\n");
  const [first = "", ...rest] = lines;
  const bullet = `- ${first.trimEnd()}${entrySuffix(entry, input)}`;
  return [bullet, ...rest.map((line) => (line.trim() === "" ? "" : `  ${line.trimEnd()}`))].join(
    "\n",
  );
}

/**
 * Render a release section (spec 12) with LF line endings and a trailing newline:
 * `## 1.5.0 (2026-11-18)`, then the Major / Minor / Patch changes and Dependencies (bot
 * changesets) groups. Empty groups are left out; `none` changesets are excluded.
 */
export function renderSection(input: SectionInput): string {
  const groups = new Map<string, string[]>();
  for (const entry of input.entries) {
    const { bump, source } = entry.changeset;
    if (bump === "none") continue;
    const key = source === "bot" ? "dependencies" : bump;
    const list = groups.get(key) ?? [];
    list.push(renderEntry(entry, input));
    groups.set(key, list);
  }
  const blocks = [`## ${input.version} (${formatDate(input.date)})`];
  for (const group of GROUPS) {
    const list = groups.get(group.key);
    if (list) blocks.push(`${group.heading}\n${list.join("\n")}`);
  }
  return `${blocks.join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------
// Headings

export interface Heading {
  /** 1-6. */
  level: number;
  /** Heading text without `#` markers. */
  text: string;
  /** Version at the start of the text (spec 12), or `null` for other headings. */
  version: string | null;
  /** Offset where the heading's first line starts. */
  start: number;
  /** Offset just after the heading's last line (after its line break). */
  end: number;
}

interface Line {
  start: number;
  /** After the line break (or the end of the text). */
  end: number;
  /** Without the line break. */
  text: string;
}

const BOM = "\uFEFF";
const bomLength = (text: string) => (text.startsWith(BOM) ? 1 : 0);

/** Lines of `text`; a leading BOM is not part of the first line. */
function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let pos = bomLength(text);
  for (;;) {
    const newline = text.indexOf("\n", pos);
    const stop = newline === -1 ? text.length : newline;
    lines.push({
      start: pos,
      end: newline === -1 ? text.length : newline + 1,
      text: text.slice(pos, stop).replace(/\r$/, ""),
    });
    if (newline === -1) return lines;
    pos = newline + 1;
  }
}

/** Headings count only at column 0: indented lines belong to list items (multi-line summaries). */
const ATX = /^(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const VERSION_START =
  /^\[?\s*[vV]?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=$|[\s\]()])/;

/**
 * The version a heading text starts with (spec 12): a semver version, optionally with a
 * `v` prefix, optionally as a markdown link, optionally followed by a date or other text.
 * `## 1.5.0 (2026-11-18)`, `## 0.18.0`, `#### [v3.5.6](https://…) - 2023-01-02`.
 */
export function headingVersion(text: string): string | null {
  const match = VERSION_START.exec(text.trim());
  const version = match?.[1];
  return version && semver.valid(version) ? version : null;
}

function isParagraphLine(text: string): boolean {
  return (
    text.trim() !== "" && !/^\s/.test(text) && !/^(?:[-*+]\s|\d+[.)]\s|>|#|`{3}|~{3}|<)/.test(text)
  );
}

/** Every markdown heading (ATX and setext), outside fenced code blocks. */
export function findHeadings(text: string): Heading[] {
  const lines = splitLines(text);
  const headings: Heading[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as Line;
    const fenceMatch = FENCE.exec(line.text);
    if (fence !== null) {
      if (
        fenceMatch?.[1] &&
        fenceMatch[1][0] === fence[0] &&
        fenceMatch[1].length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch?.[1]) {
      fence = fenceMatch[1];
      continue;
    }
    const atx = ATX.exec(line.text);
    if (atx) {
      const headingText = (atx[2] ?? "").trim();
      headings.push({
        level: (atx[1] as string).length,
        text: headingText,
        version: headingVersion(headingText),
        start: line.start,
        end: line.end,
      });
      continue;
    }
    const next = lines[i + 1];
    const underline = next ? /^(=+|-+)[ \t]*$/.exec(next.text) : null;
    if (next && underline && isParagraphLine(line.text)) {
      const previous = lines[i - 1];
      // Only a one-line paragraph: a line directly after other text isn't a heading start.
      if (!previous || previous.text.trim() === "" || headings.at(-1)?.end === line.start) {
        const headingText = line.text.trim();
        headings.push({
          level: underline[1]?.startsWith("=") ? 1 : 2,
          text: headingText,
          version: headingVersion(headingText),
          start: line.start,
          end: next.end,
        });
        i++;
      }
    }
  }
  return headings;
}

/** Headings that start with a version (spec 12). */
export function findVersionHeadings(text: string): (Heading & { version: string })[] {
  return findHeadings(text).filter((h): h is Heading & { version: string } => h.version !== null);
}

/** True when the changelog already has a section for `version`. */
export function hasSection(text: string, version: string): boolean {
  return findVersionHeadings(text).some((h) => semver.eq(h.version, version));
}

// ---------------------------------------------------------------------------
// Insertion

function detectEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

const startsWithBlankLine = (text: string) => /^[ \t]*\r?\n/.test(text);
const endsWithBlankLine = (text: string) => /(?:^|\n)[ \t]*\r?\n$/.test(text);

/** Insert `section` at `offset`, separated by blank lines, in the file's line endings. */
function insertAt(text: string, offset: number, section: string): string {
  const eol = detectEol(text);
  const body = `${section.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n").join(eol)}${eol}`;
  // A BOM stays at offset 0 and doesn't count as content before the section.
  const bom = bomLength(text);
  const at = Math.max(offset, bom);
  const before = text.slice(0, at);
  const after = text.slice(at);
  const content = before.slice(bom);
  let lead = "";
  if (content !== "" && !endsWithBlankLine(content)) {
    lead = content.endsWith("\n") ? eol : eol + eol;
  }
  const trail = after !== "" && !startsWithBlankLine(after) ? eol : "";
  return `${before}${lead}${body}${trail}${after}`;
}

/**
 * Insert a new section (spec 12): directly before the first version heading, keeping
 * everything above it (title, badges, preamble). Without a version heading: after the first
 * heading; without any heading: at the top. A missing or empty changelog becomes
 * `# Changelog` plus the section. Keeps the file's line endings; old sections are never
 * changed.
 */
export function insertSection(existing: string | null | undefined, section: string): string {
  if (existing === null || existing === undefined || existing.trim() === "") {
    const bom = existing?.startsWith(BOM) ? BOM : "";
    return `${bom}${CHANGELOG_TITLE}\n\n${section.replace(/\r\n/g, "\n").replace(/\n+$/, "")}\n`;
  }
  const headings = findHeadings(existing);
  const firstVersion = headings.find((h) => h.version !== null);
  if (firstVersion) return insertAt(existing, firstVersion.start, section);
  const first = headings[0];
  if (first) return insertAt(existing, first.end, section);
  return insertAt(existing, 0, section);
}

/**
 * End offset of the section that starts with `heading`: the earlier of the next version
 * heading (at any level) and the next heading of the same or a higher level.
 */
function sectionEnd(text: string, headings: Heading[], heading: Heading): number {
  const index = headings.indexOf(heading);
  const next = headings
    .slice(index + 1)
    .find((h) => h.version !== null || h.level <= heading.level);
  return next ? next.start : text.length;
}

/**
 * Insert a backported section (spec 9.5) at its place by version, newest first: before the
 * first version heading with a lower version. Headings that can't be parsed are skipped;
 * prereleases sort before their release (`1.5.0-alpha.2` < `1.5.0`). When the changelog
 * already has a section for `version`, it is returned unchanged.
 */
export function insertSectionSorted(
  existing: string | null | undefined,
  section: string,
  version: string,
): string {
  if (!semver.valid(version)) {
    throw new LaunchsetError("invalid-version", `"${version}" is not a valid semver version`);
  }
  if (existing === null || existing === undefined || existing.trim() === "") {
    return insertSection(existing, section);
  }
  const headings = findHeadings(existing);
  const versioned = headings.filter((h): h is Heading & { version: string } => h.version !== null);
  if (versioned.some((h) => semver.eq(h.version, version))) return existing;
  const lower = versioned.find((h) => semver.lt(h.version, version));
  if (lower) return insertAt(existing, lower.start, section);
  const last = versioned.at(-1);
  if (!last) return insertSection(existing, section);
  return insertAt(existing, sectionEnd(existing, headings, last), section);
}

/**
 * The body of the section for `version` (without its heading), LF line endings, surrounding
 * blank lines trimmed; for GitHub Release bodies. `null` when there is no such section.
 */
export function extractSection(text: string, version: string): string | null {
  const headings = findHeadings(text);
  const heading = headings.find((h) => h.version !== null && semver.eq(h.version, version));
  if (!heading) return null;
  return text
    .slice(heading.end, sectionEnd(text, headings, heading))
    .replace(/\r\n/g, "\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .trimEnd();
}
