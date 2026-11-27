/**
 * The baseline (spec 11.1 step 5): `baseline` in the config names the version that was released
 * before launchset took over. The release workflow on the base branch creates its release tag
 * at the commit it runs on, so that version counts as released without being built. Pure.
 *
 * init doesn't create that tag at HEAD itself: HEAD is the commit before the migration, where
 * the old tag-triggered workflows still exist, and pushing a tag runs the workflows of the
 * tagged commit. A tag on a commit after the migration starts none of them.
 */

import type { ResolvedConfig } from "./config/schema.ts";
import { code } from "./plan-common.ts";
import { isReleased, releaseTag, type TagIndex } from "./tags.ts";

export type BaselineAction =
  /** Create `tag` at the commit the release workflow runs on. */
  | { kind: "create"; version: string; tag: string }
  /** launchset already started releasing the baseline version itself: leave it alone. */
  | { kind: "skip"; warning: string };

/**
 * What to do about `baseline` on `branch` with the root version `version`: nothing (no
 * baseline, not the base branch, the version moved on, or it is released already), create its
 * release tag, or skip it with a warning (marker or partial tags show launchset already
 * shipped part of that version).
 */
export function baselineAction(
  config: Pick<ResolvedConfig, "baseline" | "baseBranch" | "tags">,
  input: { branch: string; version: string; index: TagIndex },
): BaselineAction | undefined {
  const version = config.baseline;
  if (version === undefined || input.branch !== config.baseBranch) return undefined;
  if (input.version !== version || isReleased(input.index, version)) return undefined;
  const tag = releaseTag(config.tags, version);
  const partial = input.index.partials.get(version);
  const markers = input.index.markers.get(version);
  if (partial !== undefined || (markers !== undefined && markers.size > 0)) {
    return {
      kind: "skip",
      warning: `\`baseline\` is ${version}, but launchset already shipped part of ${version} (${partial !== undefined ? `partial tag ${code(partial)}` : `marker tags for ${[...(markers ?? [])].map(code).join(", ")}`}), so it doesn't create ${code(tag)} as a baseline. Remove \`baseline\` from the launchset config.`,
    };
  }
  return { kind: "create", version, tag };
}

/** The notice for a baseline tag this run created (or, in a dry run, would create). */
export function baselineNotice(
  action: Extract<BaselineAction, { kind: "create" }>,
  sha: string,
  options: { dryRun?: boolean } = {},
): string {
  const at = code(sha.slice(0, 7));
  return options.dryRun
    ? `\`baseline\` is ${action.version}: the release workflow creates ${code(action.tag)} at ${at}, so ${action.version} counts as released without a build.`
    : `Created the baseline tag ${code(action.tag)} at ${at} (\`baseline\` in the launchset config): ${action.version} counts as released, nothing was built. You can remove \`baseline\` from the config now.`;
}
