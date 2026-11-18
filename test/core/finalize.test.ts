import { describe, expect, it } from "vitest";
import {
  type ExistingRelease,
  type FinalizeInput,
  finalizeCandidates,
  planFinalize,
} from "../../src/core/finalize.ts";
import { parseManualTargets } from "../../src/core/release-notes.ts";
import { BUILD, fakeSha, HEAD, makeConfig, NOW, plan, tags } from "./plan-fixtures.ts";

const config = makeConfig();

const CHANGELOG = [
  "# Changelog",
  "",
  "## 1.5.0 (2026-11-18)",
  "",
  "### Minor changes",
  "- Add offline mode.",
  "",
  "## 1.4.1 (2026-11-10)",
  "",
  "### Patch changes",
  "- Fix the login crash.",
  "",
  "## 1.4.0 (2026-11-01)",
  "",
  "### Minor changes",
  "- First.",
  "",
].join("\n");

const ALL_150 = ["launchset/docker-api@1.5.0", "launchset/web@1.5.0", "launchset/android@1.5.0"];

const publishPlan = plan({
  version: "1.5.0",
  headIsReleaseCommit: true,
  tags: tags(config, ["v1.4.0"]),
});

function input(overrides: Partial<FinalizeInput> = {}): FinalizeInput {
  return {
    config,
    plan: publishPlan,
    tags: tags(config, ["v1.4.0", ...ALL_150]),
    changelog: CHANGELOG,
    releases: new Map(),
    now: NOW,
    ...overrides,
  };
}

describe("finalize publish (9.3)", () => {
  it("creates the release tag and the GitHub Release when every auto target is marked", () => {
    const result = planFinalize(input());
    expect(result.ok).toBe(true);
    expect(result.status).toBe("released");
    expect(result.actions).toHaveLength(2);
    expect(result.actions[0]).toEqual({ kind: "create-tag", tag: "v1.5.0", sha: HEAD });
    const release = result.actions[1];
    expect(release).toMatchObject({
      kind: "create-release",
      tag: "v1.5.0",
      name: "v1.5.0",
      prerelease: false,
      makeLatest: true,
    });
    if (release?.kind !== "create-release") throw new Error("expected a release");
    expect(release.body.startsWith("### Minor changes\n- Add offline mode.\n\n")).toBe(true);
    expect(release.body).toContain("- `ios`: not shipped yet");
    expect(parseManualTargets(release.body)).toEqual([{ target: "ios", shipped: false }]);
    expect(result.summary).toContain("**v1.5.0** is released");
  });

  it("doesn't need manual target markers", () => {
    const result = planFinalize(input());
    expect(result.missing).toEqual([]);
  });

  it("lists a manual target that already shipped", () => {
    const result = planFinalize(input({ tags: tags(config, [...ALL_150, "launchset/ios@1.5.0"]) }));
    const release = result.actions.find((a) => a.kind === "create-release");
    if (release?.kind !== "create-release") throw new Error("expected a release");
    expect(release.body).toContain("- `ios`: shipped");
  });

  it("fails and lists the missing auto targets", () => {
    const result = planFinalize(input({ tags: tags(config, ["launchset/web@1.5.0"]) }));
    expect(result.ok).toBe(false);
    expect(result.status).toBe("incomplete");
    expect(result.missing).toEqual(["docker-api", "android"]);
    expect(result.actions).toEqual([]);
    expect(result.failures[0]).toContain(
      "v1.5.0 is not released: 2 auto targets have no marker for 1.5.0 yet: `docker-api` and `android`.",
    );
    expect(result.summary).toContain("> [!CAUTION]");
  });

  it("is idempotent: nothing to do when tag and Release exist", () => {
    const first = planFinalize(input());
    const release = first.actions[1];
    if (release?.kind !== "create-release") throw new Error("expected a release");
    const existing: ExistingRelease = {
      id: 7,
      name: "v1.5.0",
      body: release.body,
      prerelease: false,
    };
    const second = planFinalize(
      input({
        tags: tags(config, ["v1.4.0", `v1.5.0=${HEAD}`, ...ALL_150]),
        releases: new Map([["v1.5.0", existing]]),
      }),
    );
    expect(second.ok).toBe(true);
    expect(second.actions).toEqual([]);
    expect(second.summary).toContain("Nothing to change");
  });

  it("updates an existing Release and keeps a shipped manual entry", () => {
    const body =
      'old\n\n<!-- launchset:manual-targets {"ios":{"shipped":true,"buildNumber":5,"date":"2026-11-19"}} -->\nx\n<!-- /launchset:manual-targets -->';
    const result = planFinalize(
      input({
        releases: new Map([["v1.5.0", { id: 7, name: "v1.5.0", body, prerelease: false }]]),
      }),
    );
    const update = result.actions.find((a) => a.kind === "update-release");
    expect(update).toMatchObject({ kind: "update-release", id: 7, makeLatest: true });
    if (update?.kind !== "update-release") throw new Error("expected an update");
    expect(update.body).toContain("- `ios`: shipped 2026-11-19, build 5");
    expect(update.body).toContain("Add offline mode.");
  });

  it("isn't latest when a higher release exists", () => {
    const result = planFinalize(input({ tags: tags(config, ["v1.6.0", ...ALL_150]) }));
    expect(result.actions.find((a) => a.kind === "create-release")).toMatchObject({
      makeLatest: false,
    });
  });

  it("warns when the changelog has no section", () => {
    const result = planFinalize(input({ changelog: "# Changelog\n" }));
    expect(result.warnings[0]).toContain("CHANGELOG.md has no section for 1.5.0");
  });

  it("warns when the release tag already exists elsewhere", () => {
    const result = planFinalize(
      input({ tags: tags(config, [`v1.5.0=${"f".repeat(40)}`, ...ALL_150]) }),
    );
    expect(result.actions.some((a) => a.kind === "create-tag")).toBe(false);
    expect(result.warnings[0]).toContain("already exists at fffffff");
  });
});

describe("finalize on a maintenance branch (9.5)", () => {
  const maintenancePlan = plan({
    branch: "release/1.4.x",
    version: "1.4.1",
    headIsReleaseCommit: true,
    tags: tags(config, ["v1.4.0", "v1.5.0"]),
  });
  const all141 = ["launchset/docker-api@1.4.1", "launchset/web@1.4.1", "launchset/android@1.4.1"];
  const baseChangelog = [
    "# Changelog",
    "",
    "## 1.5.0 (2026-11-18)",
    "",
    "- Feature.",
    "",
    "## 1.4.0 (2026-11-01)",
    "",
    "- First.",
    "",
  ].join("\n");

  it("is not latest and opens the changelog backport PR", () => {
    const result = planFinalize(
      input({
        plan: maintenancePlan,
        tags: tags(config, ["v1.4.0", "v1.5.0", ...all141]),
        baseChangelog,
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.actions.map((a) => a.kind)).toEqual([
      "create-tag",
      "create-release",
      "backport-changelog",
    ]);
    expect(result.actions[1]).toMatchObject({ makeLatest: false });
    const backport = result.actions[2];
    if (backport?.kind !== "backport-changelog") throw new Error("expected a backport");
    expect(backport).toMatchObject({
      version: "1.4.1",
      base: "main",
      branch: "launchset/changelog/v1.4.1",
      title: "Changelog: v1.4.1",
      commitMessage: "Changelog: v1.4.1",
      file: "CHANGELOG.md",
    });
    expect(backport.changelog).toBe(
      [
        "# Changelog",
        "",
        "## 1.5.0 (2026-11-18)",
        "",
        "- Feature.",
        "",
        "## 1.4.1 (2026-11-10)",
        "",
        "### Patch changes",
        "- Fix the login crash.",
        "",
        "## 1.4.0 (2026-11-01)",
        "",
        "- First.",
        "",
      ].join("\n"),
    );
  });

  it("skips the backport when the base branch already has the section", () => {
    const result = planFinalize(
      input({
        plan: maintenancePlan,
        tags: tags(config, ["v1.4.0", "v1.5.0", ...all141]),
        baseChangelog: CHANGELOG,
      }),
    );
    expect(result.actions.some((a) => a.kind === "backport-changelog")).toBe(false);
    expect(result.notices.join("\n")).toContain("already has the 1.4.1 section");
  });

  it("needs the base changelog", () => {
    expect(() =>
      planFinalize(input({ plan: maintenancePlan, tags: tags(config, [...all141]) })),
    ).toThrow(/needs CHANGELOG.md from main/);
  });
});

describe("superseding (9.6)", () => {
  const sha140 = fakeSha("release-1.4.0");
  const p141 = plan({ version: "1.4.1", headIsReleaseCommit: true });
  const all141 = ["launchset/docker-api@1.4.1", "launchset/web@1.4.1", "launchset/android@1.4.1"];
  const partialTags = [
    `launchset/web@1.4.0=${sha140}`,
    // Manual targets are ignored by superseding.
    `launchset/ios@1.4.0=${sha140}`,
  ];

  it("creates a partial tag and a pre-release for an older unfinished version", () => {
    const result = planFinalize(
      input({
        plan: p141,
        tags: tags(config, [...partialTags, ...all141]),
        unfinished: [{ version: "1.4.0", sha: sha140 }],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.superseded).toEqual([
      {
        version: "1.4.0",
        tag: "launchset/partial/1.4.0",
        shipped: ["web"],
        missing: ["docker-api", "android"],
      },
    ]);
    expect(result.actions.map((a) => [a.kind, "tag" in a ? a.tag : ""])).toEqual([
      ["create-tag", "v1.4.1"],
      ["create-tag", "launchset/partial/1.4.0"],
      ["create-release", "v1.4.1"],
      ["create-release", "launchset/partial/1.4.0"],
    ]);
    expect(result.actions[1]).toMatchObject({ sha: sha140 });
    const partial = result.actions[3];
    if (partial?.kind !== "create-release") throw new Error("expected a release");
    expect(partial.name).toBe("v1.4.0 (partial, superseded by v1.4.1)");
    expect(partial.prerelease).toBe(true);
    expect(partial.makeLatest).toBe(false);
    expect(partial.body).toContain("- Shipped: `web`");
    expect(partial.body).toContain("- Not shipped: `docker-api` and `android`");
    expect(partial.body).toContain("- First.");
  });

  it("supersedes even when the new release is incomplete", () => {
    const result = planFinalize(
      input({
        plan: p141,
        tags: tags(config, [...partialTags, "launchset/web@1.4.1"]),
        unfinished: [{ version: "1.4.0", sha: sha140 }],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.actions.map((a) => a.kind)).toEqual(["create-tag", "create-release"]);
    expect(result.actions[0]).toMatchObject({ tag: "launchset/partial/1.4.0" });
  });

  it("is idempotent when the partial tag and its Release exist", () => {
    const result = planFinalize(
      input({
        plan: p141,
        tags: tags(config, [...partialTags, "launchset/partial/1.4.0", ...all141, "v1.4.1"]),
        unfinished: [{ version: "1.4.0", sha: sha140 }],
        releases: new Map([
          ["launchset/partial/1.4.0", { id: 3, name: "x", body: "y", prerelease: true }],
        ]),
      }),
    );
    expect(result.actions.filter((a) => "tag" in a && a.tag.includes("partial"))).toEqual([]);
  });

  it("only creates the missing Release when the partial tag already exists", () => {
    const result = planFinalize(
      input({
        plan: p141,
        tags: tags(config, [...partialTags, "launchset/partial/1.4.0", ...all141]),
        unfinished: [{ version: "1.4.0", sha: sha140 }],
      }),
    );
    expect(
      result.actions.filter((a) => a.kind === "create-tag").map((a) => "tag" in a && a.tag),
    ).toEqual(["v1.4.1"]);
    expect(result.actions.some((a) => a.kind === "create-release" && a.prerelease)).toBe(true);
  });

  it("releases an older version that has every auto marker instead of superseding it", () => {
    const result = planFinalize(
      input({
        plan: p141,
        tags: tags(config, [
          `launchset/web@1.4.0=${sha140}`,
          `launchset/docker-api@1.4.0=${sha140}`,
          `launchset/android@1.4.0=${sha140}`,
          ...all141,
        ]),
        unfinished: [{ version: "1.4.0", sha: sha140 }],
      }),
    );
    expect(result.superseded).toEqual([]);
    expect(result.completed).toEqual(["1.4.0"]);
    expect(result.actions).toContainEqual({ kind: "create-tag", tag: "v1.4.0", sha: sha140 });
    expect(
      result.actions.find((a) => a.kind === "create-release" && a.tag === "v1.4.0"),
    ).toMatchObject({
      makeLatest: false,
      prerelease: false,
    });
  });

  it("ignores older versions with only manual markers, released ones and newer ones", () => {
    const result = planFinalize(
      input({
        plan: p141,
        tags: tags(config, [`launchset/ios@1.3.0`, "v1.2.0", "launchset/web@1.2.0", ...all141]),
        unfinished: [
          { version: "1.3.0", sha: fakeSha("130") },
          { version: "1.2.0", sha: fakeSha("120") },
          { version: "1.5.0", sha: fakeSha("150") },
        ],
      }),
    );
    expect(result.superseded).toEqual([]);
    expect(result.actions.map((a) => a.kind)).toEqual(["create-tag", "create-release"]);
  });
});

describe("finalize ship (9.8)", () => {
  const shipPlan = plan({
    event: { kind: "dispatch", target: "ios" },
    version: "1.6.0",
    tags: tags(config, [`v1.5.0=${fakeSha("150")}`]),
    reachableReleases: ["1.5.0"],
  });
  const existingBody = [
    "### Minor changes",
    "- Add offline mode.",
    "",
    '<!-- launchset:manual-targets {"ios":{"shipped":false}} -->',
    "### Manual targets",
    "",
    "- `ios`: not shipped yet",
    "<!-- /launchset:manual-targets -->",
  ].join("\n");
  const releases = new Map([
    ["v1.5.0", { id: 9, name: "v1.5.0", body: existingBody, prerelease: false }],
  ]);

  it("updates the manual targets list when the marker exists, never creating tags", () => {
    const result = planFinalize(
      input({ plan: shipPlan, tags: tags(config, ["v1.5.0", "launchset/ios@1.5.0"]), releases }),
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe("shipped");
    expect(result.actions).toHaveLength(1);
    const update = result.actions[0];
    if (update?.kind !== "update-release") throw new Error("expected an update");
    expect(update.id).toBe(9);
    expect(update.makeLatest).toBeUndefined();
    expect(update.body).toContain("- Add offline mode.");
    expect(update.body).toContain(`- \`ios\`: shipped 2026-11-18, build ${BUILD}`);
    expect(update.body).not.toContain("not shipped yet");

    // Re-run with the updated body: nothing to do, the date stays.
    const again = planFinalize(
      input({
        plan: shipPlan,
        tags: tags(config, ["v1.5.0", "launchset/ios@1.5.0"]),
        releases: new Map([
          ["v1.5.0", { id: 9, name: "v1.5.0", body: update.body, prerelease: false }],
        ]),
        now: new Date("2026-12-01T00:00:00Z"),
      }),
    );
    expect(again.actions).toEqual([]);
    expect(again.notices[0]).toContain("already lists ios as shipped");
  });

  it("fails when the marker is missing", () => {
    const result = planFinalize(
      input({ plan: shipPlan, tags: tags(config, ["v1.5.0"]), releases }),
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe("not-shipped");
    expect(result.missing).toEqual(["ios"]);
    expect(result.actions).toEqual([]);
    expect(result.failures[0]).toContain("ios 1.5.0 has no marker yet");
  });

  it("creates the Release when the version has none (e.g. a baseline tag)", () => {
    const result = planFinalize(
      input({ plan: shipPlan, tags: tags(config, ["v1.5.0", "launchset/ios@1.5.0"]) }),
    );
    const create = result.actions[0];
    if (create?.kind !== "create-release") throw new Error("expected a release");
    expect(create.tag).toBe("v1.5.0");
    expect(create.makeLatest).toBe(true);
    expect(create.body).toContain("- Add offline mode.");
    expect(create.body).toContain("- `ios`: shipped 2026-11-18");
  });
});

describe("planFinalize guards", () => {
  it("rejects other modes", () => {
    expect(() => planFinalize(input({ plan: plan() }))).toThrow(/publish and ship/);
  });
});

describe("review regressions: finalize", () => {
  const sha140 = fakeSha("release-1.4.0");
  const all = (v: string) => [
    `launchset/docker-api@${v}=${sha140}`,
    `launchset/web@${v}=${sha140}`,
    `launchset/android@${v}=${sha140}`,
  ];
  const p141 = plan({ version: "1.4.1", headIsReleaseCommit: true, tags: tags(config, []) });

  it("never gives a superseded version (partial tag) a release tag", () => {
    const result = planFinalize(
      input({ tags: tags(config, ["v1.4.0", ...ALL_150, "launchset/partial/1.5.0", "v1.5.1"]) }),
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe("superseded");
    expect(result.actions).toEqual([]);
    expect(result.failures[0]).toContain("never gets v1.5.0");
  });

  it("isn't latest when publishing below the latest release", () => {
    const low = plan({
      version: "1.5.1",
      headIsReleaseCommit: true,
      tags: tags(config, ["v1.6.0"]),
    });
    const result = planFinalize(
      input({
        plan: low,
        tags: tags(config, [
          "v1.6.0",
          "launchset/docker-api@1.5.1",
          "launchset/web@1.5.1",
          "launchset/android@1.5.1",
        ]),
      }),
    );
    expect(result.actions.find((a) => a.kind === "create-release")).toMatchObject({
      makeLatest: false,
    });
  });

  it("marks an older completed version latest when it's the highest release on the base branch", () => {
    const result = planFinalize(
      input({
        plan: p141,
        tags: tags(config, [...all("1.4.0"), "launchset/web@1.4.1"]),
        unfinished: [{ version: "1.4.0", sha: sha140 }],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.completed).toEqual(["1.4.0"]);
    expect(result.actions.find((a) => a.kind === "create-release")).toMatchObject({
      tag: "v1.4.0",
      makeLatest: true,
    });
  });

  it("gives latest only to the current version when both complete", () => {
    const result = planFinalize(
      input({
        plan: p141,
        tags: tags(config, [...all("1.4.0"), ...all("1.4.1")]),
        unfinished: [{ version: "1.4.0", sha: sha140 }],
      }),
    );
    const releases = result.actions.filter((a) => a.kind === "create-release");
    expect(releases.map((a) => [a.tag, a.makeLatest])).toEqual([
      ["v1.4.1", true],
      ["v1.4.0", false],
    ]);
  });

  it("backports an older completed version on a maintenance branch, never latest", () => {
    const m = plan({
      branch: "release/1.4.x",
      version: "1.4.1",
      headIsReleaseCommit: true,
      tags: tags(config, ["v1.5.0"]),
    });
    const result = planFinalize(
      input({
        plan: m,
        tags: tags(config, ["v1.5.0", ...all("1.4.0"), ...all("1.4.1")]),
        unfinished: [{ version: "1.4.0", sha: sha140 }],
        baseChangelog: "# Changelog\n\n## 1.5.0 (2026-11-18)\n\n- Feature.\n",
      }),
    );
    expect(
      result.actions.filter((a) => a.kind === "create-release").every((a) => !a.makeLatest),
    ).toBe(true);
    const backports = result.actions.filter((a) => a.kind === "backport-changelog");
    expect(backports.map((a) => a.branch)).toEqual([
      "launchset/changelog/v1.4.1",
      "launchset/changelog/v1.4.0",
    ]);
    expect(backports[1]?.section).toBe("## 1.4.0 (2026-11-01)\n\n### Minor changes\n- First.\n");
    expect(backports[1]?.changelog).toContain("## 1.5.0 (2026-11-18)\n\n- Feature.\n\n## 1.4.0");
  });

  it("keeps an older version with a partial tag partial, even with every auto marker", () => {
    const result = planFinalize(
      input({
        plan: p141,
        tags: tags(config, [...all("1.4.0"), "launchset/partial/1.4.0", ...all("1.4.1")]),
        unfinished: [{ version: "1.4.0", sha: sha140 }],
      }),
    );
    expect(result.completed).toEqual([]);
    expect(result.actions.some((a) => "tag" in a && a.tag === "v1.4.0")).toBe(false);
    // The missing partial Release is retried.
    expect(result.actions).toContainEqual(
      expect.objectContaining({
        kind: "create-release",
        tag: "launchset/partial/1.4.0",
        prerelease: true,
      }),
    );
  });

  it("records an eas manual target without the root build number", () => {
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
    const ship = plan({
      config: cfg,
      event: { kind: "dispatch", target: "ios" },
      tags: tags(cfg, ["v1.4.0"]),
    });
    const result = planFinalize(
      input({
        config: cfg,
        plan: ship,
        tags: tags(cfg, ["v1.4.0", "launchset/ios@1.4.0"]),
        changelog: CHANGELOG,
      }),
    );
    const create = result.actions[0];
    if (create?.kind !== "create-release") throw new Error("expected a release");
    expect(parseManualTargets(create.body)).toEqual([
      { target: "ios", shipped: true, buildNumber: null, date: "2026-11-18" },
    ]);
  });
});

describe("finalizeCandidates (9.6)", () => {
  const snapshot = tags(config, [
    "v1.3.0",
    "launchset/web@1.3.0",
    `launchset/web@1.4.0=${fakeSha("m140")}`,
    `launchset/web@1.4.1=${fakeSha("m141")}`,
    `launchset/partial/1.4.1=${fakeSha("p141")}`,
    "launchset/ios@1.4.2",
    "launchset/web@1.6.0",
  ]);

  it("lists older versions with auto markers and no release tag, oldest first", () => {
    expect(finalizeCandidates(config, snapshot, "1.5.0")).toEqual([
      { version: "1.4.0", sha: fakeSha("m140") },
      { version: "1.4.1", sha: fakeSha("p141") },
    ]);
  });

  it("drops partial-tagged versions whose partial Release exists", () => {
    expect(
      finalizeCandidates(config, snapshot, "1.5.0", new Set(["launchset/partial/1.4.1"])),
    ).toEqual([{ version: "1.4.0", sha: fakeSha("m140") }]);
  });
});
