import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  collectActionRefs,
  findStale,
  formatReport,
  majorOf,
  readScannedFiles,
} from "../../scripts/check-action-majors.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("majorOf", () => {
  it("reads the major of a version tag", () => {
    expect(majorOf("v5")).toBe(5);
    expect(majorOf("v1.345.0")).toBe(1);
    expect(majorOf("2.0.0")).toBe(2);
    expect(majorOf("v7.0")).toBe(7);
  });

  it("is undefined for anything that is not a version", () => {
    expect(majorOf("main")).toBeUndefined();
    expect(majorOf("8e5e7e5ab8b370d6c329ec480221332ada57f0ab")).toBeUndefined();
    expect(majorOf("v2-beta")).toBeUndefined();
    expect(majorOf("@@action@@")).toBeUndefined();
  });
});

describe("collectActionRefs", () => {
  const text = [
    "jobs:",
    "  a:",
    "    steps:",
    "      - uses: actions/checkout@v5",
    "      - id: token",
    "        uses: actions/create-github-app-token@v2",
    "      - uses: ./action",
    "      - uses: @@action@@",
    "      - uses: docker://alpine:3",
    "      - uses: some/action@8e5e7e5ab8b370d6c329ec480221332ada57f0ab",
    "      - uses: some/action@main",
    '      - uses: "Docker/Build-Push-Action@v6.1.0"',
    "      - uses: github/codeql-action/init@v3 # trailing comment",
    "# - uses: actions/setup-node@v5",
    "#   uses: actions/setup-java@v5",
    "      run: echo 'uses: not/this@v1'",
  ].join("\n");
  const refs = collectActionRefs([{ path: "t.yml", text }]);

  it("finds published actions pinned to a version tag, commented-out examples included", () => {
    expect(refs.map((r) => [r.action, r.major, r.line])).toEqual([
      ["actions/checkout", 5, 4],
      ["actions/create-github-app-token", 2, 6],
      ["docker/build-push-action", 6, 12],
      ["github/codeql-action", 3, 13],
      ["actions/setup-node", 5, 14],
      ["actions/setup-java", 5, 15],
    ]);
  });

  it("keeps the ref as written and the file it came from", () => {
    expect(refs.find((r) => r.action === "docker/build-push-action")).toMatchObject({
      ref: "v6.1.0",
      path: "t.yml",
    });
  });
});

describe("findStale", () => {
  const refs = collectActionRefs([
    {
      path: "templates/workflows/release.yml",
      text: "- uses: actions/checkout@v5\n- uses: actions/setup-node@v7\n- uses: ruby/setup-ruby@v1\n",
    },
    {
      path: ".github/workflows/ci.yml",
      text: "- uses: actions/checkout@v7\n- uses: actions/checkout@v4\n- uses: unknown/action@v1\n",
    },
  ]);
  const latest = new Map([
    ["actions/checkout", "v7.0.1"],
    ["actions/setup-node", "v7.1.0"],
    ["ruby/setup-ruby", "v1.345.0"],
  ]);

  it("lists each action behind its latest major, with every place that is behind", () => {
    expect(findStale(refs, latest)).toEqual([
      {
        action: "actions/checkout",
        used: [4, 5],
        latest: 7,
        latestTag: "v7.0.1",
        where: ["templates/workflows/release.yml:1", ".github/workflows/ci.yml:2"],
      },
    ]);
  });

  it("is empty when every major is current", () => {
    expect(findStale(refs, new Map([["actions/checkout", "v4"]]))).toEqual([]);
  });

  it("ignores a latest tag that is not a version", () => {
    expect(findStale(refs, new Map([["actions/checkout", "nightly"]]))).toEqual([]);
  });

  it("formats a Markdown report", () => {
    const report = formatReport(findStale(refs, latest));
    expect(report).toContain("- **actions/checkout**: v4, v5 → v7 (latest release v7.0.1");
    expect(report).toContain("  - `templates/workflows/release.yml:1`");
    expect(formatReport([])).toMatch(/latest major/);
  });
});

describe("the repo's own templates and workflows", () => {
  const refs = collectActionRefs(readScannedFiles(root));

  it("are scanned, snippets included", () => {
    const paths = new Set(refs.map((r) => r.path));
    expect(paths).toContain("templates/workflows/launchset-release.yml");
    expect(paths).toContain("templates/workflows/snippets/docker.yml");
    expect(paths).toContain(".github/workflows/ci.yml");
  });

  // Offline: Dependabot bumps `.github/workflows/` only, so this fails its PR until the
  // templates (which `init` writes into other repos) are bumped along.
  it("use one major per action across the templates and launchset's own workflows", () => {
    const majors = new Map<string, Set<string>>();
    for (const r of refs) {
      const set = majors.get(r.action) ?? new Set();
      set.add(`v${r.major} (${r.path}:${r.line})`);
      majors.set(r.action, set);
    }
    for (const [action, uses] of majors) {
      const distinct = new Set([...uses].map((u) => u.split(" ")[0]));
      expect(distinct.size, `${action}: ${[...uses].join(", ")}`).toBe(1);
    }
  });
});
