/** Shared fixtures for the plan/state tests. */

import { parseChangeset } from "../../src/core/changesets.ts";
import { type ResolvedConfig, resolveConfig } from "../../src/core/config/schema.ts";
import { snapshotTags, type TagSnapshot } from "../../src/core/plan-common.ts";
import { planRelease, type ReleaseInput } from "../../src/core/release.ts";
import type { Bump, Changeset } from "../../src/core/types.ts";

export const NOW = new Date("2026-11-18T12:00:00Z");
/** The `timestamp` build number at NOW. */
export const BUILD = Math.floor((NOW.getTime() - Date.parse("2020-01-01T00:00:00Z")) / 1000);
export const HEAD = "a".repeat(40);
export const REPO = "demonsters/app";

export function makeConfig(overrides: Record<string, unknown> = {}): ResolvedConfig {
  return resolveConfig({
    targets: {
      "docker-api": { type: "docker", image: "ghcr.io/demonsters/api" },
      web: { type: "web" },
      android: {
        type: "android",
        source: { kind: "gradle", file: "android/app/build.gradle" },
      },
      ios: {
        type: "ios",
        source: { kind: "xcodeproj", file: "ios/App.xcodeproj" },
        release: "manual",
      },
    },
    ...overrides,
  });
}

/** Tags from `name` or `name=sha` strings; a missing sha gets a fake one derived from the name. */
export function tags(config: ResolvedConfig, names: string[]): TagSnapshot {
  return snapshotTags(
    names.map((entry) => {
      const [name, sha] = entry.split("=") as [string, string | undefined];
      return { name, sha: sha ?? fakeSha(name) };
    }),
    config,
  );
}

export function fakeSha(seed: string): string {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash.toString(16).padStart(8, "0").repeat(5);
}

export function changeset(name: string, bump: Bump, summary = `Change ${name}`): Changeset {
  const text =
    bump === "none" ? "---\nbump: none\n---\n" : `---\nbump: ${bump}\n---\n\n${summary}\n`;
  return parseChangeset(text, `.launchset/${name}.md`).changeset;
}

export function releaseInput(overrides: Partial<ReleaseInput> = {}): ReleaseInput {
  const config = overrides.config ?? makeConfig();
  return {
    config,
    branch: "main",
    event: { kind: "push" },
    headSha: HEAD,
    version: "1.4.0",
    headIsReleaseCommit: false,
    tags: tags(config, ["v1.4.0"]),
    reachableReleases: ["1.4.0"],
    changesets: [],
    botPrs: [],
    commitsSinceRelease: [],
    now: NOW,
    run: {
      id: 99,
      number: 17,
      attempt: 1,
      url: "https://github.com/demonsters/app/actions/runs/99",
    },
    repository: REPO,
    ...overrides,
  };
}

export function plan(overrides: Partial<ReleaseInput> = {}) {
  return planRelease(releaseInput(overrides)).plan;
}
