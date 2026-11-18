import { describe, expect, it } from "vitest";
import {
  type ChangelogEntry,
  extractSection,
  findHeadings,
  findVersionHeadings,
  hasSection,
  headingVersion,
  insertSection,
  insertSectionSorted,
  renderSection,
} from "../../src/core/changelog.ts";
import type { Bump } from "../../src/core/types.ts";

const entry = (
  bump: Bump,
  summary: string,
  extra: Partial<ChangelogEntry> = {},
): ChangelogEntry => ({
  changeset: { bump, summary },
  ...extra,
});

const SECTION = "## 1.5.0 (2026-11-18)\n\n### Minor changes\n- Add offline mode.\n";

describe("renderSection", () => {
  it("renders the spec example", () => {
    const text = renderSection({
      version: "1.5.0",
      date: "2026-11-18",
      repository: "org/repo",
      entries: [
        entry("minor", "Add offline mode to the mobile app.", { pr: 123, author: "someone" }),
        entry("patch", "Fix crash on the login screen.", { pr: 130 }),
        {
          changeset: {
            bump: "patch",
            summary: "Bump react-native from 0.76.1 to 0.76.3",
            source: "bot",
            pr: 131,
          },
          author: "dependabot[bot]",
        },
        entry("major", "Drop Android 7."),
      ],
    });
    expect(text).toBe(
      [
        "## 1.5.0 (2026-11-18)",
        "",
        "### Major changes",
        "- Drop Android 7.",
        "",
        "### Minor changes",
        "- Add offline mode to the mobile app. ([#123](https://github.com/org/repo/pull/123), @someone)",
        "",
        "### Patch changes",
        "- Fix crash on the login screen. ([#130](https://github.com/org/repo/pull/130))",
        "",
        "### Dependencies",
        "- Bump react-native from 0.76.1 to 0.76.3 ([#131](https://github.com/org/repo/pull/131))",
        "",
      ].join("\n"),
    );
  });

  it("leaves out empty groups and none changesets", () => {
    expect(
      renderSection({
        version: "1.4.1",
        date: new Date("2026-11-18T23:59:00Z"),
        entries: [entry("none", "Docs only."), entry("patch", "Fix.")],
      }),
    ).toBe("## 1.4.1 (2026-11-18)\n\n### Patch changes\n- Fix.\n");
  });

  it("indents the rest of a multi-line summary under the bullet", () => {
    expect(
      renderSection({
        version: "1.5.0",
        date: "2026-11-18",
        repository: "org/repo",
        entries: [
          entry(
            "minor",
            "Add offline mode.\r\n\r\nWorks on:\n- Android\n- iOS\n\n```ts\nsync();\n```",
            {
              pr: 9,
              author: "@dev",
            },
          ),
          entry("minor", "Second."),
        ],
      }),
    ).toBe(
      [
        "## 1.5.0 (2026-11-18)",
        "",
        "### Minor changes",
        "- Add offline mode. ([#9](https://github.com/org/repo/pull/9), @dev)",
        "",
        "  Works on:",
        "  - Android",
        "  - iOS",
        "",
        "  ```ts",
        "  sync();",
        "  ```",
        "- Second.",
        "",
      ].join("\n"),
    );
  });

  it("writes PR numbers without links when the repository is unknown, and nothing without info", () => {
    const text = renderSection({
      version: "1.0.0",
      date: "2026-11-18",
      entries: [entry("patch", "A.", { pr: 5, author: "x" }), entry("patch", "B.")],
    });
    expect(text).toContain("- A. (#5, @x)\n- B.\n");
  });

  it("uses the changeset's own pr and a custom server URL", () => {
    expect(
      renderSection({
        version: "1.0.0",
        date: "2026-11-18",
        repository: "org/repo",
        serverUrl: "https://github.example.com/",
        entries: [{ changeset: { bump: "patch", summary: "A.", pr: 7 } }],
      }),
    ).toContain("- A. ([#7](https://github.example.com/org/repo/pull/7))");
  });

  it("rejects a malformed date string", () => {
    expect(() => renderSection({ version: "1.0.0", date: "18-11-2026", entries: [] })).toThrow(
      /expected a date like 2026-11-18/,
    );
  });
});

describe("version headings", () => {
  it.each([
    ["1.5.0 (2026-11-18)", "1.5.0"],
    ["0.18.0", "0.18.0"],
    ["[v3.5.6](https://github.com/org/repo/compare/v3.5.5...v3.5.6) - 2023-01-02", "3.5.6"],
    ["v2.0.0", "2.0.0"],
    ["1.5.0-alpha.2", "1.5.0-alpha.2"],
    ["[1.0.0]", "1.0.0"],
    ["Unreleased", null],
    ["Changelog", null],
    ["@scope/pkg@1.2.0", null],
    ["1.5", null],
    ["Version 1.5.0", null],
  ])("%s → %s", (text, expected) => {
    expect(headingVersion(text)).toBe(expected);
  });

  it("ignores headings inside fenced code blocks and finds setext titles", () => {
    const text = "Changelog\n=========\n\n```md\n## 9.9.9\n```\n\n## 1.0.0\n";
    expect(findHeadings(text).map((h) => [h.level, h.text])).toEqual([
      [1, "Changelog"],
      [2, "1.0.0"],
    ]);
    expect(findVersionHeadings(text).map((h) => h.version)).toEqual(["1.0.0"]);
    expect(hasSection(text, "1.0.0")).toBe(true);
    expect(hasSection(text, "9.9.9")).toBe(false);
  });
});

describe("insertSection", () => {
  it("creates a new changelog with a title", () => {
    expect(insertSection(null, SECTION)).toBe(`# Changelog\n\n${SECTION}`);
    expect(insertSection("", SECTION)).toBe(`# Changelog\n\n${SECTION}`);
    expect(insertSection("\n\n", SECTION)).toBe(`# Changelog\n\n${SECTION}`);
  });

  it("inserts before the first version heading of a launchset changelog", () => {
    const existing = "# Changelog\n\n## 1.4.0 (2026-10-01)\n\n### Patch changes\n- Old.\n";
    expect(insertSection(existing, SECTION)).toBe(
      `# Changelog\n\n${SECTION}\n## 1.4.0 (2026-10-01)\n\n### Patch changes\n- Old.\n`,
    );
  });

  it("inserts into a Changesets-style changelog, keeping everything else byte for byte", () => {
    const existing = [
      "# @demonsters/app",
      "",
      "## 0.18.0",
      "",
      "### Minor Changes",
      "",
      "- 1a2b3c4: Add things",
      "",
      "## 0.17.2",
      "",
      "### Patch Changes",
      "",
      "- 5d6e7f8: Fix things",
      "",
    ].join("\n");
    const result = insertSection(existing, SECTION);
    expect(result).toBe(
      `# @demonsters/app\n\n${SECTION}\n${existing.slice("# @demonsters/app\n\n".length)}`,
    );
    expect(result.endsWith(existing.slice(existing.indexOf("## 0.18.0")))).toBe(true);
  });

  it("inserts into an auto-changelog file, keeping the preamble at the top", () => {
    const existing = [
      "### Changelog",
      "",
      "All notable changes to this project will be documented in this file. Dates are displayed in UTC.",
      "",
      "Generated by [`auto-changelog`](https://github.com/CookPete/auto-changelog).",
      "",
      "#### [v3.5.6](https://github.com/org/repo/compare/v3.5.5...v3.5.6)",
      "",
      "> 2 January 2023",
      "",
      "- Fix the thing [`#42`](https://github.com/org/repo/pull/42)",
      "",
    ].join("\n");
    const at = existing.indexOf("#### [v3.5.6]");
    expect(insertSection(existing, SECTION)).toBe(
      `${existing.slice(0, at)}${SECTION}\n${existing.slice(at)}`,
    );
  });

  it("accepts mixed styles: launchset sections above old Changesets sections", () => {
    const existing = [
      "# Changelog",
      "",
      "## 1.4.0 (2026-10-01)",
      "",
      "### Patch changes",
      "- New style.",
      "",
      "## 0.18.0",
      "",
      "### Minor Changes",
      "",
      "- 1a2b3c4: Old style",
      "",
    ].join("\n");
    const result = insertSection(existing, SECTION);
    expect(result.indexOf("## 1.5.0")).toBeLessThan(result.indexOf("## 1.4.0"));
    expect(result.endsWith(existing.slice(existing.indexOf("## 1.4.0")))).toBe(true);
  });

  it("goes after the title when there is no version heading", () => {
    expect(insertSection("# Changelog\n", SECTION)).toBe(`# Changelog\n\n${SECTION}`);
    expect(insertSection("# Changelog", SECTION)).toBe(`# Changelog\n\n${SECTION}`);
    expect(insertSection("# Changelog\n\nNothing yet.\n", SECTION)).toBe(
      `# Changelog\n\n${SECTION}\nNothing yet.\n`,
    );
  });

  it("goes at the top when there is no heading", () => {
    expect(insertSection("Some notes.\n", SECTION)).toBe(`${SECTION}\nSome notes.\n`);
  });

  it("keeps CRLF line endings", () => {
    const existing = "# Changelog\r\n\r\n## 1.4.0\r\n\r\n- Old.\r\n";
    const result = insertSection(existing, SECTION);
    expect(result).toBe(
      "# Changelog\r\n\r\n## 1.5.0 (2026-11-18)\r\n\r\n### Minor changes\r\n- Add offline mode.\r\n\r\n## 1.4.0\r\n\r\n- Old.\r\n",
    );
    expect(result.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("adds a blank line when the line before the heading isn't blank", () => {
    expect(insertSection("# Changelog\n## 1.4.0\n- Old.\n", SECTION)).toBe(
      `# Changelog\n\n${SECTION}\n## 1.4.0\n- Old.\n`,
    );
  });
});

describe("insertSectionSorted (backport, 9.5)", () => {
  const main = [
    "# Changelog",
    "",
    "## 1.5.0 (2026-11-18)",
    "",
    "- Five.",
    "",
    "## 1.5.0-alpha.2",
    "",
    "- Alpha.",
    "",
    "## Unreleased notes",
    "",
    "## 1.4.0 (2026-10-01)",
    "",
    "- Four.",
    "",
    "## 1.3.0",
    "",
    "- Three.",
    "",
  ].join("\n");
  const section = (v: string) => `## ${v} (2026-11-20)\n\n### Patch changes\n- Fix.\n`;

  it("places a hotfix between its neighbours", () => {
    const result = insertSectionSorted(main, section("1.4.1"), "1.4.1");
    const at = main.indexOf("## 1.4.0");
    expect(result).toBe(`${main.slice(0, at)}${section("1.4.1")}\n${main.slice(at)}`);
  });

  it("sorts prerelease headings before their release, skipping unparsable headings", () => {
    const result = insertSectionSorted(main, section("1.5.0-beta.1"), "1.5.0-beta.1");
    const headings = findVersionHeadings(result).map((h) => h.version);
    expect(headings).toEqual(["1.5.0", "1.5.0-beta.1", "1.5.0-alpha.2", "1.4.0", "1.3.0"]);
  });

  it("puts the newest version at the first version heading", () => {
    const result = insertSectionSorted(main, section("1.6.0"), "1.6.0");
    expect(findVersionHeadings(result)[0]?.version).toBe("1.6.0");
    expect(result.startsWith("# Changelog\n\n## 1.6.0")).toBe(true);
  });

  it("appends after the last version section when it's the oldest", () => {
    const withFooter = `${main}## Older\n\nSee the wiki.\n`;
    const result = insertSectionSorted(main, section("1.2.9"), "1.2.9");
    expect(result).toBe(`${main}\n${section("1.2.9")}`);
    expect(insertSectionSorted(withFooter, section("1.2.9"), "1.2.9")).toBe(
      `${main}\n${section("1.2.9")}\n## Older\n\nSee the wiki.\n`,
    );
  });

  it("is idempotent when the section already exists", () => {
    expect(insertSectionSorted(main, section("1.4.0"), "1.4.0")).toBe(main);
  });

  it("falls back to insertSection without version headings", () => {
    expect(insertSectionSorted("# Changelog\n", section("1.4.1"), "1.4.1")).toBe(
      `# Changelog\n\n${section("1.4.1")}`,
    );
    expect(insertSectionSorted(null, section("1.4.1"), "1.4.1")).toBe(
      `# Changelog\n\n${section("1.4.1")}`,
    );
  });

  it("works with auto-changelog headings at another level", () => {
    const auto = "### Changelog\n\n#### [v1.5.0](url)\n\n- a\n\n#### [v1.4.0](url)\n\n- b\n";
    const result = insertSectionSorted(auto, section("1.4.1"), "1.4.1");
    expect(findVersionHeadings(result).map((h) => h.version)).toEqual(["1.5.0", "1.4.1", "1.4.0"]);
  });
});

describe("extractSection", () => {
  const text = [
    "# Changelog",
    "",
    "## 1.5.0 (2026-11-18)",
    "",
    "### Minor changes",
    "- Add offline mode.",
    "",
    "### Patch changes",
    "- Fix.",
    "",
    "## 1.4.0",
    "",
    "- Old.",
    "",
  ].join("\r\n");

  it("returns the body without the heading, up to the next heading of the same level", () => {
    expect(extractSection(text, "1.5.0")).toBe(
      "### Minor changes\n- Add offline mode.\n\n### Patch changes\n- Fix.",
    );
    expect(extractSection(text, "1.4.0")).toBe("- Old.");
  });

  it("returns null when the version has no section", () => {
    expect(extractSection(text, "1.3.0")).toBeNull();
  });

  it("round-trips with renderSection + insertSection", () => {
    const rendered = renderSection({
      version: "2.0.0",
      date: "2026-11-18",
      entries: [entry("major", "Big change.")],
    });
    expect(extractSection(insertSection(text, rendered), "2.0.0")).toBe(
      "### Major changes\n- Big change.",
    );
  });
});

describe("review regressions", () => {
  it("extractSection stops at the next version heading of a deeper level (auto-changelog)", () => {
    const auto = [
      "### Changelog",
      "",
      "#### [v3.5.6](https://github.com/org/repo/compare/v3.5.5...v3.5.6)",
      "",
      "- Old fix.",
      "",
      "#### [v3.5.5](https://github.com/org/repo/compare/v3.5.4...v3.5.5)",
      "",
      "- Older fix.",
      "",
    ].join("\n");
    const updated = insertSection(auto, "## 3.6.0 (2026-11-18)\n\n### Minor changes\n- New.\n");
    expect(extractSection(updated, "3.6.0")).toBe("### Minor changes\n- New.");
    expect(extractSection(updated, "3.5.6")).toBe("- Old fix.");
  });

  it("insertSectionSorted appends after the last section, not after deeper version headings", () => {
    const mixed = "# Changelog\n\n## 2.0.0\n\n- Two.\n\n#### [v1.0.0](url)\n\n- One.\n";
    const result = insertSectionSorted(mixed, "## 0.9.0\n\n- Old.\n", "0.9.0");
    expect(findVersionHeadings(result).map((h) => h.version)).toEqual(["2.0.0", "1.0.0", "0.9.0"]);
  });

  it("indented lines are never headings (multi-line summaries under a bullet)", () => {
    const text = [
      "# Changelog",
      "",
      "## 1.5.0 (2026-11-18)",
      "",
      "### Minor changes",
      "- Prepare the next major.",
      "  ## 2.0.0 is coming",
      "  Read on",
      "  =======",
      "",
      "## 1.4.0",
      "",
      "- Old.",
      "",
    ].join("\n");
    expect(findVersionHeadings(text).map((h) => h.version)).toEqual(["1.5.0", "1.4.0"]);
    expect(findHeadings(text).map((h) => h.text)).toEqual([
      "Changelog",
      "1.5.0 (2026-11-18)",
      "Minor changes",
      "1.4.0",
    ]);
    expect(extractSection(text, "1.5.0")).toContain("  ## 2.0.0 is coming");
    const rendered = renderSection({
      version: "1.6.0",
      date: "2026-11-18",
      entries: [entry("minor", "Plan.\n## 2.0.0 is coming")],
    });
    expect(findVersionHeadings(insertSection(text, rendered)).map((h) => h.version)).toEqual([
      "1.6.0",
      "1.5.0",
      "1.4.0",
    ]);
  });

  it("keeps a leading BOM at offset 0 and finds the heading after it", () => {
    const bom = "\uFEFF";
    const existing = `${bom}# Changelog\n\n## 1.4.0\n\n- Old.\n`;
    expect(findHeadings(existing)[0]).toMatchObject({ level: 1, text: "Changelog", start: 1 });
    expect(insertSection(existing, SECTION)).toBe(
      `${bom}# Changelog\n\n${SECTION}\n## 1.4.0\n\n- Old.\n`,
    );
    expect(insertSection(`${bom}# Changelog\n`, SECTION)).toBe(`${bom}# Changelog\n\n${SECTION}`);
    expect(insertSection(`${bom}Notes.\n`, SECTION)).toBe(`${bom}${SECTION}\nNotes.\n`);
    expect(insertSection(bom, SECTION)).toBe(`${bom}# Changelog\n\n${SECTION}`);
  });
});
