import { describe, expect, it } from "vitest";
import { findPreviewBranch, isMaintenanceBranch, matchBranch } from "../../src/core/branches.ts";
import { resolveConfig } from "../../src/core/config/schema.ts";

describe("matchBranch", () => {
  it("matches globs where * doesn't cross /", () => {
    expect(matchBranch("feature/x", "feature/*")).toBe(true);
    expect(matchBranch("feature/x/y", "feature/*")).toBe(false);
    expect(matchBranch("feature/x/y", "feature/**")).toBe(true);
  });
});

describe("findPreviewBranch", () => {
  const config = resolveConfig({
    preview: {
      branches: [
        "develop",
        { branch: "feature/*", targets: ["web"] },
        { branch: "next/*", prerelease: "alpha" },
        "release/**",
      ],
    },
    targets: { web: { type: "web" } },
  });

  it("returns the first matching entry", () => {
    expect(findPreviewBranch(config, "develop")).toEqual({ branch: "develop" });
    expect(findPreviewBranch(config, "feature/login")).toEqual({
      branch: "feature/*",
      targets: ["web"],
    });
    expect(findPreviewBranch(config, "next/new-form")).toEqual({
      branch: "next/*",
      prerelease: "alpha",
    });
    expect(findPreviewBranch(config, "main")).toBeNull();
  });

  it("never auto-previews maintenance branches", () => {
    expect(findPreviewBranch(config, "release/1.4.x")).toBeNull();
    expect(findPreviewBranch(config, "release/other")).toEqual({ branch: "release/**" });
    // Not a maintenance branch (no <major>.<minor>), so it previews like any other branch.
    expect(findPreviewBranch(config, "release/foo.x")).toEqual({ branch: "release/**" });
  });

  it("returns null when previews are disabled", () => {
    expect(
      findPreviewBranch(
        resolveConfig({ preview: false, targets: { web: { type: "web" } } }),
        "develop",
      ),
    ).toBeNull();
  });
});

describe("isMaintenanceBranch", () => {
  it("needs a <major>.<minor> in place of the *", () => {
    const config = { maintenanceBranches: "release/*.x" };
    expect(isMaintenanceBranch(config, "release/1.4.x")).toBe(true);
    expect(isMaintenanceBranch(config, "release/foo.x")).toBe(false);
    expect(isMaintenanceBranch(config, "release/1.x")).toBe(false);
    expect(isMaintenanceBranch(config, "main")).toBe(false);
    expect(isMaintenanceBranch({ maintenanceBranches: "hotfix/*" }, "hotfix/2.0")).toBe(true);
  });
});
