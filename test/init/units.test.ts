import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AGENTS_END, AGENTS_START, upsertAgentsSection } from "../../src/init/agents.ts";
import { renderConfigSource } from "../../src/init/config-source.ts";
import { classifyTag, plainVersion, roundUpOffset } from "../../src/init/detect.ts";
import { launchsetTagsMatched, matchesFilter } from "../../src/init/github-filter.ts";
import { addLefthookCommand, detectHooks, installHook } from "../../src/init/hooks.ts";
import { commandKinds, detectMachinery, type MachineryInput } from "../../src/init/machinery.ts";
import { packageFile, packageRoot } from "../../src/init/package-files.ts";
import { applyRetirement, removeSegments } from "../../src/init/retire.ts";
import {
  dockerBuilds,
  metadataTagTemplates,
  parseWorkflow,
  tagTemplate,
  type Workflow,
} from "../../src/init/workflow-scan.ts";

const temp: string[] = [];
afterAll(() => {
  for (const d of temp) rmSync(d, { recursive: true, force: true });
});
function tempDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "launchset-init-unit-"));
  temp.push(dir);
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text);
  }
  return dir;
}

function workflow(path: string, text: string): Workflow {
  const w = parseWorkflow(path, text);
  if ("error" in w) throw new Error(w.error);
  return w;
}

function input(partial: Partial<MachineryInput>): MachineryInput {
  return {
    workflows: [],
    dockerBuilds: [],
    packages: [],
    scriptFiles: [],
    fastfiles: [],
    docs: [],
    ...partial,
  };
}

/** Detect machinery in one workflow file and apply `action` to every item. */
async function retire(text: string, action: "disable" | "remove" = "disable") {
  const path = ".github/workflows/w.yml";
  const dir = tempDir({ [path]: text });
  const w = workflow(path, text);
  const findings = detectMachinery(
    input({
      workflows: [w],
      dockerBuilds: dockerBuilds(w, { tagPrefix: w.triggers.tagEvents ? "v" : null }),
    }),
  );
  const { changes, followUps } = await applyRetirement(
    dir,
    findings.map((finding) => ({ finding, action })),
  );
  let after: string | null = null;
  try {
    after = readFileSync(join(dir, path), "utf8");
  } catch {
    after = null;
  }
  return { findings, changes, after, followUps };
}

describe("GitHub filter patterns", () => {
  it("matches like GitHub: * stops at /, ** doesn't, + and ? repeat, ! excludes", () => {
    expect(matchesFilter(["v*"], "v1.2.3")).toBe(true);
    expect(matchesFilter(["v*"], "launchset/web@1.2.3")).toBe(false);
    expect(matchesFilter(["**"], "launchset/web@1.2.3")).toBe(true);
    expect(matchesFilter(["v[0-9]+.[0-9]+.[0-9]+"], "v10.2.33")).toBe(true);
    expect(matchesFilter(["v[0-9]+.[0-9]+.[0-9]+"], "v1.2.3-alpha.0")).toBe(false);
    expect(matchesFilter(["*.*.*"], "1.2.3")).toBe(true);
    expect(matchesFilter(["v*", "!v*-*"], "v1.2.3-beta.1")).toBe(false);
    expect(launchsetTagsMatched("release-*")).toEqual([]);
    expect(launchsetTagsMatched("*")).toEqual(["v1.2.3", "1.2.3", "v1.2.3-alpha.0"]);
  });
});

describe("docker tag templates from workflows", () => {
  it("turns tags as written into launchset templates", () => {
    expect(tagTemplate(`\${{ github.ref_name }}`, "v")).toBe("v{version}");
    expect(tagTemplate(`\${{ github.ref_name }}`, "")).toBe("{version}");
    expect(tagTemplate(`v\${{ steps.version.outputs.version }}`, "v")).toBe("v{version}");
    expect(tagTemplate(`\${GITHUB_REF#refs/tags/v}`, "v")).toBe("{version}");
    expect(tagTemplate(`sha-\${{ github.sha }}`, "v")).toBe("sha-{sha}");
    expect(tagTemplate(`\${GITHUB_SHA::7}`, "v")).toBe("{shortSha}");
    expect(tagTemplate("latest", "v")).toBe("latest");
    expect(tagTemplate("staging", "v")).toBeNull();
    expect(tagTemplate(`\${{ env.BRANCH }}`, "v")).toBeNull();
  });

  it("reads docker/metadata-action tags and flavor", () => {
    expect(
      metadataTagTemplates(
        "type=semver,pattern=v{{version}}\ntype=semver,pattern={{major}}.{{minor}}\ntype=ref,event=branch\ntype=sha,format=long",
        undefined,
        "v",
      ),
    ).toEqual(["v{version}", "{major}.{minor}", "sha-{sha}", "latest"]);
    expect(metadataTagTemplates("type=ref,event=tag", "latest=false", "v")).toEqual(["v{version}"]);
    expect(
      metadataTagTemplates(
        `type=raw,value=latest\ntype=raw,value=\${{ github.ref_name }}`,
        undefined,
        "",
      ),
    ).toEqual(["latest", "{version}"]);
  });
});

describe("shell commands", () => {
  it("knows what conflicts", () => {
    expect(commandKinds("npx changeset version")).toEqual(["changesets"]);
    expect(commandKinds("git tag -a v1.0.0 -m x")).toEqual(["tag-creation"]);
    expect(commandKinds("git tag --list")).toEqual([]);
    expect(commandKinds("git tag")).toEqual([]);
    expect(commandKinds("npm version patch")).toEqual(["tag-creation"]);
    expect(commandKinds("npm version patch --no-git-tag-version")).toEqual([]);
    expect(commandKinds("gh release create v1.0.0 dist/*")).toEqual(["tag-creation"]);
    expect(commandKinds("agvtool new-version -all 12")).toEqual(["version-writer"]);
    expect(commandKinds("sed -i '' 's/versionCode .*/versionCode 3/' app/build.gradle")).toEqual([
      "version-writer",
    ]);
    expect(commandKinds("pnpm build")).toEqual([]);
  });

  it("removes && parts and keeps the other separators as written", () => {
    expect(removeSegments("pnpm build && changeset publish", ["changeset publish"])).toBe(
      "pnpm build",
    );
    expect(removeSegments("a &&b && c", ["b"])).toBe("a && c");
    expect(removeSegments("changeset version", ["changeset version"])).toBeNull();
  });
});

describe("retiring workflow machinery", () => {
  it("removes only conflicting tag patterns from a flow list", async () => {
    const text =
      'on:\n  push:\n    tags: ["v*", "deploy-*"]\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: echo\n';
    const { after } = await retire(text);
    expect(after).toBe(
      'on:\n  push:\n    tags: ["deploy-*"]\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: echo\n',
    );
  });

  it("removes only the tags filter when branches also trigger", async () => {
    const text =
      "on:\n  push:\n    branches: [main]\n    tags:\n      - '*.*.*'\njobs:\n  a:\n    steps:\n      - run: echo\n";
    const { after } = await retire(text);
    expect(after).toBe(
      "on:\n  push:\n    branches: [main]\njobs:\n  a:\n    steps:\n      - run: echo\n",
    );
  });

  it("removes a job whose every step conflicts, and the needs that point at it", async () => {
    const text = `on:
  push:
    branches: [main]
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: changesets/action@v1
  deploy:
    needs: [release, build]
    steps:
      - run: ./deploy.sh
  notify:
    needs: release
    steps:
      - run: echo done
`;
    const { after, changes } = await retire(text);
    expect(after).toBe(`on:
  push:
    branches: [main]
jobs:
  deploy:
    needs: [build]
    steps:
      - run: ./deploy.sh
  notify:
    steps:
      - run: echo done
`);
    expect(changes[0]?.summary).toContain('removed job "release" (all its steps conflicted)');
  });

  it("never deletes the file: when every job conflicts, the triggers become workflow_dispatch", async () => {
    const text =
      "on:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  r:\n    steps:\n      - uses: softprops/action-gh-release@v2\n";
    const { after, changes, followUps } = await retire(text);
    expect(after).toBe(
      "on:\n  workflow_dispatch:\njobs:\n  r:\n    steps:\n      - uses: softprops/action-gh-release@v2\n",
    );
    expect(changes[0]).toMatchObject({ action: "updated" });
    expect(followUps[0]).toContain("now only runs when started by hand");
  });

  it("removes latest from build-push tags and flips the metadata latest flavor", async () => {
    const text = `on:
  push:
    branches: [main]
jobs:
  a:
    steps:
      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/o/app
          flavor: latest=true
          tags: |
            type=sha
      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: \${{ steps.meta.outputs.tags }}
      - uses: docker/build-push-action@v6
        with:
          file: other/Dockerfile
          push: true
          tags: ghcr.io/o/other:main,ghcr.io/o/other:latest
`;
    const { after, findings } = await retire(text);
    expect(findings.map((f) => f.item.kinds)).toEqual([["docker-latest"], ["docker-latest"]]);
    expect(after).toBe(
      text
        .replace("flavor: latest=true", "flavor: latest=false")
        .replace("ghcr.io/o/other:main,ghcr.io/o/other:latest", "ghcr.io/o/other:main"),
    );
  });

  it("can't disable a trigger written in flow style, so it offers remove and keep", async () => {
    const text = "on: { push: { tags: [v*] } }\njobs:\n  a:\n    steps:\n      - run: echo\n";
    const { findings } = await retire(text, "remove");
    expect(findings[0]?.item.actions).toEqual(["remove", "keep"]);
  });
});

describe("other machinery", () => {
  it("disables GitLab tag jobs", async () => {
    const text =
      "stages: [build]\nbuild:\n  script: make\nrelease:\n  only:\n    - tags\n  script: make release\n";
    const dir = tempDir({ ".gitlab-ci.yml": text });
    const findings = detectMachinery(input({ gitlab: { path: ".gitlab-ci.yml", text } }));
    expect(findings.map((f) => f.item.id)).toEqual(["machinery..gitlab-ci.yml#1"]);
    await applyRetirement(dir, [{ finding: findings[0] as never, action: "disable" }]);
    expect(readFileSync(join(dir, ".gitlab-ci.yml"), "utf8")).toBe(
      "stages: [build]\nbuild:\n  script: make\n",
    );
  });

  it("removes fastlane version actions only when they're one-line calls", async () => {
    const text =
      'lane :beta do\n  increment_build_number(xcodeproj: "App.xcodeproj")\n  build_app\nend\n';
    const dir = tempDir({ "ios/fastlane/Fastfile": text });
    const findings = detectMachinery(
      input({ fastfiles: [{ path: "ios/fastlane/Fastfile", text }] }),
    );
    expect(findings[0]?.item.actions).toEqual(["disable", "keep"]);
    await applyRetirement(dir, [{ finding: findings[0] as never, action: "disable" }]);
    expect(readFileSync(join(dir, "ios/fastlane/Fastfile"), "utf8")).toBe(
      'lane :beta do\n  # launchset: disabled — launchset stamps versions and build numbers: increment_build_number(xcodeproj: "App.xcodeproj")\n  build_app\nend\n',
    );
  });

  it("a script file nothing runs can only be removed or kept", () => {
    const findings = detectMachinery(
      input({
        scriptFiles: [{ path: "scripts/tag.js", text: 'execSync("git tag v" + version)\n' }],
      }),
    );
    expect(findings[0]?.item).toMatchObject({
      kinds: ["tag-creation"],
      actions: ["remove", "keep"],
    });
  });
});

describe("hooks", () => {
  it("adds the command to lefthook configs with and without a pre-push section", () => {
    expect(addLefthookCommand("pre-push:\n  commands:\n    test:\n      run: pnpm test\n")).toBe(
      "pre-push:\n  commands:\n    launchset:\n      run: npx @demonsters/launchset check --push\n    test:\n      run: pnpm test\n",
    );
    expect(addLefthookCommand("pre-push:\n  scripts:\n    a.sh:\n      runner: bash\n")).toBeNull();
  });

  it("adds the command to simple-git-hooks in package.json", async () => {
    const dir = tempDir({
      "package.json":
        '{\n  "name": "x",\n  "simple-git-hooks": {\n    "pre-push": "pnpm test"\n  }\n}\n',
    });
    const [hook] = await detectHooks(dir);
    expect(hook).toEqual({ tool: "simple-git-hooks", path: "package.json", installed: false });
    await installHook(dir, hook as never);
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(
      '{\n  "name": "x",\n  "simple-git-hooks": {\n    "pre-push": "pnpm test && npx @demonsters/launchset check --push"\n  }\n}\n',
    );
    expect(await detectHooks(dir)).toEqual([
      { tool: "simple-git-hooks", path: "package.json", installed: true },
    ]);
  });
});

describe("AGENTS.md section", () => {
  it("is added once and replaced in place on later runs", () => {
    const first = upsertAgentsSection("# Agents\n\nBe nice.\n", "## launchset\n\nv1");
    expect(first).toBe(
      `# Agents\n\nBe nice.\n\n${AGENTS_START}\n## launchset\n\nv1\n${AGENTS_END}\n`,
    );
    const second = upsertAgentsSection(`${first}\nMore.\n`, "## launchset\n\nv2");
    expect(second).toBe(
      `# Agents\n\nBe nice.\n\n${AGENTS_START}\n## launchset\n\nv2\n${AGENTS_END}\n\nMore.\n`,
    );
    expect(upsertAgentsSection(null, "x")).toBe(`${AGENTS_START}\nx\n${AGENTS_END}\n`);
  });
});

describe("small helpers", () => {
  it("classifies version tags", () => {
    expect(classifyTag("v1.2.3")).toEqual({
      tag: "v1.2.3",
      version: "1.2.3",
      format: "v{version}",
      prerelease: false,
      counted: true,
    });
    expect(classifyTag("0.9.4")?.format).toBe("{version}");
    expect(classifyTag("api@1.0.0-beta.1")).toEqual({
      tag: "api@1.0.0-beta.1",
      version: "1.0.0-beta.1",
      format: "api@{version}",
      prerelease: true,
      package: "api",
      counted: true,
    });
    expect(classifyTag("launchset/web@1.0.0")).toBeNull();
    expect(classifyTag("release-1")).toBeNull();
  });

  it("reads loose versions and rounds offsets", () => {
    expect(plainVersion("1.0")).toBe("1.0.0");
    expect(plainVersion("v2.3.4")).toBe("2.3.4");
    expect(plainVersion("1.0.0-rc.1")).toBeNull();
    expect(roundUpOffset(913801)).toBe(920000);
    expect(roundUpOffset(57)).toBe(57);
  });

  it("renders config keys that aren't identifiers quoted", () => {
    const text = renderConfigSource({
      config: { targets: { "docker-api": { type: "docker", image: "ghcr.io/o/api" } } },
      comments: new Map([["targets.docker-api", ["A comment."]]]),
      hints: {},
      targets: [],
    });
    expect(text).toContain(
      '    // A comment.\n    "docker-api": { type: "docker", image: "ghcr.io/o/api" },\n',
    );
  });

  it("finds the package files from the source tree", () => {
    expect(readFileSync(packageFile("package.json"), "utf8")).toContain(
      '"name": "@demonsters/launchset"',
    );
    expect(packageRoot()).toBe(join(import.meta.dirname, "../.."));
  });
});
