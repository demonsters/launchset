import { describe, expect, it } from "vitest";
import {
  type LaunchsetConfig,
  type ResolvedDockerTarget,
  resolveConfig,
} from "../../src/core/config/schema.ts";
import {
  type DockerTagContext,
  dockerPlan,
  ociLabels,
  releaseVerifyTag,
  renderDockerTag,
  renderDockerTags,
} from "../../src/core/docker-tags.ts";

type DockerInput = Extract<LaunchsetConfig["targets"][string], { type: "docker" }>;

function target(options: Partial<DockerInput> = {}): ResolvedDockerTarget {
  const config = resolveConfig({
    targets: { api: { type: "docker", image: "ghcr.io/demonsters/api", ...options } },
  });
  return config.targets.api as ResolvedDockerTarget;
}

const SHA = "0123456789abcdef0123456789abcdef01234567";
const CREATED = "2026-11-18T12:00:00.000Z";

const release = (version: string, extra: Partial<DockerTagContext> = {}): DockerTagContext => ({
  channel: "release",
  version,
  maintenance: false,
  sha: SHA,
  buildNumber: 217_000_000,
  createdAt: CREATED,
  ...extra,
});

describe("default release tags", () => {
  it("renders version, minor, major and latest", () => {
    const plan = dockerPlan(target(), release("1.5.0"));
    expect(plan).toEqual({
      images: ["ghcr.io/demonsters/api"],
      tags: ["1.5.0", "1.5", "1", "latest"],
      refs: [
        "ghcr.io/demonsters/api:1.5.0",
        "ghcr.io/demonsters/api:1.5",
        "ghcr.io/demonsters/api:1",
        "ghcr.io/demonsters/api:latest",
      ],
      verifyTag: "1.5.0",
      labels: {
        "org.opencontainers.image.version": "1.5.0",
        "org.opencontainers.image.revision": SHA,
        "org.opencontainers.image.created": CREATED,
      },
    });
  });

  it("makes refs for every image, images outer loop", () => {
    const plan = dockerPlan(
      target({ image: ["ghcr.io/org/api", "docker.io/org/api"], tags: ["{version}", "latest"] }),
      release("2.0.0"),
    );
    expect(plan.refs).toEqual([
      "ghcr.io/org/api:2.0.0",
      "ghcr.io/org/api:latest",
      "docker.io/org/api:2.0.0",
      "docker.io/org/api:latest",
    ]);
  });
});

describe("placeholders", () => {
  it("renders every placeholder", () => {
    const values = {
      version: "1.5.0-alpha.3",
      major: "1",
      minor: "5",
      patch: "0",
      preid: "alpha",
      branchSlug: "next-new-form",
      sha: SHA,
      shortSha: "0123456",
      buildNumber: "42",
    };
    expect(
      renderDockerTag(
        "{version}_{major}.{minor}.{patch}_{preid}_{branchSlug}_{sha}_{shortSha}_{buildNumber}",
        values,
      ),
    ).toBe(`1.5.0-alpha.3_1.5.0_alpha_next-new-form_${SHA}_0123456_42`);
    expect(renderDockerTag("pr-{prNumber}", { prNumber: "123" })).toBe("pr-123");
  });

  it("uses {next} for major/minor/patch of previews and prereleases", () => {
    const { tags } = renderDockerTags(["{major}.{minor}.{patch}-preview", "{version}"], {
      channel: "preview",
      version: "1.5.0-pr.123.4",
      prNumber: 123,
      maintenance: false,
      createdAt: CREATED,
    });
    expect(tags).toEqual(["1.5.0-preview", "1.5.0-pr.123.4"]);
  });

  it("errors on unknown placeholders and invalid tags", () => {
    expect(() => renderDockerTag("{versoin}", {}, "targets.api.tags.release")).toThrow(
      "targets.api.tags.release: unknown placeholder {versoin}",
    );
    expect(() => renderDockerTag("-{version}", { version: "1.0.0" })).toThrow(
      /isn't a valid Docker tag/,
    );
    expect(() => renderDockerTag("a/{version}", { version: "1.0.0" })).toThrow(
      /isn't a valid Docker tag/,
    );
  });
});

describe("skipped templates", () => {
  it("PR previews skip {branchSlug}", () => {
    const plan = dockerPlan(target(), {
      channel: "preview",
      version: "1.5.0-pr.123.4",
      prNumber: 123,
      branchSlug: "feature-x",
      maintenance: false,
      createdAt: CREATED,
    });
    expect(plan.tags).toEqual(["1.5.0-pr.123.4", "pr-123"]);
    expect(plan.verifyTag).toBe("1.5.0-pr.123.4");
    expect(plan.labels).toEqual({
      "org.opencontainers.image.version": "1.5.0-pr.123.4",
      "org.opencontainers.image.created": CREATED,
    });
  });

  it("branch previews skip {prNumber}", () => {
    const plan = dockerPlan(target(), {
      channel: "preview",
      version: "1.5.0-develop.17",
      branchSlug: "develop",
      maintenance: false,
      createdAt: CREATED,
    });
    expect(plan.tags).toEqual(["1.5.0-develop.17", "develop"]);
  });

  it("prereleases use the prerelease list with {branchSlug} and {preid}", () => {
    const ctx: DockerTagContext = {
      channel: "prerelease",
      version: "1.5.0-alpha.3",
      preid: "alpha",
      branchSlug: "next-new-form",
      maintenance: false,
      createdAt: CREATED,
    };
    expect(dockerPlan(target(), ctx).tags).toEqual(["1.5.0-alpha.3", "next-new-form"]);
    expect(
      dockerPlan(target({ tags: { prerelease: ["{version}", "{preid}", "pr-{prNumber}"] } }), {
        ...ctx,
        prNumber: 5,
      }).tags,
    ).toEqual(["1.5.0-alpha.3", "alpha"]);
  });

  it("release runs skip {preid}, {prNumber} and {branchSlug}, and missing sha/build number", () => {
    const { tags } = renderDockerTags(
      ["{version}", "{preid}", "pr-{prNumber}", "{branchSlug}", "sha-{shortSha}", "b{buildNumber}"],
      {
        channel: "release",
        version: "1.5.0",
        maintenance: false,
        preid: "alpha",
        prNumber: 1,
        branchSlug: "main",
        buildNumber: null,
        createdAt: CREATED,
      },
    );
    expect(tags).toEqual(["1.5.0"]);
  });

  it("drops duplicate tags", () => {
    expect(
      renderDockerTags(["{version}", "{major}.{minor}.{patch}"], release("1.5.0")).tags,
    ).toEqual(["1.5.0"]);
  });
});

describe("maintenance branches", () => {
  it("drop latest and major-only tags from the default list", () => {
    const plan = dockerPlan(target(), release("1.4.2", { maintenance: true }));
    expect(plan.tags).toEqual(["1.4.2", "1.4"]);
  });

  it("filter custom lists too", () => {
    const plan = dockerPlan(
      target({
        tags: ["v{version}", "v{major}.{minor}", "v{major}", "latest", "stable", "sha-{shortSha}"],
      }),
      release("1.4.2", { maintenance: true }),
    );
    expect(plan.tags).toEqual(["v1.4.2", "v1.4"]);
    expect(plan.verifyTag).toBe("v1.4.2");
  });
});

describe("0.x versions", () => {
  it("skip major-only tags but keep the literal latest", () => {
    expect(dockerPlan(target(), release("0.3.1")).tags).toEqual(["0.3.1", "0.3", "latest"]);
  });

  it("skip other tags without {version}/{minor} in custom lists", () => {
    expect(
      dockerPlan(
        target({ tags: ["{version}", "v{major}", "stable", "latest", "{major}.{minor}"] }),
        release("0.9.0"),
      ).tags,
    ).toEqual(["0.9.0", "latest", "0.9"]);
  });

  it("keep them from 1.0.0 on", () => {
    expect(dockerPlan(target({ tags: ["{version}", "stable"] }), release("1.0.0")).tags).toEqual([
      "1.0.0",
      "stable",
    ]);
  });

  it("on a maintenance branch, latest is dropped as well", () => {
    expect(dockerPlan(target(), release("0.3.2", { maintenance: true })).tags).toEqual([
      "0.3.2",
      "0.3",
    ]);
  });
});

describe("verify tag (7.4)", () => {
  it("is the first rendered template containing {version}", () => {
    const plan = dockerPlan(
      target({ tags: ["latest", "v{version}", "{version}"] }),
      release("1.5.0"),
    );
    expect(plan.verifyTag).toBe("v1.5.0");
  });

  it("skips {version} templates that weren't rendered", () => {
    const plan = dockerPlan(
      target({ tags: ["{version}-b{buildNumber}", "v{version}"] }),
      release("1.5.0", { buildNumber: null }),
    );
    expect(plan.verifyTag).toBe("v1.5.0");
  });

  it("errors on a release run without a rendered {version} tag", () => {
    expect(() =>
      dockerPlan(
        target({ tags: ["{version}-{shortSha}", "latest"] }),
        release("1.5.0", { sha: undefined }),
      ),
    ).toThrow(
      "targets.api.tags.release: no rendered tag contains {version}, so there is no verify tag",
    );
  });

  it("is empty for a preview list without {version}", () => {
    const plan = dockerPlan(target({ tags: { preview: ["pr-{prNumber}"] } }), {
      channel: "preview",
      version: "1.5.0-pr.1.1",
      prNumber: 1,
      maintenance: false,
      createdAt: CREATED,
    });
    expect(plan.tags).toEqual(["pr-1"]);
    expect(plan.verifyTag).toBe("");
  });

  it("errors when no tag is left at all", () => {
    expect(() =>
      dockerPlan(target({ tags: { preview: ["pr-{prNumber}"] } }), {
        channel: "preview",
        version: "1.5.0-develop.1",
        branchSlug: "develop",
        maintenance: false,
        createdAt: CREATED,
      }),
    ).toThrow("targets.api.tags.preview: no tag template produced a tag for this preview run");
  });

  it("is available for the release PR (image file stamping)", () => {
    expect(releaseVerifyTag(target({ tags: ["latest", "v{version}"] }), "1.5.0")).toBe("v1.5.0");
    expect(releaseVerifyTag(target(), "1.5.0")).toBe("1.5.0");
    expect(() => releaseVerifyTag(target({ tags: ["{version}-{shortSha}"] }), "1.5.0")).toThrow(
      /isn't known when the release PR is made/,
    );
  });
});

describe("ociLabels", () => {
  it("has version, revision and created", () => {
    expect(ociLabels({ version: "1.5.0", sha: SHA, createdAt: CREATED })).toEqual({
      "org.opencontainers.image.version": "1.5.0",
      "org.opencontainers.image.revision": SHA,
      "org.opencontainers.image.created": CREATED,
    });
  });
});

describe("maintenance and 0.x rules apply to release tags only", () => {
  it("keeps 0.x PR preview tags", () => {
    const plan = dockerPlan(target(), {
      channel: "preview",
      version: "0.4.0-pr.5.2",
      prNumber: 5,
      maintenance: false,
      createdAt: CREATED,
    });
    expect(plan.tags).toEqual(["0.4.0-pr.5.2", "pr-5"]);
  });

  it("keeps 0.x branch preview tags", () => {
    const plan = dockerPlan(target(), {
      channel: "preview",
      version: "0.4.0-develop.7",
      branchSlug: "develop",
      maintenance: false,
      createdAt: CREATED,
    });
    expect(plan.tags).toEqual(["0.4.0-develop.7", "develop"]);
  });

  it("keeps 0.x prerelease tags", () => {
    const plan = dockerPlan(target(), {
      channel: "prerelease",
      version: "0.4.0-alpha.1",
      preid: "alpha",
      branchSlug: "next-x",
      maintenance: false,
      createdAt: CREATED,
    });
    expect(plan.tags).toEqual(["0.4.0-alpha.1", "next-x"]);
  });

  it("keeps preview tags on a maintenance branch", () => {
    const plan = dockerPlan(target(), {
      channel: "preview",
      version: "1.4.3-pr.9.1",
      prNumber: 9,
      maintenance: true,
      createdAt: CREATED,
    });
    expect(plan.tags).toEqual(["1.4.3-pr.9.1", "pr-9"]);
  });
});
