import { describe, expect, it } from "vitest";
import {
  ChangesetError,
  convertChangesetsFile,
  generateChangesetName,
  isChangesetPath,
  parseChangeset,
  serializeChangeset,
} from "../../src/core/changesets.ts";

const PATH = ".launchset/brave-lions-sing.md";

function parseError(text: string, path = PATH): ChangesetError {
  try {
    parseChangeset(text, path);
  } catch (error) {
    expect(error).toBeInstanceOf(ChangesetError);
    return error as ChangesetError;
  }
  throw new Error("expected parseChangeset to throw");
}

describe("parseChangeset", () => {
  it("parses bump and summary", () => {
    const { changeset, warnings } = parseChangeset(
      "---\nbump: minor\n---\n\nAdd offline mode to the mobile app.\n",
      PATH,
    );
    expect(changeset).toEqual({
      name: "brave-lions-sing.md",
      path: PATH,
      bump: "minor",
      summary: "Add offline mode to the mobile app.",
      extra: {},
    });
    expect(warnings).toEqual([]);
  });

  it("keeps multi-line markdown bodies and trims surrounding blank lines", () => {
    const text =
      "---\r\nbump: patch\r\n---\r\n\r\n\r\nFix login.\r\n\r\n- detail one\r\n  - nested\r\n\r\n\r\n";
    expect(parseChangeset(text, PATH).changeset.summary).toBe(
      "Fix login.\n\n- detail one\n  - nested",
    );
  });

  it("accepts every bump type", () => {
    for (const bump of ["major", "minor", "patch"]) {
      expect(parseChangeset(`---\nbump: ${bump}\n---\nx\n`, PATH).changeset.bump).toBe(bump);
    }
  });

  it("allows an empty body for bump: none", () => {
    expect(parseChangeset("---\nbump: none\n---\n", PATH).changeset).toMatchObject({
      bump: "none",
      summary: "",
    });
  });

  it("reads source: bot and pr", () => {
    const { changeset } = parseChangeset(
      "---\nbump: patch\nsource: bot\npr: 131\n---\n\nBump react-native from 0.76.1 to 0.76.3\n",
      PATH,
    );
    expect(changeset.source).toBe("bot");
    expect(changeset.pr).toBe(131);
  });

  it("warns about unknown keys and keeps them in extra", () => {
    const { changeset, warnings } = parseChangeset(
      "---\nbump: patch\nstoreNotes:\n  ios: Faster login\naudience: internal\n---\nFix.\n",
      PATH,
    );
    expect(changeset.extra).toEqual({ storeNotes: { ios: "Faster login" }, audience: "internal" });
    expect(warnings).toEqual([
      `${PATH}:3: unknown frontmatter key "storeNotes" (kept, but launchset ignores it)`,
      `${PATH}:5: unknown frontmatter key "audience" (kept, but launchset ignores it)`,
    ]);
  });

  it("strips a BOM", () => {
    expect(parseChangeset("﻿---\nbump: patch\n---\nx\n", PATH).changeset.bump).toBe("patch");
  });

  describe("errors name the file and line", () => {
    it("missing frontmatter", () => {
      const error = parseError("Just a summary\n");
      expect(error.line).toBe(1);
      expect(error.file).toBe(PATH);
      expect(error.message).toMatch(/^\.launchset\/brave-lions-sing\.md:1: missing frontmatter/);
      expect(error.code).toBe("invalid-changeset");
      expect(error.hint).toContain("bump: minor");
    });

    it("empty file", () => {
      expect(parseError("").line).toBe(1);
    });

    it("unclosed frontmatter", () => {
      const error = parseError("---\nbump: patch\nFix.\n");
      expect(error.message).toContain("frontmatter is not closed");
    });

    it("invalid YAML, with the file line", () => {
      const error = parseError("---\nbump: patch\nfoo: [unclosed\n---\nx\n");
      expect(error.message).toMatch(/:\d+: invalid frontmatter/);
      expect(error.line).toBeGreaterThanOrEqual(3);
    });

    it("frontmatter that isn't key/value lines", () => {
      const error = parseError("---\n- patch\n---\nx\n");
      expect(error.line).toBe(2);
      expect(error.message).toContain('expected "key: value" lines');
    });

    it("duplicate keys", () => {
      const error = parseError("---\nbump: patch\nbump: minor\n---\nx\n");
      expect(error.line).toBe(3);
    });

    it("missing bump", () => {
      const error = parseError("---\nsource: bot\n---\nx\n");
      expect(error.message).toBe(
        `${PATH}:1: missing "bump" in the frontmatter: add a line "bump: <major|minor|patch|none>"`,
      );
    });

    it("empty frontmatter", () => {
      expect(parseError("---\n---\nx\n").message).toContain('missing "bump"');
    });

    it("invalid bump, at the value's line", () => {
      const error = parseError("---\n# comment\nbump: minr\n---\nx\n");
      expect(error.message).toBe(
        `${PATH}:3: invalid bump "minr": expected major, minor, patch or none`,
      );
    });

    it("bump without a value", () => {
      expect(parseError("---\nbump:\n---\nx\n").message).toContain("invalid bump nothing");
    });

    it("invalid source", () => {
      expect(parseError("---\nbump: patch\nsource: human\n---\nx\n").message).toMatch(
        /:3: invalid source "human"/,
      );
    });

    it("invalid pr", () => {
      expect(parseError("---\nbump: patch\npr: abc\n---\nx\n").message).toMatch(
        /:3: invalid pr "abc": expected a pull request number/,
      );
      expect(parseError("---\nbump: patch\npr: 0\n---\nx\n").line).toBe(3);
    });

    it("empty summary for a release bump, at the body line", () => {
      const error = parseError("---\nbump: minor\n---\n\n   \n");
      expect(error.line).toBe(4);
      expect(error.message).toContain("the summary is empty");
    });
  });
});

describe("serializeChangeset", () => {
  it("writes the spec format", () => {
    expect(serializeChangeset({ bump: "minor", summary: "Add offline mode.", extra: {} })).toBe(
      "---\nbump: minor\n---\n\nAdd offline mode.\n",
    );
  });

  it("writes bump: none without a body", () => {
    expect(serializeChangeset({ bump: "none", summary: "", extra: {} })).toBe(
      "---\nbump: none\n---\n",
    );
  });

  it("round-trips, keeping extra keys", () => {
    const original = parseChangeset(
      "---\nbump: patch\nsource: bot\npr: 7\nstoreNotes:\n  ios: Faster\n  android: 'Faster: really'\n---\n\nLine one.\n\n```sh\nnpm i\n```\n",
      PATH,
    ).changeset;
    const text = serializeChangeset(original);
    expect(parseChangeset(text, PATH).changeset).toEqual(original);
    expect(text.startsWith("---\nbump: patch\nsource: bot\npr: 7\nstoreNotes:")).toBe(true);
  });
});

describe("isChangesetPath", () => {
  it.each([
    [".launchset/brave-lions-sing.md", true],
    ["./.launchset/x.md", true],
    [".launchset/README.md", false],
    [".launchset/readme.md", false],
    [".launchset/nested/x.md", false],
    [".launchset/x.txt", false],
    [".launchset/.md", false],
    ["docs/.launchset/x.md", false],
    [".changeset/x.md", false],
    [".launchset\\win.md", true],
  ])("%s → %s", (path, expected) => {
    expect(isChangesetPath(path)).toBe(expected);
  });

  it("supports a launchset root in a subdirectory", () => {
    expect(isChangesetPath("apps/web/.launchset/x.md", "apps/web/.launchset")).toBe(true);
  });
});

describe("generateChangesetName", () => {
  it("makes three lowercase words joined by dashes", () => {
    expect(generateChangesetName(new Set(), Math.random)).toMatch(/^[a-z]+-[a-z]+-[a-z]+\.md$/);
  });

  it("is deterministic with an injected rng", () => {
    expect(generateChangesetName(new Set(), () => 0)).toBe("brave-apples-act.md");
  });

  it("avoids existing names", () => {
    const values = [0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5];
    let i = 0;
    const rng = () => values[i++ % values.length] as number;
    const name = generateChangesetName(new Set(["brave-apples-act.md"]), rng);
    expect(name).not.toBe("brave-apples-act.md");
    expect(name).toMatch(/^[a-z]+-[a-z]+-[a-z]+\.md$/);
  });

  it("falls back to a numbered name when the rng keeps colliding", () => {
    const name = generateChangesetName(new Set(["brave-apples-act.md"]), () => 0);
    expect(name).toBe("brave-apples-act-2.md");
  });
});

describe("convertChangesetsFile", () => {
  it("takes the highest bump over quoted and unquoted package lines", () => {
    const text = [
      "---",
      '"@demonsters/api": patch',
      "'@demonsters/web': minor",
      "mobile: patch",
      "---",
      "",
      "Add offline mode.",
      "",
    ].join("\n");
    const result = convertChangesetsFile(text, ".changeset/odd-owls-dance.md");
    expect(result.changeset).toEqual({
      name: "odd-owls-dance.md",
      path: ".launchset/odd-owls-dance.md",
      bump: "minor",
      summary: "Add offline mode.",
      extra: {},
    });
    expect(result.packages).toEqual({
      "@demonsters/api": "patch",
      "@demonsters/web": "minor",
      mobile: "patch",
    });
    expect(
      parseChangeset(serializeChangeset(result.changeset), result.changeset.path).changeset,
    ).toEqual(result.changeset);
  });

  it("major wins", () => {
    expect(
      convertChangesetsFile('---\n"a": major\n"b": minor\n---\nx\n', "x.md").changeset.bump,
    ).toBe("major");
  });

  it("empty frontmatter becomes none", () => {
    expect(convertChangesetsFile("---\n---\n", ".changeset/empty.md").changeset).toMatchObject({
      bump: "none",
      summary: "",
    });
  });

  it("errors on an invalid bump with the line", () => {
    expect(() =>
      convertChangesetsFile('---\n"a": minor\n"b": huge\n---\nx\n', ".changeset/x.md"),
    ).toThrow(
      '.changeset/x.md:3: invalid Changesets bump "huge" for "b": expected major, minor, patch or none',
    );
  });

  it("accepts none package bumps", () => {
    const result = convertChangesetsFile(
      '---\n"a": none\n"b": none\n---\nDocs.\n',
      ".changeset/x.md",
    );
    expect(result.changeset.bump).toBe("none");
    expect(result.packages).toEqual({ a: "none", b: "none" });
    expect(
      convertChangesetsFile('---\n"a": none\n"b": patch\n---\nFix.\n', "x.md").changeset.bump,
    ).toBe("patch");
  });

  it("a release bump without a summary is a warning, flagged for init", () => {
    const result = convertChangesetsFile('---\n"a": patch\n---\n', ".changeset/x.md");
    expect(result.changeset).toMatchObject({ bump: "patch", summary: "" });
    expect(result.needsSummary).toBe(true);
    expect(result.warnings).toEqual([
      ".changeset/x.md:4: the summary is empty; launchset needs one for a patch changeset, so write it in the converted file",
    ]);
  });

  it("an empty none changeset needs nothing", () => {
    const result = convertChangesetsFile("---\n---\n", ".changeset/x.md");
    expect(result.needsSummary).toBe(false);
    expect(result.warnings).toEqual([]);
  });
});

describe("YAML features in frontmatter", () => {
  it("resolves aliases in extra keys", () => {
    const { changeset } = parseChangeset(
      "---\nbump: patch\nbase: &b { a: 1 }\ncopy: *b\n---\nx\n",
      PATH,
    );
    expect(changeset.extra).toEqual({ base: { a: 1 }, copy: { a: 1 } });
  });
});
