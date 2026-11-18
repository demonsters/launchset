import { describe, expect, it } from "vitest";
import { LaunchsetError } from "../../src/core/errors.ts";
import { indexTags, prereleaseVersions, takenVersions } from "../../src/core/tags.ts";
import {
  assertInLine,
  baseVersionOf,
  branchPreviewVersion,
  branchSlug,
  distTag,
  highestBump,
  isPlainVersion,
  maintenanceBranchName,
  maintenanceViolations,
  marketingVersion,
  nextFreeVersion,
  nextPrereleaseNumber,
  nextVersion,
  parseMaintenanceBranch,
  prereleaseVersion,
  previewBaseVersion,
  prPreviewVersion,
  releaseBump,
  releaseVersion,
} from "../../src/core/versions.ts";

const TAGS = {
  release: "v{version}",
  marker: "launchset/{target}@{version}",
  partial: "launchset/partial/{version}",
};

describe("bumps (4.3)", () => {
  it("takes the highest bump", () => {
    expect(highestBump(["patch", "major", "minor"])).toBe("major");
    expect(highestBump(["none", "patch"])).toBe("patch");
    expect(highestBump(["none", "none"])).toBe("none");
    expect(highestBump([])).toBe("none");
  });

  it("has no release when only none changesets are pending", () => {
    expect(releaseBump([{ bump: "none" }, { bump: "none" }])).toBeNull();
    expect(releaseBump([])).toBeNull();
    expect(releaseBump([{ bump: "none" }, { bump: "minor" }, { bump: "patch" }])).toBe("minor");
  });
});

describe("nextVersion", () => {
  it("increments like semver.inc", () => {
    expect(nextVersion("1.4.0", "patch")).toBe("1.4.1");
    expect(nextVersion("1.4.3", "minor")).toBe("1.5.0");
    expect(nextVersion("1.4.3", "major")).toBe("2.0.0");
    expect(nextVersion("0.3.1", "major")).toBe("1.0.0");
    expect(nextVersion("1.4.0", "none")).toBe("1.4.0");
  });

  it("rejects a version that isn't plain X.Y.Z", () => {
    expect(() => nextVersion("v1.4.0", "patch")).toThrow(LaunchsetError);
    expect(() => nextVersion("1.4", "patch")).toThrow('"1.4" is not a plain X.Y.Z version');
    expect(() => nextVersion("1.5.0-alpha.1", "patch")).toThrow(/plain X\.Y\.Z/);
  });
});

describe("nextFreeVersion (8.1)", () => {
  it("skips a version a hotfix released: 1.4.1 taken → 1.4.2", () => {
    const index = indexTags(["v1.4.0", "v1.4.1"], { tags: TAGS });
    expect(nextFreeVersion(nextVersion("1.4.0", "patch"), takenVersions(index))).toBe("1.4.2");
  });

  it("skips versions that have only marker tags (an unfinished release)", () => {
    const index = indexTags(["v1.4.0", "launchset/android@1.4.1", "launchset/partial/1.4.2"], {
      tags: TAGS,
    });
    expect(nextFreeVersion("1.4.1", takenVersions(index))).toBe("1.4.3");
  });

  it("ignores prerelease tags", () => {
    const index = indexTags(["v1.4.0", "v1.5.0-alpha.0", "v1.5.0-alpha.1"], { tags: TAGS });
    expect(nextFreeVersion("1.5.0", takenVersions(index))).toBe("1.5.0");
  });

  it("accepts a predicate", () => {
    expect(nextFreeVersion("2.0.0", (v) => v === "2.0.0" || v === "2.0.1")).toBe("2.0.2");
  });

  it("returns the version itself when it's free", () => {
    expect(nextFreeVersion("1.5.0", new Set(["1.4.0"]))).toBe("1.5.0");
  });
});

describe("maintenance branches (8.2)", () => {
  it("parses the line from the default pattern", () => {
    expect(parseMaintenanceBranch("release/1.4.x")).toEqual({ major: 1, minor: 4 });
    expect(parseMaintenanceBranch("release/10.20.x")).toEqual({ major: 10, minor: 20 });
    expect(parseMaintenanceBranch("release/1.x")).toBeNull();
    expect(parseMaintenanceBranch("release/1.4.x/foo")).toBeNull();
    expect(parseMaintenanceBranch("main")).toBeNull();
    expect(parseMaintenanceBranch("release/01.4.x")).toBeNull();
    expect(parseMaintenanceBranch("releasex1.4.x")).toBeNull();
  });

  it("supports custom patterns with regex metacharacters", () => {
    expect(parseMaintenanceBranch("hotfix/v1.4", "hotfix/v*")).toEqual({ major: 1, minor: 4 });
    expect(parseMaintenanceBranch("maint+1.4.(x)", "maint+*.(x)")).toEqual({ major: 1, minor: 4 });
    expect(parseMaintenanceBranch("maintx1.4.(x)", "maint+*.(x)")).toBeNull();
  });

  it("rejects a pattern without exactly one *", () => {
    expect(() => parseMaintenanceBranch("release/1.4.x", "release/x")).toThrow(/exactly one "\*"/);
    expect(() => maintenanceBranchName({ major: 1, minor: 4 }, "*/*")).toThrow(/exactly one/);
  });

  it("builds the branch name", () => {
    expect(maintenanceBranchName({ major: 1, minor: 4 })).toBe("release/1.4.x");
    expect(maintenanceBranchName({ major: 2, minor: 0 }, "hotfix/*")).toBe("hotfix/2.0");
  });

  it("allows only patch and none changesets, saying where the change belongs", () => {
    const violations = maintenanceViolations(
      [
        { path: ".launchset/a.md", bump: "patch" },
        { path: ".launchset/b.md", bump: "minor" },
        { path: ".launchset/c.md", bump: "none" },
        { path: ".launchset/d.md", bump: "major" },
      ],
      "release/1.4.x",
      "main",
    );
    expect(violations.map((v) => [v.path, v.bump])).toEqual([
      [".launchset/b.md", "minor"],
      [".launchset/d.md", "major"],
    ]);
    expect(violations[0]?.message).toBe(
      '.launchset/b.md: bump "minor" isn\'t allowed on the maintenance branch release/1.4.x (only patch and none). A minor change belongs on main: open this PR against main instead.',
    );
  });

  it("computes the release version on a maintenance line, skipping taken versions", () => {
    const maintenance = {
      line: { major: 1, minor: 4 },
      branch: "release/1.4.x",
      baseBranch: "main",
    };
    expect(releaseVersion({ current: "1.4.1", bump: "patch", taken: new Set(), maintenance })).toBe(
      "1.4.2",
    );
    expect(
      releaseVersion({ current: "1.4.1", bump: "patch", taken: new Set(["1.4.2"]), maintenance }),
    ).toBe("1.4.3");
  });

  it("rejects minor/major on a maintenance line", () => {
    const maintenance = {
      line: { major: 1, minor: 4 },
      branch: "release/1.4.x",
      baseBranch: "main",
    };
    expect(() =>
      releaseVersion({ current: "1.4.1", bump: "minor", taken: new Set(), maintenance }),
    ).toThrow('bump "minor" isn\'t allowed on the maintenance branch release/1.4.x');
  });

  it("errors when the version leaves the line", () => {
    const maintenance = {
      line: { major: 1, minor: 4 },
      branch: "release/1.4.x",
      baseBranch: "main",
    };
    expect(() =>
      releaseVersion({ current: "1.5.0", bump: "patch", taken: new Set(), maintenance }),
    ).toThrow("version 1.5.1 is outside the 1.4 line of the maintenance branch release/1.4.x");
    expect(() => assertInLine("1.4.9", { major: 1, minor: 4 }, "release/1.4.x")).not.toThrow();
  });

  it("computes the base-branch release version", () => {
    expect(releaseVersion({ current: "1.4.0", bump: "patch", taken: new Set(["1.4.1"]) })).toBe(
      "1.4.2",
    );
    expect(releaseVersion({ current: "1.4.0", bump: "minor", taken: new Set(["1.4.1"]) })).toBe(
      "1.5.0",
    );
  });
});

describe("preview versions (8.3)", () => {
  it("uses the changesets' bump, or a patch bump when nothing is pending", () => {
    expect(previewBaseVersion({ current: "1.4.0", bump: "minor" })).toBe("1.5.0");
    expect(previewBaseVersion({ current: "1.4.0", bump: null })).toBe("1.4.1");
    expect(previewBaseVersion({ current: "1.4.0", bump: "none" })).toBe("1.4.1");
    expect(previewBaseVersion({ current: "1.4.0", bump: null, taken: new Set(["1.4.1"]) })).toBe(
      "1.4.2",
    );
  });

  it("builds PR and branch preview versions", () => {
    expect(prPreviewVersion("1.5.0", 123, 4)).toBe("1.5.0-pr.123.4");
    expect(branchPreviewVersion("1.5.0", "develop", 17)).toBe("1.5.0-develop.17");
    expect(branchPreviewVersion("1.5.0", branchSlug("feature/New_Form"), 2)).toBe(
      "1.5.0-feature-new-form.2",
    );
  });

  it("rejects bad inputs", () => {
    expect(() => prPreviewVersion("1.5.0", 0, 4)).toThrow("PR number must be an integer >= 1");
    expect(() => prPreviewVersion("1.5.0", 1, 1.5)).toThrow("run number");
    expect(() => branchPreviewVersion("1.5.0", "", 1)).toThrow(/no letters or digits/);
    expect(() => branchPreviewVersion("1.5.0", "007", 1)).toThrow(/not a valid semver version/);
    expect(branchPreviewVersion("1.5.0", branchSlug("007"), 1)).toBe("1.5.0-b-007.1");
    expect(() => prPreviewVersion("1.5.0-alpha.1", 1, 1)).toThrow(/plain X\.Y\.Z/);
  });
});

describe("prerelease versions (9.9)", () => {
  it("starts at 0", () => {
    expect(nextPrereleaseNumber("1.5.0", "alpha", [])).toBe(0);
    expect(prereleaseVersion("1.5.0", "alpha", 0)).toBe("1.5.0-alpha.0");
  });

  it("counts one past the highest existing number, gaps are fine", () => {
    const index = indexTags(
      ["v1.4.0", "v1.5.0-alpha.0", "v1.5.0-alpha.3", "v1.5.0-beta.7", "v1.4.1-alpha.9"],
      { tags: TAGS },
    );
    const existing = prereleaseVersions(index);
    expect(nextPrereleaseNumber("1.5.0", "alpha", existing)).toBe(4);
    expect(nextPrereleaseNumber("1.5.0", "beta", existing)).toBe(8);
    expect(nextPrereleaseNumber("1.5.0", "rc", existing)).toBe(0);
    expect(nextPrereleaseNumber("1.6.0", "alpha", existing)).toBe(0);
  });

  it("only counts exact {next}-{preid}.<n> versions", () => {
    expect(
      nextPrereleaseNumber("1.5.0", "alpha", [
        "1.5.0-alpha.2.1",
        "1.5.0-alphabet.5",
        "1.5.0-alpha.x",
      ]),
    ).toBe(0);
    expect(nextPrereleaseNumber("1.5.0", "alpha", ["1.5.0-alpha.10", "1.5.0-alpha.9"])).toBe(11);
  });

  it("never counts prerelease tags as releases", () => {
    const index = indexTags(["v1.5.0-alpha.0"], { tags: TAGS });
    expect(index.releases.size).toBe(0);
    expect(index.prereleases.get("1.5.0-alpha.0")).toBe("v1.5.0-alpha.0");
  });
});

describe("branchSlug", () => {
  it.each([
    ["develop", "develop"],
    ["next/new-form", "next-new-form"],
    ["Feature/JIRA-123_Login Screen", "feature-jira-123-login-screen"],
    ["--weird--//name--", "weird-name"],
    ["a".repeat(40), "a".repeat(30)],
    [`${"a".repeat(29)}/b`, "a".repeat(29)],
    ["dependabot/npm_and_yarn/react-18.3.1", "dependabot-npm-and-yarn-react"],
    ["v2.0/hotfix", "v2-0-hotfix"],
    ["___", ""],
    ["007", "b-007"],
    ["01", "b-01"],
    ["123/456", "123-456"],
    ["1".repeat(40), `b-${"1".repeat(28)}`],
  ])("%s → %s", (input, expected) => {
    const slug = branchSlug(input);
    expect(slug).toBe(expected);
    expect(slug).toMatch(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)?$/);
    expect(slug.length).toBeLessThanOrEqual(30);
  });
});

describe("distTag (10)", () => {
  it("covers every channel", () => {
    expect(distTag({ channel: "release", version: "1.5.0", maintenance: false })).toBe("latest");
    expect(distTag({ channel: "release", version: "1.4.2", maintenance: true })).toBe(
      "release-1.4",
    );
    expect(distTag({ channel: "prerelease", preid: "alpha" })).toBe("alpha");
    expect(distTag({ channel: "preview", prNumber: 123 })).toBe("pr-123");
    expect(distTag({ channel: "preview", branchSlug: "develop" })).toBe("develop");
    expect(() => distTag({ channel: "preview" })).toThrow(/PR number or a branch slug/);
  });
});

describe("helpers", () => {
  it("iOS gets the plain base version, other targets the full version", () => {
    expect(marketingVersion("ios", "1.5.0-pr.123.4")).toBe("1.5.0");
    expect(marketingVersion("ios", "1.5.0")).toBe("1.5.0");
    expect(marketingVersion("android", "1.5.0-pr.123.4")).toBe("1.5.0-pr.123.4");
    expect(marketingVersion("docker", "1.5.0-alpha.3")).toBe("1.5.0-alpha.3");
  });

  it("base version and plain check", () => {
    expect(baseVersionOf("1.5.0-alpha.3")).toBe("1.5.0");
    expect(() => baseVersionOf("nope")).toThrow(/not a valid semver/);
    expect(isPlainVersion("1.5.0")).toBe(true);
    expect(isPlainVersion("1.5.0-alpha.3")).toBe(false);
    expect(isPlainVersion("01.5.0")).toBe(false);
    expect(isPlainVersion("1.5.0+build")).toBe(false);
  });
});
