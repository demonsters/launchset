import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { findBotPrsWithoutChangeset } from "../../src/forge/bot-prs.ts";
import { createGitHub } from "../../src/forge/github/index.ts";
import { Git } from "../../src/git/index.ts";
import { initRepo } from "../git/helpers.ts";
import { linkHeader, REPO, rawPr, server, TOKEN } from "./helpers.ts";

const isChangesetPath = (path: string) =>
  /^\.launchset\/[^/]+\.md$/.test(path) && path !== ".launchset/README.md";

const now = () => new Date().toISOString();
const OLD = "2020-01-01T00:00:00Z";

/**
 * main: #2 (root) → #3 → [v1.0.0] → #10 squash → #11 (has changeset) → #12 human
 *       → local merge of release/1.0.x (#13 lives there) → #14 merge commit
 *       → #17 rebase merge (two commits) → #16 (only deleted a changeset)
 */
function fixture() {
  const repo = initRepo();
  const s: Record<string, string> = {};
  s.root = repo.commit("Bump a (#2)");
  s.old = repo.commit("Bump lodash (#3)");
  repo.git("tag", "v1.0.0");
  s.squash = repo.commit("Bump react-native from 0.76.1 to 0.76.3 (#10)");
  s.withChangeset = repo.commit("Bump expo (#11)", {
    ".launchset/expo.md": "---\nbump: patch\n---\nx\n",
  });
  s.human = repo.commit("Add offline mode (#12)");
  repo.checkout("-b", "release/1.0.x", "v1.0.0");
  s.otherBase = repo.commit("Bump zod (#13)");
  repo.checkout("main");
  s.localMerge = repo.merge("release/1.0.x", "Merge release/1.0.x");
  repo.checkout("-b", "renovate/eslint");
  s.renovate1 = repo.commit("Update eslint");
  s.renovate2 = repo.commit("Update eslint config");
  repo.checkout("main");
  s.renovateMerge = repo.merge("renovate/eslint", "Merge pull request #14");
  s.rebase1 = repo.commit("Bump yaml part 1");
  s.rebase2 = repo.commit("Bump yaml part 2");
  s.deleted = repo.commit("Bump semver (#16)");
  return { repo, s };
}

type Raw = ReturnType<typeof rawPr>;

function pullsFor(s: Record<string, string>): Raw[] {
  const bot = "dependabot[bot]";
  // Sorted by updated_at desc, as GitHub returns them.
  return [
    rawPr(16, {
      login: "Dependabot[bot]",
      title: "Bump semver",
      merge_commit_sha: s.deleted,
      updated_at: now(),
    }),
    rawPr(17, { login: bot, title: "Bump yaml", merge_commit_sha: s.rebase2, updated_at: now() }),
    rawPr(19, {
      login: bot,
      title: "Merged after HEAD",
      merge_commit_sha: "f".repeat(40),
      updated_at: now(),
    }),
    rawPr(15, { login: bot, merged_at: null, merge_commit_sha: null, updated_at: now() }),
    rawPr(14, {
      login: "renovate[bot]",
      title: "Update eslint",
      merge_commit_sha: s.renovateMerge,
      head: "renovate/eslint",
      updated_at: now(),
    }),
    rawPr(13, {
      login: bot,
      title: "Bump zod",
      base: "release/1.0.x",
      merge_commit_sha: s.otherBase,
      updated_at: now(),
    }),
    rawPr(12, { login: "someone", merge_commit_sha: s.human, updated_at: now() }),
    rawPr(11, {
      login: bot,
      title: "Bump expo",
      merge_commit_sha: s.withChangeset,
      updated_at: now(),
    }),
    rawPr(10, {
      login: bot,
      title: "Bump react-native from 0.76.1 to 0.76.3",
      merge_commit_sha: s.squash,
      updated_at: now(),
    }),
    rawPr(3, { login: bot, title: "Bump lodash", merge_commit_sha: s.old, updated_at: OLD }),
    rawPr(2, { login: bot, title: "Bump a", merge_commit_sha: s.root, updated_at: OLD }),
  ];
}

const files: Record<string, { filename: string; status: string }[]> = {
  "2": [{ filename: "package.json", status: "modified" }],
  "3": [{ filename: "package.json", status: "modified" }],
  "10": [
    { filename: "package.json", status: "modified" },
    { filename: ".launchset/README.md", status: "modified" },
  ],
  "11": [
    { filename: "package.json", status: "modified" },
    { filename: ".launchset/expo.md", status: "added" },
  ],
  "13": [{ filename: "package.json", status: "modified" }],
  "14": [{ filename: "package.json", status: "modified" }],
  "16": [{ filename: ".launchset/old.md", status: "removed" }],
  "17": [{ filename: "package.json", status: "modified" }],
};

function handlers(s: Record<string, string>, log: { pages: number[]; files: number[] }) {
  return [
    http.get(`${REPO}/pulls`, ({ request }) => {
      const query = new URL(request.url).searchParams;
      expect(query.get("state")).toBe("closed");
      expect(query.get("sort")).toBe("updated");
      expect(query.get("direction")).toBe("desc");
      const page = Number(query.get("page") ?? "1");
      log.pages.push(page);
      const all = pullsFor(s).filter((pr) => pr.base.ref === query.get("base"));
      const pages = [all.slice(0, 5), all.slice(5, 9), all.slice(9)];
      return HttpResponse.json(pages[page - 1] ?? [], {
        headers: linkHeader(request.url, page, pages.length),
      });
    }),
    http.get(`${REPO}/pulls/:number/files`, ({ params }) => {
      log.files.push(Number(params.number));
      const list = files[String(params.number)];
      return list
        ? HttpResponse.json(list)
        : HttpResponse.json({ message: "Not Found" }, { status: 404 });
    }),
    http.get(`${REPO}/commits/:sha/pulls`, () =>
      HttpResponse.json({ message: "per-commit lookups must not be used" }, { status: 500 }),
    ),
  ];
}

describe("findBotPrsWithoutChangeset", () => {
  it("finds merged bot PRs into the branch without a changeset in since..head", async () => {
    const { repo, s } = fixture();
    const log = { pages: [] as number[], files: [] as number[] };
    server.use(...handlers(s, log));
    const options = {
      git: new Git({ cwd: repo.dir }),
      forge: createGitHub({ token: TOKEN, repository: "acme/app" }),
      head: "HEAD",
      branch: "main",
      bots: ["dependabot[bot]", "renovate[bot]"],
      isChangesetPath,
    };
    const expected = [
      { number: 10, title: "Bump react-native from 0.76.1 to 0.76.3", author: "dependabot[bot]" },
      { number: 14, title: "Update eslint", author: "renovate[bot]" },
      { number: 16, title: "Bump semver", author: "Dependabot[bot]" },
      { number: 17, title: "Bump yaml", author: "dependabot[bot]" },
    ];
    expect(await findBotPrsWithoutChangeset({ ...options, since: "v1.0.0" })).toEqual(expected);
    // The listing stopped at the first PR updated before the range start (#3 on page 2), so
    // page 3 was never requested.
    expect(log.pages).toEqual([1, 2]);
    // PR files are fetched only for in-range bot PRs.
    expect(log.files.sort((a, b) => a - b)).toEqual([10, 11, 14, 16, 17]);

    // `since` may be any ref or sha (the flow passes the release commit).
    expect(await findBotPrsWithoutChangeset({ ...options, since: s.old })).toEqual(expected);
    // A later start excludes earlier PRs.
    expect(
      (await findBotPrsWithoutChangeset({ ...options, since: s.renovateMerge })).map(
        (p) => p.number,
      ),
    ).toEqual([16, 17]);
  });

  it("covers the whole history without `since`, and works on a maintenance branch", async () => {
    const { repo, s } = fixture();
    const log = { pages: [] as number[], files: [] as number[] };
    server.use(...handlers(s, log));
    const base = {
      git: new Git({ cwd: repo.dir }),
      forge: createGitHub({ token: TOKEN, repository: "acme/app" }),
      since: undefined,
      bots: ["dependabot[bot]"],
      isChangesetPath,
    };
    expect(
      (await findBotPrsWithoutChangeset({ ...base, head: "HEAD", branch: "main" })).map(
        (p) => p.number,
      ),
    ).toEqual([2, 3, 10, 16, 17]);
    expect(log.pages).toEqual([1, 2, 3]);
    expect(
      await findBotPrsWithoutChangeset({
        ...base,
        since: "v1.0.0",
        head: "release/1.0.x",
        branch: "release/1.0.x",
      }),
    ).toEqual([{ number: 13, title: "Bump zod", author: "dependabot[bot]" }]);
  });

  it("returns nothing without bots or commits, and fails loudly on API errors", async () => {
    const { repo, s } = fixture();
    const git = new Git({ cwd: repo.dir });
    const forge = createGitHub({ token: TOKEN, repository: "acme/app" });
    const base = { git, forge, since: "v1.0.0", head: "HEAD", branch: "main", isChangesetPath };
    expect(await findBotPrsWithoutChangeset({ ...base, bots: [] })).toEqual([]);
    expect(
      await findBotPrsWithoutChangeset({ ...base, since: "HEAD", bots: ["dependabot[bot]"] }),
    ).toEqual([]);

    server.use(
      http.get(`${REPO}/pulls/10/files`, () =>
        HttpResponse.json({ message: "Forbidden" }, { status: 403 }),
      ),
      ...handlers(s, { pages: [], files: [] }),
    );
    await expect(
      findBotPrsWithoutChangeset({ ...base, bots: ["dependabot[bot]"] }),
    ).rejects.toThrow(/GET \/repos\/acme\/app\/pulls\/10\/files failed \(403\)/);
  });
});
