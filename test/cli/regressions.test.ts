import { realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exitCodeFor, reportError, UsageError } from "../../src/cli/errors.ts";
import type { CliIo } from "../../src/cli/io.ts";
import { LaunchsetError } from "../../src/core/errors.ts";
import { GitError } from "../../src/git/index.ts";
import { GitHubError } from "../../src/github/errors.ts";
import { VerifyError } from "../../src/verify/types.ts";
import { cli, fixtureRepo } from "./helpers.ts";

function report(error: unknown, env: CliIo["env"] = {}): string {
  let stderr = "";
  reportError(
    {
      stdout: () => {},
      stderr: (t) => {
        stderr += t;
      },
      env,
      isTTY: false,
      cwd: "/",
    },
    error,
  );
  return stderr;
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("error reporting", () => {
  it("treats Git, GitHub and Verify errors as expected, with the hint once", () => {
    const git = new GitError(
      "git push failed: rejected\nHint: pull first",
      "git push",
      "rejected",
      1,
      "pull first",
    );
    const text = report(git);
    expect(text).toBe("error: git push failed: rejected\nhint: pull first\n");

    const github = new GitHubError(
      "GitHub API POST /x failed (403): nope\nHint: grant pull requests: write",
      403,
      "POST /x",
      "grant pull requests: write",
    );
    expect(report(github)).toBe(
      "error: GitHub API POST /x failed (403): nope\nhint: grant pull requests: write\n",
    );

    const verify = new VerifyError("Google Play says the build number is taken");
    const verifyText = report(verify);
    expect(verifyText).toBe("error: Google Play says the build number is taken\n");
    expect(verifyText).not.toContain("bug");
  });

  it("splits an embedded hint even without a hint property", () => {
    const text = report(new Error("something failed\nHint: do this"));
    expect(text).toBe("error: something failed\nhint: do this\n");
    expect(count(text, "do this")).toBe(1);
  });

  it("gives the bug hint only to unexpected errors", () => {
    expect(report(new TypeError("x is undefined"))).toContain("looks like a bug");
    expect(report(new LaunchsetError("c", "bad"))).not.toContain("bug");
    expect(report(Object.assign(new Error("odd"), { hint: "try this" }))).toBe(
      "error: odd\nhint: try this\n",
    );
  });

  it("maps only usage errors to exit code 2", () => {
    expect(exitCodeFor(new UsageError("x"))).toBe(2);
    expect(exitCodeFor(new LaunchsetError("c", "x"))).toBe(1);
    expect(exitCodeFor(new Error("x"))).toBe(1);
  });
});

describe("usage errors exit 2", () => {
  it.each([
    [["status", "--since", "origin/main"], "--since only applies"],
    [["add", "--empty", "--bump", "minor"], "--empty means bump: none"],
    [
      ["stamp", "--target", "web", "--plan", "{}", "--version", "1.0.0"],
      "--plan can't be combined",
    ],
    [["add"], "add needs --bump"],
    [["mark", "--target", "web"], "mark needs --version or the plan"],
    [["verify", "--target", "web"], "verify needs the release plan"],
  ])("%j", async (argv, message) => {
    const f = fixtureRepo();
    const r = await cli(argv, { cwd: f.dir });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(message);
  });

  it("keeps real failures at exit 1", async () => {
    const f = fixtureRepo();
    const r = await cli(["status", "--require-changeset", "--since", "nope/ref"], { cwd: f.dir });
    expect(r.code).toBe(1);
  });
});

describe("flow messages are neutral between CLI and action", () => {
  it("mark and add errors name both the flags and the inputs", async () => {
    const { mark } = await import("../../src/flow/mark.ts");
    const { add } = await import("../../src/flow/add.ts");
    const { createContext } = await import("../../src/flow/context.ts");
    const f = fixtureRepo();
    const context = await createContext({ cwd: f.dir, env: {} });
    await expect(mark(context, { target: "web", fetch: false })).rejects.toThrow(
      "mark needs a plan or a version (CLI: --plan / --version; action: plan / version inputs)",
    );
    await expect(add(context, {})).rejects.toMatchObject({
      hint: expect.stringContaining("action: bump input"),
    });
  });
});

describe("init root", () => {
  function monorepo() {
    const f = fixtureRepo();
    f.repo.commit("add app", {
      "apps/web/package.json": `${JSON.stringify({ name: "web", version: "1.4.0" })}\n`,
    });
    return { ...f, sub: join(f.dir, "apps/web"), top: realpathSync(f.dir) };
  }

  it("sets up the git top-level folder when run in a subfolder, and says so", async () => {
    const { sub, top } = monorepo();
    const r = await cli(["init", "--detect", "--json"], { cwd: sub });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).detection.root).toBe(top);
    expect(r.stderr).toContain(`note: init sets up the repo root ${top}`);
    expect(r.stderr).toContain("--cwd");
  });

  it("says nothing at the top level", async () => {
    const { dir } = monorepo();
    const r = await cli(["init", "--detect", "--json"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("sets up the subfolder with an explicit --cwd and warns about workflows", async () => {
    const { sub, dir, top } = monorepo();
    const r = await cli(["init", "--detect", "--json", "--cwd", "apps/web"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(realpathSync(JSON.parse(r.stdout).detection.root)).toBe(realpathSync(sub));
    expect(r.stderr).toContain("warning:");
    expect(r.stderr).toContain(`subfolder of the repo ${top}`);
    expect(r.stderr).toContain("only runs workflows from the repo root");
  });

  it("documents --cwd for init", async () => {
    const r = await cli(["init", "--help"]);
    expect(r.stdout).toMatch(/--cwd <dir>\s+set up this folder \(default: the git repo root/);
  });
});

describe("plan --preview writes nothing", () => {
  it("doesn't reserve the prerelease tag", async () => {
    const f = fixtureRepo("1.4.0", {
      config: {
        targets: { web: { type: "web" } },
        preview: { branches: [{ branch: "next/*", prerelease: "alpha" }] },
      },
    });
    f.repo.checkout("-b", "next/login");
    f.repo.commit("feat", {
      ".launchset/brave-lions.md": "---\nbump: minor\n---\n\nAdd login\n",
    });
    f.repo.git("push", "--quiet", "origin", "next/login");
    const r = await cli(["plan", "--preview", "--run-number", "3"], { cwd: f.dir });
    expect(r.code).toBe(0);
    const plan = JSON.parse(r.stdout);
    expect(plan.tag).toBe("v1.5.0-alpha.0");
    expect(plan.channel).toBe("prerelease");
    expect(r.stderr).toContain("Tag: v1.5.0-alpha.0 (not reserved: dry run)");
    expect(f.repo.git("ls-remote", "--tags", "origin")).not.toContain("alpha");
    expect(f.repo.git("tag", "--list", "v1.5.0-alpha.*")).toBe("");
  });
});
