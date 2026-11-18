import { describe, expect, it } from "vitest";
import {
  type ManualTargetEntry,
  mergeManualTargets,
  parseManualTargets,
  partialReleaseTitle,
  renderManualTargets,
  renderPartialReleaseBody,
  renderReleaseBody,
  upsertManualTargets,
} from "../../src/core/release-notes.ts";

const shipped: ManualTargetEntry = {
  target: "ios",
  shipped: true,
  buildNumber: 217,
  date: "2026-11-18",
};
const notShipped: ManualTargetEntry = { target: "macos", shipped: false };

describe("manual targets block (9.3, 9.8)", () => {
  it("renders between hidden markers and parses back", () => {
    const block = renderManualTargets([shipped, notShipped], "1.5.0");
    expect(block).toContain("### Manual targets");
    expect(block).toContain("- `ios`: shipped 2026-11-18, build 217");
    expect(block).toContain(
      "- `macos`: not shipped yet (ship it with a release workflow run with target `macos` and version `1.5.0`)",
    );
    expect(block.startsWith("<!-- launchset:manual-targets {")).toBe(true);
    expect(block.endsWith("<!-- /launchset:manual-targets -->")).toBe(true);
    expect(parseManualTargets(`Notes\n\n${block}\n`)).toEqual([shipped, notShipped]);
  });

  it("returns null without a block and [] for a broken marker", () => {
    expect(parseManualTargets("Just notes")).toBeNull();
    expect(
      parseManualTargets(
        "<!-- launchset:manual-targets {oops -->\nx\n<!-- /launchset:manual-targets -->",
      ),
    ).toEqual([]);
  });

  it("replaces the block in place and is idempotent", () => {
    const body = renderReleaseBody({
      version: "1.5.0",
      section: "### Minor changes\n- Add offline mode.",
      changelogFile: "CHANGELOG.md",
      manualTargets: [{ target: "ios", shipped: false }],
    });
    const updated = upsertManualTargets(body, [shipped], "1.5.0");
    expect(updated).toContain(
      "### Minor changes\n- Add offline mode.\n\n<!-- launchset:manual-targets",
    );
    expect(updated).toContain("- `ios`: shipped 2026-11-18, build 217");
    expect(updated).not.toContain("not shipped yet");
    expect(upsertManualTargets(updated, [shipped], "1.5.0")).toBe(updated);
  });

  it("keeps text after the block (hand edits) and handles CRLF bodies", () => {
    const body = `Notes\r\n\r\n${renderManualTargets([notShipped])}\r\n\r\nThanks!`;
    const updated = upsertManualTargets(body, [
      { target: "macos", shipped: true, buildNumber: null, date: "2026-11-20" },
    ]);
    expect(updated).toContain("- `macos`: shipped 2026-11-20\n");
    expect(updated.endsWith("Thanks!")).toBe(true);
  });

  it("appends a block when there is none", () => {
    expect(upsertManualTargets("Notes", [notShipped])).toMatch(
      /^Notes\n\n<!-- launchset:manual-targets/,
    );
    expect(upsertManualTargets("Notes", [])).toBe("Notes");
  });

  it("merges by rank: shipped with date > shipped > not shipped; earlier list wins ties", () => {
    const later: ManualTargetEntry = {
      target: "ios",
      shipped: true,
      buildNumber: 999,
      date: "2026-12-01",
    };
    const derived: ManualTargetEntry = {
      target: "ios",
      shipped: true,
      buildNumber: null,
      date: null,
    };
    expect(mergeManualTargets([[shipped], [later]], ["ios"])).toEqual([shipped]);
    expect(
      mergeManualTargets([[{ target: "ios", shipped: false }], [later], [derived]], ["ios"]),
    ).toEqual([later]);
    expect(mergeManualTargets([[], [], [derived]], ["ios"])).toEqual([derived]);
    expect(
      mergeManualTargets([[notShipped], [{ target: "ios", shipped: false }]], ["ios"]),
    ).toEqual([{ target: "ios", shipped: false }, notShipped]);
  });
});

describe("partial releases (9.6)", () => {
  it("titles and describes a superseded release", () => {
    expect(partialReleaseTitle("v1.4.0", "v1.4.1")).toBe("v1.4.0 (partial, superseded by v1.4.1)");
    const body = renderPartialReleaseBody({
      version: "1.4.0",
      tag: "v1.4.0",
      supersededBy: "v1.4.1",
      shipped: ["web"],
      missing: ["android", "docker-api"],
      section: "### Patch changes\n- Fix.",
      changelogFile: "CHANGELOG.md",
    });
    expect(body).toContain("v1.4.1 superseded it");
    expect(body).toContain("- Shipped: `web`");
    expect(body).toContain("- Not shipped: `android` and `docker-api`");
    expect(body.endsWith("### Patch changes\n- Fix.")).toBe(true);
  });

  it("notes a missing changelog section", () => {
    expect(
      renderReleaseBody({
        version: "1.5.0",
        section: null,
        changelogFile: "CHANGELOG.md",
        manualTargets: [],
      }),
    ).toBe("_No section for 1.5.0 in CHANGELOG.md._");
  });
});
