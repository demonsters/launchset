/**
 * `launchset hotfix <major.minor>` (spec 9.5): create the maintenance branch (default
 * `release/<major>.<minor>.x`) at the latest release tag of that line and push it.
 */

import { LaunchsetError } from "../core/errors.ts";
import { renderSummary } from "../core/plan-common.ts";
import { latestReleaseInLine, releaseTag } from "../core/tags.ts";
import { maintenanceBranchName, type VersionLine } from "../core/versions.ts";
import type { FlowContext, FlowResult } from "./context.ts";
import { hasRemote, readTagSnapshot, syncTags } from "./gather.ts";

export interface HotfixOptions {
  /** `1.4` (a leading `v` is fine). */
  line: string;
  /** `git fetch --tags` first (when a remote exists). Default true. */
  fetch?: boolean;
}

export interface HotfixData {
  branch: string;
  tag: string;
  version: string;
  sha: string;
  pushed: boolean;
}

/** Parse `1.4` / `v1.4` into a version line. */
export function parseVersionLine(input: string): VersionLine {
  const match = /^[vV]?(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(input.trim());
  if (!match) {
    throw new LaunchsetError("invalid-line", `"${input}" is not a version line like 1.4`, {
      hint: "Pass <major>.<minor>, e.g. launchset hotfix 1.4.",
    });
  }
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/** `launchset hotfix` (spec 9.5). */
export async function hotfix(
  context: FlowContext,
  options: HotfixOptions,
): Promise<FlowResult<HotfixData>> {
  const { config, git } = context;
  const line = parseVersionLine(options.line);
  const lineText = `${line.major}.${line.minor}`;
  await syncTags(context, options.fetch ?? true);
  const tags = await readTagSnapshot(context);
  const version = latestReleaseInLine(tags.index, line);
  if (version === null) {
    throw new LaunchsetError(
      "no-release-in-line",
      `there is no release in the ${lineText} line (no ${releaseTag(config.tags, `${lineText}.0`)} or later ${lineText}.x tag)`,
      {
        hint: "A maintenance branch starts from a released version. Check the line, and fetch the tags.",
      },
    );
  }
  const tag = releaseTag(config.tags, version);
  const sha = tags.shas.get(tag);
  if (!sha) throw new Error(`internal: no commit for tag ${tag}`);
  const branch = maintenanceBranchName(line, config.maintenanceBranches);
  if ((await git.tryRevParse(`refs/heads/${branch}`)) !== undefined) {
    throw new LaunchsetError("branch-exists", `the branch ${branch} already exists locally`, {
      hint: `Use it: git checkout ${branch}.`,
    });
  }
  const remote = await hasRemote(git);
  if (remote && (await git.remoteBranchExists(branch))) {
    throw new LaunchsetError("branch-exists", `the branch ${branch} already exists on the remote`, {
      hint: `Use it: git fetch ${git.remote} ${branch} && git checkout ${branch}.`,
    });
  }
  // Push first, then create the local branch: a failed push leaves nothing behind, so a re-run
  // works.
  if (remote) {
    await git.run(["push", "--porcelain", git.remote, `${sha}:refs/heads/${branch}`], {
      auth: true,
    });
  }
  await git.run(["branch", "--no-track", branch, sha]);
  return {
    ok: true,
    outputs: {},
    summary: renderSummary({
      title: "launchset: hotfix",
      paragraphs: [
        `Created \`${branch}\` at \`${tag}\` (\`${sha.slice(0, 7)}\`)${remote ? " and pushed it" : ""}.`,
      ],
    }),
    lines: [
      `Created ${branch} at ${tag} (${sha.slice(0, 7)})${remote ? " and pushed it" : " (no remote: not pushed)"}.`,
      `Next: git checkout ${branch}, then open PRs against it with patch changesets.`,
    ],
    data: { branch, tag, version, sha, pushed: remote },
  };
}
