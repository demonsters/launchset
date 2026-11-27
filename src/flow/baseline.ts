/**
 * `baseline` in the release flow (spec 11.1 step 5): on the base branch, create the baseline
 * version's release tag at HEAD (pushed with launchset's credentials, like every tag it creates)
 * and plan as if it had been there all along.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { type BaselineAction, baselineAction, baselineNotice } from "../core/baseline.ts";
import { LaunchsetError } from "../core/errors.ts";
import { code, snapshotTags } from "../core/plan-common.ts";
import type { FlowContext } from "./context.ts";
import { lastReleaseTagOf, type ReleaseState } from "./gather.ts";
import { ensureTag } from "./git-ops.ts";

export interface BaselineResult {
  state: ReleaseState;
  notices: string[];
  warnings: string[];
}

/**
 * Apply `baseline` to a gathered release state. With `dryRun` (`launchset plan`) the tag isn't
 * created, but the plan is the one the release workflow will make. The tag is pushed with the
 * host's skip-CI option (GitLab `ci.skip`, also with `gitlab.tagPipelines`). On GitHub it starts
 * the tag workflows of HEAD's commit: launchset's own only run on branch pushes, but tag
 * workflows the team kept run for it too.
 *
 * The tag is only created when the config in use is the one committed at HEAD: run locally right
 * after `init`, before the migration is committed, HEAD is the commit before it, which still has
 * the old tag workflows. Then it is planned like a dry run, with a warning.
 */
export async function applyBaseline(
  context: FlowContext,
  state: ReleaseState,
  options: {
    dryRun?: boolean;
    /** Gather the state again (fetching tags): when another run pushed the tag first. */
    regather?: () => Promise<ReleaseState>;
  } = {},
): Promise<BaselineResult> {
  const action: BaselineAction | undefined = baselineAction(context.config, {
    branch: state.branch,
    version: state.version,
    index: state.tags.index,
  });
  if (action === undefined) return { state, notices: [], warnings: [] };
  if (action.kind === "skip") return { state, notices: [], warnings: [action.warning] };
  const warnings: string[] = [];
  let dryRun = options.dryRun ?? false;
  if (!dryRun && !(await configCommitted(context, state.headSha))) {
    dryRun = true;
    warnings.push(
      `\`baseline\` is ${action.version}, but the launchset config isn't committed at ${code(state.headSha.slice(0, 7))}, so ${code(action.tag)} isn't created here: a tag on a commit before the migration would start its tag-triggered workflows. Commit the config; the release workflow creates the tag after the merge.`,
    );
  }
  if (!dryRun) {
    try {
      await ensureTag(context, action.tag, state.headSha, { skipCi: true });
    } catch (error) {
      // A run for another commit created it first: that tag is the baseline.
      if (!(error instanceof LaunchsetError && error.code === "tag-conflict") || !options.regather)
        throw error;
      return {
        state: await options.regather(),
        notices: [`Another release run created the baseline tag ${code(action.tag)} first.`],
        warnings: [],
      };
    }
  }
  // The version is released at HEAD: nothing before HEAD is unreleased work anymore.
  const refs = (await context.git.tags()).filter((t) => t.name !== action.tag);
  const reachableReleases = [...new Set([...state.reachableReleases, action.version])];
  return {
    state: {
      ...state,
      tags: snapshotTags([...refs, { name: action.tag, sha: state.headSha }], context.config),
      reachableReleases,
      lastReleaseTag: lastReleaseTagOf(context, reachableReleases),
      commitsSinceRelease: [],
      botPrs: [],
      headIsReleaseCommit: false,
      releaseCommit: state.headSha,
    },
    notices: [baselineNotice(action, state.headSha, { dryRun })],
    warnings,
  };
}

/** True when the config file in use is committed at `sha` with the same content. */
async function configCommitted(context: FlowContext, sha: string): Promise<boolean> {
  const path = await context.git.toRepoPath(basename(context.configFile));
  const [committed, current] = await Promise.all([
    context.git.showFile(sha, path),
    readFile(context.configFile, "utf8"),
  ]);
  return committed === current;
}
