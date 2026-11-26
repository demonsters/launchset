/** Regression tests for the init review findings (numbered as in the review). */

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.ts";
import { type InitDetectJson, runInit } from "../../src/init/index.ts";
import { editScripts } from "../../src/init/retire.ts";
import { collect, fixtureRepo, options, read, repoFrom, status } from "./helpers.ts";

const pkg = (name: string, version: string, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ name, version, ...extra }, null, 2)}\n`;

async function detect(dir: string): Promise<InitDetectJson> {
  const result = await runInit(options(dir, { detect: true, json: true }));
  return result.detect as InitDetectJson;
}

function decision(json: InitDetectJson, id: string) {
  const found = json.decisions.find((d) => d.id === id);
  if (!found) throw new Error(`no decision ${id}: ${json.decisions.map((d) => d.id).join(", ")}`);
  return found;
}

function item(json: InitDetectJson, id: string) {
  const found = json.detection.machinery.find((m) => m.id === id);
  if (!found)
    throw new Error(`no item ${id}: ${json.detection.machinery.map((m) => m.id).join(", ")}`);
  return found;
}

describe("1. name@version tags of other packages", () => {
  it("are listed but decide neither the version nor the baseline", async () => {
    const dir = repoFrom(
      { "package.json": pkg("app", "1.4.0") },
      { tags: ["@acme/eslint-config@12.1.0", "v1.3.0"] },
    );
    const json = await detect(dir);
    expect(json.detection.canonical.version).toBe("1.4.0");
    expect(json.detection.tags.find((t) => t.package === "@acme/eslint-config")?.counted).toBe(
      false,
    );
    const version = decision(json, "version");
    expect(version.default).toBe("1.4.0");
    expect(version.options.map((o) => o.value)).toEqual(["1.4.0", "1.3.0"]);
    expect(version.evidence).toContainEqual({
      path: "@acme/eslint-config@12.1.0",
      note: "ignored: tag of another package (@acme/eslint-config), not this repo's version",
    });
    expect(decision(json, "baseline").default).toBe("no");
    expect(decision(json, "tags.release").options.map((o) => o.value)).toEqual(["v{version}"]);
  });

  it("count for the root package and for a target's package", async () => {
    const dir = repoFrom(
      {
        "package.json": pkg("app", "1.4.0"),
        "apps/api/package.json": pkg("api", "1.4.0"),
        "apps/api/Dockerfile": "FROM node\n",
      },
      { tags: ["app@1.4.0", "api@2.0.0"] },
    );
    const json = await detect(dir);
    expect(json.detection.tags.every((t) => t.counted)).toBe(true);
    expect(json.detection.canonical.version).toBe("2.0.0");
  });
});

describe("2. re-running init", () => {
  it("keeps generated files that differ (with a warning) unless overwrite is decided", async () => {
    const dir = fixtureRepo("docker-v", { tags: ["v1.3.0"] });
    await runInit(options(dir, { yes: true }));
    rmSync(join(dir, "launchset.config.ts"));
    writeFileSync(join(dir, ".launchset/README.md"), "# Our notes\n");
    const check = read(dir, ".github/workflows/launchset-check.yml");
    writeFileSync(join(dir, ".github/workflows/launchset-check.yml"), `${check}# edited\n`);

    const json = await detect(dir);
    expect(decision(json, "file..launchset/README.md")).toMatchObject({
      default: "keep",
      ask: true,
    });

    const out = collect();
    await runInit(options(dir, { yes: true, output: out }));
    expect(read(dir, ".launchset/README.md")).toBe("# Our notes\n");
    expect(read(dir, ".github/workflows/launchset-check.yml")).toBe(`${check}# edited\n`);
    expect(out.warnings).toContain(
      ".launchset/README.md already exists and differs from what init would write; it was kept (answer file..launchset/README.md=overwrite to replace it).",
    );
    // An unchanged generated file gives no warning.
    expect(out.warnings.some((w) => w.startsWith(".github/workflows/launchset-release.yml"))).toBe(
      false,
    );

    rmSync(join(dir, "launchset.config.ts"));
    await runInit(
      options(dir, {
        yes: true,
        decide: { "file..github/workflows/launchset-check.yml": "overwrite" },
      }),
    );
    expect(read(dir, ".github/workflows/launchset-check.yml")).toBe(check);
    expect(read(dir, ".launchset/README.md")).toBe("# Our notes\n");
  });
});

const wf = (run: string, on = "on:\n  push:\n    branches: [main]\n") =>
  `${on}jobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - name: Release\n        run: |\n${run
    .split("\n")
    .map((l) => (l === "" ? "" : `          ${l}`))
    .join("\n")}\n`;

describe("3. disabling commands without breaking the script", () => {
  it("neutralizes commands inside if or after && with a `:` no-op, deletes top-level ones", async () => {
    const run = [
      'if [ "$PUBLISH" = "1" ]; then',
      '  git tag "v$VERSION"',
      "fi",
      "npm run build &&",
      "  git push origin --tags",
      "cat <<EOF > notes.txt",
      "git tag is only text here",
      "EOF",
      "gh release create v1",
      "echo done",
    ].join("\n");
    const dir = repoFrom({
      "package.json": pkg("app", "1.0.0"),
      ".github/workflows/r.yml": wf(run),
    });
    await runInit(options(dir, { yes: true }));
    const expected = [
      'if [ "$PUBLISH" = "1" ]; then',
      `  : # launchset: disabled — launchset's finalize creates tags and releases: git tag "v$VERSION"`,
      "fi",
      "npm run build &&",
      "  : # launchset: disabled — launchset's finalize creates tags and releases: git push origin --tags",
      "cat <<EOF > notes.txt",
      "git tag is only text here",
      "EOF",
      "echo done",
    ].join("\n");
    expect(read(dir, ".github/workflows/r.yml")).toBe(wf(expected));
  });

  it("keeps the && chain going when the neutralized command continues it", async () => {
    const dir = repoFrom({
      "package.json": pkg("app", "1.0.0"),
      ".github/workflows/r.yml": wf("npm version patch &&\n  npm publish\necho done"),
    });
    await runInit(options(dir, { yes: true }));
    expect(read(dir, ".github/workflows/r.yml")).toBe(
      wf(
        "npm version patch &&\n  npm publish\necho done".replace(
          "npm version patch &&",
          ": && # launchset: disabled — launchset's finalize creates tags and releases: npm version patch &&",
        ),
      ),
    );
  });

  it("offers no disable for a command in a case item", async () => {
    const dir = repoFrom({
      "package.json": pkg("app", "1.0.0"),
      ".github/workflows/r.yml": wf('case "$REF" in\n  v*) git tag "$REF" ;;\nesac\necho done'),
    });
    const json = await detect(dir);
    expect(item(json, "machinery..github/workflows/r.yml#1").actions).toEqual(["remove", "keep"]);
  });
});

describe("4. Dockerfiles", () => {
  it("skips stray Dockerfiles; with nothing built only the root one is proposed", async () => {
    const dir = repoFrom({
      "package.json": pkg("app", "1.0.0"),
      Dockerfile: "FROM node\n",
      "services/worker/Dockerfile": "FROM node\n",
      ".devcontainer/Dockerfile": "FROM node\n",
      "test/fixtures/Dockerfile": "FROM node\n",
      "examples/demo/Dockerfile": "FROM node\n",
      "docs/Dockerfile": "FROM node\n",
    });
    const json = await detect(dir);
    expect(json.detection.targets.map((t) => [t.name, t.proposed])).toEqual([
      ["docker", "auto"],
      ["worker", "none"],
      ["web", "none"],
    ]);
    expect(decision(json, "target.worker")).toMatchObject({ default: "none", ask: true });
    expect(json.detection.notes.some((n) => n.message.includes(".devcontainer/Dockerfile"))).toBe(
      true,
    );
  });

  it("several unbuilt Dockerfiles and no root one: none for all, web stays auto", async () => {
    const dir = repoFrom({
      "package.json": pkg("app", "1.0.0"),
      "a/Dockerfile": "FROM node\n",
      "b/Dockerfile": "FROM node\n",
    });
    const json = await detect(dir);
    expect(decision(json, "target.a")).toMatchObject({ default: "none", ask: true });
    expect(decision(json, "target.web").default).toBe("auto");
    // Deciding one Dockerfile auto makes web fall back to none.
    const result = await runInit(
      options(dir, { detect: true, json: true, decide: { "target.a": "auto" } }),
    );
    expect(result.detect?.decisions.find((d) => d.id === "target.web")?.default).toBe("none");
  });
});

describe("5. prerelease versions in files", () => {
  it("count as candidates and lowering them warns", async () => {
    const files = {
      "package.json": pkg("app", "1.5.0"),
      "apps/api/package.json": pkg("api", "2.0.0-rc.1"),
      "apps/api/Dockerfile": "FROM node\n",
    };
    const json = await detect(repoFrom(files));
    expect(json.detection.canonical.version).toBe("2.0.0");

    const dir = repoFrom(files);
    const out = collect();
    await runInit(
      options(dir, {
        yes: true,
        output: out,
        decide: { version: "1.5.0", "docker.api.image": "ghcr.io/o/api" },
      }),
    );
    expect(out.warnings).toContain(
      "apps/api/package.json:3 version goes down from 2.0.0-rc.1 to 1.5.0 (decided explicitly).",
    );
  });
});

describe("6. workflows that fire on launchset's tags", () => {
  const publish = "      - run: npm publish\n";
  const workflow = (on: string) =>
    `${on}jobs:\n  p:\n    runs-on: ubuntu-latest\n    steps:\n${publish}`;

  it("flags push with only tags-ignore", async () => {
    const dir = repoFrom({
      "package.json": pkg("app", "1.0.0"),
      ".github/workflows/p.yml": workflow('on:\n  push:\n    tags-ignore: ["v*"]\n'),
    });
    const json = await detect(dir);
    expect(item(json, "machinery..github/workflows/p.yml#1")).toMatchObject({
      kinds: ["tag-trigger"],
      evidence: [
        {
          path: ".github/workflows/p.yml",
          line: 3,
          // The workflow publishes the package, so an npm target takes over (its marker too).
          note: "tags-ignore doesn't exclude launchset/npm@1.2.3, launchset/web@1.2.3, launchset/partial/1.2.3",
        },
      ],
    });
  });

  it("flags an unfiltered push only when the workflow publishes, and excludes tags on disable", async () => {
    const quiet = repoFrom({
      "package.json": pkg("app", "1.0.0"),
      ".github/workflows/ci.yml": "on: push\njobs:\n  t:\n    steps:\n      - run: npm test\n",
    });
    expect((await detect(quiet)).detection.machinery).toEqual([]);

    const dir = repoFrom({
      "package.json": pkg("app", "1.0.0"),
      ".github/workflows/a.yml": workflow("on: push\n"),
      ".github/workflows/b.yml": workflow("on: [push, pull_request]\n"),
      ".github/workflows/c.yml": workflow("on:\n  push:\n    paths:\n      - src/**\n"),
    });
    await runInit(options(dir, { yes: true }));
    const filter = '    branches: ["**"]\n    tags-ignore: ["**"]\n';
    expect(read(dir, ".github/workflows/a.yml")).toBe(workflow(`on:\n  push:\n${filter}`));
    expect(read(dir, ".github/workflows/b.yml")).toBe(
      workflow(`on:\n  push:\n${filter}  pull_request:\n`),
    );
    expect(read(dir, ".github/workflows/c.yml")).toBe(
      workflow(`on:\n  push:\n${filter}    paths:\n      - src/**\n`),
    );
  });

  it("tests tag filters against the repo's own tag formats too", async () => {
    const dir = repoFrom(
      {
        "package.json": pkg("app", "1.0.0"),
        ".github/workflows/p.yml": workflow('on:\n  push:\n    tags: ["app@*"]\n'),
      },
      { tags: ["app@1.0.0"] },
    );
    const json = await detect(dir);
    expect(item(json, "machinery..github/workflows/p.yml#1").evidence[0]?.note).toBe(
      "tag pattern app@* matches app@1.2.3, app@1.2.3-alpha.0",
    );
  });
});

describe("7. converting Changesets files", () => {
  it("writes a placeholder for a bump without a summary and lists it", async () => {
    const dir = repoFrom({
      "package.json": pkg("app", "1.0.0"),
      ".changeset/quiet-cats-nap.md": '---\n"app": patch\n---\n',
    });
    const out = collect();
    const result = await runInit(options(dir, { convertOnly: true, output: out }));
    expect(read(dir, ".launchset/quiet-cats-nap.md")).toBe(
      "---\nbump: patch\n---\n\nTODO: describe this change (converted from .changeset/quiet-cats-nap.md)\n",
    );
    expect(out.warnings).toContain(
      ".changeset/quiet-cats-nap.md has a bump but no summary; .launchset/quiet-cats-nap.md got a TODO placeholder summary.",
    );
    expect(result.manualSteps).toContain(
      'Write the changelog summary in .launchset/quiet-cats-nap.md (it says "TODO: describe this change").',
    );
    // A second run sees the target and skips it, even after it was edited.
    writeFileSync(join(dir, ".launchset/quiet-cats-nap.md"), "---\nbump: patch\n---\n\nFixed.\n");
    const again = await runInit(options(dir, { convertOnly: true }));
    expect(again.changes).toEqual([]);
  });
});

describe("8, 11, 12. docker tags and images", () => {
  it("offers no disable when latest is the only tag pushed on branch pushes", async () => {
    const dir = repoFrom({
      "package.json": pkg("app", "1.0.0"),
      Dockerfile: "FROM node\n",
      ".github/workflows/d.yml":
        "on:\n  push:\n    branches: [main]\njobs:\n  d:\n    steps:\n      - uses: docker/build-push-action@v6\n        with:\n          push: true\n          tags: ghcr.io/o/app:latest\n",
    });
    const json = await detect(dir);
    expect(item(json, "machinery..github/workflows/d.yml#1")).toMatchObject({
      actions: ["remove", "keep"],
      effects: {
        keep: "leaves it as is (no disable: latest is the only tag it pushes, so removing it would leave an empty tags input)",
      },
    });
  });

  it("keeps every metadata-action image; a branch name is never a version", async () => {
    const dir = repoFrom({
      "package.json": pkg("app", "1.0.0"),
      Dockerfile: "FROM node\n",
      ".github/workflows/release.yml": `on:\n  push:\n    tags: ["v*"]\njobs:\n  d:\n    steps:\n      - id: meta\n        uses: docker/metadata-action@v5\n        with:\n          images: |\n            ghcr.io/o/app\n            docker.io/o/app\n          tags: type=semver,pattern={{version}}\n      - uses: docker/build-push-action@v6\n        with:\n          push: true\n          tags: \${{ steps.meta.outputs.tags }}\n`,
      ".github/workflows/staging.yml": `on:\n  push:\n    branches: [main]\njobs:\n  d:\n    steps:\n      - uses: docker/build-push-action@v6\n        with:\n          push: false\n          tags: ghcr.io/o/app:\${{ github.ref_name }}\n`,
    });
    const json = await detect(dir);
    const docker = json.detection.targets.find((t) => t.type === "docker");
    expect(docker?.docker?.images).toEqual(["ghcr.io/o/app", "docker.io/o/app"]);
    expect(docker?.docker?.tags).toEqual(["{version}", "latest"]);
    await runInit(options(dir, { yes: true }));
    const { config } = await loadConfig(dir);
    expect(config.targets.docker).toMatchObject({ image: ["ghcr.io/o/app", "docker.io/o/app"] });

    const branchOnly = repoFrom({
      "package.json": pkg("app", "1.0.0"),
      Dockerfile: "FROM node\n",
      ".github/workflows/staging.yml": `on:\n  push:\n    branches: [main]\njobs:\n  d:\n    steps:\n      - uses: docker/build-push-action@v6\n        with:\n          push: true\n          tags: ghcr.io/o/app:\${{ github.ref_name }}\n`,
    });
    const bj = await detect(branchOnly);
    expect(bj.detection.targets.find((t) => t.type === "docker")?.docker?.tags).toBeUndefined();
  });
});

describe("9. GitLab", () => {
  it("skips keywords and templates, and follows extends", async () => {
    const dir = repoFrom({
      "package.json": pkg("app", "1.0.0"),
      ".gitlab-ci.yml":
        "stages: [build, release]\nvariables:\n  A: b\n.release_template:\n  only:\n    - tags\nbuild:\n  script: make\ndeploy:\n  extends: .release_template\n  script: make deploy\n",
    });
    const json = await detect(dir);
    expect(json.detection.machinery.map((m) => m.what)).toEqual([
      'GitLab job "deploy" (runs on tags)',
    ]);
  });
});

describe("10. references to removed steps", () => {
  it("are shown as evidence and listed as manual steps", async () => {
    const dir = fixtureRepo("changesets", { tags: ["@demonsters/widgets@0.9.4"] });
    const json = await detect(dir);
    expect(item(json, "machinery..github/workflows/release.yml#1").evidence).toContainEqual({
      path: ".github/workflows/release.yml",
      line: 25,
      note: "uses steps.changesets outputs: check it once the step is gone",
    });
    const result = await runInit(options(dir, { yes: true }));
    expect(result.manualSteps).toContain(
      "Check .github/workflows/release.yml:18: it uses steps.changesets, but init removed that step.",
    );
  });
});

describe("14. flags", () => {
  it("rejects --convert-only with --detect", async () => {
    const dir = fixtureRepo("changesets");
    await expect(runInit(options(dir, { convertOnly: true, detect: true }))).rejects.toThrow(
      "--convert-only writes files, so it can't be combined with --detect.",
    );
    expect(status(dir)).toEqual([]);
  });
});

describe("15. package.json script removal", () => {
  it("splices the property and its comma; one-line objects stay one line", () => {
    expect(
      editScripts(
        '{ "scripts": { "build": "tsc", "release": "changeset publish" } }\n',
        [{ script: "release" }],
        "p",
      ),
    ).toBe('{ "scripts": { "build": "tsc" } }\n');
    expect(
      editScripts(
        '{ "scripts": { "version": "changeset version", "build": "tsc" } }\n',
        [{ script: "version" }],
        "p",
      ),
    ).toBe('{ "scripts": { "build": "tsc" } }\n');
    expect(
      editScripts('{"scripts": {"version": "changeset version"}}', [{ script: "version" }], "p"),
    ).toBe('{"scripts": {}}');
    expect(
      editScripts(
        '{\n  "scripts": {\n    "version": "changeset version"\n  }\n}\n',
        [{ script: "version" }],
        "p",
      ),
    ).toBe('{\n  "scripts": {\n  }\n}\n');
    expect(
      editScripts(
        '{ "scripts": { "release": "pnpm build && changeset publish" } }',
        [{ script: "release", segments: ["changeset publish"] }],
        "p",
      ),
    ).toBe('{ "scripts": { "release": "pnpm build" } }');
  });
});

describe("16. other release tooling", () => {
  it("finds semantic-release, release-please, on: release and their config", async () => {
    const dir = repoFrom({
      "package.json": pkg("app", "1.0.0", { scripts: { release: "semantic-release" } }),
      ".releaserc.json": "{}\n",
      ".github/workflows/rp.yml":
        "on:\n  push:\n    branches: [main]\njobs:\n  rp:\n    steps:\n      - uses: googleapis/release-please-action@v4\n      - run: echo ok\n",
      ".github/workflows/notify.yml":
        "on:\n  release:\n    types: [published]\njobs:\n  n:\n    steps:\n      - run: ./notify.sh\n",
      ".github/workflows/edited.yml":
        "on:\n  release:\n    types: [edited]\njobs:\n  n:\n    steps:\n      - run: ./notify.sh\n",
    });
    const json = await detect(dir);
    expect(json.detection.machinery.map((m) => [m.id, m.kinds])).toEqual([
      ["machinery..github/workflows/notify.yml#1", ["release-trigger"]],
      ["machinery..github/workflows/rp.yml#1", ["release-tool"]],
      ["machinery.package.json#1", ["release-tool"]],
    ]);
    expect(json.detection.notes).toContainEqual(
      expect.objectContaining({ path: ".releaserc.json", manual: true }),
    );
    const result = await runInit(options(dir, { yes: true }));
    expect(read(dir, ".github/workflows/notify.yml")).toBe(
      "on:\n  workflow_dispatch:\njobs:\n  n:\n    steps:\n      - run: ./notify.sh\n",
    );
    expect(
      result.manualSteps.some((s) =>
        s.startsWith(".releaserc.json: semantic-release configuration"),
      ),
    ).toBe(true);
  });

  it("says that verify catches a store that's ahead", async () => {
    const dir = fixtureRepo("capacitor-sync", { tags: ["v1.0.1"] });
    const result = await runInit(options(dir, { yes: true }));
    expect(result.manualSteps.some((s) => s.includes("`launchset verify` stops the upload"))).toBe(
      true,
    );
  });
});
