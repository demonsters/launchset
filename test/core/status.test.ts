import { describe, expect, it } from "vitest";
import { readChangesetFile } from "../../src/core/plan-common.ts";
import { computeStatus, renderStatus } from "../../src/core/status.ts";
import { makeConfig, tags } from "./plan-fixtures.ts";

const config = makeConfig();

describe("status (11)", () => {
  const snapshot = tags(config, [
    "v1.3.0",
    "v1.4.0",
    "v1.4.1",
    "launchset/ios@1.3.0",
    "launchset/web@1.5.0",
  ]);

  it("reports pending changesets, next version, releases and manual targets", () => {
    const data = computeStatus({
      config,
      branch: "main",
      version: "1.4.0",
      changesets: [
        readChangesetFile("---\nbump: patch\n---\n\nFix it.\n", ".launchset/a.md"),
        readChangesetFile("---\nbump: nope\n---\n", ".launchset/b.md"),
      ],
      mismatches: [],
      tags: snapshot,
      commitsSinceRelease: [],
    });
    expect(data.bump).toBe("patch");
    // 1.4.1 is taken (hotfix), 1.5.0 isn't a patch.
    expect(data.nextVersion).toBe("1.4.2");
    expect(data.pending).toEqual([{ path: ".launchset/a.md", bump: "patch", summary: "Fix it." }]);
    expect(data.invalid[0]?.path).toBe(".launchset/b.md");
    expect(data.lastRelease).toEqual({ version: "1.4.1", tag: "v1.4.1" });
    expect(data.unfinished).toEqual([
      { version: "1.5.0", shipped: ["web"], missing: ["docker-api", "android"] },
    ]);
    expect(data.manualTargets).toEqual([
      { target: "ios", lastShipped: "1.3.0", releasesBehind: 2 },
    ]);
    expect(data.consistency.ok).toBe(true);
    expect(data.commitsWithoutChangeset).toBeNull();

    const text = renderStatus(data);
    expect(text).toContain("Next version:  1.4.2 (patch)");
    expect(text).toContain("patch  Fix it.  .launchset/a.md");
    expect(text).toContain("ios: 1.3.0 (2 releases behind)");
    expect(text).toContain("1.5.0: shipped web; missing docker-api, android");
    expect(text).toContain("Invalid changesets (1):");
  });

  it("warns about commits without changesets and reports mismatches", () => {
    const data = computeStatus({
      config,
      branch: "main",
      version: "1.4.0",
      changesets: [],
      mismatches: [
        {
          target: null,
          path: "package-lock.json",
          found: [{ key: "version", value: "1.3.0" }],
          expected: "1.4.0",
        },
      ],
      tags: snapshot,
      reachableReleases: ["1.3.0", "1.4.0"],
      commitsSinceRelease: [{ sha: "e".repeat(40), subject: "Change" }],
    });
    expect(data.bump).toBeNull();
    expect(data.nextVersion).toBeNull();
    expect(data.lastRelease?.tag).toBe("v1.4.0");
    expect(data.commitsWithoutChangeset).toEqual({
      since: "v1.4.0",
      commits: [{ sha: "e".repeat(40), subject: "Change" }],
    });
    const text = renderStatus(data);
    expect(text).toContain("Next version:  nothing to release");
    expect(text).toContain("Version files: 1 mismatch");
    expect(text).toContain("package-lock.json: version = 1.3.0, expected 1.4.0");
    expect(text).toContain("1 commit since v1.4.0 and no pending changeset");
  });

  it("explains why the next version can't be computed on a maintenance branch", () => {
    const data = computeStatus({
      config,
      branch: "release/1.4.x",
      version: "1.4.1",
      changesets: [readChangesetFile("---\nbump: minor\n---\n\nFeature.\n", ".launchset/a.md")],
      mismatches: [],
      tags: snapshot,
      commitsSinceRelease: [],
    });
    expect(data.maintenance).toBe(true);
    expect(data.nextVersion).toBeNull();
    expect(data.nextVersionError).toContain("isn't allowed on the maintenance branch");
    expect(renderStatus(data)).toContain("can't be computed");
  });

  it("counts bot PRs as a patch", () => {
    const data = computeStatus({
      config,
      branch: "main",
      version: "1.4.1",
      changesets: [],
      mismatches: [],
      tags: snapshot,
      commitsSinceRelease: [{ sha: "e".repeat(40), subject: "Bump x" }],
      botPrs: [{ number: 5, title: "Bump x", author: "dependabot[bot]" }],
    });
    expect(data.bump).toBe("patch");
    expect(data.nextVersion).toBe("1.4.2");
    expect(data.commitsWithoutChangeset).toBeNull();
    expect(renderStatus(data)).toContain("#5  Bump x");
  });
});
