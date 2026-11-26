/**
 * Fails when a GitHub Action used in the workflow templates (`templates/`) or in launchset's own
 * workflows (`.github/workflows/`) is pinned to a major below the action's latest release.
 *
 *   node scripts/check-action-majors.ts [--report <file>]
 *
 * Collects every `uses: owner/repo@vN` (commented-out examples included), asks the GitHub API
 * for each action's latest release (falling back to its highest `vX.Y.Z` tag when it publishes
 * no releases) and prints the actions that are behind. `--report` also writes that list as
 * Markdown, for the issue the scheduled workflow opens. Set GITHUB_TOKEN (or GH_TOKEN) to avoid
 * the anonymous rate limit.
 *
 * Exit status: 0 when every major is current, 1 when one is behind, 2 on an error (network, API).
 *
 * Dependabot keeps `.github/workflows/` current, but it doesn't scan `templates/`: those files
 * are what `launchset init` writes into other repos, so they need this check.
 * See design/DECISIONS.md ("Action majors in the templates").
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the check looks, relative to the repo root. */
export const SCAN_DIRS = ["templates", ".github/workflows"] as const;

/** One `uses:` reference to a published action, pinned to a major tag. */
export interface ActionRef {
  /** `owner/repo`, lowercased (GitHub names are case-insensitive). */
  action: string;
  /** The ref as written, e.g. `v5` or `v1.2.3`. */
  ref: string;
  major: number;
  /** Repo-relative POSIX path. */
  path: string;
  line: number;
}

/** An action whose pinned major is below its latest release. */
export interface StaleAction {
  action: string;
  /** Every major in use that is behind, lowest first. */
  used: number[];
  latest: number;
  latestTag: string;
  /** `path:line` of each reference that is behind. */
  where: string[];
}

// `uses: owner/repo[/path]@ref`, optionally quoted, optionally behind a `#` comment and a `- `.
const USES =
  /^\s*(?:#\s*)?(?:-\s+)?uses:\s*["']?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/[^@\s"']*)?@([^\s"'#]+)/;

/**
 * The major of a version tag: `v5` → 5, `v1.2.3` → 1, `2.0.0` → 2. `undefined` for anything
 * else (a SHA, a branch, a template token).
 */
export function majorOf(tag: string): number | undefined {
  const m = /^v?(\d+)(?:\.\d+){0,2}$/.exec(tag.trim());
  return m?.[1] === undefined ? undefined : Number(m[1]);
}

/**
 * Every `uses:` of a published action pinned to a version tag. Local actions (`./action`),
 * `docker://` images, SHA or branch pins and template tokens (`@@action@@`) are skipped: they
 * have no major to compare.
 */
export function collectActionRefs(files: { path: string; text: string }[]): ActionRef[] {
  const refs: ActionRef[] = [];
  for (const file of files) {
    file.text.split(/\r?\n/).forEach((text, index) => {
      const m = USES.exec(text);
      if (!m) return;
      const [, owner, repo, ref] = m as unknown as [string, string, string, string];
      const major = majorOf(ref);
      if (major === undefined) return;
      refs.push({
        action: `${owner}/${repo}`.toLowerCase(),
        ref,
        major,
        path: file.path,
        line: index + 1,
      });
    });
  }
  return refs;
}

/**
 * The actions whose used major is below the latest release's major. `latest` maps an action
 * (lowercased `owner/repo`) to its latest release tag; an action missing from it, or with a tag
 * that isn't a version, is not reported.
 */
export function findStale(refs: ActionRef[], latest: ReadonlyMap<string, string>): StaleAction[] {
  const byAction = new Map<string, ActionRef[]>();
  for (const ref of refs) byAction.set(ref.action, [...(byAction.get(ref.action) ?? []), ref]);
  const stale: StaleAction[] = [];
  for (const [action, uses] of [...byAction].sort(([a], [b]) => a.localeCompare(b))) {
    const latestTag = latest.get(action);
    const latestMajor = latestTag === undefined ? undefined : majorOf(latestTag);
    if (latestTag === undefined || latestMajor === undefined) continue;
    const behind = uses.filter((u) => u.major < latestMajor);
    if (behind.length === 0) continue;
    stale.push({
      action,
      used: [...new Set(behind.map((u) => u.major))].sort((a, b) => a - b),
      latest: latestMajor,
      latestTag,
      where: behind.map((u) => `${u.path}:${u.line}`),
    });
  }
  return stale;
}

/** The report as Markdown: one bullet per action, with the places to change. */
export function formatReport(stale: StaleAction[]): string {
  if (stale.length === 0)
    return "Every action in the templates and workflows is on its latest major.\n";
  const lines = [
    "These actions are pinned to a major below their latest release. Read each release's notes for breaking changes (renamed or removed inputs), then bump the templates and `.github/workflows/` together.",
    "",
  ];
  for (const s of stale) {
    const used = s.used.map((m) => `v${m}`).join(", ");
    lines.push(
      `- **${s.action}**: ${used} → v${s.latest} (latest release ${s.latestTag}, https://github.com/${s.action}/releases)`,
    );
    for (const w of s.where) lines.push(`  - \`${w}\``);
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Network and file system (not unit-tested)

/** The latest release tag of `action`, or its highest version tag when it has no releases. */
async function latestTag(action: string, token: string | undefined): Promise<string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "launchset-check-action-majors",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const api = `https://api.github.com/repos/${action}`;
  const release = await fetch(`${api}/releases/latest`, { headers });
  if (release.ok) return ((await release.json()) as { tag_name: string }).tag_name;
  if (release.status !== 404) {
    throw new Error(
      `${action}: GET releases/latest answered ${release.status} ${release.statusText}`,
    );
  }
  // No releases (some actions only push tags): the highest vX.Y.Z tag.
  const tags = await fetch(`${api}/tags?per_page=100`, { headers });
  if (!tags.ok) throw new Error(`${action}: GET tags answered ${tags.status} ${tags.statusText}`);
  const names = ((await tags.json()) as { name: string }[]).map((t) => t.name);
  const best = names
    .filter((n) => majorOf(n) !== undefined)
    .sort((a, b) => (majorOf(b) ?? 0) - (majorOf(a) ?? 0))[0];
  if (!best) throw new Error(`${action}: no releases and no version tags`);
  return best;
}

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.(ya?ml|md)$/.test(name)) yield path;
  }
}

/** The files under {@link SCAN_DIRS}, with repo-relative POSIX paths. */
export function readScannedFiles(root: string): { path: string; text: string }[] {
  return SCAN_DIRS.flatMap((dir) =>
    [...walk(join(root, dir))].map((path) => ({
      path: relative(root, path).split("\\").join("/"),
      text: readFileSync(path, "utf8"),
    })),
  );
}

async function main(): Promise<number> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  const reportAt = args.indexOf("--report");
  const reportFile = reportAt === -1 ? undefined : args[reportAt + 1];
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined;

  const refs = collectActionRefs(readScannedFiles(root));
  const actions = [...new Set(refs.map((r) => r.action))].sort();
  const latest = new Map<string, string>();
  for (const action of actions) latest.set(action, await latestTag(action, token));
  for (const action of actions) console.log(`${action}: latest ${latest.get(action)}`);

  const stale = findStale(refs, latest);
  const report = formatReport(stale);
  console.log(`\n${report}`);
  if (reportFile) writeFileSync(reportFile, report);
  return stale.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(2);
    },
  );
}
