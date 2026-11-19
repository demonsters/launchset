/**
 * Release PR content (spec 9.3, 9.4, 9.8, 12): branch, title, body, commit message, the
 * changelog section and the changeset files the commit deletes. Pure: the I/O layer rebuilds
 * the branch from the base branch, bumps and stamps the version files, inserts `section` into
 * the changelog (`insertSection`), deletes `deletePaths`, commits and force-pushes.
 */

import { type ChangelogEntry, renderSection } from "./changelog.ts";
import { CHANGESET_DIR } from "./changesets.ts";
import type { ResolvedConfig } from "./config/schema.ts";
import { LaunchsetError } from "./errors.ts";
import { type ForgeHost, forgeWords } from "./forge-links.ts";
import {
  type BotPrInfo,
  code,
  describeManualTarget,
  isoDay,
  joinWords,
  type ManualTargetStatus,
  manualTargetStatuses,
  type TagSnapshot,
} from "./plan-common.ts";
import { autoTargets, releaseTag, type TagTemplates } from "./tags.ts";
import type { Changeset, Plan } from "./types.ts";

/** Prefix of every release PR branch (spec 9.2, 9.3). */
export const RELEASE_PR_BRANCH_PREFIX = "launchset/release/";

/** Hidden marker in the release PR body. */
export const RELEASE_PR_MARKER = "<!-- launchset:release-pr -->";

/** `launchset/release/<base>`; slashes are kept (`launchset/release/release/1.4.x`). */
export function releasePrBranch(base: string): string {
  return `${RELEASE_PR_BRANCH_PREFIX}${base}`;
}

/** True for a release PR head branch (`launchset/release/*`, any depth). */
export function isReleasePrBranch(head: string): boolean {
  return head.startsWith(RELEASE_PR_BRANCH_PREFIX) && head.length > RELEASE_PR_BRANCH_PREFIX.length;
}

/** `Release v1.5.0`: the release tag the PR will create (`tags.release`). */
export function releasePrTitle(tags: TagTemplates, version: string): string {
  return `Release ${releaseTag(tags, version)}`;
}

/** Where a changeset came from, for its changelog line (`changelog.links`, spec 12). */
export interface ChangesetOrigin {
  pr: number;
  /** PR author login. */
  author?: string;
}

/**
 * The in-memory changeset for a bot PR without one (spec 9.4): `patch`, `source: bot`,
 * `pr: <n>`, the PR title as summary. Never written as a file: the release commit would
 * consume it right away.
 */
export function botChangeset(pr: BotPrInfo, host?: ForgeHost): Changeset {
  const name = `bot-pr-${pr.number}.md`;
  return {
    name,
    path: `${CHANGESET_DIR}/${name}`,
    bump: "patch",
    summary: pr.title.trim() || `Dependency update (${forgeWords(host).prText(pr.number)})`,
    source: "bot",
    pr: pr.number,
    extra: {},
  };
}

export interface ReleasePrInput {
  config: ResolvedConfig;
  /** A `release-pr` plan from `planRelease`. */
  plan: Plan;
  /** The pending changesets the plan was made from (including `none` ones), in changelog order. */
  changesets: readonly Changeset[];
  /** Bot PRs without a changeset (the plan's `releasePr.botPrs`). */
  botPrs: readonly BotPrInfo[];
  /** PR and author per changeset path (`forge/changelog-info`); used with `changelog.links`. */
  origins?: ReadonlyMap<string, ChangesetOrigin>;
  tags: TagSnapshot;
  /** Release date for the changelog heading. */
  now: Date | number;
  /** Default the host's public server (`https://github.com`). */
  serverUrl?: string;
  /** Code host for PR links and their text; default `github`. */
  host?: ForgeHost;
}

export interface ReleasePrContent {
  /** Branch the PR targets (the plan's branch). */
  base: string;
  /** Head branch, `launchset/release/<base>`. */
  branch: string;
  title: string;
  body: string;
  commitMessage: string;
  version: string;
  /** The changelog section to insert (heading included, LF, trailing newline). */
  section: string;
  /** `changelog.file`. */
  changelogFile: string;
  /** Every pending changeset file, `none` ones included: the commit deletes them. */
  deletePaths: string[];
  /** Generated bot changesets (memory only, spec 9.4). */
  generatedChangesets: Changeset[];
  autoTargets: string[];
  manualTargets: ManualTargetStatus[];
}

/** Build the release PR (spec 9.3). Throws when `plan` isn't a `release-pr` plan. */
export function buildReleasePr(input: ReleasePrInput): ReleasePrContent {
  const { config, plan } = input;
  if (plan.mode !== "release-pr" || !plan.releasePr) {
    throw new LaunchsetError(
      "invalid-plan",
      `buildReleasePr needs a release-pr plan, got mode "${plan.mode}"`,
    );
  }
  const version = plan.releasePr.version;
  const useLinks = config.changelog.links;

  const seenPrs = new Set(input.changesets.flatMap((c) => (c.pr !== undefined ? [c.pr] : [])));
  const generated: Changeset[] = [];
  for (const pr of input.botPrs) {
    if (seenPrs.has(pr.number)) continue;
    seenPrs.add(pr.number);
    generated.push(botChangeset(pr, input.host));
  }

  const entries: ChangelogEntry[] = [];
  for (const changeset of input.changesets) {
    const entry: ChangelogEntry = { changeset };
    const origin = useLinks ? input.origins?.get(changeset.path) : undefined;
    if (origin) {
      entry.pr = origin.pr;
      if (origin.author) entry.author = origin.author;
    }
    entries.push(entry);
  }
  for (const changeset of generated) entries.push({ changeset });

  const section = renderSection({
    version,
    date: isoDay(input.now),
    entries,
    ...(useLinks && plan.repository ? { repository: plan.repository } : {}),
    ...(input.serverUrl ? { serverUrl: input.serverUrl } : {}),
    ...(input.host ? { host: input.host } : {}),
  });

  const auto = autoTargets(config);
  const manual = manualTargetStatuses(config, input.tags.index);
  const title = releasePrTitle(config.tags, version);
  const body = renderReleasePrBody({
    version,
    bump: plan.releasePr.bump,
    base: plan.branch,
    section,
    autoTargets: auto,
    manualTargets: manual,
    ...(input.host ? { host: input.host } : {}),
  });

  return {
    base: plan.branch,
    branch: releasePrBranch(plan.branch),
    title,
    body,
    commitMessage: title,
    version,
    section,
    changelogFile: config.changelog.file,
    deletePaths: input.changesets.map((c) => c.path),
    generatedChangesets: generated,
    autoTargets: auto,
    manualTargets: manual,
  };
}

function renderReleasePrBody(input: {
  version: string;
  bump: string;
  base: string;
  section: string;
  autoTargets: string[];
  manualTargets: ManualTargetStatus[];
  host?: ForgeHost;
}): string {
  const PR = forgeWords(input.host).prName;
  const gitlab = input.host === "gitlab";
  const blocks = [
    RELEASE_PR_MARKER,
    `Merging this ${PR} releases **v${input.version}** (${input.bump}) from ${code(input.base)}: it builds and ships every auto target (${joinWords(input.autoTargets.map(code))}).`,
    input.section.trimEnd(),
  ];
  if (input.manualTargets.length > 0) {
    blocks.push(
      [
        "### Manual targets",
        "",
        gitlab
          ? `Stamped with ${input.version} by this MR, but shipped on demand (a release pipeline run with the \`LAUNCHSET_TARGET\` variable, or \`launchset ship\`):`
          : `Stamped with ${input.version} by this PR, but shipped on demand (a release workflow run with the \`target\` input, or \`launchset ship\`):`,
        "",
        ...input.manualTargets.map((s) => `- ${describeManualTarget(s)}`),
      ].join("\n"),
    );
  }
  blocks.push(
    `<sub>launchset rebuilds this ${PR} from ${code(input.base)} on every push. Don't edit it: change the changesets in \`.launchset/\` instead.</sub>`,
  );
  return `${blocks.join("\n\n")}\n`;
}

/** Comment posted when an open release PR is closed because nothing is pending anymore. */
export function releasePrCloseComment(base: string, host?: ForgeHost): string {
  return `Closing: no changesets are pending on ${code(base)} anymore, so there is nothing to release. launchset opens a new release ${forgeWords(host).prName} when one is added.`;
}
