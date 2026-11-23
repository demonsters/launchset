/** The per-branch cache of {@link Forge.closedPrsInto}, shared by the forge clients. */

import type { ForgeError } from "./errors.ts";
import type { Forge, PullRequest } from "./types.ts";

/**
 * Build `closedPrsInto` from `list(base, since)` (merged PRs, newest update first, down to
 * `since` in ms). One listing per branch serves later calls that look back no further (bot
 * PRs and changelog links of one release PR). `invalid` makes the error for an unparsable
 * `updatedSince`.
 */
export function cachedClosedPrs(
  list: (base: string, since: number | undefined) => Promise<PullRequest[]>,
  invalid: (updatedSince: string) => ForgeError,
): Forge["closedPrsInto"] {
  const listings = new Map<string, { since: number | undefined; prs: Promise<PullRequest[]> }>();
  return async (base, options = {}) => {
    const since = options.updatedSince ? Date.parse(options.updatedSince) : undefined;
    if (since !== undefined && Number.isNaN(since)) throw invalid(options.updatedSince ?? "");
    const cached = listings.get(base);
    if (cached && (cached.since === undefined || (since !== undefined && since >= cached.since))) {
      const prs = await cached.prs;
      return prs.filter((pr) => since === undefined || !(Date.parse(pr.updatedAt) < since));
    }
    const prs = list(base, since);
    listings.set(base, { since, prs });
    prs.catch(() => {
      if (listings.get(base)?.prs === prs) listings.delete(base);
    });
    return [...(await prs)];
  };
}
