import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CheckInput, evaluateCheck, evaluatePushCheck } from "../../src/core/check.ts";
import { readChangesetFile } from "../../src/core/plan-common.ts";
import { makeConfig, tags } from "./plan-fixtures.ts";

const config = makeConfig();

const file = (name: string, bump: string, summary = `Summary of ${name}.`) =>
  readChangesetFile(`---\nbump: ${bump}\n---\n\n${summary}\n`, `.launchset/${name}.md`);

function input(overrides: Partial<CheckInput> = {}): CheckInput {
  return {
    config,
    pr: { number: 42, author: "someone", headBranch: "feature/x", baseBranch: "main" },
    changedFiles: [],
    changesets: [],
    mismatches: [],
    version: "1.4.0",
    tags: tags(config, ["v1.4.0"]),
    ...overrides,
  };
}

describe("PR check (9.2)", () => {
  it("passes when the PR adds a valid changeset and shows bump, version and summaries", () => {
    const result = evaluateCheck(
      input({
        changedFiles: [{ status: "A", path: ".launchset/brave-lions-sing.md" }],
        changesets: [
          file("brave-lions-sing", "minor", "Add offline mode."),
          file("older", "patch"),
        ],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("changeset");
    expect(result.prChangesets.map((c) => c.path)).toEqual([".launchset/brave-lions-sing.md"]);
    expect(result.bump).toBe("minor");
    expect(result.nextVersion).toBe("1.5.0");
    expect(result.comment).toContain("### launchset: 1 changeset found");
    expect(result.comment).toContain("The next release will be **1.5.0** (minor).");
    expect(result.comment).toContain(
      "- `minor`: Add offline mode. (`.launchset/brave-lions-sing.md`)",
    );
    expect(result.summary).toContain("launchset check: passed");
  });

  it("passes when the PR changes a changeset, and with bump: none", () => {
    const result = evaluateCheck(
      input({
        changedFiles: [{ status: "M", path: ".launchset/docs.md" }],
        changesets: [readChangesetFile("---\nbump: none\n---\n", ".launchset/docs.md")],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.bump).toBeNull();
    expect(result.comment).toContain("- `none`: no release");
  });

  it("fails without a changeset and explains how to add one", () => {
    const result = evaluateCheck(
      input({
        changedFiles: [
          { status: "D", path: ".launchset/gone.md" },
          { status: "A", path: ".launchset/README.md" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.code)).toEqual(["no-changeset"]);
    expect(result.comment).toContain("npx @demonsters/launchset add");
    expect(result.comment).toContain("bump: patch");
    expect(result.comment).toContain("launchset docs");
    // The link points at a page that exists in this repo.
    const link = result.comment.match(
      /https:\/\/github\.com\/demonsters\/launchset\/blob\/main\/(\S+?\.md)/,
    );
    expect(link?.[1]).toBeDefined();
    expect(existsSync(join(import.meta.dirname, "../..", link?.[1] ?? "missing"))).toBe(true);
  });

  it("passes for bot authors (case-insensitive)", () => {
    const result = evaluateCheck(
      input({
        pr: {
          number: 7,
          author: "Dependabot[bot]",
          headBranch: "dependabot/npm/x",
          baseBranch: "main",
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("bot");
    expect(result.comment).toContain("No changeset needed");
  });

  it("passes for the release PR (any base, slashes kept)", () => {
    const result = evaluateCheck(
      input({
        pr: {
          number: 8,
          author: "launchset[bot]",
          headBranch: "launchset/release/release/1.4.x",
          baseBranch: "release/1.4.x",
          fork: false,
        },
        version: "1.4.1",
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("release-pr");
  });

  it("fails on invalid changesets anywhere, even for bots", () => {
    const broken = readChangesetFile("---\nbump: huge\n---\n\nx\n", ".launchset/broken.md");
    const result = evaluateCheck(
      input({
        pr: { number: 7, author: "renovate[bot]", headBranch: "renovate/x", baseBranch: "main" },
        changesets: [broken],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.code).toBe("invalid-changeset");
    expect(result.failures[0]?.message).toContain(".launchset/broken.md:2: invalid bump");
    expect(result.comment).toContain("**Problems:**");
  });

  it("fails on minor changesets against a maintenance branch", () => {
    const result = evaluateCheck(
      input({
        pr: { number: 9, author: "someone", headBranch: "fix", baseBranch: "release/1.4.x" },
        version: "1.4.1",
        changedFiles: [{ status: "A", path: ".launchset/feat.md" }],
        changesets: [file("feat", "minor")],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.code)).toEqual(["maintenance-bump"]);
    expect(result.failures[0]?.message).toContain("belongs on main");
    expect(result.nextVersion).toBeNull();
  });

  it("computes the next version in the maintenance line", () => {
    const result = evaluateCheck(
      input({
        pr: { number: 9, author: "someone", headBranch: "fix", baseBranch: "release/1.4.x" },
        version: "1.4.1",
        tags: tags(config, ["v1.4.1", "v1.4.2"]),
        changedFiles: [{ status: "A", path: ".launchset/fix.md" }],
        changesets: [file("fix", "patch")],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.nextVersion).toBe("1.4.3");
  });

  it("fails on version mismatches", () => {
    const result = evaluateCheck(
      input({
        changedFiles: [{ status: "A", path: ".launchset/a.md" }],
        changesets: [file("a", "patch")],
        mismatches: [
          {
            target: "android",
            path: "android/app/build.gradle",
            found: [{ key: "versionName", value: "1.3.0", line: 12 }],
            expected: "1.4.0",
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.code).toBe("version-mismatch");
    expect(result.failures[0]?.message).toContain(
      "android/app/build.gradle (android): versionName = 1.3.0 (line 12), expected 1.4.0",
    );
  });

  it("collects unknown-key warnings", () => {
    const result = evaluateCheck(
      input({
        changedFiles: [{ status: "A", path: ".launchset/a.md" }],
        changesets: [
          readChangesetFile("---\nbump: patch\nstore: x\n---\n\nFix.\n", ".launchset/a.md"),
        ],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.warnings[0]).toContain('unknown frontmatter key "store"');
  });
});

describe("check --push (11)", () => {
  it("warns about commits without a changeset, never fails", () => {
    const result = evaluatePushCheck({
      config,
      changesets: [],
      commitsSinceRelease: [{ sha: "c".repeat(40), subject: "Quick fix" }],
      reachableReleases: ["1.4.0"],
    });
    expect(result.ok).toBe(true);
    expect(result.warnings[0]).toContain("1 commit since v1.4.0 and no pending changeset");
    expect(result.message).toContain("warning only");
  });

  it("is quiet when a changeset is pending", () => {
    const result = evaluatePushCheck({
      config,
      changesets: [file("a", "patch")],
      commitsSinceRelease: [{ sha: "c".repeat(40), subject: "Quick fix" }],
      reachableReleases: [],
    });
    expect(result.warnings).toEqual([]);
    expect(result.message).toBe("launchset: ok");
  });
});

describe("review regressions: check", () => {
  const releasePr = {
    number: 8,
    author: "launchset[bot]",
    headBranch: "launchset/release/main",
    baseBranch: "main",
  };

  it("exempts the release PR only from this repository", () => {
    expect(evaluateCheck(input({ pr: { ...releasePr, fork: false } })).ok).toBe(true);
    const fork = evaluateCheck(input({ pr: { ...releasePr, fork: true } }));
    expect(fork.ok).toBe(false);
    expect(fork.failures[0]?.message).toContain("only when it comes from this repository");
    expect(evaluateCheck(input({ pr: releasePr })).ok).toBe(false);
  });

  it("fails when the PR only deletes changesets", () => {
    const result = evaluateCheck(
      input({
        changedFiles: [{ status: "D", path: ".launchset/old.md" }],
        changesets: [file("other", "patch")],
      }),
    );
    expect(result.failures.map((f) => f.code)).toEqual(["no-changeset"]);
  });

  it("doesn't count a pure rename of a changeset", () => {
    const renamed = (similarity?: number) =>
      evaluateCheck(
        input({
          changedFiles: [
            {
              status: "R",
              path: ".launchset/new-name.md",
              oldPath: ".launchset/old-name.md",
              ...(similarity !== undefined ? { similarity } : {}),
            },
          ],
          changesets: [file("new-name", "patch")],
        }),
      );
    expect(renamed(100).ok).toBe(false);
    expect(renamed().ok).toBe(false);
    expect(renamed(80).ok).toBe(true);
  });

  it("counts a file moved into the changeset folder", () => {
    const result = evaluateCheck(
      input({
        changedFiles: [
          { status: "R", path: ".launchset/a.md", oldPath: "notes/a.md", similarity: 100 },
        ],
        changesets: [file("a", "patch")],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("matches repo-relative paths with a changesetDir in a subfolder", () => {
    const sub = readChangesetFile("---\nbump: patch\n---\n\nFix.\n", "apps/web/.launchset/a.md");
    const result = evaluateCheck(
      input({
        changesetDir: "apps/web/.launchset",
        changedFiles: [{ status: "A", path: "./apps/web/.launchset/a.md" }],
        changesets: [sub],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.prChangesets).toHaveLength(1);
  });

  it("throws an internal error for changeset paths that aren't repo-relative", () => {
    expect(() =>
      evaluateCheck(
        input({ changesetDir: "apps/web/.launchset", changesets: [file("a", "patch")] }),
      ),
    ).toThrow(/internal error: changeset path "\.launchset\/a\.md"/);
  });
});
