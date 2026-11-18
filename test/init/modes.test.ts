import { describe, expect, it } from "vitest";
import {
  type Decision,
  INIT_FLAGS,
  type Prompter,
  parseDecide,
  runInit,
} from "../../src/init/index.ts";
import { collect, fixture, fixtureRepo, git, options, read, status } from "./helpers.ts";

describe("init --convert-only", () => {
  it("only converts .changeset/*.md, warns about pre.json, and is idempotent", async () => {
    const dir = fixtureRepo("changesets");
    const out = collect();
    const result = await runInit(options(dir, { convertOnly: true, output: out }));
    expect(result.mode).toBe("convert-only");
    // Names are deterministic: three words seeded from the source path.
    expect(status(dir)).toEqual([
      "?? .launchset/brave-lions-sing.md",
      "?? .launchset/fair-trains-rush.md",
    ]);
    expect(read(dir, ".launchset/brave-lions-sing.md")).toBe(
      "---\nbump: minor\n---\n\nAdd a date picker widget.\n",
    );
    expect(out.warnings).toEqual([
      ".changeset/pre.json (Changesets pre mode) is ignored: launchset has no pre mode. Use a prerelease branch instead (preview.branches with prerelease), and run `launchset init --convert-only` on that branch.",
    ]);
    expect(result.manualSteps).toEqual([
      "The .changeset/ folder is no longer used: you can delete it (config.json and README.md were left alone).",
    ]);

    // A second run converts nothing new (same-name files are recognized).
    git(dir, "add", "--all");
    git(dir, "commit", "--quiet", "--no-verify", "-m", "converted");
    const again = await runInit(options(dir, { convertOnly: true }));
    expect(again.changes).toEqual([]);
    expect(status(dir)).toEqual([]);
  });

  it("fails on a broken Changesets file before writing anything", async () => {
    const dir = fixtureRepo("changesets");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      `${dir}/.changeset/broken.md`,
      '---\n"@demonsters/widgets": huge\n---\n\nOops.\n',
    );
    await expect(runInit(options(dir, { convertOnly: true }))).rejects.toThrow(
      '.changeset/broken.md:2: invalid Changesets bump "huge" for "@demonsters/widgets"',
    );
    expect(status(dir)).toEqual(["?? .changeset/broken.md"]);
  });
});

/** A prompter that answers from a map and records what it was asked. */
function scripted(
  answers: Record<string, string>,
): Prompter & { asked: Decision[]; notes: string[] } {
  const asked: Decision[] = [];
  const notes: string[] = [];
  return {
    asked,
    notes,
    async ask(decision, validate) {
      asked.push(decision);
      const value = answers[decision.id] ?? decision.default;
      const error = validate?.(value);
      if (error) throw new Error(`test answer ${decision.id}=${value}: ${error}`);
      return value;
    },
    note(message) {
      notes.push(message);
    },
  };
}

describe("init interactive", () => {
  it("asks every applicable decision with its default and skips those that don't apply", async () => {
    const dir = fixtureRepo("docker-v", { tags: ["v1.3.0"] });
    const prompter = scripted({ "target.docker": "none", "target.web": "auto" });
    const result = await runInit(options(dir, { interactive: true, prompter }));
    expect(prompter.asked.map((d) => d.id)).toEqual([
      "version",
      "tags.release",
      "target.docker",
      "target.web",
      // docker.* and image.* only apply to a docker target: not asked.
      "machinery..github/workflows/docker.yml#1",
      "baseline",
      "offset",
      "skill",
    ]);
    expect(prompter.asked[0]?.default).toBe("1.4.0");
    expect(prompter.notes[0]).toContain("Versions found:");
    expect(result.answers["target.docker"]).toBe("none");
    expect(read(dir, "launchset.config.ts")).toContain('    web: { type: "web" },\n');
    expect(read(dir, "launchset.config.ts")).not.toContain("docker");
  });

  it("without a TTY (interactive false) and without --yes, uses the defaults", async () => {
    const dir = fixtureRepo("docker-v", { tags: ["v1.3.0"] });
    const prompter = scripted({});
    const result = await runInit(options(dir, { interactive: false, prompter }));
    expect(prompter.asked).toEqual([]);
    expect(result.answers["target.docker"]).toBe("auto");
  });

  it("--yes never prompts", async () => {
    const dir = fixtureRepo("docker-v", { tags: ["v1.3.0"] });
    const prompter = scripted({});
    await runInit(options(dir, { interactive: true, yes: true, prompter }));
    expect(prompter.asked).toEqual([]);
  });
});

describe("init decisions: errors", () => {
  const repo = () => fixtureRepo("docker-v", { tags: ["v1.3.0"] });

  it("rejects unknown ids and lists the valid ones", async () => {
    const dir = repo();
    const error = await runInit(
      options(dir, { yes: true, decide: { "target.androd": "auto" } }),
    ).catch((e) => e);
    expect(error.message).toBe('Unknown decision "target.androd".');
    expect(error.hint).toContain(
      "Valid decision ids: version, tags.release, target.docker, target.web,",
    );
    expect(status(dir)).toEqual([]);
  });

  it("rejects invalid values and lists the options", async () => {
    const dir = repo();
    const error = await runInit(
      options(dir, { yes: true, decide: { "target.docker": "sometimes" } }),
    ).catch((e) => e);
    expect(error.message).toBe(
      "--decide target.docker=sometimes: expected one of auto, manual, none.",
    );
    expect(error.hint).toBe("Options: auto | manual | none.");

    const version = await runInit(options(dir, { yes: true, decide: { version: "v1.5" } })).catch(
      (e) => e,
    );
    expect(version.message).toBe(
      "--decide version=v1.5: expected a plain X.Y.Z version (no v prefix, no prerelease).",
    );
    const tags = await runInit(
      options(dir, { yes: true, decide: { "docker.docker.tags": "latest" } }),
    ).catch((e) => e);
    expect(tags.message).toBe(
      "--decide docker.docker.tags=latest: expected at least one template containing {version} (it's the tag registry verify checks).",
    );
    const image = await runInit(
      options(dir, { yes: true, decide: { "docker.docker.image": "ghcr.io/x/api:1.0" } }),
    ).catch((e) => e);
    expect(image.message).toBe(
      "--decide docker.docker.image=ghcr.io/x/api:1.0: expected an image name without tag or digest, like ghcr.io/org/app.",
    );
    expect(status(dir)).toEqual([]);
  });

  it("needs at least one auto target", async () => {
    const dir = repo();
    await expect(
      runInit(
        options(dir, { yes: true, decide: { "target.docker": "manual", "target.web": "none" } }),
      ),
    ).rejects.toThrow(
      'At least one target must have release: "auto", otherwise no release ever completes.',
    );
    expect(status(dir)).toEqual([]);
  });

  it("flags conflict with --decide; --hook needs a hook setup", async () => {
    const dir = repo();
    await expect(
      runInit(options(dir, { yes: true, baseline: true, decide: { baseline: "no" } })),
    ).rejects.toThrow("--baseline conflicts with --decide baseline=no.");
    await expect(runInit(options(dir, { yes: true, hook: true }))).rejects.toThrow(
      "--hook: no pre-push hook setup found (simple-git-hooks, husky or lefthook).",
    );
    // --no-skill answers the skill decision.
    const result = await runInit(options(dir, { yes: true, skill: false }));
    expect(result.answers.skill).toBe("no");
    expect(status(dir).some((s) => s.includes(".claude/"))).toBe(false);
  });

  it("parses --decide values", () => {
    expect(
      parseDecide(["version=1.4.0", "target.ios=manual", "docker.api.tags=v{version}, latest"]),
    ).toEqual({
      version: "1.4.0",
      "target.ios": "manual",
      "docker.api.tags": "v{version}, latest",
    });
    expect(() => parseDecide(["version"])).toThrow("--decide version: expected <id>=<value>.");
    expect(() => parseDecide(["version=1.0.0", "version=2.0.0"])).toThrow(
      "--decide version is given twice with different values (1.0.0, 2.0.0).",
    );
  });

  it("documents every named flag and the decision it answers", () => {
    expect(INIT_FLAGS.map((f) => [f.flag, f.option, f.decision ?? null])).toEqual([
      ["--yes", "yes", null],
      ["--decide", "decide", null],
      ["--detect", "detect", null],
      ["--json", "json", null],
      ["--convert-only", "convertOnly", null],
      ["--baseline", "baseline", "baseline"],
      ["--skill", "skill", "skill"],
      ["--hook", "hook", "hook"],
    ]);
  });

  it("detect mode with --decide shows the answers' effect on later defaults", async () => {
    const dir = repo();
    const result = await runInit(
      options(dir, { detect: true, json: true, decide: { version: "1.3.0" } }),
    );
    const baseline = result.detect?.decisions.find((d) => d.id === "baseline");
    expect(baseline?.default).toBe("no");
    expect(baseline?.question).toContain("v1.3.0 already exists");
    expect(read(dir, "package.json")).toBe(fixture("docker-v", "package.json"));
  });
});
