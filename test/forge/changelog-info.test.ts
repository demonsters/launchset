import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { changelogInfoFor } from "../../src/forge/changelog-info.ts";
import { createGitHub } from "../../src/forge/github/index.ts";
import { Git } from "../../src/git/index.ts";
import { initRepo } from "../git/helpers.ts";
import { REPO, rawPr, server, TOKEN } from "./helpers.ts";

function fixture() {
  const repo = initRepo();
  repo.commit("initial");
  // a.md: added on a feature branch, merged with a merge commit, edited later.
  repo.checkout("-b", "feature");
  const addA = repo.commit("Add offline mode", {
    ".launchset/a.md": "---\nbump: minor\n---\nOffline\n",
  });
  repo.checkout("main");
  repo.merge("feature", "Merge pull request #20");
  repo.commit("Tweak changeset wording", {
    ".launchset/a.md": "---\nbump: minor\n---\nOffline mode\n",
  });
  // b.md: pushed straight to main, no PR.
  const addB = repo.commit("Direct push", { ".launchset/b.md": "---\nbump: patch\n---\nFix\n" });
  // c.md: the API errors for its commit.
  const addC = repo.commit("Broken lookup", { ".launchset/c.md": "---\nbump: patch\n---\nC\n" });
  // d.md: in two merged PRs (into a feature branch, then into main).
  const addD = repo.commit("Squashed (#31)", { ".launchset/d.md": "---\nbump: patch\n---\nD\n" });
  // e.md: not committed yet.
  repo.write(".launchset/e.md", "---\nbump: patch\n---\nE\n");
  return { repo, addA, addB, addC, addD };
}

describe("changelogInfoFor", () => {
  it("finds the PR and author of the commit that added each changeset", async () => {
    const { repo, addA, addB, addC, addD } = fixture();
    const queried: string[] = [];
    server.use(
      http.get(`${REPO}/commits/:sha/pulls`, ({ params }) => {
        const sha = String(params.sha);
        queried.push(sha);
        if (sha === addA) return HttpResponse.json([rawPr(20, { login: "someone" })]);
        if (sha === addB) return HttpResponse.json([]);
        if (sha === addC) return HttpResponse.json({ message: "boom" }, { status: 502 });
        if (sha === addD) {
          return HttpResponse.json([
            rawPr(30, { login: "early", base: "feature-x", merged_at: "2026-10-01T00:00:00Z" }),
            rawPr(31, { login: "dev", base: "main", merged_at: "2026-10-05T00:00:00Z" }),
            rawPr(32, { login: "open", state: "open", merged_at: null }),
          ]);
        }
        return HttpResponse.json({ message: "unexpected" }, { status: 500 });
      }),
      // Fallback listing for b.md: nothing matches its commit.
      http.get(`${REPO}/pulls`, () =>
        HttpResponse.json([rawPr(99, { merge_commit_sha: "a".repeat(40) })]),
      ),
    );
    const logs: string[] = [];
    const info = await changelogInfoFor(
      [
        ".launchset/a.md",
        ".launchset/b.md",
        ".launchset/c.md",
        ".launchset/d.md",
        ".launchset/e.md",
      ],
      {
        git: new Git({ cwd: repo.dir }),
        forge: createGitHub({ token: TOKEN, repository: "acme/app" }),
        branch: "main",
        log: { debug: (m) => logs.push(`debug: ${m}`), warn: (m) => logs.push(`warn: ${m}`) },
      },
    );
    expect(Object.fromEntries(info)).toEqual({
      ".launchset/a.md": { pr: 20, author: "someone", url: "https://github.com/acme/app/pull/20" },
      ".launchset/d.md": { pr: 31, author: "dev", url: "https://github.com/acme/app/pull/31" },
    });
    expect(queried).toContain(addA);
    expect(logs.some((l) => l.startsWith("debug:") && l.includes(".launchset/b.md"))).toBe(true);
    expect(logs.some((l) => l.startsWith("debug:") && l.includes(".launchset/e.md"))).toBe(true);
    expect(
      logs.some((l) => l.startsWith("warn:") && l.includes(".launchset/c.md") && l.includes("502")),
    ).toBe(true);
    expect(logs.join("\n")).not.toContain(TOKEN);
  });

  it("falls back to the branch's merged PRs off the default branch, from a subdirectory", async () => {
    const repo = initRepo();
    repo.commit("initial", { "apps/mobile/package.json": "{}\n" });
    repo.checkout("-b", "release/1.4.x");
    // Squash-merged PR #40.
    const squash = repo.commit("Fix crash (#40)", { "apps/mobile/.launchset/fix.md": "x\n" });
    // Merge-commit PR #41: the changeset is added on the side branch.
    repo.checkout("-b", "hotfix/login");
    const side = repo.commit("Add changeset", { "apps/mobile/.launchset/login.md": "y\n" });
    repo.commit("More work");
    repo.checkout("release/1.4.x");
    const merge = repo.merge("hotfix/login", "Merge pull request #41");
    // Pushed directly, no PR.
    const direct = repo.commit("Direct", { "apps/mobile/.launchset/direct.md": "z\n" });

    const lookups: string[] = [];
    let listings = 0;
    server.use(
      http.get(`${REPO}/commits/:sha/pulls`, ({ params }) => {
        lookups.push(String(params.sha));
        // Off the default branch GitHub only returns open PRs here.
        return HttpResponse.json([rawPr(50, { state: "open", merged_at: null })]);
      }),
      http.get(`${REPO}/pulls`, ({ request }) => {
        listings++;
        expect(new URL(request.url).searchParams.get("base")).toBe("release/1.4.x");
        return HttpResponse.json([
          rawPr(41, {
            login: "dev",
            base: "release/1.4.x",
            merge_commit_sha: merge,
            updated_at: new Date().toISOString(),
          }),
          rawPr(40, {
            login: "fixer",
            base: "release/1.4.x",
            merge_commit_sha: squash,
            updated_at: new Date().toISOString(),
          }),
        ]);
      }),
    );
    const git = new Git({ cwd: join(repo.dir, "apps", "mobile") });
    const paths = await Promise.all(
      [".launchset/fix.md", ".launchset/login.md", ".launchset/direct.md"].map((p) =>
        git.toRepoPath(p),
      ),
    );
    const info = await changelogInfoFor(paths, {
      git,
      forge: createGitHub({ token: TOKEN, repository: "acme/app" }),
      branch: "release/1.4.x",
    });
    expect(Object.fromEntries(info)).toEqual({
      "apps/mobile/.launchset/fix.md": {
        pr: 40,
        author: "fixer",
        url: "https://github.com/acme/app/pull/40",
      },
      "apps/mobile/.launchset/login.md": {
        pr: 41,
        author: "dev",
        url: "https://github.com/acme/app/pull/41",
      },
    });
    expect(lookups.sort()).toEqual([squash, side, direct].sort());
    expect(listings).toBe(1);
  });

  it("without a branch preference picks the earliest merged PR", async () => {
    const { repo, addD } = fixture();
    server.use(
      http.get(`${REPO}/commits/:sha/pulls`, ({ params }) =>
        String(params.sha) === addD
          ? HttpResponse.json([
              rawPr(31, { base: "main", merged_at: "2026-10-05T00:00:00Z" }),
              rawPr(30, { base: "feature-x", merged_at: "2026-10-01T00:00:00Z" }),
            ])
          : HttpResponse.json([]),
      ),
    );
    const info = await changelogInfoFor([".launchset/d.md"], {
      git: new Git({ cwd: repo.dir }),
      forge: createGitHub({ token: TOKEN, repository: "acme/app" }),
    });
    expect(info.get(".launchset/d.md")?.pr).toBe(30);
  });

  it("without a token returns no entries and makes no calls", async () => {
    const { repo } = fixture();
    const logs: string[] = [];
    const info = await changelogInfoFor([".launchset/a.md"], {
      git: new Git({ cwd: repo.dir }),
      forge: undefined,
      log: { debug: (m) => logs.push(m) },
    });
    expect(info.size).toBe(0);
    expect(logs).toEqual([
      "changelog.github: no GitHub token, leaving PR links out of the changelog.",
    ]);
  });
});
