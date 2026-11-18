import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseChangeset } from "../../src/core/changesets.ts";
import { tempDir } from "../git/helpers.ts";
import { cli, fixtureRepo, readJson } from "./helpers.ts";

const COMMANDS = [
  "init",
  "add",
  "status",
  "version",
  "plan",
  "stamp",
  "verify",
  "mark",
  "ship",
  "finalize",
  "hotfix",
  "check",
];

const packageVersion = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

// biome-ignore lint/suspicious/noExplicitAny: test helper over arbitrary JSON.
function json(text: string): Record<string, any> {
  // biome-ignore lint/suspicious/noExplicitAny: same.
  return JSON.parse(text) as Record<string, any>;
}

function changesets(dir: string): string[] {
  const root = join(dir, ".launchset");
  return readdirSync(root).filter((f) => f.endsWith(".md") && f !== "README.md");
}

describe("help and version", () => {
  it("prints the top-level help with every command", async () => {
    const r = await cli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("Usage: launchset");
    for (const name of COMMANDS) expect(r.stdout).toMatch(new RegExp(`^  ${name}\\b`, "m"));
    expect(r.stdout).toContain("--cwd <dir>");
  });

  it.each(COMMANDS)("%s --help has usage and an example", async (name) => {
    const r = await cli([name, "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Usage: launchset ${name}`);
    expect(r.stdout).toContain("Example:");
    expect(r.stdout).toContain(`$ launchset ${name}`);
    expect(r.stderr).toBe("");
  });

  it("prints the package version with -V and --version", async () => {
    for (const flag of ["-V", "--version"]) {
      const r = await cli([flag]);
      expect(r).toEqual({ code: 0, stdout: `${packageVersion}\n`, stderr: "" });
    }
  });

  it("keeps --version as a value for the commands that take one", async () => {
    const f = fixtureRepo();
    const r = await cli(["stamp", "--target", "web", "--version", "2.0.0"], { cwd: f.dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("version 2.0.0");
  });

  it("documents the init flags", async () => {
    const r = await cli(["init", "--help"]);
    for (const flag of [
      "--decide <id=value>",
      "--detect",
      "--convert-only",
      "--yes",
      "--json",
      "--baseline",
      "--no-baseline",
      "--skill",
      "--no-skill",
      "--hook",
      "--no-hook",
    ]) {
      expect(r.stdout).toContain(flag);
    }
  });
});

describe("usage errors", () => {
  it("rejects an unknown command with exit code 2", async () => {
    const r = await cli(["frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("error: unknown command 'frobnicate'");
  });

  it("rejects an unknown option", async () => {
    const f = fixtureRepo();
    const r = await cli(["status", "--frobnicate"], { cwd: f.dir });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("error: unknown option '--frobnicate'");
  });

  it("rejects a missing required option and a bad bump", async () => {
    const f = fixtureRepo();
    const stamp = await cli(["stamp", "--version", "1.0.0"], { cwd: f.dir });
    expect(stamp.code).toBe(2);
    expect(stamp.stderr).toContain("required option '--target <name>'");
    const add = await cli(["add", "--bump", "huge", "-m", "x"], { cwd: f.dir });
    expect(add.code).toBe(2);
    expect(add.stderr).toContain("--bump");
    expect(changesets(f.dir)).toEqual([]);
  });

  it("rejects a bad build number and a missing hotfix argument", async () => {
    const f = fixtureRepo();
    const bn = await cli(
      ["stamp", "--target", "web", "--version", "1.0.0", "--build-number", "x"],
      {
        cwd: f.dir,
      },
    );
    expect(bn.code).toBe(2);
    expect(bn.stderr).toContain("positive integer");
    const hotfix = await cli(["hotfix"], { cwd: f.dir });
    expect(hotfix.code).toBe(2);
    expect(hotfix.stderr).toContain("missing required argument");
  });
});

describe("errors", () => {
  it("prints error and hint without a stack, exit code 1", async () => {
    const dir = tempDir("empty");
    const r = await cli(["status"], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^error: no launchset config found in .*\nhint: Run `launchset init`/);
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });

  it("prints the stack with LAUNCHSET_DEBUG", async () => {
    const dir = tempDir("empty");
    const r = await cli(["status"], { cwd: dir, env: { LAUNCHSET_DEBUG: "1" } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("error: no launchset config found");
    expect(r.stderr).toMatch(/\n\s+at /);
  });

  it("colors error labels only on a terminal without NO_COLOR", async () => {
    const dir = tempDir("empty");
    const plain = await cli(["status"], { cwd: dir });
    expect(plain.stderr).not.toContain("\u001b[");
    const tty = await cli(["status"], { cwd: dir, isTTY: true, env: {} });
    expect(tty.stderr).toContain("\u001b[");
    const noColor = await cli(["status"], { cwd: dir, isTTY: true, env: { NO_COLOR: "1" } });
    expect(noColor.stderr).not.toContain("\u001b[");
  });

  it("rejects a malformed --repo", async () => {
    const f = fixtureRepo();
    const r = await cli(["status", "--repo", "nope"], { cwd: f.dir });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("error: --repo nope is not owner/repo");
  });
});

describe("--cwd and the config root", () => {
  it("runs in --cwd, also before the command name", async () => {
    const f = fixtureRepo();
    const elsewhere = tempDir("elsewhere");
    for (const argv of [
      ["--cwd", f.dir, "status", "--json"],
      ["status", "--cwd", f.dir, "--json"],
    ]) {
      const r = await cli(argv, { cwd: elsewhere });
      expect(r.code).toBe(0);
      expect(json(r.stdout).version).toBe("1.4.0");
    }
  });

  it("resolves a relative --cwd against the shell directory", async () => {
    const f = fixtureRepo();
    const r = await cli(["--cwd", basename(f.dir), "status", "--json"], { cwd: dirname(f.dir) });
    expect(r.code).toBe(0);
    expect(json(r.stdout).version).toBe("1.4.0");
  });

  it("finds the config from a subdirectory", async () => {
    const f = fixtureRepo();
    f.repo.write("ios/.keep", "");
    const r = await cli(["status", "--json"], { cwd: join(f.dir, "ios") });
    expect(r.code).toBe(0);
    expect(json(r.stdout).version).toBe("1.4.0");
  });
});

describe("add", () => {
  it("writes a valid changeset and prints its path", async () => {
    const f = fixtureRepo();
    const r = await cli(["add", "--bump", "minor", "--message", "Add dark mode"], { cwd: f.dir });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const path = r.stdout.trim();
    expect(path).toMatch(/^\.launchset\/[a-z-]+\.md$/);
    const parsed = parseChangeset(readFileSync(join(f.dir, path), "utf8"), path);
    expect(parsed.changeset).toMatchObject({ bump: "minor", summary: "Add dark mode" });
  });

  it("writes bump: none with --empty", async () => {
    const f = fixtureRepo();
    const r = await cli(["add", "--empty"], { cwd: f.dir });
    expect(r.code).toBe(0);
    const path = r.stdout.trim();
    expect(parseChangeset(readFileSync(join(f.dir, path), "utf8"), path).changeset.bump).toBe(
      "none",
    );
  });

  it("prints JSON with --json", async () => {
    const f = fixtureRepo();
    const r = await cli(["add", "-m", "Fix it", "--bump", "patch", "--json"], { cwd: f.dir });
    expect(r.code).toBe(0);
    const data = json(r.stdout);
    expect(data).toMatchObject({ bump: "patch", summary: "Fix it" });
    expect(existsSync(data.absolute)).toBe(true);
  });

  it("fails without flags when there is no terminal", async () => {
    const f = fixtureRepo();
    const r = await cli(["add"], { cwd: f.dir });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(
      "error: add needs --bump <major|minor|patch|none> and --message <text>",
    );
    expect(r.stderr).toContain("hint: Pass the flags");
    expect(changesets(f.dir)).toEqual([]);
  });

  it("fails with --yes even in a terminal, and without a message", async () => {
    const f = fixtureRepo();
    const yes = await cli(["add", "--yes"], { cwd: f.dir, isTTY: true });
    expect(yes.code).toBe(1);
    expect(yes.stderr).toContain("error: add needs --bump");
    const bare = await cli(["add", "--bump", "minor"], { cwd: f.dir });
    expect(bare.code).toBe(1);
    expect(bare.stderr).toContain("error: a minor changeset needs a summary");
    expect(changesets(f.dir)).toEqual([]);
  });

  it("rejects --empty with a bump", async () => {
    const f = fixtureRepo();
    const r = await cli(["add", "--empty", "--bump", "major"], { cwd: f.dir });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("error: --empty means bump: none");
  });

  it("asks for the bump and summary in a terminal without flags", async () => {
    const f = fixtureRepo();
    const asked: string[] = [];
    const r = await cli(["add"], {
      cwd: f.dir,
      isTTY: true,
      io: {
        addPrompts: {
          bump: async () => {
            asked.push("bump");
            return "major";
          },
          summary: async () => {
            asked.push("summary");
            return "Drop the old API";
          },
        },
      },
    });
    expect(r.code).toBe(0);
    expect(asked).toEqual(["bump", "summary"]);
    const path = r.stdout.trim();
    const parsed = parseChangeset(readFileSync(join(f.dir, path), "utf8"), path);
    expect(parsed.changeset).toMatchObject({ bump: "major", summary: "Drop the old API" });
  });

  it("does not ask the summary for bump none, and never asks when flags are given", async () => {
    const f = fixtureRepo();
    const never = {
      bump: async () => {
        throw new Error("prompted");
      },
      summary: async () => {
        throw new Error("prompted");
      },
    };
    const none = await cli(["add"], {
      cwd: f.dir,
      isTTY: true,
      io: { addPrompts: { ...never, bump: async () => "none" } },
    });
    expect(none.code).toBe(0);
    const flags = await cli(["add", "--bump", "patch", "-m", "x"], {
      cwd: f.dir,
      isTTY: true,
      io: { addPrompts: never },
    });
    expect(flags.code).toBe(0);
  });
});

describe("status", () => {
  it("prints text by default", async () => {
    const f = fixtureRepo();
    const r = await cli(["status"], { cwd: f.dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Version:       1.4.0");
    expect(r.stdout).toContain("Last release:  v1.4.0");
  });

  it("prints only JSON on stdout with --json", async () => {
    const f = fixtureRepo();
    await cli(["add", "--bump", "minor", "-m", "Add dark mode"], { cwd: f.dir });
    const r = await cli(["status", "--json"], { cwd: f.dir });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const data = json(r.stdout);
    expect(data).toMatchObject({
      branch: "main",
      version: "1.4.0",
      bump: "minor",
      nextVersion: "1.5.0",
      lastRelease: { version: "1.4.0", tag: "v1.4.0" },
      consistency: { ok: true, mismatches: [] },
    });
    expect(data.pending).toHaveLength(1);
    expect(data.pending[0].summary).toBe("Add dark mode");
    expect(data.manualTargets).toEqual([{ target: "ios", lastShipped: null, releasesBehind: 1 }]);
  });

  it("--require-changeset fails (exit 1) without a changeset since the base ref", async () => {
    const f = fixtureRepo();
    const r = await cli(["status", "--require-changeset", "--since", "origin/main"], {
      cwd: f.dir,
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("no changeset added or changed compared with origin/main");
  });

  it("--require-changeset passes with a new changeset and reports it in JSON", async () => {
    const f = fixtureRepo();
    await cli(["add", "--bump", "patch", "-m", "Fix it"], { cwd: f.dir });
    const r = await cli(["status", "--require-changeset", "--since", "origin/main", "--json"], {
      cwd: f.dir,
    });
    expect(r.code).toBe(0);
    const data = json(r.stdout);
    expect(data.requireChangeset.ok).toBe(true);
    expect(data.requireChangeset.since).toBe("origin/main");
    expect(data.requireChangeset.changesets).toHaveLength(1);
  });

  it("keeps stdout pure JSON on failure and explains on stderr", async () => {
    const f = fixtureRepo();
    const r = await cli(["status", "--require-changeset", "--since", "origin/main", "--json"], {
      cwd: f.dir,
    });
    expect(r.code).toBe(1);
    expect(json(r.stdout).requireChangeset.ok).toBe(false);
    expect(r.stderr).toContain("no changeset added or changed");
  });

  it("rejects an unknown --since ref and --since without --require-changeset", async () => {
    const f = fixtureRepo();
    const unknown = await cli(["status", "--require-changeset", "--since", "nope/ref"], {
      cwd: f.dir,
    });
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("error: --since nope/ref isn't a known commit or branch");
    const alone = await cli(["status", "--since", "origin/main"], { cwd: f.dir });
    expect(alone.code).toBe(1);
    expect(alone.stderr).toContain("--since only applies with --require-changeset");
  });
});

describe("version", () => {
  it("--dry-run prints the diff and writes nothing", async () => {
    const f = fixtureRepo();
    await cli(["add", "--bump", "minor", "-m", "Add dark mode"], { cwd: f.dir });
    const r = await cli(["version", "--dry-run"], { cwd: f.dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Would set the version to 1.5.0");
    expect(r.stdout).toContain('+  "version": "1.5.0"');
    expect(readJson(f.dir, "package.json").version).toBe("1.4.0");
    expect(changesets(f.dir)).toHaveLength(1);
  });

  it("applies the changesets without --dry-run", async () => {
    const f = fixtureRepo();
    await cli(["add", "--bump", "minor", "-m", "Add dark mode"], { cwd: f.dir });
    const r = await cli(["version"], { cwd: f.dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Version set to 1.5.0");
    expect(readJson(f.dir, "package.json").version).toBe("1.5.0");
    expect(changesets(f.dir)).toEqual([]);
    expect(readFileSync(join(f.dir, "CHANGELOG.md"), "utf8")).toContain("Add dark mode");
  });

  it("says so when nothing is pending", async () => {
    const f = fixtureRepo();
    const r = await cli(["version", "--dry-run", "--json"], { cwd: f.dir });
    expect(r.code).toBe(0);
    expect(json(r.stdout)).toMatchObject({ version: null, dryRun: true });
  });
});

describe("plan", () => {
  it("prints the plan as JSON, notes on stderr", async () => {
    const f = fixtureRepo();
    const r = await cli(["plan"], { cwd: f.dir });
    expect(r.code).toBe(0);
    expect(json(r.stdout)).toMatchObject({ schemaVersion: 1, mode: "none", version: "1.4.0" });
    expect(r.stderr).toContain("note: Nothing to release");
  });

  it("plans a release PR with pending changesets, same output with --json", async () => {
    const f = fixtureRepo();
    await cli(["add", "--bump", "minor", "-m", "Add dark mode"], { cwd: f.dir });
    f.repo.commit("add changeset");
    f.repo.git("push", "--quiet", "origin", "main");
    const plain = await cli(["plan"], { cwd: f.dir });
    const asJson = await cli(["plan", "--json"], { cwd: f.dir });
    expect(plain.code).toBe(0);
    expect(json(plain.stdout)).toMatchObject({ mode: "release-pr", version: "1.5.0" });
    expect(asJson.stdout).toBe(plain.stdout);
    // plan only decides: no branch, no PR.
    expect(f.repo.git("branch", "--list")).not.toContain("launchset");
  });

  it("plans a hand-made build of a manual target", async () => {
    const f = fixtureRepo();
    const r = await cli(["plan", "--target", "ios"], { cwd: f.dir });
    expect(r.code).toBe(0);
    const plan = json(r.stdout);
    expect(plan).toMatchObject({ mode: "ship", version: "1.4.0", matrix: ["ios"] });
    expect(plan.buildNumber).toBeGreaterThan(0);
  });

  it("--preview prints the preview plan on a branch", async () => {
    const f = fixtureRepo();
    f.repo.checkout("-b", "feature/x");
    f.repo.commit("work");
    const r = await cli(["plan", "--preview", "--run-number", "12"], { cwd: f.dir });
    expect(r.code).toBe(0);
    expect(json(r.stdout)).toMatchObject({
      channel: "preview",
      version: "1.4.1-feature-x.12",
    });
    const noRun = await cli(["plan", "--preview"], { cwd: f.dir });
    expect(noRun.code).toBe(1);
    expect(noRun.stderr).toContain("error: a preview version needs the workflow run number");
  });
});

describe("stamp", () => {
  it("writes the version and build number from flags", async () => {
    const f = fixtureRepo();
    const r = await cli(
      ["stamp", "--target", "ios", "--version", "1.5.0", "--build-number", "217000000"],
      { cwd: f.dir },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ios: version 1.5.0, build number 217000000 (release)");
    const text = readFileSync(join(f.dir, "ios/Version.xcconfig"), "utf8");
    expect(text).toContain("MARKETING_VERSION = 1.5.0");
    expect(text).toContain("CURRENT_PROJECT_VERSION = 217000000");
  });

  it("prints JSON with the env variables for later steps", async () => {
    const f = fixtureRepo();
    const r = await cli(
      ["stamp", "--target", "ios", "--version", "1.5.0", "--build-number", "7", "--json"],
      { cwd: f.dir },
    );
    expect(r.code).toBe(0);
    expect(json(r.stdout)).toMatchObject({
      target: "ios",
      version: "1.5.0",
      buildNumber: 7,
      env: {
        LAUNCHSET_VERSION: "1.5.0",
        LAUNCHSET_BUILD_NUMBER: "7",
        LAUNCHSET_CHANNEL: "release",
      },
    });
  });

  it("takes the plan from --plan @file and from LAUNCHSET_PLAN", async () => {
    const f = fixtureRepo();
    const plan = (await cli(["plan", "--target", "ios"], { cwd: f.dir })).stdout;
    const file = join(tempDir("plan"), "plan.json");
    writeFileSync(file, plan);
    const build = json(plan).buildNumber;
    const viaFile = await cli(["stamp", "--target", "ios", "--plan", `@${file}`], { cwd: f.dir });
    expect(viaFile.code).toBe(0);
    expect(readFileSync(join(f.dir, "ios/Version.xcconfig"), "utf8")).toContain(
      `CURRENT_PROJECT_VERSION = ${build}`,
    );
    f.repo.git("checkout", "--", ".");
    const viaEnv = await cli(["stamp", "--target", "ios"], {
      cwd: f.dir,
      env: { LAUNCHSET_PLAN: plan },
    });
    expect(viaEnv.code).toBe(0);
    expect(viaEnv.stdout).toContain(`build number ${build}`);
    f.repo.git("checkout", "--", ".");
    const inline = await cli(["stamp", "--target", "ios", "--plan", plan], { cwd: f.dir });
    expect(inline.code).toBe(0);
  });

  it("lets explicit flags win over LAUNCHSET_PLAN", async () => {
    const f = fixtureRepo();
    const plan = (await cli(["plan", "--target", "ios"], { cwd: f.dir })).stdout;
    const r = await cli(["stamp", "--target", "ios", "--version", "3.0.0"], {
      cwd: f.dir,
      env: { LAUNCHSET_PLAN: plan },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("version 3.0.0");
  });

  it("explains what is missing or conflicting", async () => {
    const f = fixtureRepo();
    const none = await cli(["stamp", "--target", "web"], { cwd: f.dir });
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("error: stamp needs --version or the plan");
    const both = await cli(["stamp", "--target", "web", "--plan", "{}", "--version", "1.0.0"], {
      cwd: f.dir,
    });
    expect(both.code).toBe(1);
    expect(both.stderr).toContain("--plan can't be combined");
    const file = await cli(["stamp", "--target", "web", "--plan", "@/no/such/plan.json"], {
      cwd: f.dir,
    });
    expect(file.code).toBe(1);
    expect(file.stderr).toContain("error: can't read the plan file /no/such/plan.json");
    const unknown = await cli(["stamp", "--target", "nope", "--version", "1.0.0"], { cwd: f.dir });
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('error: there is no target "nope"');
  });
});

describe("verify, mark, finalize, ship, hotfix, check", () => {
  it("verify and finalize need a plan", async () => {
    const f = fixtureRepo();
    for (const argv of [["verify", "--target", "web"], ["finalize"]]) {
      const r = await cli(argv, { cwd: f.dir });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("needs the release plan");
      expect(r.stderr).toContain("hint: Pass --plan");
    }
  });

  it("reports an invalid plan", async () => {
    const f = fixtureRepo();
    const r = await cli(["verify", "--target", "web", "--plan", "not json"], { cwd: f.dir });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("error: the plan input is not valid JSON");
  });

  it("finalize needs a GitHub token", async () => {
    const f = fixtureRepo();
    const plan = (await cli(["plan", "--target", "ios"], { cwd: f.dir })).stdout;
    const r = await cli(["finalize"], { cwd: f.dir, env: { LAUNCHSET_PLAN: plan } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("error: finalize needs a GitHub token");
    expect(r.stderr).toContain("hint: Pass --token");
  });

  it("mark needs --version or a plan; marks an auto target by version", async () => {
    const f = fixtureRepo();
    const none = await cli(["mark", "--target", "web"], { cwd: f.dir });
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("mark needs --version or the plan");
    const r = await cli(["mark", "--target", "web", "--version", "1.4.0", "--json"], {
      cwd: f.dir,
    });
    expect(r.code).toBe(0);
    expect(json(r.stdout)).toMatchObject({ target: "web", version: "1.4.0" });
    expect(f.repo.git("tag", "--list", "launchset/*")).toContain("launchset/web@1.4.0");
  });

  it("ship prepares a manual target and prints the build number as JSON", async () => {
    const f = fixtureRepo();
    const r = await cli(["ship", "--target", "ios", "--json"], { cwd: f.dir });
    expect(r.code).toBe(0);
    const data = json(r.stdout);
    expect(data).toMatchObject({ target: "ios", version: "1.4.0", tag: "v1.4.0", shipped: true });
    expect(data.env.LAUNCHSET_BUILD_NUMBER).toBe(String(data.buildNumber));
    expect(readFileSync(join(f.dir, "ios/Version.xcconfig"), "utf8")).toContain(
      `CURRENT_PROJECT_VERSION = ${data.buildNumber}`,
    );
  });

  it("ship refuses an auto target", async () => {
    const f = fixtureRepo();
    const r = await cli(["ship", "--target", "web"], { cwd: f.dir });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("error: web is an auto target");
  });

  it("hotfix creates the maintenance branch", async () => {
    const f = fixtureRepo();
    const r = await cli(["hotfix", "1.4"], { cwd: f.dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("release/1.4.x");
    expect(f.repo.git("branch", "--list", "release/1.4.x")).toContain("release/1.4.x");
    const bad = await cli(["hotfix", "one"], { cwd: f.dir });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("error:");
  });

  it("check --base fails (exit 1) without a changeset and passes with one", async () => {
    const f = fixtureRepo();
    f.repo.checkout("-b", "feature");
    f.repo.commit("work");
    const failing = await cli(["check", "--base", "origin/main"], { cwd: f.dir });
    expect(failing.code).toBe(1);
    expect(failing.stdout).toContain("no-changeset");
    await cli(["add", "--bump", "patch", "-m", "Fix it"], { cwd: f.dir });
    f.repo.commit("changeset");
    const passing = await cli(["check", "--base", "origin/main", "--json"], { cwd: f.dir });
    expect(passing.code).toBe(0);
    expect(json(passing.stdout).result).toBeDefined();
  });

  it("check --push warns but never fails", async () => {
    const f = fixtureRepo();
    f.repo.commit("work");
    const r = await cli(["check", "--push"], { cwd: f.dir });
    expect(r.code).toBe(0);
  });
});

describe("init", () => {
  it("--detect --json prints only JSON and writes nothing", async () => {
    const dir = tempDir("init");
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "app", version: "2.1.0" })}\n`,
    );
    const before = readdirSync(dir).sort();
    const r = await cli(["init", "--detect", "--json"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const out = json(r.stdout);
    expect(out.schemaVersion).toBe(1);
    expect(out.detection.canonical.version).toBe("2.1.0");
    expect(Array.isArray(out.decisions)).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  it("--detect prints a readable report without --json", async () => {
    const dir = tempDir("init");
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "app", version: "2.1.0" })}\n`,
    );
    const r = await cli(["init", "--detect"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("canonical: 2.1.0");
    expect(readdirSync(dir)).toEqual(["package.json"]);
  });

  it("--yes writes the config and workflows without prompting", async () => {
    const dir = tempDir("init");
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "app", version: "2.1.0" })}\n`,
    );
    const r = await cli(["init", "--yes", "--no-baseline", "--no-skill"], {
      cwd: dir,
      isTTY: true,
    });
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "launchset.config.ts"))).toBe(true);
    expect(existsSync(join(dir, ".launchset/README.md"))).toBe(true);
  });

  it("runs without prompts when stdin is not a terminal", async () => {
    const dir = tempDir("init");
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "app", version: "2.1.0" })}\n`,
    );
    const never = {
      ask: async () => {
        throw new Error("prompted");
      },
    };
    const r = await cli(["init", "--no-baseline", "--no-skill"], {
      cwd: dir,
      io: { initPrompter: never },
    });
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "launchset.config.ts"))).toBe(true);
  });

  it("asks through the prompter in a terminal", async () => {
    const dir = tempDir("init");
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "app", version: "2.1.0" })}\n`,
    );
    const asked: string[] = [];
    const r = await cli(["init", "--no-baseline", "--no-skill"], {
      cwd: dir,
      isTTY: true,
      io: {
        initPrompter: {
          ask: async (decision) => {
            asked.push(decision.id);
            return decision.default;
          },
          note: () => {},
        },
      },
    });
    expect(r.code).toBe(0);
    expect(asked.length).toBeGreaterThan(0);
  });

  it("passes --decide through and rejects a malformed one", async () => {
    const dir = tempDir("init");
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "app", version: "2.1.0" })}\n`,
    );
    const r = await cli(
      ["init", "--yes", "--no-skill", "--decide", "version=2.2.0", "--decide", "baseline=no"],
      { cwd: dir },
    );
    expect(r.code).toBe(0);
    expect(readJson(dir, "package.json").version).toBe("2.2.0");
    const bad = await cli(["init", "--detect", "--decide", "oops"], { cwd: dir });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("error: --decide oops: expected <id>=<value>");
  });

  it("--convert-only converts Changesets files", async () => {
    const dir = tempDir("init");
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "app", version: "2.1.0" })}\n`,
    );
    const r = await cli(["init", "--convert-only"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("No .changeset/*.md files to convert.");
  });
});
