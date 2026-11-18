import { describe, expect, it } from "vitest";
import { LaunchsetError } from "../../src/core/errors.ts";
import { planRelease } from "../../src/core/release.ts";
import {
  BUILD,
  changeset,
  fakeSha,
  HEAD,
  makeConfig,
  NOW,
  plan,
  releaseInput,
  tags,
} from "./plan-fixtures.ts";

const config = makeConfig();

function expectError(fn: () => unknown, code: string): LaunchsetError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(LaunchsetError);
    expect((error as LaunchsetError).code).toBe(code);
    return error as LaunchsetError;
  }
  throw new Error(`expected a ${code} error`);
}

describe("publish on push (9.3)", () => {
  it("publishes when HEAD is the release commit and the release tag doesn't exist", () => {
    const decision = planRelease(
      releaseInput({ version: "1.5.0", headIsReleaseCommit: true, tags: tags(config, ["v1.4.0"]) }),
    );
    const p = decision.plan;
    expect(p.mode).toBe("publish");
    expect(p.releaseSha).toBe(HEAD);
    expect(p.version).toBe("1.5.0");
    expect(p.tag).toBe("v1.5.0");
    expect(p.channel).toBe("release");
    expect(p.distTag).toBe("latest");
    expect(p.buildNumber).toBe(BUILD);
    // Manual targets are never in the publish matrix.
    expect(p.matrix).toEqual(["docker-api", "web", "android"]);
    expect(Object.keys(p.targets)).toEqual(["docker-api", "web", "android"]);
    expect(p.targets.android).toMatchObject({
      marketingVersion: "1.5.0",
      buildNumber: BUILD,
      marker: "launchset/android@1.5.0",
      release: "auto",
    });
    expect(p.targets["docker-api"]?.docker).toMatchObject({
      tags: ["1.5.0", "1.5", "1", "latest"],
      verifyTag: "1.5.0",
      refs: [
        "ghcr.io/demonsters/api:1.5.0",
        "ghcr.io/demonsters/api:1.5",
        "ghcr.io/demonsters/api:1",
        "ghcr.io/demonsters/api:latest",
      ],
      labels: {
        "org.opencontainers.image.version": "1.5.0",
        "org.opencontainers.image.revision": HEAD,
        "org.opencontainers.image.created": NOW.toISOString(),
      },
    });
    expect(p.createdAt).toBe(NOW.toISOString());
    expect(p.repository).toBe("demonsters/app");
    expect(decision.summary).toContain("Publishing **1.5.0**");
  });

  it("leaves out auto targets that already have a marker", () => {
    const p = plan({
      version: "1.5.0",
      headIsReleaseCommit: true,
      tags: tags(config, ["launchset/web@1.5.0", "launchset/docker-api@1.5.0"]),
    });
    expect(p.mode).toBe("publish");
    expect(p.matrix).toEqual(["android"]);
  });

  it("publishes with an empty matrix when every auto target is marked (finalize creates the tag)", () => {
    const decision = planRelease(
      releaseInput({
        version: "1.5.0",
        headIsReleaseCommit: true,
        tags: tags(config, [
          "launchset/web@1.5.0",
          "launchset/docker-api@1.5.0",
          "launchset/android@1.5.0",
        ]),
      }),
    );
    expect(decision.plan.mode).toBe("publish");
    expect(decision.plan.matrix).toEqual([]);
    expect(decision.notices.join("\n")).toContain("finalize creates v1.5.0");
  });

  it("wins over pending changesets", () => {
    const decision = planRelease(
      releaseInput({
        version: "1.5.0",
        headIsReleaseCommit: true,
        changesets: [changeset("a", "minor")],
      }),
    );
    expect(decision.plan.mode).toBe("publish");
    expect(decision.plan.releasePr).toBeUndefined();
    expect(decision.notices.join("\n")).toContain("1 pending changeset");
  });

  it("doesn't publish an already released version", () => {
    const p = plan({ version: "1.5.0", headIsReleaseCommit: true, tags: tags(config, ["v1.5.0"]) });
    expect(p.mode).toBe("none");
  });

  it("doesn't publish when HEAD isn't the release commit (later pushes never auto-retry)", () => {
    const p = plan({ version: "1.5.0", headIsReleaseCommit: false });
    expect(p.mode).toBe("none");
  });

  it("uses target build-number overrides and checks the Android limit", () => {
    const custom = makeConfig({
      targets: {
        web: { type: "web", buildNumber: { offset: 1000 } },
        android: {
          type: "android",
          source: { kind: "gradle", file: "build.gradle" },
          buildNumber: { offset: 2_000_000_000 },
        },
      },
    });
    expectError(
      () =>
        planRelease(releaseInput({ config: custom, version: "1.5.0", headIsReleaseCommit: true })),
      "build-number-too-large",
    );
    const ok = makeConfig({
      targets: { web: { type: "web", buildNumber: { offset: 1000 } } },
    });
    const p = plan({ config: ok, version: "1.5.0", headIsReleaseCommit: true });
    expect(p.buildNumber).toBe(BUILD);
    expect(p.targets.web?.buildNumber).toBe(BUILD + 1000);
  });

  it("has no build number with eas", () => {
    const eas = makeConfig({ buildNumber: { strategy: "eas" } });
    const p = plan({ config: eas, version: "1.5.0", headIsReleaseCommit: true });
    expect(p.buildNumber).toBeNull();
    expect(p.targets.android?.buildNumber).toBeNull();
  });

  it("on a maintenance branch: no latest/major Docker tags, release-X.Y dist-tag", () => {
    const p = plan({ branch: "release/1.4.x", version: "1.4.1", headIsReleaseCommit: true });
    expect(p.mode).toBe("publish");
    expect(p.maintenance).toBe(true);
    expect(p.distTag).toBe("release-1.4");
    expect(p.targets["docker-api"]?.docker?.tags).toEqual(["1.4.1", "1.4"]);
  });

  it("refuses branches that are neither base nor maintenance", () => {
    expectError(() => planRelease(releaseInput({ branch: "feature/x" })), "not-a-release-branch");
  });

  it("refuses a prerelease root version", () => {
    expectError(
      () => planRelease(releaseInput({ version: "1.5.0-alpha.1", headIsReleaseCommit: true })),
      "invalid-version",
    );
  });
});

describe("publish on workflow_dispatch (retry, 9.3)", () => {
  const releaseCommit = "b".repeat(40);

  it("retries an unfinished release from the release commit with the missing auto targets", () => {
    const decision = planRelease(
      releaseInput({
        event: { kind: "dispatch" },
        version: "1.5.0",
        releaseCommit,
        tags: tags(config, [`launchset/web@1.5.0=${releaseCommit}`]),
      }),
    );
    expect(decision.plan.mode).toBe("publish");
    expect(decision.plan.releaseSha).toBe(releaseCommit);
    expect(decision.plan.matrix).toEqual(["docker-api", "android"]);
    expect(
      decision.plan.targets["docker-api"]?.docker?.labels["org.opencontainers.image.revision"],
    ).toBe(releaseCommit);
    expect(decision.notices[0]).toContain("Retrying the release of 1.5.0");
  });

  it("is none with a notice when the current version is already released", () => {
    const decision = planRelease(
      releaseInput({
        event: { kind: "dispatch" },
        version: "1.5.0",
        tags: tags(config, ["v1.5.0"]),
      }),
    );
    expect(decision.plan.mode).toBe("none");
    expect(decision.notices[0]).toContain("already released");
  });

  it("needs the release commit", () => {
    expectError(
      () => planRelease(releaseInput({ event: { kind: "dispatch" }, version: "1.5.0" })),
      "no-release-commit",
    );
  });

  it("rejects a version input without a target", () => {
    expectError(
      () => planRelease(releaseInput({ event: { kind: "dispatch", version: "1.4.0" } })),
      "version-without-target",
    );
  });
});

describe("release-pr (9.3, 8.1, 8.2)", () => {
  it("opens a release PR for pending changesets with the highest bump", () => {
    const decision = planRelease(
      releaseInput({
        tags: tags(config, ["v1.4.0"]),
        changesets: [changeset("a", "patch"), changeset("b", "minor"), changeset("c", "none")],
      }),
    );
    const p = decision.plan;
    expect(p.mode).toBe("release-pr");
    expect(p.version).toBe("1.5.0");
    expect(p.matrix).toEqual([]);
    expect(p.releaseSha).toBe("");
    expect(p.buildNumber).toBeNull();
    expect(p.releasePr).toEqual({
      version: "1.5.0",
      bump: "minor",
      changesets: [".launchset/a.md", ".launchset/b.md", ".launchset/c.md"],
      botPrs: [],
    });
  });

  it("skips a version a hotfix already took (next free version)", () => {
    const decision = planRelease(
      releaseInput({
        tags: tags(config, ["v1.4.0", "v1.4.1"]),
        changesets: [changeset("a", "patch")],
      }),
    );
    expect(decision.plan.version).toBe("1.4.2");
    expect(decision.notices[0]).toContain("1.4.1 is already taken");
  });

  it("counts marker tags as taken too", () => {
    const p = plan({
      tags: tags(config, ["v1.4.0", "launchset/web@1.4.1"]),
      changesets: [changeset("a", "patch")],
    });
    expect(p.version).toBe("1.4.2");
  });

  it("opens a release PR for bot PRs alone (patch)", () => {
    const p = plan({
      botPrs: [{ number: 12, title: "Bump react from 18 to 19", author: "dependabot[bot]" }],
    });
    expect(p.mode).toBe("release-pr");
    expect(p.version).toBe("1.4.1");
    expect(p.releasePr?.bump).toBe("patch");
    expect(p.releasePr?.botPrs).toEqual([12]);
  });

  it("works on a maintenance branch with patch changesets", () => {
    const p = plan({
      branch: "release/1.4.x",
      version: "1.4.1",
      tags: tags(config, ["v1.4.0", "v1.4.1", "v1.5.0"]),
      changesets: [changeset("fix", "patch")],
    });
    expect(p.mode).toBe("release-pr");
    expect(p.version).toBe("1.4.2");
    expect(p.maintenance).toBe(true);
    expect(p.distTag).toBe("release-1.4");
  });

  it("rejects minor changesets on a maintenance branch", () => {
    const error = expectError(
      () =>
        planRelease(
          releaseInput({
            branch: "release/1.4.x",
            version: "1.4.1",
            changesets: [changeset("feat", "minor"), changeset("fix", "patch")],
          }),
        ),
      "maintenance-bump",
    );
    expect(error.message).toContain(".launchset/feat.md (minor)");
    expect(error.hint).toContain("belongs on main");
  });
});

describe("none (9.3)", () => {
  it("is none when only none changesets are pending", () => {
    const decision = planRelease(releaseInput({ changesets: [changeset("docs", "none")] }));
    expect(decision.plan.mode).toBe("none");
    expect(decision.warnings).toEqual([]);
    expect(decision.notices[0]).toContain("Only bump: none changesets");
  });

  it("warns about commits since the last release without any changeset", () => {
    const decision = planRelease(
      releaseInput({
        tags: tags(config, ["v1.4.0"]),
        reachableReleases: ["1.3.0", "1.4.0"],
        commitsSinceRelease: [
          { sha: "c".repeat(40), subject: "Fix typo" },
          { sha: "d".repeat(40), subject: "Tweak CI\n\nlonger body" },
        ],
      }),
    );
    expect(decision.plan.mode).toBe("none");
    expect(decision.warnings).toHaveLength(1);
    expect(decision.warnings[0]).toContain(
      "2 commits since v1.4.0 and no pending changeset: they won't be released.",
    );
    expect(decision.warnings[0]).toContain("- ccccccc Fix typo");
    expect(decision.warnings[0]).toContain("- ddddddd Tweak CI");
    expect(decision.unreleasedCommits?.since).toBe("v1.4.0");
    expect(decision.summary).toContain("> [!WARNING]");
  });

  it("doesn't warn when a none changeset is pending (a changeset covers them)", () => {
    const decision = planRelease(
      releaseInput({
        changesets: [changeset("docs", "none")],
        commitsSinceRelease: [{ sha: "c".repeat(40), subject: "Docs" }],
      }),
    );
    expect(decision.warnings).toEqual([]);
  });

  it("is a quiet none without commits", () => {
    const decision = planRelease(releaseInput());
    expect(decision.plan.mode).toBe("none");
    expect(decision.warnings).toEqual([]);
  });
});

describe("ship (9.8)", () => {
  const shipTags = tags(config, [
    `v1.3.0=${fakeSha("130")}`,
    `v1.4.0=${fakeSha("140")}`,
    `v1.5.0=${fakeSha("150")}`,
    "launchset/ios@1.4.0",
  ]);
  const dispatch = (target: string, version?: string, force?: boolean) =>
    releaseInput({
      event: {
        kind: "dispatch",
        target,
        ...(version !== undefined ? { version } : {}),
        ...(force !== undefined ? { force } : {}),
      },
      version: "1.6.0",
      tags: shipTags,
      reachableReleases: ["1.3.0", "1.4.0", "1.5.0"],
    });

  it("ships the latest release on the branch by default", () => {
    const decision = planRelease(dispatch("ios"));
    const p = decision.plan;
    expect(p.mode).toBe("ship");
    expect(p.version).toBe("1.5.0");
    expect(p.releaseSha).toBe(fakeSha("150"));
    expect(p.matrix).toEqual(["ios"]);
    expect(p.channel).toBe("release");
    expect(p.distTag).toBe("latest");
    expect(p.tag).toBe("v1.5.0");
    expect(p.targets.ios).toMatchObject({
      marketingVersion: "1.5.0",
      buildNumber: BUILD,
      marker: "launchset/ios@1.5.0",
      release: "manual",
    });
  });

  it("accepts a v-prefixed version input", () => {
    expect(planRelease(dispatch("ios", "v1.5.0")).plan.version).toBe("1.5.0");
  });

  it("refuses to go backwards, unless forced", () => {
    const error = expectError(() => planRelease(dispatch("ios", "1.3.0")), "ship-backwards");
    expect(error.message).toContain("ios already shipped 1.4.0");
    const forced = planRelease(dispatch("ios", "1.3.0", true));
    expect(forced.plan.mode).toBe("ship");
    expect(forced.plan.version).toBe("1.3.0");
    expect(forced.plan.releaseSha).toBe(fakeSha("130"));
    // An older version doesn't move npm latest.
    expect(forced.plan.distTag).toBe("release-1.3");
    expect(forced.notices[0]).toContain("force");
  });

  it("is none with a notice when the version is already shipped", () => {
    const decision = planRelease(dispatch("ios", "1.4.0"));
    expect(decision.plan.mode).toBe("none");
    expect(decision.plan.matrix).toEqual([]);
    expect(decision.notices[0]).toBe("ios 1.4.0 is already shipped: nothing to do.");
  });

  it("refuses auto targets", () => {
    const error = expectError(() => planRelease(dispatch("android")), "ship-auto-target");
    expect(error.message).toContain("ships with every release");
    expect(error.hint).toContain("without the target input");
  });

  it("refuses unknown targets", () => {
    expectError(() => planRelease(dispatch("macos")), "unknown-target");
  });

  it("refuses unreleased versions", () => {
    const error = expectError(() => planRelease(dispatch("ios", "1.6.0")), "not-released");
    expect(error.hint).toContain("preview");
  });

  it("refuses when nothing is released on the branch", () => {
    expectError(
      () =>
        planRelease(
          releaseInput({ event: { kind: "dispatch", target: "ios" }, reachableReleases: [] }),
        ),
      "no-release",
    );
  });

  it("drops moving Docker tags for a manual docker target shipping an older version", () => {
    const withDocker = makeConfig({
      targets: {
        web: { type: "web" },
        edge: { type: "docker", image: "ghcr.io/demonsters/edge", release: "manual" },
      },
    });
    const p = plan({
      config: withDocker,
      event: { kind: "dispatch", target: "edge", version: "1.4.0" },
      tags: tags(withDocker, ["v1.4.0", "v1.5.0"]),
      reachableReleases: ["1.4.0", "1.5.0"],
    });
    expect(p.targets.edge?.docker?.tags).toEqual(["1.4.0", "1.4"]);
    const latest = plan({
      config: withDocker,
      event: { kind: "dispatch", target: "edge" },
      tags: tags(withDocker, ["v1.4.0", "v1.5.0"]),
      reachableReleases: ["1.4.0", "1.5.0"],
    });
    expect(latest.targets.edge?.docker?.tags).toEqual(["1.5.0", "1.5", "1", "latest"]);
  });

  it("works outside CI with a run-number root strategy when the target overrides it", () => {
    const cfg = makeConfig({
      buildNumber: { strategy: "run-number" },
      targets: {
        web: { type: "web" },
        ios: {
          type: "ios",
          source: { kind: "xcodeproj", file: "ios/App.xcodeproj" },
          release: "manual",
          buildNumber: { strategy: "timestamp" },
        },
      },
    });
    const { run: _run, ...rest } = releaseInput({
      config: cfg,
      event: { kind: "dispatch", target: "ios" },
      tags: tags(cfg, ["v1.5.0"]),
      reachableReleases: ["1.5.0"],
    });
    const p = planRelease(rest).plan;
    expect(p.buildNumber).toBe(BUILD);
    expect(p.targets.ios?.buildNumber).toBe(BUILD);
  });
});

describe("review regressions: unfinished, superseded and lower versions", () => {
  const R = "e".repeat(40);
  const commits = [
    { sha: "1".repeat(40), subject: "Tweak README" },
    { sha: R, subject: "Release v1.5.0 (#40)" },
    { sha: "2".repeat(40), subject: "Add offline mode (#39)" },
  ];
  const unfinished = tags(config, ["v1.4.0", `launchset/web@1.5.0=${R}`]);

  it("warns on a push after an unfinished release and leaves the release commit out", () => {
    const decision = planRelease(
      releaseInput({
        version: "1.5.0",
        tags: unfinished,
        reachableReleases: ["1.4.0"],
        commitsSinceRelease: commits,
      }),
    );
    expect(decision.plan.mode).toBe("none");
    expect(decision.warnings[0]).toBe(
      "1.5.0 is not released (missing `docker-api` and `android`); pushes don't retry it: re-run the failed jobs, or start the release workflow by hand (workflow_dispatch without inputs). A newer release supersedes it (spec 9.6).",
    );
    // Only the commit after the release commit counts (the marker's commit is used).
    expect(decision.unreleasedCommits?.commits).toEqual([commits[0]]);
    expect(decision.warnings[1]).toContain("1 commit since v1.4.0");
  });

  it("uses the given release commit, and skips the commit warning without one", () => {
    const noMarkers = tags(config, ["v1.4.0"]);
    const withCommit = planRelease(
      releaseInput({
        version: "1.5.0",
        tags: noMarkers,
        releaseCommit: R,
        commitsSinceRelease: commits,
      }),
    );
    expect(withCommit.unreleasedCommits?.commits).toEqual([commits[0]]);
    const without = planRelease(
      releaseInput({ version: "1.5.0", tags: noMarkers, commitsSinceRelease: commits }),
    );
    expect(without.warnings).toHaveLength(1);
    expect(without.warnings[0]).toContain("missing `docker-api`, `web` and `android`");
    expect(without.unreleasedCommits).toBeUndefined();
  });

  it("opens a release PR at the next free version with the unfinished warning", () => {
    const decision = planRelease(
      releaseInput({ version: "1.5.0", tags: unfinished, changesets: [changeset("fix", "patch")] }),
    );
    expect(decision.plan.mode).toBe("release-pr");
    expect(decision.plan.version).toBe("1.5.1");
    expect(decision.warnings[0]).toContain("1.5.0 is not released");
  });

  it("never publishes a superseded version (partial tag), on push or dispatch", () => {
    const superseded = tags(config, [
      "v1.4.0",
      "launchset/web@1.5.0",
      `launchset/partial/1.5.0=${R}`,
      "v1.5.1",
    ]);
    const push = planRelease(
      releaseInput({ version: "1.5.0", headIsReleaseCommit: true, tags: superseded }),
    );
    expect(push.plan.mode).toBe("none");
    expect(push.warnings[0]).toContain(
      "1.5.0 was superseded: it has the partial tag launchset/partial/1.5.0",
    );
    const dispatch = planRelease(
      releaseInput({
        event: { kind: "dispatch" },
        version: "1.5.0",
        releaseCommit: R,
        tags: superseded,
      }),
    );
    expect(dispatch.plan.mode).toBe("none");
    expect(dispatch.warnings[0]).toContain("superseded");
    const withPending = planRelease(
      releaseInput({ version: "1.5.0", tags: superseded, changesets: [changeset("fix", "patch")] }),
    );
    expect(withPending.plan.mode).toBe("release-pr");
    expect(withPending.plan.version).toBe("1.5.2");
  });

  it("publishes a version below the latest release without moving latest", () => {
    const decision = planRelease(
      releaseInput({ version: "1.5.1", headIsReleaseCommit: true, tags: tags(config, ["v1.6.0"]) }),
    );
    const p = decision.plan;
    expect(p.mode).toBe("publish");
    expect(p.maintenance).toBe(false);
    expect(p.distTag).toBe("release-1.5");
    expect(p.targets["docker-api"]?.docker?.tags).toEqual(["1.5.1", "1.5"]);
    expect(decision.notices.join("\n")).toContain("lower than the latest release 1.6.0");
  });

  it("falls through to release-pr / none on a dispatch when the version is released", () => {
    const releasedTags = tags(config, ["v1.4.0"]);
    const pr = planRelease(
      releaseInput({
        event: { kind: "dispatch" },
        tags: releasedTags,
        changesets: [changeset("feat", "minor")],
      }),
    );
    expect(pr.plan.mode).toBe("release-pr");
    expect(pr.plan.version).toBe("1.5.0");
    expect(pr.notices[0]).toContain("v1.4.0 is already released");
    const none = planRelease(
      releaseInput({
        event: { kind: "dispatch" },
        tags: releasedTags,
        commitsSinceRelease: [commits[0] as (typeof commits)[0]],
      }),
    );
    expect(none.plan.mode).toBe("none");
    expect(none.warnings[0]).toContain("1 commit since v1.4.0 and no pending changeset");
  });

  it("ships an eas target with its own null build number", () => {
    const cfg = makeConfig({
      targets: {
        web: { type: "web" },
        ios: {
          type: "ios",
          source: { kind: "expo", file: "app.json" },
          release: "manual",
          buildNumber: { strategy: "eas" },
        },
      },
    });
    const decision = planRelease(
      releaseInput({
        config: cfg,
        event: { kind: "dispatch", target: "ios" },
        tags: tags(cfg, ["v1.4.0"]),
      }),
    );
    expect(decision.plan.mode).toBe("ship");
    expect(decision.plan.buildNumber).toBe(BUILD);
    expect(decision.plan.targets.ios?.buildNumber).toBeNull();
    expect(decision.summary).not.toContain("build number");
  });
});
