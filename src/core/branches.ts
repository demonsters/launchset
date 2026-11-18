/** Branch-name helpers (pure). */

import picomatch from "picomatch";
import type { PreviewBranch } from "./config/schema.ts";
import { parseMaintenanceBranch } from "./versions.ts";

const cache = new Map<string, (input: string) => boolean>();

/** True when `branch` matches the glob `pattern` (`*` doesn't cross `/`). */
export function matchBranch(branch: string, pattern: string): boolean {
  let matcher = cache.get(pattern);
  if (!matcher) {
    matcher = picomatch(pattern, { dot: true });
    cache.set(pattern, matcher);
  }
  return matcher(branch);
}

/**
 * True when `branch` is a maintenance branch: it fits `maintenanceBranches` with a
 * `<major>.<minor>` in place of the `*` (`release/1.4.x`, not `release/foo.x`). The one
 * definition of "maintenance branch"; use it everywhere.
 */
export function isMaintenanceBranch(
  config: { maintenanceBranches: string },
  branch: string,
): boolean {
  return parseMaintenanceBranch(branch, config.maintenanceBranches) !== null;
}

interface PreviewBranchConfig {
  maintenanceBranches: string;
  preview: { enabled: boolean; branches: PreviewBranch[] };
}

/**
 * The `preview.branches` entry that makes a push to `branch` auto-preview (spec 9.7, 9.9),
 * or `null`. The first matching entry wins. Branches matching `maintenanceBranches` never
 * auto-preview, even when a pattern matches them.
 */
export function findPreviewBranch(
  config: PreviewBranchConfig,
  branch: string,
): PreviewBranch | null {
  if (!config.preview.enabled || isMaintenanceBranch(config, branch)) return null;
  return config.preview.branches.find((entry) => matchBranch(branch, entry.branch)) ?? null;
}
