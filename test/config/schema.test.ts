import { describe, expect, it } from "vitest";
import { configJsonSchema } from "../../src/core/config/json-schema.ts";
import {
  ConfigError,
  type ConfigIssue,
  defineConfig,
  gitlabSettings,
  hostConfigIssues,
  resolveConfig,
  targetShell,
  UNKNOWN_KEY_MESSAGE,
} from "../../src/core/config/schema.ts";
import { LaunchsetError } from "../../src/core/errors.ts";

const web = { type: "web" } as const;

function issues(input: unknown): ConfigIssue[] {
  try {
    resolveConfig(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).issues;
  }
  throw new Error("expected the config to be invalid");
}

describe("resolveConfig: defaults and normalization", () => {
  it("fills in every default", () => {
    const config = resolveConfig({ targets: { web } });
    expect(config).toMatchObject({
      version: { file: "package.json" },
      changelog: { file: "CHANGELOG.md", links: true },
      baseBranch: "main",
      maintenanceBranches: "release/*.x",
      tags: {
        release: "v{version}",
        marker: "launchset/{target}@{version}",
        partial: "launchset/partial/{version}",
      },
      buildNumber: { strategy: "timestamp", epoch: "2020-01-01T00:00:00Z", offset: 0 },
      check: { bots: ["dependabot[bot]", "renovate[bot]", "renovate-bot"] },
      preview: {
        enabled: true,
        label: "launchset:preview",
        rebuildOnPush: true,
        branches: [],
        targets: "all",
      },
    });
    expect(config.targets.web).toEqual({
      type: "web",
      name: "web",
      release: "auto",
      verify: [],
      files: [],
      buildNumber: { strategy: "timestamp", epoch: "2020-01-01T00:00:00Z", offset: 0 },
    });
  });

  it("expands shorthands and merges build-number overrides", () => {
    const config = resolveConfig({
      buildNumber: { offset: 100 },
      preview: { branches: ["develop", { branch: "next/*", prerelease: "alpha" }] },
      targets: {
        api: { type: "docker", image: "ghcr.io/org/api", tags: ["v{version}", "latest"] },
        ios: {
          type: "ios",
          source: { kind: "plist", file: "ios/Info.plist" },
          buildNumber: { strategy: "run-number" },
          release: "manual",
        },
      },
    });
    expect(config.preview.branches).toEqual([
      { branch: "develop" },
      { branch: "next/*", prerelease: "alpha" },
    ]);
    expect(config.targets.api).toMatchObject({
      image: ["ghcr.io/org/api"],
      tags: {
        release: ["v{version}", "latest"],
        preview: ["{version}", "pr-{prNumber}", "{branchSlug}"],
        prerelease: ["{version}", "{branchSlug}"],
      },
    });
    expect(config.targets.ios).toMatchObject({
      source: { kind: "plist", files: ["ios/Info.plist"] },
      buildNumber: { strategy: "run-number", epoch: "2020-01-01T00:00:00Z", offset: 100 },
    });
    expect(Object.keys(config.targets)).toEqual(["api", "ios"]);
  });

  it("allows a top-level $schema key (launchset.config.json)", () => {
    expect(() => resolveConfig({ $schema: "./schema.json", targets: { web } })).not.toThrow();
  });

  it("preview: false disables previews", () => {
    expect(resolveConfig({ preview: false, targets: { web } }).preview.enabled).toBe(false);
  });

  it("defineConfig returns its input", () => {
    const input = { targets: { web } };
    expect(defineConfig(input)).toBe(input);
  });
});

describe("ConfigError", () => {
  it("is a LaunchsetError naming the file and each field", () => {
    try {
      resolveConfig({ targets: {}, typo: 1 }, { file: "launchset.config.ts" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LaunchsetError);
      expect((error as ConfigError).code).toBe("invalid-config");
      expect((error as Error).message).toBe(
        `Invalid launchset config in launchset.config.ts:\n  - typo: ${UNKNOWN_KEY_MESSAGE}`,
      );
    }
  });
});

describe("validation rules (spec 5)", () => {
  it("unknown keys: one issue per key, with the key in the path", () => {
    expect(
      issues({ targets: { api: { type: "docker", image: "x", tgs: [] } }, foo: 1, bar: 2 }),
    ).toEqual([
      { path: "targets.api.tgs", message: UNKNOWN_KEY_MESSAGE },
      { path: "foo", message: UNKNOWN_KEY_MESSAGE },
      { path: "bar", message: UNKNOWN_KEY_MESSAGE },
    ]);
    expect(issues({ preview: { lable: "x" }, targets: { web } })).toEqual([
      { path: "preview.lable", message: UNKNOWN_KEY_MESSAGE },
    ]);
    expect(
      issues({
        targets: { a: { type: "android", source: { kind: "gradle", file: "x", flavor: "y" } } },
      }),
    ).toEqual([{ path: "targets.a.source.flavor", message: UNKNOWN_KEY_MESSAGE }]);
    expect(
      issues({
        targets: {
          api: { type: "docker", image: "x", tags: { release: ["{version}"], previw: [] } },
        },
      }),
    ).toEqual([{ path: "targets.api.tags.previw", message: UNKNOWN_KEY_MESSAGE }]);
  });

  it("at least one target", () => {
    expect(issues({ targets: {} })).toEqual([
      { path: "targets", message: "expected at least one target" },
    ]);
    expect(issues({})).toEqual([{ path: "targets", message: "required: expected an object" }]);
  });

  it("target names", () => {
    expect(issues({ targets: { Web: web, "-x": web, ok: web } })).toEqual([
      {
        path: "targets.Web",
        message:
          "invalid target name: expected lowercase letters, digits and dashes, starting with a letter or digit",
      },
      expect.objectContaining({ path: "targets.-x" }),
    ]);
  });

  it("at least one auto target", () => {
    expect(issues({ targets: { web: { type: "web", release: "manual" } } })).toEqual([
      {
        path: "targets",
        message:
          'expected at least one target with release: "auto" (otherwise no release completes)',
      },
    ]);
  });

  it("semver build numbers with previews", () => {
    const [root] = issues({ buildNumber: { strategy: "semver" }, targets: { web } });
    expect(root?.path).toBe("buildNumber.strategy");
    expect(root?.message).toMatch(/can't be used while previews are enabled.*set preview: false/);
    expect(
      issues({ targets: { web: { type: "web", buildNumber: { strategy: "semver" } } } }).map(
        (i) => i.path,
      ),
    ).toEqual(["targets.web.buildNumber.strategy"]);
    expect(() =>
      resolveConfig({ preview: false, buildNumber: { strategy: "semver" }, targets: { web } }),
    ).not.toThrow();
  });

  describe("docker tags (6.1)", () => {
    const docker = (tags: unknown) => ({
      targets: { api: { type: "docker", image: "ghcr.io/o/api", tags } },
    });

    it("the release list needs a {version} template", () => {
      expect(issues(docker(["latest", "{major}"]))).toEqual([
        {
          path: "targets.api.tags.release",
          message: "expected at least one template containing {version} (used by verify)",
        },
      ]);
      expect(issues(docker({ release: ["stable"] })).map((i) => i.path)).toEqual([
        "targets.api.tags.release",
      ]);
    });

    it("preview and prerelease lists can't contain latest or a plain X.Y.Z", () => {
      expect(
        issues(
          docker({
            preview: ["{version}", "latest", "{major}.{minor}.{patch}"],
            prerelease: ["v{major}.{minor}.{patch}", "{major}.{minor}"],
          }),
        ),
      ).toEqual([
        {
          path: "targets.api.tags.preview.1",
          message:
            '"latest" isn\'t allowed in preview tags: it would look like a release (latest or a plain X.Y.Z)',
        },
        expect.objectContaining({ path: "targets.api.tags.preview.2" }),
        expect.objectContaining({ path: "targets.api.tags.prerelease.0" }),
      ]);
    });

    it("unknown placeholders", () => {
      expect(issues(docker(["{version}", "{versoin}"]))).toEqual([
        {
          path: "targets.api.tags.1",
          message:
            "unknown placeholder {versoin}: expected {version}, {major}, {minor}, {patch}, {preid}, {prNumber}, {branchSlug}, {sha}, {shortSha}, {buildNumber}",
        },
      ]);
    });

    it("empty lists and wrong shapes", () => {
      expect(issues(docker([]))).toEqual([
        { path: "targets.api.tags", message: "expected at least one tag template" },
      ]);
      expect(issues(docker(5))).toEqual([
        {
          path: "targets.api.tags",
          message:
            "expected a list of tag templates (the release list), or an object with release, preview and/or prerelease lists, got the number 5",
        },
      ]);
    });

    it("image names", () => {
      expect(issues({ targets: { api: { type: "docker" } } })).toEqual([
        {
          path: "targets.api.image",
          message:
            'required: expected an image name like "ghcr.io/org/app", or a list of image names',
        },
      ]);
      expect(
        issues({ targets: { api: { type: "docker", image: "ghcr.io/o/api:latest" } } }),
      ).toEqual([
        {
          path: "targets.api.image",
          message:
            'expected an image name without tag or digest, like "ghcr.io/org/app" (got "ghcr.io/o/api:latest"); set tags with "tags"',
        },
      ]);
      expect(
        issues({
          targets: { api: { type: "docker", image: ["ghcr.io/o/api", "x@sha256:abc"] } },
        }).map((i) => i.path),
      ).toEqual(["targets.api.image.1"]);
      expect(() =>
        resolveConfig({ targets: { api: { type: "docker", image: "localhost:5000/api" } } }),
      ).not.toThrow();
      expect(issues({ targets: { api: { type: "docker", image: [] } } })).toEqual([
        { path: "targets.api.image", message: "expected at least one image" },
      ]);
    });
  });

  describe("preview branches (9.7, 9.9)", () => {
    it("a prerelease pattern can't match the base branch", () => {
      expect(
        issues({ preview: { branches: [{ branch: "*", prerelease: "alpha" }] }, targets: { web } }),
      ).toEqual([
        {
          path: "preview.branches.0.branch",
          message: 'prerelease branch pattern "*" matches the base branch "main"',
        },
      ]);
      expect(() => resolveConfig({ preview: { branches: ["*"] }, targets: { web } })).not.toThrow();
      expect(
        issues({
          baseBranch: "develop",
          preview: { branches: [{ branch: "dev*", prerelease: "beta" }] },
          targets: { web },
        }).map((i) => i.path),
      ).toEqual(["preview.branches.0.branch"]);
    });

    it("prerelease ids", () => {
      expect(
        issues({
          preview: { branches: [{ branch: "next/*", prerelease: "1" }] },
          targets: { web },
        }),
      ).toEqual([
        {
          path: "preview.branches.0.prerelease",
          message:
            "expected a prerelease id like alpha, beta or rc (letters, digits and dashes, not only digits)",
        },
      ]);
      expect(
        issues({
          preview: { branches: [{ branch: "next/*", prerelease: "al.pha" }] },
          targets: { web },
        }),
      ).toHaveLength(1);
    });

    it("entries must be globs or objects", () => {
      expect(issues({ preview: { branches: [5] }, targets: { web } })).toEqual([
        {
          path: "preview.branches.0",
          message:
            'expected a branch glob like "develop" or "feature/*", or an object { branch, targets?, prerelease? }, got the number 5',
        },
      ]);
      expect(issues({ preview: { branches: [{ targets: "all" }] }, targets: { web } })).toEqual([
        { path: "preview.branches.0.branch", message: "required: expected a string" },
      ]);
    });

    it("target references must exist", () => {
      expect(
        issues({
          preview: { targets: ["web", "andriod"], branches: [{ branch: "x", targets: ["nope"] }] },
          targets: { web },
        }),
      ).toEqual([
        { path: "preview.targets.1", message: 'unknown target "andriod"' },
        { path: "preview.branches.0.targets.0", message: 'unknown target "nope"' },
      ]);
      expect(issues({ preview: { targets: "some" }, targets: { web } })).toEqual([
        {
          path: "preview.targets",
          message: 'expected "all" or a list of target names, got the string "some"',
        },
      ]);
    });

    it("preview must be false or an object", () => {
      expect(issues({ preview: true, targets: { web } })).toEqual([
        {
          path: "preview",
          message:
            "expected false (to disable previews) or an object with preview settings, got true",
        },
      ]);
    });
  });

  describe("branches and tag templates", () => {
    it("maintenanceBranches needs exactly one *", () => {
      expect(issues({ maintenanceBranches: "release/x", targets: { web } })).toEqual([
        {
          path: "maintenanceBranches",
          message:
            'expected a branch pattern with exactly one "*", which stands for <major>.<minor> (default "release/*.x")',
        },
      ]);
      expect(issues({ maintenanceBranches: "*/*", targets: { web } })).toHaveLength(1);
    });

    it("maintenanceBranches can't match the base branch", () => {
      expect(
        issues({ baseBranch: "release/1.4", maintenanceBranches: "release/*", targets: { web } }),
      ).toEqual([
        {
          path: "maintenanceBranches",
          message: 'pattern "release/*" matches the base branch "release/1.4"',
        },
      ]);
      // Only branches with a <major>.<minor> in place of the * are maintenance branches.
      expect(() => resolveConfig({ baseBranch: "release/foo.x", targets: { web } })).not.toThrow();
    });

    it("tag templates need their placeholders and nothing else", () => {
      expect(
        issues({
          tags: { release: "v", marker: "{version}", partial: "p/{version}/{sha}" },
          targets: { web },
        }),
      ).toEqual([
        { path: "tags.release", message: "expected a template containing {version}" },
        { path: "tags.marker", message: "expected a template containing {target} and {version}" },
        { path: "tags.partial", message: "unknown placeholder {sha}: expected {version}" },
      ]);
    });

    it("the partial template must differ from the release template", () => {
      expect(
        issues({ tags: { release: "{version}", partial: "{version}" }, targets: { web } }),
      ).toEqual([
        {
          path: "tags.partial",
          message:
            "must differ from tags.release (a partial release must never look like a release)",
        },
      ]);
    });
  });

  describe("targets", () => {
    it("unknown or missing type", () => {
      expect(issues({ targets: { api: { type: "dockr", image: "x" } } })).toEqual([
        {
          path: "targets.api.type",
          message:
            'expected one of "docker", "web", "android", "ios", "custom", got the string "dockr"',
        },
      ]);
      expect(issues({ targets: { api: { image: "x" } } })).toEqual([
        {
          path: "targets.api.type",
          message: 'required: expected one of "docker", "web", "android", "ios", "custom"',
        },
      ]);
    });

    it("unknown or missing source kind, and required source fields", () => {
      expect(
        issues({ targets: { a: { type: "android", source: { kind: "gradel", file: "x" } } } }),
      ).toEqual([
        {
          path: "targets.a.source.kind",
          message:
            'expected one of "gradle", "gradle-properties", "capacitor", "expo", got the string "gradel"',
        },
      ]);
      expect(issues({ targets: { a: { type: "android", source: { kind: "gradle" } } } })).toEqual([
        { path: "targets.a.source.file", message: "required: expected a string" },
      ]);
      expect(issues({ targets: { a: { type: "android" } } })).toEqual([
        { path: "targets.a.source", message: "required: expected an object" },
      ]);
      expect(
        issues({ targets: { a: { type: "android", source: { kind: "gradle", file: "" } } } }),
      ).toEqual([{ path: "targets.a.source.file", message: "expected a non-empty string" }]);
    });

    it("enum values and types", () => {
      expect(issues({ targets: { a: { type: "web", release: "sometimes" } } })).toEqual([
        {
          path: "targets.a.release",
          message: 'expected one of "auto", "manual", got the string "sometimes"',
        },
      ]);
      expect(
        issues({
          buildNumber: { strategy: "time", offset: 1.5, epoch: "yesterday" },
          targets: { web },
        }),
      ).toEqual([
        {
          path: "buildNumber.strategy",
          message:
            'expected one of "timestamp", "run-number", "semver", "eas", got the string "time"',
        },
        { path: "buildNumber.epoch", message: "expected an ISO 8601 date-time" },
        { path: "buildNumber.offset", message: "expected an integer, got the number 1.5" },
      ]);
      expect(issues({ buildNumber: { offset: -1 }, targets: { web } })).toEqual([
        { path: "buildNumber.offset", message: "expected an integer >= 0" },
      ]);
      expect(issues({ changelog: { github: "yes" }, targets: { web } })).toEqual([
        { path: "changelog.github", message: 'expected true or false, got the string "yes"' },
      ]);
      expect(issues({ targets: [] })).toEqual([
        { path: "targets", message: "expected an object, got a list" },
      ]);
      expect(issues("hello")).toEqual([
        { path: "", message: 'expected an object, got the string "hello"' },
      ]);
    });

    it("verify values per type", () => {
      expect(issues({ targets: { a: { type: "docker", image: "x", verify: ["store"] } } })).toEqual(
        [{ path: "targets.a.verify.0", message: 'expected "registry", got the string "store"' }],
      );
      expect(issues({ targets: { a: { type: "web", verify: ["store"] } } })).toEqual([
        {
          path: "targets.a.verify.0",
          message: "web targets have no verify checks: remove this entry",
        },
      ]);
    });

    it("store verification needs store ids", () => {
      expect(
        issues({
          targets: {
            a: { type: "android", source: { kind: "gradle", file: "x" }, verify: ["store"] },
            i: { type: "ios", source: { kind: "xcodeproj", file: "x" }, verify: ["store"] },
          },
        }),
      ).toEqual([
        {
          path: "targets.a.store.packageName",
          message: 'verify: ["store"] needs store.packageName',
        },
        { path: "targets.i.store.appId", message: 'verify: ["store"] needs store.appId' },
      ]);
      expect(
        issues({
          targets: {
            i: { type: "ios", source: { kind: "xcodeproj", file: "x" }, store: { appId: "abc" } },
          },
        }),
      ).toEqual([
        { path: "targets.i.store.appId", message: "expected the numeric Apple ID of the app" },
      ]);
    });

    it("plist sources take file or files", () => {
      expect(issues({ targets: { i: { type: "ios", source: { kind: "plist" } } } })).toEqual([
        {
          path: "targets.i.source",
          message: "expected file or files with at least one Info.plist path",
        },
      ]);
      expect(
        issues({
          targets: { i: { type: "ios", source: { kind: "plist", file: "a", files: ["b"] } } },
        }),
      ).toEqual([
        {
          path: "targets.i.source",
          message: "use either file (one Info.plist) or files (several), not both",
        },
      ]);
    });

    it("files entries", () => {
      expect(
        issues({
          targets: {
            web: {
              type: "web",
              files: [
                { path: "k8s/*.yaml", kind: "image" },
                { path: "x", kind: "regex", pattern: "(", replace: "{version}" },
                { path: "x", kind: "regex", pattern: "a", replace: "b", flags: "g" },
                { path: "x", kind: "jsn" },
                { path: "x", kind: "json" },
              ],
            },
          },
        }),
      ).toEqual([
        {
          path: "targets.web.files.1.pattern",
          message: expect.stringMatching(/^expected a valid regular expression \(/),
        },
        { path: "targets.web.files.2.flags", message: "expected only the RegExp flags i, m, s, u" },
        {
          path: "targets.web.files.3.kind",
          message: 'expected one of "json", "yaml", "regex", "image", got the string "jsn"',
        },
        { path: "targets.web.files.4.key", message: "required: expected a string" },
      ]);
      expect(
        issues({
          targets: { web: { type: "web", files: [{ path: "k8s/*.yaml", kind: "image" }] } },
        }),
      ).toEqual([
        {
          path: "targets.web.files.0.kind",
          message: 'kind "image" is only allowed in docker targets',
        },
      ]);
    });
  });
});

describe("review regressions", () => {
  it("unknown placeholders in a regex replace are errors; other braces stay literal", () => {
    const regex = (replace: string) => ({
      targets: {
        web: { type: "web", files: [{ path: "x", kind: "regex", pattern: "v", replace }] },
      },
    });
    expect(issues(regex("v{versoin}"))).toEqual([
      {
        path: "targets.web.files.0.replace",
        message:
          "unknown placeholder {versoin}: expected {version}, {major}, {minor}, {patch}, {buildNumber}",
      },
    ]);
    expect(issues(regex("{prNumber}")).map((i) => i.path)).toEqual(["targets.web.files.0.replace"]);
    for (const ok of [
      "{version}+{buildNumber}",
      "{major}.{minor}.{patch}",
      '{ "v": "{version}" }',
      "a{2,3}",
      ["$", "{name}-{version}"].join(""),
      "{}",
    ]) {
      expect(() => resolveConfig(regex(ok))).not.toThrow();
    }
  });

  it("docker tag templates must render to valid tags at load time", () => {
    const docker = (tags: unknown) => ({
      targets: { api: { type: "docker", image: "ghcr.io/o/api", tags } },
    });
    expect(issues(docker(["{version}", "foo bar"]))).toEqual([
      {
        path: "targets.api.tags.1",
        message:
          '"foo bar" can\'t become a valid Docker tag (it renders like "foo bar"): use only letters, digits, _ . and -, don\'t start with . or -, and keep it under 128 characters',
      },
    ]);
    expect(issues(docker({ preview: ["-{version}"] })).map((i) => i.path)).toEqual([
      "targets.api.tags.preview.0",
    ]);
    expect(issues(docker(["{version}", "v/{major}"])).map((i) => i.path)).toEqual([
      "targets.api.tags.1",
    ]);
    expect(issues(docker(["{version}", "x".repeat(129)])).map((i) => i.path)).toEqual([
      "targets.api.tags.1",
    ]);
    expect(() =>
      resolveConfig(docker(["v{version}", "sha-{shortSha}", "{major}_{minor}", "latest"])),
    ).not.toThrow();
  });
});

describe("changelog.github (deprecated alias of changelog.links)", () => {
  const changelog = (input: Record<string, unknown>) =>
    resolveConfig({ changelog: input, targets: { web } }).changelog;

  it("maps github onto links", () => {
    expect(changelog({ github: false })).toEqual({ file: "CHANGELOG.md", links: false });
    expect(changelog({ github: true })).toEqual({ file: "CHANGELOG.md", links: true });
    expect(changelog({ links: false })).toEqual({ file: "CHANGELOG.md", links: false });
    expect(changelog({ links: false, github: false })).toEqual({
      file: "CHANGELOG.md",
      links: false,
    });
  });

  it("rejects both with different values", () => {
    expect(issues({ changelog: { links: true, github: false }, targets: { web } })).toEqual([
      {
        path: "changelog.github",
        message: '"github" is the old name of "links", which is set to true: keep only "links"',
      },
    ]);
  });

  it("stays valid in the JSON Schema, marked deprecated", () => {
    const schema = configJsonSchema() as {
      properties: { changelog: { properties: Record<string, Record<string, unknown>> } };
    };
    const props = schema.properties.changelog.properties;
    expect(props.links).toMatchObject({ type: "boolean", default: true });
    expect(props.github).toMatchObject({ type: "boolean", deprecated: true });
  });
});

describe("configJsonSchema", () => {
  it("generates the input JSON Schema with $schema allowed", () => {
    const schema = configJsonSchema();
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.type).toBe("object");
    const properties = schema.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining(["$schema", "version", "targets", "preview", "buildNumber", "tags"]),
    );
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["targets"]);
  });
});

describe("GitLab settings: after, gitlab.shell, gitlab.include, gitlab.tagPipelines", () => {
  const custom = { type: "custom" } as const;

  it("resolves them, with defaults when they're left out", () => {
    const config = resolveConfig({
      gitlab: { include: [".gitlab/ci-templates.yml"], tagPipelines: true },
      targets: {
        windows: { ...custom, gitlab: { shell: "powershell" } },
        appimage: custom,
        site: { ...custom, after: ["windows", "appimage"] },
      },
    });
    expect(targetShell(config.targets.windows as never)).toBe("powershell");
    expect(targetShell(config.targets.appimage as never)).toBe("sh");
    expect(config.targets.site?.after).toEqual(["windows", "appimage"]);
    expect(gitlabSettings(config)).toEqual({
      include: [".gitlab/ci-templates.yml"],
      tagPipelines: true,
    });
    const plain = resolveConfig({ targets: { web } });
    expect(gitlabSettings(plain)).toEqual({ include: [], tagPipelines: false });
    expect(plain.targets.web).not.toHaveProperty("after");
    expect(plain).not.toHaveProperty("gitlab");
  });

  it("checks after: known, not itself, once, no cycles, auto only after auto", () => {
    expect(
      issues({
        targets: {
          a: { ...custom, after: ["b", "nope", "a", "b"] },
          b: { ...custom, after: ["c"] },
          c: { ...custom, after: ["a"] },
          m: { ...custom, release: "manual", after: ["a"] },
          d: { ...custom, after: ["m"] },
        },
      }),
    ).toEqual([
      { path: "targets.a.after.1", message: 'unknown target "nope"' },
      { path: "targets.a.after.2", message: "a target can't come after itself" },
      { path: "targets.a.after.3", message: '"b" is listed twice' },
      {
        path: "targets.d.after.0",
        message:
          '"m" is a manual target: a release doesn\'t build it, so the auto target d can only come after auto targets',
      },
      {
        path: "targets.a.after",
        message: "targets can't wait for each other in a circle: a -> b -> c -> a",
      },
    ]);
  });

  it("gives clear messages for bad shells and include paths, and unknown keys", () => {
    expect(issues({ targets: { w: { ...custom, gitlab: { shell: "pwsh" } } } })).toEqual([
      {
        path: "targets.w.gitlab.shell",
        message:
          'expected "sh" or "powershell" ("powershell" covers Windows PowerShell 5.1 and PowerShell 7, pwsh)',
      },
    ]);
    expect(
      issues({
        gitlab: { include: ["ci/$X.yml", "ci/*.yml", "ci/a.txt", "../x.yml", "https://x/y.yml"] },
        targets: { web },
      }).map((i) => [i.path, i.message.split(",")[0]]),
    ).toEqual([
      [
        "gitlab.include.0",
        "expected a literal path (no variables or wildcards: a generated child pipeline can't use them in include)",
      ],
      [
        "gitlab.include.1",
        "expected a literal path (no variables or wildcards: a generated child pipeline can't use them in include)",
      ],
      ["gitlab.include.2", "expected a .yml or .yaml file"],
      ["gitlab.include.3", "expected a path inside the repository"],
      ["gitlab.include.4", "expected a path inside the repository"],
    ]);
    expect(issues({ gitlab: { tagPipeline: true }, targets: { web } })).toEqual([
      { path: "gitlab.tagPipeline", message: UNKNOWN_KEY_MESSAGE },
    ]);
  });

  it("after is GitLab only: an issue on GitHub", () => {
    const config = resolveConfig({ targets: { a: custom, b: { ...custom, after: ["a"] } } });
    expect(hostConfigIssues(config, "gitlab")).toEqual([]);
    expect(hostConfigIssues(config, "github")).toEqual([
      {
        path: "targets.b.after",
        message: expect.stringMatching(
          /^is GitLab only: the GitHub workflows build every target in one matrix job/,
        ),
      },
    ]);
    expect(hostConfigIssues(resolveConfig({ targets: { web } }), "github")).toEqual([]);
  });

  it("is in the JSON Schema", () => {
    const schema = configJsonSchema() as { properties: Record<string, { properties?: object }> };
    expect(Object.keys(schema.properties.gitlab?.properties ?? {})).toEqual([
      "include",
      "tagPipelines",
    ]);
  });
});
