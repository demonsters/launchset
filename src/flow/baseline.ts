/**
 * `baseline` in the release flow (spec 11.1 step 5): on the base branch, create the baseline
 * version's release tag at HEAD (pushed with launchset's credentials, like every tag it creates)
 * and plan as if it had been there all along.
 */

import { type BaselineAction, baselineAction, baselineNotice } from "../core/baseline.ts";
import { LaunchsetError } from "../core/errors.ts";
import { snapshotTags } from "../core/plan-common.ts";
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
 * created, but the plan is the one the release workflow will make. Tags pushed this way start
 * the workflows of HEAD's commit, where launchset's own workflows only run on branch pushes.
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
  if (!options.dryRun) {
    try {
      await ensureTag(context, action.tag, state.headSha);
    } catch (error) {
      // A run for another commit created it first: that tag is the baseline.
      if (!(error instanceof LaunchsetError && error.code === "tag-conflict") || !options.regather)
        throw error;
      return { state: await options.regather(), notices: [], warnings: [] };
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
    notices: [baselineNotice(action, state.headSha, options)],
    warnings: [],
  };
}
