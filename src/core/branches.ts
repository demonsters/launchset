/** Branch-name helpers (pure). */

import picomatch from "picomatch";

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
