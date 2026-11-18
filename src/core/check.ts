/**
 * The PR check (spec 9.2, 6.7, 8.2) and `check --push` (spec 11). Pure: the I/O layer lists
 * the PR's changed files, parses every changeset at the PR head, runs the consistency check
 * and posts `comment` as the sticky comment.
 */

import { isMaintenanceBranch } from "./branches.ts";
import { isChangesetPath } from "./changesets.ts";
import type { ResolvedConfig } from "./config/schema.ts";
import { LaunchsetError } from "./errors.ts";
import {
  type ChangesetFile,
  type CommitInfo,
  code,
  describeMismatch,
  firstLine,
  highestVersion,
  plural,
  renderSummary,
  type TagSnapshot,
  type VersionMismatch,
  validChangesets,
} from "./plan-common.ts";
import { commitsWithoutChangesetWarning } from "./release.ts";
import { isReleasePrBranch } from "./release-pr.ts";
import { releaseTag, takenVersions } from "./tags.ts";
import type { Bump, Changeset } from "./types.ts";
import {
  maintenanceViolations,
  parseMaintenanceBranch,
  releaseBump,
  releaseVersion,
} from "./versions.ts";

/** Docs page linked from the sticky comment when a PR has no changeset. */
export const DEFAULT_DOCS_URL =
  "https://github.com/demonsters/launchset/blob/main/docs/changesets.md";

/** Sticky comment id (`<!-- launchset:check -->`, see `github.upsertStickyComment`). */
export const CHECK_COMMENT_ID = "check";

export interface ChangedFileInput {
  status: "A" | "M" | "D" | "R";
  /** Repo-relative POSIX (new) path. */
  path: string;
  /** Repo-relative old path, for renames. */
  oldPath?: string;
  /**
   * For renames (`R`): content similarity in percent, 100 = identical (git's `R100`; from the
   * GitHub API, 100 when `changes` is 0). A rename of a changeset counts as changing it only
   * when this is given and below 100; a file moved into the changeset folder from elsewhere
   * always counts.
   */
  similarity?: number;
}

export interface CheckInput {
  config: ResolvedConfig;
  pr: {
    number: number;
    author: string;
    headBranch: string;
    baseBranch: string;
    /**
     * False when the head repo is the base repo (`pull_request.head.repo.full_name ===
     * base.repo.full_name`). The release PR exemption needs `fork: false`: a fork can name
     * its branch `launchset/release/...` too.
     */
    fork?: boolean;
  };
  /**
   * Files the PR changes (at least those under the changeset folder), repo-relative like
   * `changesetDir` and every `ChangesetFile.path`.
   */
  changedFiles: readonly ChangedFileInput[];
  /**
   * Every changeset file at the PR head, parsed or not. `path` (and `changeset.path`) must
   * be repo-relative and inside `changesetDir`; anything else is an internal error.
   */
  changesets: readonly ChangesetFile[];
  /** Consistency check at the PR head (spec 6.7). */
  mismatches: readonly VersionMismatch[];
  /** Root version at the PR head. */
  version: string;
  tags: TagSnapshot;
  docsUrl?: string;
  /**
   * The changeset folder, repo-relative: `apps/web/.launchset` when launchset runs in a
   * subdirectory (`working-directory`). Default `.launchset`.
   */
  changesetDir?: string;
}

export type CheckFailureCode =
  | "no-changeset"
  | "invalid-changeset"
  | "maintenance-bump"
  | "version-mismatch";

export interface CheckFailure {
  code: CheckFailureCode;
  message: string;
}

export interface CheckResult {
  ok: boolean;
  /** Why the check passes: a changeset, a bot author, or the release PR. */
  reason: "changeset" | "bot" | "release-pr" | null;
  failures: CheckFailure[];
  /** Changesets the PR adds or changes (valid ones). */
  prChangesets: Changeset[];
  /** Bump and resulting version of everything pending at the PR head; `null` when nothing releases. */
  bump: Exclude<Bump, "none"> | null;
  nextVersion: string | null;
  /** Non-fatal notes (unknown frontmatter keys, …). */
  warnings: string[];
  /** Markdown for the sticky comment (without the hidden marker). */
  comment: string;
  /** Markdown for `$GITHUB_STEP_SUMMARY`. */
  summary: string;
}

const EXAMPLE = [
  "```md",
  "---",
  "bump: patch",
  "---",
  "",
  "Fix the crash on the login screen.",
  "```",
].join("\n");

function howToAdd(docsUrl: string, dir: string): string {
  return [
    "Add one with:",
    "",
    "```sh",
    "npx @demonsters/launchset add",
    "```",
    "",
    `or write a file like \`${dir}/brave-lions-sing.md\` by hand:`,
    "",
    EXAMPLE,
    "",
    "Use `bump: none` (and no summary) for a change that needs no release, like docs or CI. Bumps: `major` (breaking), `minor` (features), `patch` (fixes).",
    "",
    `More in the [launchset docs](${docsUrl}).`,
  ].join("\n");
}

/** Evaluate the PR check (spec 9.2). */
export function evaluateCheck(input: CheckInput): CheckResult {
  const { config, pr } = input;
  const dir = input.changesetDir ?? ".launchset";
  const docsUrl = input.docsUrl ?? DEFAULT_DOCS_URL;
  const failures: CheckFailure[] = [];
  const warnings = input.changesets.flatMap((f) => (f.ok ? f.warnings : []));

  // Invalid changesets anywhere in .launchset/.
  for (const file of input.changesets) {
    if (!file.ok) failures.push({ code: "invalid-changeset", message: file.error });
  }

  const valid = validChangesets(input.changesets);
  assertRepoRelative(input.changesets, dir);
  const byPath = new Map(valid.map((c) => [normalizePath(c.path), c]));
  const touched = new Set(
    input.changedFiles.filter((f) => countsAsChange(f, dir)).map((f) => normalizePath(f.path)),
  );
  const prChangesets = [...touched].flatMap((p) => {
    const c = byPath.get(p);
    return c ? [c] : [];
  });

  const maintenance = isMaintenanceBranch(config, pr.baseBranch);
  if (maintenance) {
    for (const v of maintenanceViolations(valid, pr.baseBranch, config.baseBranch)) {
      failures.push({ code: "maintenance-bump", message: v.message });
    }
  }

  for (const m of input.mismatches) {
    failures.push({
      code: "version-mismatch",
      message: `version mismatch: ${describeMismatch(m)}. Version numbers are written by launchset only; undo the manual edit.`,
    });
  }

  const releasePrBranch = isReleasePrBranch(pr.headBranch);
  // Only the release PR from this repository is exempt, never a fork's look-alike branch.
  const releasePr = releasePrBranch && pr.fork === false;
  const bots = config.check.bots.map((b) => b.toLowerCase());
  const bot = bots.includes(pr.author.toLowerCase());
  let reason: CheckResult["reason"] = null;
  if (prChangesets.length > 0) reason = "changeset";
  else if (releasePr) reason = "release-pr";
  else if (bot) reason = "bot";
  if (reason === null) {
    failures.push({
      code: "no-changeset",
      message: `this PR adds no changeset: every PR needs one in ${dir}/ (bump: none when it needs no release).${releasePrBranch ? ` The ${code(pr.headBranch)} branch counts as the release PR only when it comes from this repository, not a fork.` : ""}`,
    });
  }

  const bump = releaseBump(valid);
  let nextVersion: string | null = null;
  if (bump !== null && !failures.some((f) => f.code === "maintenance-bump")) {
    const line = parseMaintenanceBranch(pr.baseBranch, config.maintenanceBranches);
    try {
      nextVersion = releaseVersion({
        current: input.version,
        bump,
        taken: takenVersions(input.tags.index),
        ...(line
          ? { maintenance: { line, branch: pr.baseBranch, baseBranch: config.baseBranch } }
          : {}),
      });
    } catch (error) {
      warnings.push(`can't compute the next version: ${(error as Error).message}`);
    }
  }

  const result: CheckResult = {
    ok: failures.length === 0,
    reason,
    failures,
    prChangesets,
    bump,
    nextVersion,
    warnings,
    comment: "",
    summary: "",
  };
  result.comment = renderCheckComment(result, input, howToAdd(docsUrl, dir));
  result.summary = renderSummary({
    title: `launchset check: ${result.ok ? "passed" : "failed"}`,
    paragraphs: [passLine(result, input)],
    failures: failures.map((f) => f.message),
    warnings,
  });
  return result;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Added, modified, or renamed with changed content (or moved in from outside the folder). */
function countsAsChange(file: ChangedFileInput, dir: string): boolean {
  if (file.status === "D" || !isChangesetPath(normalizePath(file.path), dir)) return false;
  if (file.status !== "R") return true;
  if (file.oldPath === undefined || !isChangesetPath(normalizePath(file.oldPath), dir)) {
    return true;
  }
  return file.similarity !== undefined && file.similarity < 100;
}

/** Changeset paths and changed-file paths must share one base: the repo root. */
function assertRepoRelative(files: readonly ChangesetFile[], dir: string): void {
  for (const file of files) {
    const paths = file.ok ? [file.path, file.changeset.path] : [file.path];
    for (const path of paths) {
      if (!isChangesetPath(normalizePath(path), dir)) {
        throw new LaunchsetError(
          "internal-error",
          `internal error: changeset path "${path}" is not a changeset in the folder "${dir}". The check needs repo-relative paths for changesets, changed files and changesetDir alike.`,
        );
      }
    }
    if (file.ok && normalizePath(file.path) !== normalizePath(file.changeset.path)) {
      throw new LaunchsetError(
        "internal-error",
        `internal error: changeset file "${file.path}" was parsed as "${file.changeset.path}"; parse it with its repo-relative path`,
      );
    }
  }
}

function passLine(result: CheckResult, input: CheckInput): string {
  switch (result.reason) {
    case "changeset":
      return `This PR has ${plural(result.prChangesets.length, "changeset")}.`;
    case "release-pr":
      return "This is the launchset release PR.";
    case "bot":
      return `${code(input.pr.author)} is a bot (check.bots): no changeset needed; the release lists it under Dependencies.`;
    default:
      return "This PR has no changeset.";
  }
}

function renderCheckComment(result: CheckResult, input: CheckInput, addHelp: string): string {
  const blocks: string[] = [];
  const next =
    result.bump !== null && result.nextVersion !== null
      ? `The next release will be **${result.nextVersion}** (${result.bump}).`
      : result.bump === null
        ? "Nothing pending releases anything yet."
        : "";
  if (result.reason === "release-pr") {
    blocks.push(
      "### launchset: release PR",
      "This is the launchset release PR. Merging it releases every auto target.",
    );
  } else if (result.prChangesets.length > 0) {
    const highest = releaseBump(result.prChangesets);
    blocks.push(
      `### launchset: ${plural(result.prChangesets.length, "changeset")} found`,
      `This PR's bump: **${highest ?? "none"}**. ${next}`.trim(),
      result.prChangesets
        .map((c) =>
          c.bump === "none"
            ? `- \`none\`: no release (${code(c.path)})`
            : `- \`${c.bump}\`: ${firstLine(c.summary)} (${code(c.path)})`,
        )
        .join("\n"),
    );
  } else if (result.reason === "bot") {
    blocks.push(
      "### launchset: bot PR",
      `No changeset needed: PRs from ${code(input.pr.author)} get a generated patch entry under Dependencies in the next release.`,
    );
  } else {
    blocks.push(
      "### launchset: no changeset",
      "This PR has no changeset, so the check fails.",
      addHelp,
    );
  }
  if (result.failures.some((f) => f.code !== "no-changeset")) {
    blocks.push(
      [
        "**Problems:**",
        "",
        ...result.failures.filter((f) => f.code !== "no-changeset").map((f) => `- ${f.message}`),
      ].join("\n"),
    );
  }
  if (result.warnings.length > 0) {
    blocks.push(["**Warnings:**", "", ...result.warnings.map((w) => `- ${w}`)].join("\n"));
  }
  return `${blocks.join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------
// check --push (spec 11)

export interface PushCheckInput {
  config: ResolvedConfig;
  /** Every changeset file at HEAD. */
  changesets: readonly ChangesetFile[];
  /** Commits since the last release (newest first). */
  commitsSinceRelease: readonly CommitInfo[];
  /** Plain versions whose release tag is reachable from HEAD. */
  reachableReleases: readonly string[];
}

export interface PushCheckResult {
  /** Always true: `check --push` never blocks a push. */
  ok: true;
  warnings: string[];
  /** Text for the terminal. */
  message: string;
}

/**
 * `check --push` for a pre-push hook (spec 11): warns when commits since the last release
 * exist and no changeset is pending at all, or when a changeset is invalid. Never fails.
 */
export function evaluatePushCheck(input: PushCheckInput): PushCheckResult {
  const warnings: string[] = [];
  for (const file of input.changesets) {
    if (!file.ok) warnings.push(`invalid changeset: ${file.error}`);
  }
  if (input.changesets.length === 0 && input.commitsSinceRelease.length > 0) {
    const last = highestVersion(input.reachableReleases);
    warnings.push(
      commitsWithoutChangesetWarning(
        input.commitsSinceRelease,
        last === null ? null : releaseTag(input.config.tags, last),
      ),
    );
  }
  const message =
    warnings.length > 0
      ? `launchset: ${warnings.join("\n\n")}\n\n(This is a warning only; the push goes ahead.)`
      : "launchset: ok";
  return { ok: true, warnings, message };
}
