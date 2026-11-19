import { describe, expect, it } from "vitest";
import { LaunchsetError } from "../../src/core/errors.ts";
import {
  botChangeset,
  buildReleasePr,
  isReleasePrBranch,
  RELEASE_PR_MARKER,
  releasePrBranch,
  releasePrCloseComment,
} from "../../src/core/release-pr.ts";
import { changeset, makeConfig, NOW, plan, tags } from "./plan-fixtures.ts";

const config = makeConfig();

describe("release PR branch names", () => {
  it("keeps slashes of the base branch", () => {
    expect(releasePrBranch("main")).toBe("launchset/release/main");
    expect(releasePrBranch("release/1.4.x")).toBe("launchset/release/release/1.4.x");
    expect(isReleasePrBranch("launchset/release/release/1.4.x")).toBe(true);
    expect(isReleasePrBranch("launchset/release/")).toBe(false);
    expect(isReleasePrBranch("feature/launchset/release/main")).toBe(false);
  });
});

describe("buildReleasePr (9.3, 9.4, 9.8, 12)", () => {
  const pending = [
    changeset("brave-lions-sing", "minor", "Add offline mode."),
    changeset("calm-cats-nap", "patch", "Fix the login crash.\n\nIt happened on slow networks."),
    changeset("quiet-docs", "none"),
  ];
  const botPrs = [
    { number: 131, title: "Bump react-native from 0.76.1 to 0.76.3", author: "dependabot[bot]" },
  ];
  const releaseTags = tags(config, ["v1.3.0", "v1.4.0", "launchset/ios@1.3.0"]);
  const releasePlan = plan({ tags: releaseTags, changesets: pending, botPrs });

  const content = buildReleasePr({
    config,
    plan: releasePlan,
    changesets: pending,
    botPrs,
    origins: new Map([
      [".launchset/brave-lions-sing.md", { pr: 123, author: "someone" }],
      [".launchset/calm-cats-nap.md", { pr: 130 }],
    ]),
    tags: releaseTags,
    now: NOW,
  });

  it("names branch, title and commit", () => {
    expect(content.base).toBe("main");
    expect(content.branch).toBe("launchset/release/main");
    expect(content.title).toBe("Release v1.5.0");
    expect(content.commitMessage).toBe("Release v1.5.0");
    expect(content.version).toBe("1.5.0");
    expect(content.changelogFile).toBe("CHANGELOG.md");
  });

  it("deletes every pending changeset, none included, and never writes bot changesets", () => {
    expect(content.deletePaths).toEqual([
      ".launchset/brave-lions-sing.md",
      ".launchset/calm-cats-nap.md",
      ".launchset/quiet-docs.md",
    ]);
    expect(content.generatedChangesets).toEqual([botChangeset(botPrs[0] as (typeof botPrs)[0])]);
    expect(content.generatedChangesets[0]).toMatchObject({ bump: "patch", source: "bot", pr: 131 });
  });

  it("renders the changelog section with PR links, authors and Dependencies", () => {
    expect(content.section).toBe(
      [
        "## 1.5.0 (2026-11-18)",
        "",
        "### Minor changes",
        "- Add offline mode. ([#123](https://github.com/demonsters/app/pull/123), @someone)",
        "",
        "### Patch changes",
        "- Fix the login crash. ([#130](https://github.com/demonsters/app/pull/130))",
        "",
        "  It happened on slow networks.",
        "",
        "### Dependencies",
        "- Bump react-native from 0.76.1 to 0.76.3 ([#131](https://github.com/demonsters/app/pull/131))",
        "",
      ].join("\n"),
    );
  });

  it("writes the body: note with auto targets, section, manual targets and the marker", () => {
    expect(content.body.startsWith(RELEASE_PR_MARKER)).toBe(true);
    expect(content.body).toContain(
      "Merging this PR releases **v1.5.0** (minor) from `main`: it builds and ships every auto target (`docker-api`, `web` and `android`).",
    );
    expect(content.body).toContain(content.section.trimEnd());
    expect(content.body).toContain("### Manual targets");
    expect(content.body).toContain("- `ios`: 1.3.0 (1 release behind)");
    expect(content.manualTargets).toEqual([
      { target: "ios", lastShipped: "1.3.0", releasesBehind: 1 },
    ]);
    expect(content.autoTargets).toEqual(["docker-api", "web", "android"]);
  });

  it("leaves out links with changelog.links: false", () => {
    const noGithub = makeConfig({ changelog: { links: false } });
    const result = buildReleasePr({
      config: noGithub,
      plan: plan({ config: noGithub, changesets: pending, botPrs }),
      changesets: pending,
      botPrs,
      origins: new Map([[".launchset/brave-lions-sing.md", { pr: 123, author: "someone" }]]),
      tags: tags(noGithub, []),
      now: NOW,
    });
    expect(result.section).toContain("- Add offline mode.\n");
    expect(result.section).toContain("- Bump react-native from 0.76.1 to 0.76.3 (#131)");
    expect(result.body).toContain("- `ios`: never shipped");
  });

  it("uses the maintenance branch as base", () => {
    const fixes = [changeset("fix", "patch", "Fix it.")];
    const maintenancePlan = plan({
      branch: "release/1.4.x",
      version: "1.4.1",
      tags: tags(config, ["v1.4.1"]),
      changesets: fixes,
    });
    const result = buildReleasePr({
      config,
      plan: maintenancePlan,
      changesets: fixes,
      botPrs: [],
      tags: tags(config, ["v1.4.1"]),
      now: NOW,
    });
    expect(result.base).toBe("release/1.4.x");
    expect(result.branch).toBe("launchset/release/release/1.4.x");
    expect(result.title).toBe("Release v1.4.2");
  });

  it("skips bot PRs that already have a changeset", () => {
    const withPr = { ...changeset("bot", "patch", "Bump x"), pr: 131 };
    const result = buildReleasePr({
      config,
      plan: plan({ changesets: [withPr], botPrs }),
      changesets: [withPr],
      botPrs,
      tags: tags(config, []),
      now: NOW,
    });
    expect(result.generatedChangesets).toEqual([]);
  });

  it("needs a release-pr plan", () => {
    expect(() =>
      buildReleasePr({
        config,
        plan: plan(),
        changesets: [],
        botPrs: [],
        tags: tags(config, []),
        now: NOW,
      }),
    ).toThrow(LaunchsetError);
  });

  it("has a close comment", () => {
    expect(releasePrCloseComment("main")).toContain("no changesets are pending on `main`");
  });
});
