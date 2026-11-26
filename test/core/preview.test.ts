import { describe, expect, it } from "vitest";
import { LaunchsetError } from "../../src/core/errors.ts";
import {
  nextPrereleaseCandidate,
  type PreviewDecision,
  type PreviewInput,
  planPreview,
  prereleaseRelease,
  renderPreviewComment,
} from "../../src/core/preview.ts";
import type { Plan } from "../../src/core/types.ts";
import { BUILD, changeset, HEAD, makeConfig, NOW, tags } from "./plan-fixtures.ts";

const config = makeConfig({
  preview: {
    branches: [
      "develop",
      { branch: "feature/*", targets: ["docker-api"] },
      { branch: "next/*", prerelease: "alpha" },
      "release/*",
    ],
    targets: ["android", "ios", "docker-api"],
  },
});

function input(overrides: Partial<PreviewInput> = {}): PreviewInput {
  return {
    config,
    trigger: { kind: "push" },
    branch: "develop",
    headSha: HEAD,
    version: "1.4.0",
    changesets: [changeset("a", "minor")],
    tags: tags(config, ["v1.4.0"]),
    now: NOW,
    run: { id: 5, number: 17, attempt: 1, url: "https://github.com/demonsters/app/actions/runs/5" },
    repository: "demonsters/app",
    ...overrides,
  };
}

function planOf(decision: PreviewDecision): Plan {
  if (decision.kind !== "plan") throw new Error(`expected a plan, got skip: ${decision.reason}`);
  return decision.plan;
}

function skipOf(decision: PreviewDecision) {
  if (decision.kind !== "skip") throw new Error("expected a skip");
  return decision;
}

describe("PR previews (8.3, 9.7)", () => {
  const pr = {
    kind: "pr" as const,
    number: 123,
    labels: ["launchset:preview"],
    action: "synchronize",
  };

  it("builds {next}-pr.{n}.{run} for preview.targets", () => {
    const decision = planPreview(input({ trigger: pr, branch: "feature/login" }));
    const p = planOf(decision);
    expect(decision.kind === "plan" && decision.preview).toBe("pr");
    expect(p.mode).toBe("preview");
    expect(p.channel).toBe("preview");
    expect(p.version).toBe("1.5.0-pr.123.17");
    expect(p.baseVersion).toBe("1.5.0");
    expect(p.prNumber).toBe(123);
    expect(p.branchSlug).toBeUndefined();
    expect(p.distTag).toBe("pr-123");
    expect(p.releaseSha).toBe(HEAD);
    expect(p.tag).toBeUndefined();
    // Config order; manual targets preview like any other.
    expect(p.matrix).toEqual(["docker-api", "android", "ios"]);
    expect(p.targets.android?.marketingVersion).toBe("1.5.0-pr.123.17");
    expect(p.targets.ios?.marketingVersion).toBe("1.5.0");
    expect(p.targets.ios?.marker).toBeUndefined();
    expect(p.buildNumber).toBe(BUILD);
    expect(p.targets["docker-api"]?.docker?.tags).toEqual(["1.5.0-pr.123.17", "pr-123"]);
  });

  it("uses a patch bump when nothing is pending", () => {
    expect(planOf(planPreview(input({ trigger: pr, changesets: [] }))).version).toBe(
      "1.4.1-pr.123.17",
    );
  });

  it("skips taken versions for {next}", () => {
    const p = planOf(
      planPreview(input({ trigger: pr, changesets: [], tags: tags(config, ["v1.4.1"]) })),
    );
    expect(p.baseVersion).toBe("1.4.2");
  });

  it("skips without the label, for forks, and with rebuildOnPush: false on pushes", () => {
    expect(skipOf(planPreview(input({ trigger: { ...pr, labels: [] } }))).code).toBe("no-label");
    expect(skipOf(planPreview(input({ trigger: { ...pr, fork: true } }))).reason).toContain("fork");
    const noRebuild = makeConfig({ preview: { rebuildOnPush: false } });
    expect(skipOf(planPreview(input({ config: noRebuild, trigger: pr }))).code).toBe(
      "not-labeled-event",
    );
    expect(
      planPreview(input({ config: noRebuild, trigger: { ...pr, action: "labeled" } })).kind,
    ).toBe("plan");
  });

  it("skips when previews are disabled", () => {
    const off = makeConfig({ preview: false });
    const decision = skipOf(planPreview(input({ config: off, trigger: pr })));
    expect(decision.code).toBe("previews-disabled");
    expect(decision.summary).toContain("> [!NOTE]");
  });

  it("needs a run number", () => {
    const { run: _run, ...rest } = input({ trigger: pr });
    expect(() => planPreview(rest)).toThrow(LaunchsetError);
  });
});

describe("branch previews (8.3, 9.7)", () => {
  it("auto-previews a matching branch push as {next}-{slug}.{run}", () => {
    const p = planOf(planPreview(input()));
    expect(p.version).toBe("1.5.0-develop.17");
    expect(p.branchSlug).toBe("develop");
    expect(p.distTag).toBe("develop");
    expect(p.targets["docker-api"]?.docker?.tags).toEqual(["1.5.0-develop.17", "develop"]);
  });

  it("uses the branch entry's targets over preview.targets", () => {
    const p = planOf(planPreview(input({ branch: "feature/new_Form" })));
    expect(p.matrix).toEqual(["docker-api"]);
    expect(p.version).toBe("1.5.0-feature-new-form.17");
  });

  it("uses the dispatch input over the branch entry", () => {
    const p = planOf(
      planPreview(
        input({ branch: "feature/x", trigger: { kind: "dispatch", targets: ["web", "android"] } }),
      ),
    );
    expect(p.matrix).toEqual(["web", "android"]);
    const all = planOf(
      planPreview(input({ branch: "feature/x", trigger: { kind: "dispatch", targets: ["all"] } })),
    );
    expect(all.matrix).toEqual(["docker-api", "web", "android", "ios"]);
  });

  it("previews any branch on dispatch", () => {
    const p = planOf(planPreview(input({ branch: "spike/thing", trigger: { kind: "dispatch" } })));
    expect(p.version).toBe("1.5.0-spike-thing.17");
    expect(p.matrix).toEqual(["docker-api", "android", "ios"]);
  });

  it("skips a push to a branch without a preview entry", () => {
    expect(skipOf(planPreview(input({ branch: "random" }))).code).toBe("no-preview-branch");
  });

  it("never auto-previews maintenance branches, but dispatch works", () => {
    const decision = skipOf(
      planPreview(input({ branch: "release/1.4.x", version: "1.4.1", changesets: [] })),
    );
    expect(decision.code).toBe("maintenance-branch");
    const p = planOf(
      planPreview(
        input({
          branch: "release/1.4.x",
          version: "1.4.1",
          changesets: [],
          trigger: { kind: "dispatch" },
        }),
      ),
    );
    expect(p.maintenance).toBe(true);
    expect(p.version).toBe("1.4.2-release-1-4-x.17");
  });

  describe("semver targets (7.2)", () => {
    const semverConfig = makeConfig({
      preview: { targets: ["web"] },
      targets: {
        web: { type: "web" },
        ios: {
          type: "ios",
          source: { kind: "xcodeproj", file: "ios/App.xcodeproj" },
          release: "manual",
          buildNumber: { strategy: "semver" },
        },
      },
    });
    const dispatch = (targets?: string[]) =>
      planPreview(
        input({
          config: semverConfig,
          tags: tags(semverConfig, ["v1.4.0"]),
          branch: "feature/x",
          trigger: { kind: "dispatch", ...(targets ? { targets } : {}) },
        }),
      );

    it("never previews them: the targets input can't name one", () => {
      expect(planOf(dispatch()).matrix).toEqual(["web"]);
      expect(() => dispatch(["web", "ios"])).toThrow(LaunchsetError);
      let error: unknown;
      try {
        dispatch(["ios"]);
      } catch (thrown) {
        error = thrown;
      }
      expect(error).toMatchObject({
        code: "semver-preview",
        message: expect.stringContaining(
          '`ios` uses the "semver" build-number strategy, so it can\'t be previewed',
        ),
      });
    });

    it("leaves them out of all, with a notice", () => {
      const decision = dispatch(["all"]);
      expect(planOf(decision).matrix).toEqual(["web"]);
      if (decision.kind !== "plan") throw new Error("expected a plan");
      expect(decision.notices).toContain(
        'Not building `ios`: the "semver" build-number strategy can\'t be used for previews.',
      );
    });
  });

  it("rejects unknown dispatch targets", () => {
    expect(() => planPreview(input({ trigger: { kind: "dispatch", targets: ["nope"] } }))).toThrow(
      /no target "nope"/,
    );
  });
});

describe("prerelease branches (9.9)", () => {
  const pre = (overrides: Partial<PreviewInput> = {}) =>
    input({ branch: "next/new-form", ...overrides });

  it("builds {next}-{preid}.{n} with n = next free, a tag and the preid dist-tag", () => {
    const decision = planPreview(
      pre({ tags: tags(config, ["v1.4.0", "v1.5.0-alpha.0", "v1.5.0-alpha.2", "v1.6.0-alpha.7"]) }),
    );
    const p = planOf(decision);
    expect(decision.kind === "plan" && decision.preview).toBe("prerelease");
    expect(p.channel).toBe("prerelease");
    expect(p.version).toBe("1.5.0-alpha.3");
    expect(p.tag).toBe("v1.5.0-alpha.3");
    expect(p.preid).toBe("alpha");
    expect(p.distTag).toBe("alpha");
    expect(p.branchSlug).toBe("next-new-form");
    expect(p.targets.ios?.marketingVersion).toBe("1.5.0");
    expect(p.targets.android?.marketingVersion).toBe("1.5.0-alpha.3");
    expect(p.targets["docker-api"]?.docker?.tags).toEqual(["1.5.0-alpha.3", "next-new-form"]);
    expect(p.targets.android?.marker).toBeUndefined();
  });

  it("starts at 0 and prerelease tags never count as releases", () => {
    expect(planOf(planPreview(pre({ changesets: [] }))).version).toBe("1.4.1-alpha.0");
    // A prerelease tag doesn't make 1.4.1 taken: the base stays, only n moves.
    const p = planOf(planPreview(pre({ changesets: [], tags: tags(config, ["v1.4.1-alpha.4"]) })));
    expect(p.version).toBe("1.4.1-alpha.5");
  });

  it("retries with n + 1 after a reservation conflict", () => {
    const first = planOf(planPreview(pre()));
    expect(first.version).toBe("1.5.0-alpha.0");
    const retry = planOf(nextPrereleaseCandidate(pre(), first));
    expect(retry.version).toBe("1.5.0-alpha.1");
    expect(retry.tag).toBe("v1.5.0-alpha.1");
    expect(retry.targets["docker-api"]?.docker?.tags[0]).toBe("1.5.0-alpha.1");
    // Refreshed tags that know more win.
    const refreshed = planOf(
      nextPrereleaseCandidate(
        pre({ tags: tags(config, ["v1.5.0-alpha.0", "v1.5.0-alpha.4"]) }),
        first,
      ),
    );
    expect(refreshed.version).toBe("1.5.0-alpha.5");
    expect(() => nextPrereleaseCandidate(pre(), planOf(planPreview(input())))).toThrow(
      LaunchsetError,
    );
  });

  it("is also a prerelease on dispatch", () => {
    expect(planOf(planPreview(pre({ trigger: { kind: "dispatch" } }))).channel).toBe("prerelease");
  });

  it("doesn't need a run number", () => {
    const { run: _run, ...rest } = pre();
    expect(planOf(planPreview(rest)).version).toBe("1.5.0-alpha.0");
  });
});

describe("preview comment and pre-release body (9.7, 9.9)", () => {
  const p = planOf(
    planPreview(
      input({ trigger: { kind: "pr", number: 123, labels: ["launchset:preview"] }, branch: "x" }),
    ),
  );

  it("renders version, build numbers, Docker refs and per-target results", () => {
    const comment = renderPreviewComment({
      plan: p,
      results: {
        "docker-api": { status: "success", jobUrl: "https://example.test/job/1" },
        android: { status: "failure", jobUrl: "https://example.test/job/2" },
      },
    });
    expect(comment).toContain("### 🚀 launchset preview: `1.5.0-pr.123.17`");
    expect(comment).toContain("Preview of this PR: `android` failed.");
    expect(comment).toContain(
      `| \`docker-api\` | [succeeded](https://example.test/job/1) | \`1.5.0-pr.123.17\` | ${BUILD} |`,
    );
    expect(comment).toContain("| `android` | [**failed**](https://example.test/job/2) |");
    expect(comment).toContain(`| \`ios\` | running | \`1.5.0\` | ${BUILD} |`);
    expect(comment).toContain("- `ghcr.io/demonsters/api:pr-123`");
    expect(comment).toContain("[workflow run](https://github.com/demonsters/app/actions/runs/5)");
  });

  it("creates the pre-release with the branch's own changesets, never latest", () => {
    const pre = planOf(planPreview(input({ branch: "next/x" })));
    const release = prereleaseRelease({
      plan: pre,
      results: { "docker-api": { status: "success" } },
      changesets: [
        changeset("a", "minor", "Branch feature."),
        changeset("b", "patch", "On base too."),
      ],
      baseChangesetPaths: [".launchset/b.md"],
    });
    expect(release).toMatchObject({
      tag: "v1.5.0-alpha.0",
      name: "v1.5.0-alpha.0",
      prerelease: true,
      makeLatest: false,
    });
    expect(release.body).toContain("- `minor`: Branch feature.");
    expect(release.body).not.toContain("On base too.");
    expect(release.body).toContain("| `docker-api` | succeeded |");
    expect(() => prereleaseRelease({ plan: p, results: {}, changesets: [] })).toThrow(
      LaunchsetError,
    );
  });
});

describe("review regressions: preview labels", () => {
  const base = { kind: "pr" as const, number: 5, labels: ["launchset:preview", "bug"] };

  it("builds on labeled only for the preview label", () => {
    expect(
      planPreview(input({ trigger: { ...base, action: "labeled", label: "launchset:preview" } }))
        .kind,
    ).toBe("plan");
    const other = planPreview(input({ trigger: { ...base, action: "labeled", label: "bug" } }));
    expect(skipOf(other).code).toBe("other-label");
    expect(planPreview(input({ trigger: { ...base, action: "synchronize" } })).kind).toBe("plan");
    expect(planPreview(input({ trigger: { ...base, action: "reopened" } })).kind).toBe("plan");
  });

  it("with rebuildOnPush: false, only adding the preview label builds", () => {
    const noRebuild = makeConfig({ preview: { rebuildOnPush: false } });
    const at = (trigger: PreviewInput["trigger"]) =>
      planPreview(input({ config: noRebuild, trigger }));
    expect(at({ ...base, action: "labeled", label: "launchset:preview" }).kind).toBe("plan");
    expect(skipOf(at({ ...base, action: "labeled", label: "bug" })).code).toBe("other-label");
    expect(skipOf(at({ ...base, action: "synchronize" })).code).toBe("not-labeled-event");
  });
});
