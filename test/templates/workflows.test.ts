// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the tests compare GitHub ${{ }} expressions
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { resolveConfig } from "../../src/core/config/schema.ts";
import {
  branchGlobExpression,
  fillTemplate,
  renderWorkflows,
  templatesDir,
} from "../../src/templates/workflows.ts";

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}

interface Job {
  name?: string;
  needs?: string | string[];
  if?: string;
  "runs-on"?: string;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  strategy?: { "fail-fast"?: boolean; matrix?: { target?: string } };
  steps: Step[];
}

interface Workflow {
  name: string;
  on: {
    pull_request?: { types?: string[]; branches?: string[] };
    push?: { branches?: string[] };
    workflow_dispatch?: {
      inputs?: Record<string, { description?: string; required?: boolean; type?: string }>;
    };
  };
  permissions?: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress": boolean | string };
  jobs: Record<string, Job>;
}

const sampleInput = {
  preview: {
    branches: [
      "develop",
      { branch: "feature/*", targets: ["web"] },
      { branch: "next/*", prerelease: "alpha" },
    ],
  },
  targets: {
    "docker-api": {
      type: "docker",
      image: "ghcr.io/demonsters/api",
      tags: ["v{version}", "latest"],
      verify: ["registry"],
    },
    android: {
      type: "android",
      source: { kind: "capacitor", dir: "apps/mobile" },
      verify: ["store"],
      store: { packageName: "com.demonsters.app" },
    },
    ios: {
      type: "ios",
      source: { kind: "xcodeproj", file: "apps/mobile/ios/App.xcodeproj" },
      verify: ["store"],
      store: { appId: "1234567890" },
      release: "manual",
    },
    web: { type: "web" },
    npm: { type: "custom", verify: ["npm"] },
  },
};

const sampleConfig = resolveConfig(sampleInput);

function render(
  config = sampleConfig,
  extra: {
    actionRef?: string;
    hints?: Record<string, { dockerfile?: string; context?: string; platforms?: string }>;
  } = {},
) {
  const files = renderWorkflows({ config, ...extra });
  const byName = Object.fromEntries(files.map((f) => [f.path.split("/").pop(), f]));
  const get = (name: string) => {
    const file = byName[name];
    if (!file) throw new Error(`${name} was not rendered`);
    return { text: file.content, workflow: parse(file.content) as Workflow };
  };
  return {
    files,
    check: get("launchset-check.yml"),
    release: get("launchset-release.yml"),
    preview: get("launchset-preview.yml"),
  };
}

const rendered = render(sampleConfig, {
  hints: {
    "docker-api": {
      dockerfile: "apps/api/Dockerfile",
      context: "apps/api",
      platforms: "linux/amd64,linux/arm64",
    },
  },
});

const job = (workflow: Workflow, name: string): Job => {
  const found = workflow.jobs[name];
  if (!found) throw new Error(`no job ${name}`);
  return found;
};

const indexOfStep = (job: Job, predicate: (step: Step) => boolean) =>
  job.steps.findIndex(predicate);

describe("renderWorkflows", () => {
  it("renders the three files at the expected paths, as valid YAML", () => {
    expect(rendered.files.map((f) => f.path)).toEqual([
      ".github/workflows/launchset-check.yml",
      ".github/workflows/launchset-release.yml",
      ".github/workflows/launchset-preview.yml",
    ]);
    for (const file of rendered.files) {
      expect(() => parse(file.content, { strict: true })).not.toThrow();
      expect(file.content.endsWith("\n")).toBe(true);
      expect(file.content).not.toMatch(/@@[a-z_]+@@/);
      expect(file.content).not.toMatch(/\n\n\n/);
    }
  });

  it("leaves the preview workflow out when previews are disabled", () => {
    const config = resolveConfig({ ...sampleInput, preview: false });
    expect(renderWorkflows({ config }).map((f) => f.path)).toEqual([
      ".github/workflows/launchset-check.yml",
      ".github/workflows/launchset-release.yml",
    ]);
  });
});

describe("launchset-check.yml", () => {
  const { workflow, text } = rendered.check;

  it("triggers on pull requests to the base, maintenance and prerelease branches", () => {
    expect(workflow.on.pull_request?.types).toEqual([
      "opened",
      "synchronize",
      "reopened",
      "edited",
      "labeled",
      "unlabeled",
    ]);
    expect(workflow.on.pull_request?.branches).toEqual(["main", "release/*.x", "next/*"]);
  });

  it("has the right permissions and runs the check with the default token", () => {
    expect(workflow.permissions).toEqual({ contents: "read", "pull-requests": "write" });
    const steps = job(workflow, "check").steps;
    const checkout = steps.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with).toEqual({ "fetch-depth": 0 });
    const action = steps.find((s) => s.uses === "demonsters/launchset-action@v1");
    expect(action?.with).toEqual({ command: "check", token: "${{ secrets.GITHUB_TOKEN }}" });
    expect(text).not.toContain("app-token");
  });

  it("follows a custom base branch and maintenance pattern", () => {
    const config = resolveConfig({
      ...sampleInput,
      baseBranch: "trunk",
      maintenanceBranches: "maint/*",
    });
    expect(render(config).check.workflow.on.pull_request?.branches).toEqual([
      "trunk",
      "maint/*",
      "next/*",
    ]);
  });
});

describe("launchset-release.yml", () => {
  const { workflow, text } = rendered.release;
  const launchset = job(workflow, "launchset");
  const build = job(workflow, "build");
  const finalize = job(workflow, "finalize");

  it("triggers on pushes to the base and maintenance branches and on workflow_dispatch", () => {
    expect(workflow.on.push?.branches).toEqual(["main", "release/*.x"]);
    const inputs = workflow.on.workflow_dispatch?.inputs ?? {};
    expect(Object.keys(inputs)).toEqual(["target", "version"]);
    for (const input of Object.values(inputs)) {
      expect(input.required).toBe(false);
      expect(input.type).toBe("string");
      expect(input.description).toBeTruthy();
    }
  });

  it("serializes runs per ref without cancelling", () => {
    expect(workflow.concurrency).toEqual({
      group: "launchset-release-${{ github.ref }}",
      "cancel-in-progress": false,
    });
  });

  it("plans with a GitHub App token and exposes the plan outputs", () => {
    const [tokenStep, checkoutStep, actionStep] = launchset.steps;
    expect(tokenStep?.uses).toBe("actions/create-github-app-token@v2");
    expect(tokenStep?.with).toEqual({
      "app-id": "${{ secrets.LAUNCHSET_APP_ID }}",
      "private-key": "${{ secrets.LAUNCHSET_APP_PRIVATE_KEY }}",
    });
    expect(checkoutStep?.with).toMatchObject({
      token: `\${{ steps.${tokenStep?.id}.outputs.token }}`,
      "fetch-depth": 0,
    });
    expect(actionStep?.with).toEqual({
      command: "release",
      token: `\${{ steps.${tokenStep?.id}.outputs.token }}`,
      target: "${{ inputs.target }}",
      version: "${{ inputs.version }}",
    });
    expect(Object.keys(launchset.outputs ?? {})).toEqual([
      "mode",
      "matrix",
      "plan",
      "version",
      "build-number",
      "channel",
      "release-sha",
    ]);
    for (const [name, value] of Object.entries(launchset.outputs ?? {})) {
      expect(value).toBe(`\${{ steps.${actionStep?.id}.outputs.${name} }}`);
    }
  });

  it("builds a matrix for publish and ship only, without fail-fast", () => {
    expect(build.needs).toBe("launchset");
    expect(build.if).toContain(
      `contains(fromJSON('["publish","ship"]'), needs.launchset.outputs.mode)`,
    );
    expect(build.strategy?.["fail-fast"]).toBe(false);
    expect(build.strategy?.matrix?.target).toBe("${{ fromJSON(needs.launchset.outputs.matrix) }}");
  });

  it("skips the build when the matrix is empty", () => {
    expect(build.if).toContain("needs.launchset.outputs.matrix != '[]'");
  });

  it("checks out the release commit first", () => {
    expect(build.steps[0]?.uses).toMatch(/^actions\/checkout@v\d+$/);
    expect(build.steps[0]?.with).toEqual({ ref: "${{ needs.launchset.outputs.release-sha }}" });
  });

  it("runs docker login before verify, and stamp before verify", () => {
    const login = indexOfStep(build, (s) => s.uses?.startsWith("docker/login-action@") ?? false);
    const stamp = indexOfStep(build, (s) => s.id === "stamp");
    const verify = indexOfStep(build, (s) => s.id === "verify");
    expect(login).toBeGreaterThan(0);
    expect(login).toBeLessThan(verify);
    expect(stamp).toBeLessThan(verify);
    expect(build.steps[login]).toMatchObject({
      if: "matrix.target == 'docker-api'",
      with: {
        registry: "ghcr.io",
        username: "${{ github.actor }}",
        password: "${{ secrets.GITHUB_TOKEN }}",
      },
    });
  });

  it("gives GHCR pushes packages: write", () => {
    expect(build.permissions).toEqual({ contents: "read", packages: "write" });
    const noDocker = resolveConfig({ targets: { web: { type: "web" } } });
    expect(job(render(noDocker).release.workflow, "build").permissions).toEqual({
      contents: "read",
    });
  });

  it("passes the stamp tags and labels to docker/build-push-action", () => {
    const push = build.steps.find((s) => s.uses?.startsWith("docker/build-push-action@"));
    expect(push?.with).toMatchObject({
      context: "apps/api",
      file: "apps/api/Dockerfile",
      platforms: "linux/amd64,linux/arm64",
      push: true,
      tags: "${{ steps.stamp.outputs.docker-tags }}",
      labels: "${{ steps.stamp.outputs.docker-labels }}",
    });
    expect(build.steps.some((s) => s.uses?.startsWith("docker/setup-buildx-action@"))).toBe(true);
  });

  it("skips every target build step when already published", () => {
    const verify = indexOfStep(build, (s) => s.id === "verify");
    const mark = indexOfStep(build, (s) => s.with?.command === "mark");
    const between = build.steps.slice(verify + 1, mark - 1).filter((s) => s.uses || s.run);
    // docker buildx + push, node setup, npm publish
    expect(between.length).toBeGreaterThanOrEqual(4);
    for (const step of between) {
      expect(step.if).toContain("steps.verify.outputs.already-published != 'true'");
      expect(step.if).toMatch(/^matrix\.target == '/);
    }
  });

  it("publishes npm packages with the suggested dist-tag", () => {
    const publish = build.steps.find((s) => s.run?.startsWith("npm publish"));
    expect(publish?.run).toBe("npm publish --tag ${{ steps.stamp.outputs.dist-tag }}");
    expect(publish?.if).toBe(
      "matrix.target == 'npm' && steps.verify.outputs.already-published != 'true'",
    );
  });

  it("gives the verify step the store and npm credentials by name", () => {
    const verify = build.steps.find((s) => s.id === "verify");
    expect(verify?.env).toEqual({
      LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON: "${{ secrets.LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON }}",
      LAUNCHSET_ASC_KEY_ID: "${{ secrets.LAUNCHSET_ASC_KEY_ID }}",
      LAUNCHSET_ASC_ISSUER_ID: "${{ secrets.LAUNCHSET_ASC_ISSUER_ID }}",
      LAUNCHSET_ASC_PRIVATE_KEY: "${{ secrets.LAUNCHSET_ASC_PRIVATE_KEY }}",
      NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}",
    });
  });

  it("keeps the Android and iOS examples as comments", () => {
    for (const step of build.steps) {
      expect(`${step.run ?? ""}${step.uses ?? ""}`).not.toMatch(/fastlane|xcodebuild|gradlew/);
    }
    expect(text).toContain("#   run: ./gradlew bundleRelease");
    expect(text).toContain("fastlane supply");
    expect(text).toContain("fastlane pilot");
    expect(text).toContain("xcodebuild archive");
    expect(text).toContain("working-directory: apps/mobile/android");
    expect(text).toContain('-project "apps/mobile/ios/App.xcodeproj"');
    expect(text).toContain('--package_name "com.demonsters.app"');
    // Secrets by name only.
    expect(text).not.toMatch(/(password|secret|key)\w*: ["']?[A-Za-z0-9+/=]{20,}/i);
  });

  it("uses a macOS runner only for iOS targets", () => {
    expect(build["runs-on"]).toBe(
      "${{ matrix.target == 'ios' && 'macos-latest' || 'ubuntu-latest' }}",
    );
    const noIos = resolveConfig({ targets: { web: { type: "web" } } });
    expect(job(render(noIos).release.workflow, "build")["runs-on"]).toBe("ubuntu-latest");
  });

  it("marks last, with a fresh App token", () => {
    const last = build.steps.at(-1);
    expect(last?.with).toMatchObject({
      command: "mark",
      target: "${{ matrix.target }}",
      plan: "${{ needs.launchset.outputs.plan }}",
    });
    const tokenStep = build.steps.at(-2);
    expect(tokenStep?.uses).toBe("actions/create-github-app-token@v2");
    expect(last?.with?.token).toBe(`\${{ steps.${tokenStep?.id}.outputs.token }}`);
    expect(last?.if).toBeUndefined();
  });

  it("finalizes after the build, even when it failed", () => {
    expect(finalize.needs).toEqual(["launchset", "build"]);
    expect(finalize.if).toBe(
      `always() && contains(fromJSON('["publish","ship"]'), needs.launchset.outputs.mode)`,
    );
    const action = finalize.steps.find((s) => s.with?.command === "finalize");
    expect(action?.with).toMatchObject({
      plan: "${{ needs.launchset.outputs.plan }}",
    });
    expect(finalize.steps[0]?.uses).toBe("actions/create-github-app-token@v2");
  });
});

describe("launchset-preview.yml", () => {
  const { workflow, text } = rendered.preview;
  const plan = job(workflow, "plan");
  const build = job(workflow, "build");
  const comment = job(workflow, "comment");
  const label = "'launchset:preview'";

  it("triggers on labeled PRs, manual runs and pushes to the preview branches", () => {
    expect(workflow.on.pull_request?.types).toEqual(["labeled", "synchronize", "reopened"]);
    expect(workflow.on.push?.branches).toEqual(["develop", "feature/*", "next/*", "!release/*.x"]);
    const inputs = workflow.on.workflow_dispatch?.inputs ?? {};
    expect(Object.keys(inputs)).toEqual(["targets"]);
    expect(inputs.targets?.required).toBe(false);
  });

  it("only reacts to the labeled event with rebuildOnPush: false", () => {
    const config = resolveConfig({
      ...sampleInput,
      preview: { ...sampleInput.preview, rebuildOnPush: false, label: "preview-me" },
    });
    const result = render(config);
    expect(result.preview.workflow.on.pull_request?.types).toEqual(["labeled"]);
    expect(job(result.preview.workflow, "plan").if).toContain("'preview-me'");
  });

  it("has no push trigger without preview branches", () => {
    const config = resolveConfig({ targets: { web: { type: "web" } } });
    const result = render(config);
    expect(result.preview.workflow.on.push).toBeUndefined();
    expect(result.preview.workflow.concurrency?.["cancel-in-progress"]).toBe(true);
  });

  it("requires the preview label and skips unrelated labeled events", () => {
    expect(plan.if).toContain(`contains(github.event.pull_request.labels.*.name, ${label})`);
    expect(plan.if).toContain(`github.event.label.name == ${label}`);
    expect(plan.if).toMatch(/^github\.event_name != 'pull_request' \|\| /);
  });

  it("skips fork PRs and says so in the job summary", () => {
    expect(plan.if).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    const notice = job(workflow, "fork-notice");
    expect(notice.if).toContain(
      "github.event.pull_request.head.repo.full_name != github.repository",
    );
    expect(notice.steps[0]?.run).toContain("$GITHUB_STEP_SUMMARY");
    expect(notice.steps[0]?.run).toContain("fork");
  });

  it("never lets a non-preview run cancel a building preview", () => {
    const group = workflow.concurrency?.group ?? "";
    expect(group).toContain("github.event.pull_request.number || github.ref");
    expect(group).toMatch(/\|\| github\.run_id }}$/);
    expect(group).toContain(`contains(github.event.pull_request.labels.*.name, ${label})`);
  });

  it("does not cancel prerelease branches but cancels other previews", () => {
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(
      "${{ !(github.event_name != 'pull_request' && (startsWith(github.ref_name, 'next/'))) }}",
    );
    expect(text).toContain("GitHub expressions have no\n# glob matching");
  });

  it("combines several prerelease globs", () => {
    const config = resolveConfig({
      ...sampleInput,
      preview: {
        branches: [
          { branch: "next/*", prerelease: "alpha" },
          { branch: "beta", prerelease: "beta" },
          { branch: "*-rc", prerelease: "rc" },
          "develop",
        ],
      },
    });
    expect(render(config).preview.workflow.concurrency?.["cancel-in-progress"]).toBe(
      "${{ !(github.event_name != 'pull_request' && (startsWith(github.ref_name, 'next/') || github.ref_name == 'beta' || endsWith(github.ref_name, '-rc'))) }}",
    );
  });

  it("plans with the App token and passes the dispatch targets", () => {
    expect(plan.steps[0]?.uses).toBe("actions/create-github-app-token@v2");
    const action = plan.steps.find((s) => s.with?.command === "preview-plan");
    expect(action?.with).toMatchObject({
      command: "preview-plan",
      target: "${{ inputs.targets }}",
    });
    expect(plan.steps.find((s) => s.uses?.startsWith("actions/checkout@"))?.with).toMatchObject({
      "fetch-depth": 0,
    });
  });

  it("builds only the preview targets, without verify or mark", () => {
    expect(build.needs).toBe("plan");
    expect(build.strategy?.matrix?.target).toBe("${{ fromJSON(needs.plan.outputs.matrix) }}");
    expect(build.steps.some((s) => s.id === "verify")).toBe(false);
    expect(build.steps.some((s) => s.with?.command === "mark")).toBe(false);
    expect(build.steps.find((s) => s.id === "stamp")?.with).toMatchObject({
      command: "stamp",
      plan: "${{ needs.plan.outputs.plan }}",
    });
    const push = build.steps.find((s) => s.uses?.startsWith("docker/build-push-action@"));
    expect(push?.if).toBe("matrix.target == 'docker-api'");
    expect(push?.with).toMatchObject({
      tags: "${{ steps.stamp.outputs.docker-tags }}",
      labels: "${{ steps.stamp.outputs.docker-labels }}",
    });
  });

  it("publishes npm only for prereleases", () => {
    const publish = build.steps.find((s) => s.run?.startsWith("npm publish"));
    expect(publish?.if).toBe(
      "matrix.target == 'npm' && steps.stamp.outputs.channel == 'prerelease'",
    );
  });

  it("limits snippets to targets that previews build", () => {
    const config = resolveConfig({
      ...sampleInput,
      preview: { targets: ["web"], branches: [{ branch: "feature/*", targets: ["npm"] }] },
    });
    const result = render(config).preview;
    expect(result.text).toContain("# --- web (web)");
    expect(result.text).toContain("# --- npm (npm package)");
    expect(result.text).not.toContain("android");
    expect(result.text).not.toContain("docker/build-push-action");
    expect(job(result.workflow, "build")["runs-on"]).toBe("ubuntu-latest");
  });

  it("comments last, always, with the permissions it needs", () => {
    expect(comment.needs).toEqual(["plan", "build"]);
    expect(comment.if).toBe("always() && needs.plan.result != 'skipped'");
    expect(comment.permissions).toEqual({
      actions: "read",
      contents: "read",
      "pull-requests": "write",
    });
    const action = comment.steps.find((s) => s.with?.command === "preview-comment");
    expect(action?.with).toMatchObject({ plan: "${{ needs.plan.outputs.plan }}" });
    expect(comment.steps[0]?.uses).toBe("actions/create-github-app-token@v2");
  });
});

describe("branchGlobExpression", () => {
  it("turns globs into expressions", () => {
    expect(branchGlobExpression("next/*")).toBe("startsWith(github.ref_name, 'next/')");
    expect(branchGlobExpression("next/**")).toBe("startsWith(github.ref_name, 'next/')");
    expect(branchGlobExpression("beta")).toBe("github.ref_name == 'beta'");
    expect(branchGlobExpression("*-rc")).toBe("endsWith(github.ref_name, '-rc')");
    expect(branchGlobExpression("v2/*/next")).toBe("startsWith(github.ref_name, 'v2/')");
    expect(branchGlobExpression("*")).toBe("true");
    expect(branchGlobExpression("it's/*")).toBe("startsWith(github.ref_name, 'it''s/')");
  });

  it("never cancels when a glob can't be narrowed", () => {
    const config = resolveConfig({
      preview: { branches: [{ branch: "*/*", prerelease: "alpha" }] },
      targets: { web: { type: "web" } },
    });
    expect(render(config).preview.workflow.concurrency?.["cancel-in-progress"]).toBe(false);
  });
});

describe("actionRef", () => {
  it("replaces the action in every file", () => {
    const local = render(sampleConfig, { actionRef: "./action" });
    for (const file of local.files) {
      expect(file.content).not.toContain("demonsters/launchset-action");
      expect(file.content).toContain("uses: ./action");
    }
    expect(rendered.release.text).toContain("uses: demonsters/launchset-action@v1");
  });
});

describe("docker registries", () => {
  it("logs in to every registry once, with secrets by name", () => {
    const config = resolveConfig({
      targets: {
        a: { type: "docker", image: ["ghcr.io/org/a", "org/a"] },
        b: { type: "docker", image: "org/b" },
        c: { type: "docker", image: "registry.example.com:5000/c" },
      },
    });
    const build = job(render(config).release.workflow, "build");
    const logins = build.steps.filter((s) => s.uses?.startsWith("docker/login-action@"));
    expect(logins.map((s) => s.with)).toEqual([
      {
        registry: "ghcr.io",
        username: "${{ github.actor }}",
        password: "${{ secrets.GITHUB_TOKEN }}",
      },
      { username: "${{ secrets.DOCKERHUB_USERNAME }}", password: "${{ secrets.DOCKERHUB_TOKEN }}" },
      {
        registry: "registry.example.com:5000",
        username: "${{ secrets.REGISTRY_USERNAME }}",
        password: "${{ secrets.REGISTRY_PASSWORD }}",
      },
    ]);
    expect(logins[1]?.if).toBe(`contains(fromJSON('["a","b"]'), matrix.target)`);
    expect(build.permissions).toEqual({ contents: "read", packages: "write" });
  });
});

describe("fillTemplate", () => {
  it("indents blocks, drops empty lines and fills inline tokens", () => {
    const out = fillTemplate("a: @@x@@\n  @@block@@\n  @@empty@@\nb:", {
      x: "1",
      block: "- p\n- q",
      empty: "",
    });
    expect(out).toBe("a: 1\n  - p\n  - q\nb:");
  });

  it("rejects unknown tokens", () => {
    expect(() => fillTemplate("@@nope@@", {})).toThrow(/Unknown token @@nope@@/);
  });
});

describe("templatesDir", () => {
  it("finds the templates next to src/", () => {
    const dir = templatesDir();
    expect(existsSync(join(dir, "workflows", "launchset-check.yml"))).toBe(true);
    expect(existsSync(join(dir, "workflows", "launchset-release.yml"))).toBe(true);
    expect(existsSync(join(dir, "workflows", "launchset-preview.yml"))).toBe(true);
  });
});

describe("action.yml contract", () => {
  const action = parse(readFileSync("action/action.yml", "utf8")) as {
    name: string;
    description: string;
    author: string;
    branding: { icon: string; color: string };
    inputs: Record<string, { description?: string; required?: boolean }>;
    outputs: Record<string, { description?: string }>;
    runs: { using: string; main: string };
  };
  const commands = [
    "check",
    "release",
    "stamp",
    "verify",
    "mark",
    "finalize",
    "preview-plan",
    "preview-comment",
    "add",
  ];

  it("declares the spec 10 interface", () => {
    expect(action.runs).toEqual({ using: "node24", main: "dist/index.js" });
    expect(action.name).toBeTruthy();
    expect(action.author).toBeTruthy();
    expect(action.branding.icon).toBeTruthy();
    expect(Object.keys(action.inputs).sort()).toEqual(
      [
        "bump",
        "command",
        "message",
        "plan",
        "target",
        "token",
        "version",
        "working-directory",
      ].sort(),
    );
    const specOutputs = [
      "mode",
      "matrix",
      "plan",
      "version",
      "build-number",
      "channel",
      "release-sha",
      "already-published",
      "docker-tags",
      "docker-labels",
      "dist-tag",
      "pr-number",
    ];
    const extras = [
      "docker-refs-json",
      "marketing-version",
      "tag",
      "prerelease",
      // add, preview-plan and preview-comment
      "path",
      "skipped",
      "skip-reason",
      "comment-url",
      "release-url",
    ];
    expect(Object.keys(action.outputs).sort()).toEqual([...specOutputs, ...extras].sort());
    for (const entry of [...Object.values(action.inputs), ...Object.values(action.outputs)]) {
      expect(entry.description?.length).toBeGreaterThan(10);
    }
    for (const command of commands) expect(action.inputs.command?.description).toContain(command);
    expect(action.inputs.command?.required).toBe(true);
  });

  const variants = [
    ["sample", render(sampleConfig)],
    ["local action", render(sampleConfig, { actionRef: "./action" })],
    ["minimal", render(resolveConfig({ targets: { web: { type: "web" } } }))],
  ] as const;

  for (const [label, result] of variants) {
    describe(label, () => {
      for (const file of result.files) {
        it(`${file.path.split("/").pop()} only uses declared inputs and outputs`, () => {
          const workflow = parse(file.content) as Workflow;
          const ref = file.content.includes("uses: ./action")
            ? "./action"
            : "demonsters/launchset-action@v1";
          const actionSteps = Object.values(workflow.jobs)
            .flatMap((j) => j.steps)
            .filter((s) => s.uses === ref);
          expect(actionSteps.length).toBeGreaterThan(0);

          for (const step of actionSteps) {
            expect(commands).toContain(step.with?.command);
            for (const key of Object.keys(step.with ?? {})) {
              expect(Object.keys(action.inputs), `input ${key}`).toContain(key);
            }
          }

          // steps.<id>.outputs.<name> for launchset steps (also inside comments).
          const ids = new Set(actionSteps.map((s) => s.id).filter((id): id is string => !!id));
          const outputNames = Object.keys(action.outputs);
          const used = [...file.content.matchAll(/steps\.([\w-]+)\.outputs\.([\w-]+)/g)].filter(
            (m) => ids.has(m[1] as string),
          );
          if (!file.path.endsWith("check.yml")) expect(used.length).toBeGreaterThan(0);
          for (const m of used) expect(outputNames, `output ${m[2]}`).toContain(m[2]);

          // needs.<job>.outputs.<name> resolves to a declared job output.
          for (const m of file.content.matchAll(/needs\.([\w-]+)\.outputs\.([\w-]+)/g)) {
            const outputs = workflow.jobs[m[1] as string]?.outputs ?? {};
            expect(Object.keys(outputs), `needs.${m[1]}.outputs.${m[2]}`).toContain(m[2]);
          }
        });
      }
    });
  }
});
