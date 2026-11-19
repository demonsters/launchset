// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the tests compare shell ${VAR:-} expansions
import picomatch from "picomatch";
import { describe, expect, it } from "vitest";
import { type ResolvedConfig, resolveConfig } from "../../src/core/config/schema.ts";
import { packageVersion } from "../../src/init/package-files.ts";
import {
  GITLAB_FILES,
  GITLAB_INCLUDE_SNIPPET,
  renderGitLabCi,
  renderGitLabCiRoot,
} from "../../src/templates/gitlab.ts";
import {
  branchCondition,
  branchGlobRe2,
  GitLabReference,
  labelRe2,
  maintenanceRe2,
  parseGitLabYaml,
  re2Escape,
  yamlScalar,
} from "../../src/templates/gitlab-yaml.ts";

interface Rule {
  if?: string;
  when?: string;
  allow_failure?: boolean;
  variables?: Record<string, string>;
}

interface Job {
  extends?: string;
  stage?: string;
  image?: string;
  tags?: string[];
  services?: string[];
  variables?: Record<string, string>;
  rules?: Rule[] | GitLabReference;
  needs?: unknown[];
  interruptible?: boolean;
  resource_group?: string;
  before_script?: string[];
  script?: string[];
  trigger?: { include: { artifact: string; job: string }[]; strategy: string };
  artifacts?: {
    paths?: string[];
    reports?: { dotenv?: string };
    expire_in?: string;
  };
}

type Doc = Record<string, Job> & { workflow?: unknown; include?: unknown };

const sampleInput = {
  preview: {
    branches: [
      "develop",
      { branch: "feature/*", targets: ["web"] },
      { branch: "next/*", prerelease: "alpha" },
    ],
  },
  targets: {
    api: {
      type: "docker",
      image: "registry.gitlab.com/acme/api",
      verify: ["registry"],
    },
    hub: { type: "docker", image: "acme/hub" },
    web: { type: "web" },
    android: {
      type: "android",
      source: { kind: "capacitor", dir: "apps/mobile" },
      verify: ["store"],
      store: { packageName: "com.acme.app" },
    },
    ios: {
      type: "ios",
      source: { kind: "xcodeproj", file: "apps/mobile/ios/App.xcodeproj" },
      verify: ["store"],
      store: { appId: "1234567890" },
      release: "manual",
    },
    npm: { type: "custom", verify: ["npm"] },
  },
};

const sampleConfig = resolveConfig(sampleInput);

function render(config: ResolvedConfig = sampleConfig, extra: Record<string, unknown> = {}) {
  const files = renderGitLabCi({
    config,
    hints: { api: { dockerfile: "apps/api/Dockerfile", context: "apps/api" } },
    ...extra,
  });
  const get = (path: string) => {
    const file = files.find((f) => f.path === path);
    if (!file) throw new Error(`${path} was not rendered`);
    return { text: file.content, doc: parseGitLabYaml(file.content) as Doc };
  };
  return {
    files,
    jobs: get(GITLAB_FILES.jobs),
    targets: get(GITLAB_FILES.targets),
    root: get(GITLAB_FILES.root),
  };
}

const rendered = render();

const job = (doc: Doc, name: string): Job => {
  const found = doc[name];
  if (!found) throw new Error(`no job ${name}`);
  return found;
};

// ---------------------------------------------------------------------------
// A small evaluator for GitLab `rules: if:` expressions (the subset the templates use), so the
// tests can check which pipelines run a job.

type Vars = Record<string, string | undefined>;

function evaluate(expression: string, vars: Vars): boolean {
  const tokens = expression.match(
    /\(|\)|&&|\|\||==|!=|=~|\$[A-Za-z_][A-Za-z0-9_]*|"[^"]*"|\/(?:\\.|[^/\\])+\/|\S+/g,
  ) as string[];
  let i = 0;
  const peek = () => tokens[i];
  const value = (token: string): string | undefined | RegExp => {
    if (token.startsWith("$")) return vars[token.slice(1)];
    if (token.startsWith('"')) return token.slice(1, -1);
    if (token.startsWith("/")) return new RegExp(token.slice(1, -1));
    throw new Error(`unexpected ${token} in ${expression}`);
  };
  const primary = (): boolean => {
    const token = tokens[i++] as string;
    if (token === "(") {
      const result = or();
      i++; // )
      return result;
    }
    const left = value(token);
    const op = peek();
    if (op === "==" || op === "!=" || op === "=~") {
      i++;
      const right = value(tokens[i++] as string);
      if (op === "=~")
        return right instanceof RegExp && left !== undefined && right.test(String(left));
      const same = (left ?? null) === (right ?? null);
      return op === "==" ? same : !same;
    }
    return typeof left === "string" && left !== "";
  };
  const and = (): boolean => {
    let result = primary();
    while (peek() === "&&") {
      i++;
      const right = primary();
      result = result && right;
    }
    return result;
  };
  const or = (): boolean => {
    let result = and();
    while (peek() === "||") {
      i++;
      const right = and();
      result = result || right;
    }
    return result;
  };
  return or();
}

/** The `when` a job gets in a pipeline (`never` when no rule matches), like GitLab decides. */
function when(rules: Rule[], vars: Vars): string {
  for (const rule of rules) {
    if (rule.if === undefined || evaluate(rule.if, vars)) return rule.when ?? "on_success";
  }
  return "never";
}

/** The rules of a job, resolving `!reference [.hidden, rules]`. */
function rulesOf(doc: Doc, name: string): Rule[] {
  const rules = job(doc, name).rules;
  if (rules instanceof GitLabReference) {
    const [hidden, key] = rules.path as [string, "rules"];
    return job(doc, hidden)[key] as Rule[];
  }
  return rules ?? [];
}

const push = (branch: string): Vars => ({
  CI_PIPELINE_SOURCE: "push",
  CI_COMMIT_BRANCH: branch,
});
const mr = (target: string, extra: Vars = {}): Vars => ({
  CI_PIPELINE_SOURCE: "merge_request_event",
  CI_MERGE_REQUEST_TARGET_BRANCH_NAME: target,
  CI_MERGE_REQUEST_PROJECT_ID: "1",
  CI_MERGE_REQUEST_SOURCE_PROJECT_ID: "1",
  ...extra,
});

describe("renderGitLabCi", () => {
  it("renders the three files at the expected paths, as valid YAML", () => {
    expect(rendered.files.map((f) => f.path)).toEqual([
      ".gitlab/launchset.yml",
      ".gitlab/launchset-targets.yml",
      ".gitlab-ci.yml",
    ]);
    for (const file of rendered.files) {
      expect(file.content.endsWith("\n")).toBe(true);
      expect(file.content).not.toContain("@@");
      expect(() => parseGitLabYaml(file.content)).not.toThrow();
    }
    expect(rendered.jobs.text).toMatch(/^# Generated by launchset init\. Safe to edit/);
    expect(rendered.targets.text).toContain("This file is yours: launchset");
    expect(rendered.targets.text).toContain("No `rules`");
  });

  it("has launchset's jobs with the agreed names, and keeps !reference as a tag", () => {
    const doc = rendered.jobs.doc;
    expect(Object.keys(doc)).toEqual([
      ".launchset-cli",
      ".launchset-release-rules",
      "launchset-check",
      "launchset-release",
      "launchset-build",
      "launchset-preview-plan",
      "launchset-preview",
      "launchset-preview-comment",
    ]);
    expect(job(doc, "launchset-release").rules).toBeInstanceOf(GitLabReference);
    expect((job(doc, "launchset-build").rules as GitLabReference).path).toEqual([
      ".launchset-release-rules",
      "rules",
    ]);
    expect(rendered.jobs.text).not.toMatch(/^workflow:/m);
  });

  it("installs the exact launchset version with npm, Node 24 and full history", () => {
    const cli = job(rendered.jobs.doc, ".launchset-cli");
    expect(cli.image).toBe("node:24");
    expect(cli.stage).toBe("test");
    expect(cli.variables).toEqual({
      GIT_DEPTH: "0",
      LAUNCHSET_CLI: `@demonsters/launchset@${packageVersion()}`,
    });
    expect(cli.before_script).toEqual([
      'if [ -n "${NPM_TOKEN:-}" ] && ! command -v launchset >/dev/null 2>&1; then npm config set "//registry.npmjs.org/:_authToken" "$NPM_TOKEN"; fi',
      'command -v launchset >/dev/null 2>&1 || npm install --global --no-fund --no-audit --loglevel=error "$LAUNCHSET_CLI"',
      "launchset --version",
    ]);
    for (const name of ["launchset-check", "launchset-release", "launchset-preview-plan"]) {
      expect(job(rendered.jobs.doc, name).extends).toBe(".launchset-cli");
    }
    const custom = render(sampleConfig, { cliSpec: "@demonsters/launchset@next" });
    expect(job(custom.jobs.doc, ".launchset-cli").variables?.LAUNCHSET_CLI).toBe(
      "@demonsters/launchset@next",
    );
  });

  it("release: plan job with artifacts, a resource group and the mirrored trigger", () => {
    const release = job(rendered.jobs.doc, "launchset-release");
    expect(release.script).toEqual(["launchset release --ci"]);
    expect(release.interruptible).toBe(false);
    expect(release.resource_group).toBe("launchset-release-$CI_COMMIT_REF_SLUG");
    expect(release.artifacts).toEqual({
      paths: ["plan.json", "launchset-child.yml"],
      reports: { dotenv: "launchset.env" },
      expire_in: "30 days",
    });
    const build = job(rendered.jobs.doc, "launchset-build");
    expect(build.needs).toEqual(["launchset-release"]);
    expect(build.variables).toEqual({ PARENT_PIPELINE_ID: "$CI_PIPELINE_ID" });
    expect(build.trigger).toEqual({
      include: [{ artifact: "launchset-child.yml", job: "launchset-release" }],
      strategy: "mirror",
    });
  });

  it("release rules: pushes and manual runs of the base and maintenance branches", () => {
    const rules = rulesOf(rendered.jobs.doc, "launchset-release");
    expect(when(rules, push("main"))).toBe("on_success");
    expect(when(rules, push("release/1.4.x"))).toBe("on_success");
    expect(when(rules, push("release/foo.x"))).toBe("never");
    expect(when(rules, push("develop"))).toBe("never");
    expect(when(rules, { CI_PIPELINE_SOURCE: "web", CI_COMMIT_BRANCH: "main" })).toBe("on_success");
    expect(when(rules, { CI_PIPELINE_SOURCE: "api", CI_COMMIT_BRANCH: "main" })).toBe("on_success");
    expect(when(rules, { CI_PIPELINE_SOURCE: "schedule", CI_COMMIT_BRANCH: "main" })).toBe("never");
    expect(
      when(rules, {
        CI_PIPELINE_SOURCE: "web",
        CI_COMMIT_BRANCH: "main",
        LAUNCHSET_PREVIEW: "true",
      }),
    ).toBe("never");
    expect(when(rules, mr("main"))).toBe("never");
    expect(when(rules, { CI_PIPELINE_SOURCE: "push", CI_COMMIT_TAG: "v1.0.0" })).toBe("never");
    expect(rulesOf(rendered.jobs.doc, "launchset-build")).toEqual(rules);
  });

  it("check rules: MRs into the base, maintenance and prerelease branches", () => {
    const check = job(rendered.jobs.doc, "launchset-check");
    expect(check.interruptible).toBe(true);
    expect(check.script).toEqual(["launchset check"]);
    const rules = rulesOf(rendered.jobs.doc, "launchset-check");
    expect(when(rules, mr("main"))).toBe("on_success");
    expect(when(rules, mr("release/2.0.x"))).toBe("on_success");
    expect(when(rules, mr("next/big"))).toBe("on_success");
    expect(when(rules, mr("develop"))).toBe("never");
    expect(when(rules, push("main"))).toBe("never");
  });

  it("preview plan rules: label, manual job, forks, manual runs and preview branches", () => {
    const rules = rulesOf(rendered.jobs.doc, "launchset-preview-plan");
    const labeled = mr("main", { CI_MERGE_REQUEST_LABELS: "bug,launchset:preview" });
    expect(when(rules, labeled)).toBe("on_success");
    expect(when(rules, mr("main", { CI_MERGE_REQUEST_LABELS: "launchset:preview-x" }))).toBe(
      "manual",
    );
    const manualRule = rules.find((r) => r.when === "manual");
    expect(manualRule).toMatchObject({
      allow_failure: true,
      variables: { LAUNCHSET_PREVIEW_MANUAL: "true" },
    });
    expect(when(rules, mr("main"))).toBe("manual");
    const fork = mr("main", {
      CI_MERGE_REQUEST_SOURCE_PROJECT_ID: "2",
      CI_MERGE_REQUEST_LABELS: "launchset:preview",
    });
    expect(when(rules, fork)).toBe("never");
    expect(when(rules, push("develop"))).toBe("on_success");
    expect(when(rules, push("feature/login"))).toBe("on_success");
    expect(when(rules, push("feature/a/b"))).toBe("never");
    expect(when(rules, push("next/2.0"))).toBe("on_success");
    expect(when(rules, push("main"))).toBe("never");
    expect(when(rules, push("release/1.4.x"))).toBe("never");
    const manualRun = {
      CI_PIPELINE_SOURCE: "web",
      CI_COMMIT_BRANCH: "main",
      LAUNCHSET_PREVIEW: "true",
    };
    expect(when(rules, manualRun)).toBe("on_success");
    expect(when(rules, { ...manualRun, LAUNCHSET_PREVIEW: undefined })).toBe("never");
    const plan = job(rendered.jobs.doc, "launchset-preview-plan");
    expect(plan.interruptible).toBe(true);
    expect(plan.artifacts?.paths).toEqual(["plan.json", "launchset-child.yml"]);
  });

  it("the preview trigger and comment follow the plan job; the comment runs always", () => {
    const trigger = rulesOf(rendered.jobs.doc, "launchset-preview");
    const comment = rulesOf(rendered.jobs.doc, "launchset-preview-comment");
    for (const vars of [mr("main"), push("develop"), push("next/x")]) {
      expect(when(trigger, vars)).toBe("on_success");
      expect(when(comment, vars)).toBe("always");
    }
    const fork = mr("main", { CI_MERGE_REQUEST_SOURCE_PROJECT_ID: "2" });
    expect(when(trigger, fork)).toBe("never");
    expect(when(comment, fork)).toBe("never");
    expect(when(comment, push("release/1.4.x"))).toBe("never");
    expect(job(rendered.jobs.doc, "launchset-preview").trigger?.include).toEqual([
      { artifact: "launchset-child.yml", job: "launchset-preview-plan" },
    ]);
    const commentJob = job(rendered.jobs.doc, "launchset-preview-comment");
    expect(commentJob.needs).toEqual([
      { job: "launchset-preview-plan" },
      { job: "launchset-preview", artifacts: false },
    ]);
    expect(commentJob.script).toEqual(["launchset preview-comment --plan @plan.json --ci"]);
  });

  it("rebuildOnPush false: every MR gets the manual job, labeled or not", () => {
    const config = resolveConfig({
      ...sampleInput,
      preview: { ...sampleInput.preview, rebuildOnPush: false },
    });
    const { jobs } = render(config);
    const rules = rulesOf(jobs.doc, "launchset-preview-plan");
    expect(when(rules, mr("main", { CI_MERGE_REQUEST_LABELS: "launchset:preview" }))).toBe(
      "manual",
    );
    expect(when(rules, mr("main"))).toBe("manual");
    expect(jobs.text).not.toContain("CI_MERGE_REQUEST_LABELS =~");
    expect(jobs.text).toContain("preview.rebuildOnPush is false");
  });

  it("previews off: no preview jobs", () => {
    const config = resolveConfig({ ...sampleInput, preview: false });
    const { jobs, root } = render(config);
    expect(Object.keys(jobs.doc).filter((name) => name.includes("preview"))).toEqual([]);
    expect(jobs.text).not.toContain("launchset-preview");
    expect(jobs.text).not.toContain("LAUNCHSET_PREVIEW=true, on any branch");
    expect(root.text).not.toContain("Preview and prerelease branches");
  });

  it("puts every job in the given stage", () => {
    const { jobs } = render(sampleConfig, { stage: "release" });
    expect(job(jobs.doc, ".launchset-cli").stage).toBe("release");
    expect(job(jobs.doc, "launchset-build").stage).toBe("release");
    expect(job(jobs.doc, "launchset-preview").stage).toBe("release");
    expect(render(sampleConfig, { stage: "deploy: prod" }).jobs.doc[".launchset-cli"]?.stage).toBe(
      "deploy: prod",
    );
    expect(() => render(sampleConfig, { stage: " " })).toThrow(/not a GitLab CI stage name/);
  });

  it("quotes a label with special characters and matches only whole labels", () => {
    const label = "preview: [ok] (a.b)/c@d";
    const config = resolveConfig({ ...sampleInput, preview: { ...sampleInput.preview, label } });
    const { jobs } = render(config);
    const rules = rulesOf(jobs.doc, "launchset-preview-plan");
    expect(when(rules, mr("main", { CI_MERGE_REQUEST_LABELS: `bug,${label}` }))).toBe("on_success");
    expect(when(rules, mr("main", { CI_MERGE_REQUEST_LABELS: `${label}x` }))).toBe("manual");
    expect(when(rules, mr("main", { CI_MERGE_REQUEST_LABELS: "preview" }))).toBe("manual");
    expect(jobs.text).toContain("preview: \\\\[ok\\\\] \\\\(a\\\\.b\\\\)\\\\/c\\\\x40d");
  });
});

describe("the targets file", () => {
  const targets = rendered.targets.doc;

  it("has one hidden job per target with a script and no rules", () => {
    expect(Object.keys(targets)).toEqual([
      ".launchset-api",
      ".launchset-hub",
      ".launchset-web",
      ".launchset-android",
      ".launchset-ios",
      ".launchset-npm",
    ]);
    for (const name of Object.keys(targets)) {
      const value = job(targets, name);
      expect(value.script?.length).toBeGreaterThan(0);
      expect(value.rules).toBeUndefined();
      expect(value.stage).toBeUndefined();
    }
  });

  it("docker on the GitLab registry: dind, Node for launchset, CI_REGISTRY login and verify credentials", () => {
    const api = job(targets, ".launchset-api");
    expect(api.image).toBe("docker:29");
    expect(api.services).toEqual(["docker:29-dind"]);
    expect(api.variables).toEqual({
      DOCKER_TLS_CERTDIR: "/certs",
      LAUNCHSET_REGISTRY_USERNAME: "$CI_REGISTRY_USER",
      LAUNCHSET_REGISTRY_PASSWORD: "$CI_REGISTRY_PASSWORD",
      LAUNCHSET_REGISTRY_HOST: "registry.gitlab.com",
    });
    expect(api.before_script).toEqual([
      "apk add --no-cache nodejs-current npm git",
      'echo "$CI_REGISTRY_PASSWORD" | docker login --username "$CI_REGISTRY_USER" --password-stdin "$CI_REGISTRY"',
    ]);
    expect(api.script).toEqual([
      "DOCKER_TAG_ARGS=$(printf ' --tag %s' $LAUNCHSET_DOCKER_TAGS)",
      "DOCKER_LABEL_ARGS=$(printf ' --label %s' $LAUNCHSET_DOCKER_LABELS)",
      "docker buildx build $DOCKER_TAG_ARGS $DOCKER_LABEL_ARGS --file apps/api/Dockerfile --push apps/api",
    ]);
  });

  it("docker on Docker Hub: DOCKER_USERNAME / DOCKER_PASSWORD, no registry variables", () => {
    const hub = job(targets, ".launchset-hub");
    expect(hub.variables).toEqual({ DOCKER_TLS_CERTDIR: "/certs" });
    expect(hub.before_script?.[1]).toBe(
      'echo "$DOCKER_PASSWORD" | docker login --username "$DOCKER_USERNAME" --password-stdin',
    );
    expect(hub.script?.at(-1)).toBe(
      "docker buildx build $DOCKER_TAG_ARGS $DOCKER_LABEL_ARGS --push .",
    );
  });

  it("a self-managed registry counts as GitLab's when given; platforms add QEMU", () => {
    const config = resolveConfig({
      targets: {
        api: { type: "docker", image: "registry.example.com/g/api", verify: ["registry"] },
      },
    });
    const doc = render(config, {
      gitlabRegistries: ["registry.example.com"],
      hints: { api: { platforms: "linux/amd64,linux/arm64" } },
    }).targets.doc;
    const api = job(doc, ".launchset-api");
    expect(api.variables?.LAUNCHSET_REGISTRY_HOST).toBe("registry.example.com");
    expect(api.before_script?.[1]).toContain('--password-stdin "$CI_REGISTRY"');
    expect(api.script).toContain("docker run --privileged --rm tonistiigi/binfmt --install all");
    expect(api.script?.at(-1)).toContain("--platform linux/amd64,linux/arm64 --push .");
    const other = render(config).targets.doc;
    expect(job(other, ".launchset-api").before_script?.[1]).toBe(
      'echo "$DOCKER_PASSWORD" | docker login --username "$DOCKER_USERNAME" --password-stdin registry.example.com',
    );
  });

  it("web, android and ios start with a failing 'no build steps' line", () => {
    for (const name of [".launchset-web", ".launchset-android", ".launchset-ios"]) {
      expect(job(targets, name).script?.[0]).toMatch(/^echo "No build steps for .+"; exit 1$/);
    }
  });

  it("android: an Android SDK image with Node, a user npm prefix and the Gradle dir", () => {
    const android = job(targets, ".launchset-android");
    expect(android.image).toBe("cimg/android:2026.11-node");
    expect(android.before_script?.[0]).toContain("NPM_CONFIG_PREFIX");
    expect(rendered.targets.text).toContain("# - cd apps/mobile/android");
    expect(rendered.targets.text).toContain('--package_name "com.acme.app"');
    expect(rendered.targets.text).toContain("LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON");
  });

  it("ios: GitLab's hosted macOS runner tag and image", () => {
    const ios = job(targets, ".launchset-ios");
    expect(ios.tags).toEqual(["saas-macos-medium-m1"]);
    expect(ios.image).toBe("macos-26-xcode-26");
    expect(rendered.targets.text).toContain(
      '-project "apps/mobile/ios/App.xcodeproj" -scheme "App"',
    );
    expect(rendered.targets.text).toContain("LAUNCHSET_ASC_KEY_ID");
  });

  it("npm: publishes releases and prereleases with NPM_TOKEN, verify reads with NODE_AUTH_TOKEN", () => {
    const npm = job(targets, ".launchset-npm");
    expect(npm.variables).toEqual({ NODE_AUTH_TOKEN: "$NPM_TOKEN" });
    expect(npm.script).toEqual([
      'npm config set "//registry.npmjs.org/:_authToken" "$NPM_TOKEN"',
      'if [ "$LAUNCHSET_CHANNEL" != "preview" ]; then npm publish --tag "$LAUNCHSET_DIST_TAG"; fi',
    ]);
  });
});

describe("the root .gitlab-ci.yml", () => {
  it("switches between branch and MR pipelines and includes launchset's jobs", () => {
    const root = renderGitLabCiRoot(sampleConfig);
    expect(root.path).toBe(".gitlab-ci.yml");
    const doc = parseGitLabYaml(root.content) as {
      workflow: { rules: Rule[]; auto_cancel: unknown };
      include: unknown;
    };
    expect(doc.include).toEqual([{ local: ".gitlab/launchset.yml" }]);
    expect(doc.workflow.auto_cancel).toEqual({ on_new_commit: "interruptible" });
    const rules = doc.workflow.rules;
    const open = { CI_OPEN_MERGE_REQUESTS: "acme/app!1" };
    expect(when(rules, mr("main"))).toBe("on_success");
    expect(when(rules, push("feature-x"))).toBe("on_success");
    expect(when(rules, { ...push("feature-x"), ...open })).toBe("never");
    // Preview and prerelease branches build every push, also with an open MR.
    expect(when(rules, { ...push("next/2.0"), ...open })).toBe("on_success");
    expect(when(rules, { ...push("develop"), ...open })).toBe("on_success");
    // Manual runs always run.
    expect(when(rules, { CI_PIPELINE_SOURCE: "web", CI_COMMIT_BRANCH: "x", ...open })).toBe(
      "on_success",
    );
    expect(when(rules, { CI_PIPELINE_SOURCE: "push", CI_COMMIT_TAG: "v1.0.0" })).toBe("never");
    expect(GITLAB_INCLUDE_SNIPPET).toBe("include:\n  - local: .gitlab/launchset.yml\n");
  });
});

describe("RE2 patterns", () => {
  const branches = [
    "main",
    "develop",
    "feature/login",
    "feature/a/b",
    "feature",
    "next/2.0",
    "release/1.4.x",
    "release/01.4.x",
    "v1.x-beta",
    "a.b",
    "axb",
    "hot@fix",
  ];

  it.each([
    "main",
    "feature/*",
    "feature/**",
    "**/beta",
    "*-beta",
    "v?.x-beta",
    "{develop,main}",
    "release/[0-9]*",
    "a.b",
    "hot@fix",
  ])("a glob %s matches the branches picomatch matches", (glob) => {
    const regex = new RegExp(branchGlobRe2(glob));
    const isMatch = picomatch(glob, { dot: true });
    for (const branch of branches)
      expect([branch, regex.test(branch)]).toEqual([branch, isMatch(branch)]);
  });

  it("escapes / and @ for GitLab and regex characters", () => {
    expect(re2Escape("a/b.c@d")).toBe("a\\/b\\.c\\x40d");
    expect(branchGlobRe2("feature/*")).toBe("^feature\\/[^\\/]*$");
    expect(branchCondition("$CI_COMMIT_BRANCH", "main")).toBe('$CI_COMMIT_BRANCH == "main"');
    expect(branchCondition("$CI_COMMIT_BRANCH", "a b")).toBe("$CI_COMMIT_BRANCH =~ /^a b$/");
  });

  it("extglobs become a superset: the literal prefix and anything", () => {
    expect(branchGlobRe2("release/!(old)")).toBe("^release\\/.*$");
  });

  it("maintenance branches: <major>.<minor> in place of the *", () => {
    const regex = new RegExp(maintenanceRe2("release/*.x"));
    expect(regex.test("release/1.4.x")).toBe(true);
    expect(regex.test("release/10.0.x")).toBe(true);
    expect(regex.test("release/01.4.x")).toBe(false);
    expect(regex.test("release/1.4.y")).toBe(false);
    expect(regex.test("release/foo.x")).toBe(false);
  });

  it("labels match whole comma-separated names", () => {
    const regex = new RegExp(labelRe2("a.b+c"));
    expect(regex.test("a.b+c")).toBe(true);
    expect(regex.test("x,a.b+c,y")).toBe(true);
    expect(regex.test("aXb+c")).toBe(false);
    expect(regex.test("a.b+cc")).toBe(false);
  });

  it("yamlScalar quotes only when needed", () => {
    expect(yamlScalar('$A == "b"')).toBe('$A == "b"');
    expect(yamlScalar("a: b")).toBe('"a: b"');
    expect(yamlScalar("@scope/pkg")).toBe('"@scope/pkg"');
    expect(yamlScalar("x #y")).toBe('"x #y"');
  });
});
