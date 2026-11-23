/** What the pure core writes for GitLab: MR words, lowercase alerts, hints, manual previews. */

import { describe, expect, it } from "vitest";
import { computeBuildNumber } from "../../src/core/build-number.ts";
import { forgeHints } from "../../src/core/forge-hints.ts";
import { forgeWords } from "../../src/core/forge-links.ts";
import { alert, renderSummary } from "../../src/core/plan-common.ts";
import {
  type PreviewDecision,
  type PreviewInput,
  planPreview,
  renderPreviewComment,
} from "../../src/core/preview.ts";
import { renderPartialReleaseBody, renderReleaseBody } from "../../src/core/release-notes.ts";
import { releasePrCloseComment } from "../../src/core/release-pr.ts";
import { computeStatus, renderStatus } from "../../src/core/status.ts";
import type { Plan } from "../../src/core/types.ts";
import { changeset, HEAD, makeConfig, NOW, tags } from "./plan-fixtures.ts";

describe("alerts", () => {
  it("are lowercase on GitLab, unchanged on GitHub", () => {
    expect(alert("WARNING", "a\n\nb", "gitlab")).toBe("> [!warning]\n> a\n>\n> b");
    expect(alert("WARNING", "a")).toBe("> [!WARNING]\n> a");
    expect(renderSummary({ title: "t", notices: ["n"], host: "gitlab" })).toBe(
      "## t\n\n> [!note]\n> n\n",
    );
  });

  it("in the body of a superseded partial release", () => {
    const body = renderPartialReleaseBody({
      version: "1.4.0",
      tag: "v1.4.0",
      supersededBy: "v1.4.1",
      shipped: ["web"],
      missing: ["android"],
      section: null,
      changelogFile: "CHANGELOG.md",
      host: "gitlab",
    });
    expect(body.startsWith("> [!warning]\n")).toBe(true);
  });
});

describe("words and hints", () => {
  it("a prerelease's release on GitLab is a plain GitLab release", () => {
    expect(forgeWords("gitlab").prereleaseName).toBe("GitLab release");
    expect(forgeWords().prereleaseName).toBe("GitHub pre-release");
  });

  it("GitLab hints never mention GitHub Actions", () => {
    const hints = forgeHints("gitlab");
    for (const value of Object.values(hints)) {
      const text = typeof value === "function" ? `${value(true)} ${value(false)}` : value;
      expect(text).not.toMatch(/actions\/checkout|fetch-depth|GITHUB_|GitHub/);
    }
    expect(hints.prHeadMissing).toContain('GIT_DEPTH: "0"');
  });

  it("the run-number strategy outside CI names the pipeline IID", () => {
    const config = { strategy: "run-number" as const, offset: 0, epoch: "2020-01-01T00:00:00Z" };
    expect(() => computeBuildNumber(config, { now: NOW, host: "gitlab" })).toThrow(
      /CI_PIPELINE_IID/,
    );
  });

  it("manual targets are shipped with a pipeline variable", () => {
    const body = renderReleaseBody({
      version: "1.5.0",
      section: "Notes",
      changelogFile: "CHANGELOG.md",
      manualTargets: [{ target: "ios", shipped: false }],
      host: "gitlab",
    });
    expect(body).toContain(
      "ship it with a release pipeline run with `LAUNCHSET_TARGET=ios` and `LAUNCHSET_RELEASE_VERSION=1.5.0`",
    );
  });

  it("MR words in the close note and the status", () => {
    expect(releasePrCloseComment("main", "gitlab")).toContain("a new release MR");
    const config = makeConfig();
    const status = computeStatus({
      config,
      branch: "main",
      version: "1.4.0",
      changesets: [],
      mismatches: [],
      tags: tags(config, ["v1.4.0"]),
      commitsSinceRelease: [],
      botPrs: [{ number: 12, title: "Update eslint", author: "renovate-bot" }],
    });
    const text = renderStatus(status, "gitlab");
    expect(text).toContain("Bot MRs without changeset (1):\n  !12  Update eslint");
    expect(renderStatus(status)).toContain("Bot PRs without changeset (1):\n  #12  Update eslint");
  });
});

describe("MR previews", () => {
  const config = makeConfig();
  const input = (trigger: PreviewInput["trigger"]): PreviewInput => ({
    config,
    trigger,
    branch: "feature",
    headSha: HEAD,
    version: "1.4.0",
    changesets: [changeset("a", "minor")],
    tags: tags(config, ["v1.4.0"]),
    now: NOW,
    run: { id: 500, number: 17, url: "https://gitlab.com/acme/app/-/pipelines/500" },
    host: "gitlab",
  });
  const planOf = (decision: PreviewDecision): Plan => {
    if (decision.kind !== "plan") throw new Error(`skipped: ${decision.reason}`);
    return decision.plan;
  };

  it("a manual run builds without the label, never for forks", () => {
    const manual = { kind: "pr" as const, number: 4, labels: [], manual: true };
    expect(planOf(planPreview(input(manual))).version).toBe("1.5.0-pr.4.17");
    const fork = planPreview(input({ ...manual, fork: true }));
    expect(fork.kind === "skip" && fork.code).toBe("fork");
  });

  it("without the label: add it and push, or start the manual job", () => {
    const decision = planPreview(input({ kind: "pr", number: 4, labels: [] }));
    expect(decision.kind === "skip" && decision.reason).toBe(
      "MR !4 doesn't have the `launchset:preview` label: add the label and push, or start the manual preview job.",
    );
  });

  it("with the label and no event action, every pipeline builds (also with rebuildOnPush false)", () => {
    const noRebuild = makeConfig({ preview: { rebuildOnPush: false } });
    const decision = planPreview({
      ...input({ kind: "pr", number: 4, labels: ["launchset:preview"] }),
      config: noRebuild,
    });
    expect(decision.kind).toBe("plan");
  });

  it("the comment says MR and links the pipeline", () => {
    const plan = planOf(
      planPreview(input({ kind: "pr", number: 4, labels: ["launchset:preview"] })),
    );
    const comment = renderPreviewComment({ plan, results: {}, host: "gitlab" });
    expect(comment).toContain("Preview of this MR.");
    expect(comment).toContain("[pipeline](https://gitlab.com/acme/app/-/pipelines/500)");
  });
});
