/**
 * `preview-sweep` against the fake GitLab: which labeled MRs get a new MR pipeline, and what
 * is reported for the others.
 */

import { describe, expect, it } from "vitest";
import { createContext, type FlowContext } from "../../src/flow/context.ts";
import { previewSweep } from "../../src/flow/preview-sweep.ts";
import { FakeGitLab, gitlabEnv, NOW, WEB } from "./gitlab-helpers.ts";
import { setupProject } from "./helpers.ts";

const LABEL = "launchset:preview";
const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

/** A context like the sweep job's: a scheduled pipeline on main. */
async function sweepContext(
  config: unknown = { targets: { web: { type: "web" } } },
  env: Record<string, string | undefined> = {},
): Promise<FlowContext> {
  const project = setupProject({ config });
  return createContext({
    cwd: project.repo.dir,
    env: gitlabEnv({
      CI_PIPELINE_SOURCE: "schedule",
      CI_COMMIT_BRANCH: "main",
      CI_COMMIT_REF_NAME: "main",
      LAUNCHSET_PREVIEW_SWEEP: "true",
      ...env,
    }),
    now: NOW,
  });
}

/** An open MR `iid` with the label, added `minutes` ago. */
function labeledMr(
  gitlab: FakeGitLab,
  iid: number,
  minutes: number,
  extra: Partial<Parameters<FakeGitLab["addMr"]>[0]> = {},
) {
  const mr = gitlab.addMr({ iid, source: `feature-${iid}`, sha: HEAD, labels: [LABEL], ...extra });
  gitlab.labelEvent(iid, LABEL, minutesAgo(minutes));
  return mr;
}

const created = (gitlab: FakeGitLab) =>
  gitlab.callsTo("POST", "/pipelines").map((c) => Number(c.path.split("/")[2]));

describe("preview-sweep", () => {
  it("starts a pipeline when the label was added after the head's last pipeline, once", async () => {
    const gitlab = new FakeGitLab();
    labeledMr(gitlab, 1, 5);
    // The pipeline for the head from before the label ran the preview as a manual job.
    gitlab.addPipeline(1, minutesAgo(30));
    const context = await sweepContext();

    const result = await previewSweep(context);
    expect(result.ok).toBe(true);
    expect(created(gitlab)).toEqual([1]);
    expect(gitlab.callsTo("POST", "/merge_requests/1/pipelines")[0]?.auth).toBe("token");
    const [entry] = result.data.mergeRequests;
    expect(entry).toMatchObject({
      number: 1,
      outcome: "created",
      branch: "feature-1",
      headSha: HEAD,
      labelAddedAt: minutesAgo(5).toISOString(),
    });
    expect(entry?.pipeline?.url).toMatch(`${WEB}/-/pipelines/`);
    expect(result.data).toMatchObject({ enabled: true, created: 1, failed: 0, max: 10 });
    expect(result.lines[0]).toBe(
      "Preview sweep: 1 open MR(s) with the launchset:preview label, 1 pipeline(s) started.",
    );
    expect(result.lines[1]).toBe(
      `MR !1: started pipeline ${entry?.pipeline?.id}: ${entry?.pipeline?.url}`,
    );

    // The next run sees the pipeline it started: nothing more.
    const again = await previewSweep(context);
    expect(created(gitlab)).toEqual([1]);
    expect(again.data.mergeRequests[0]?.skip?.code).toBe("has-pipeline");
  });

  it("skips an MR whose head already had a pipeline after the label was added", async () => {
    const gitlab = new FakeGitLab();
    labeledMr(gitlab, 1, 30);
    const pipeline = gitlab.addPipeline(1, minutesAgo(10));
    const result = await previewSweep(await sweepContext());
    expect(created(gitlab)).toEqual([]);
    expect(result.data.mergeRequests[0]).toMatchObject({
      outcome: "skipped",
      skip: { code: "has-pipeline" },
      pipeline: { id: pipeline.id, url: pipeline.web_url },
    });
    expect(result.lines[1]).toBe(
      `MR !1: skipped: pipeline ${pipeline.id} for its head commit started after the label was added.`,
    );
  });

  it("the latest label event counts; a pipeline at exactly that time covers it", async () => {
    const gitlab = new FakeGitLab();
    labeledMr(gitlab, 1, 60);
    gitlab.labelEvent(1, LABEL, minutesAgo(50), "remove");
    gitlab.labelEvent(1, "bug", minutesAgo(1));
    gitlab.labelEvent(1, LABEL, minutesAgo(20));
    gitlab.addPipeline(1, minutesAgo(40));
    const first = await previewSweep(await sweepContext());
    expect(first.data.mergeRequests[0]?.labelAddedAt).toBe(minutesAgo(20).toISOString());
    expect(created(gitlab)).toEqual([1]);

    const other = new FakeGitLab();
    labeledMr(other, 2, 20);
    other.addPipeline(2, minutesAgo(20));
    const second = await previewSweep(await sweepContext());
    expect(second.data.mergeRequests[0]?.skip?.code).toBe("has-pipeline");
  });

  it("a pipeline after the label for an older commit, or a branch pipeline, doesn't count", async () => {
    const gitlab = new FakeGitLab();
    labeledMr(gitlab, 1, 30);
    gitlab.addPipeline(1, minutesAgo(10), { sha: OLD });
    labeledMr(gitlab, 2, 30);
    gitlab.addPipeline(2, minutesAgo(10), { ref: "feature-2", source: "push" });
    const result = await previewSweep(await sweepContext());
    expect(created(gitlab)).toEqual([1, 2]);
    expect(result.data.created).toBe(2);
  });

  it("merged results pipelines: GitLab's head pipeline says whether one ran the head", async () => {
    const gitlab = new FakeGitLab();
    labeledMr(gitlab, 1, 30);
    gitlab.addPipeline(1, minutesAgo(10), { merged: true });
    // A merged results pipeline after the label, but for an older head.
    labeledMr(gitlab, 2, 30);
    gitlab.addPipeline(2, minutesAgo(40), { merged: true });
    gitlab.addPipeline(2, minutesAgo(10), { merged: true, sha: OLD });
    const result = await previewSweep(await sweepContext());
    expect(result.data.mergeRequests.map((e) => [e.number, e.outcome])).toEqual([
      [1, "skipped"],
      [2, "created"],
    ]);
    // The head pipeline is read only where a merged results pipeline came after the label.
    const mrReads = gitlab.calls.filter((c) => /^\/merge_requests\/\d+$/.test(c.path));
    expect(mrReads.map((c) => c.path)).toEqual(["/merge_requests/1", "/merge_requests/2"]);
  });

  it("uses the MR's creation time when the label has no event (set when the MR was created)", async () => {
    const gitlab = new FakeGitLab();
    gitlab.addMr({
      iid: 1,
      source: "feature-1",
      sha: HEAD,
      labels: [LABEL],
      createdAt: minutesAgo(15).toISOString(),
    });
    const result = await previewSweep(await sweepContext());
    expect(result.data.mergeRequests[0]?.labelAddedAt).toBe(minutesAgo(15).toISOString());
    expect(created(gitlab)).toEqual([1]);
  });

  it("skips fork MRs and the release MR, and MRs without the label", async () => {
    const gitlab = new FakeGitLab();
    labeledMr(gitlab, 1, 5, { sourceProjectId: 99 });
    labeledMr(gitlab, 2, 5, { source: "launchset/release/main" });
    gitlab.addMr({ iid: 3, source: "feature-3", sha: HEAD, labels: ["bug"] });
    const result = await previewSweep(await sweepContext());
    expect(created(gitlab)).toEqual([]);
    expect(result.data.mergeRequests.map((e) => [e.number, e.skip?.code])).toEqual([
      [1, "fork"],
      [2, "release-mr"],
    ]);
    expect(result.ok).toBe(true);
    // The listing asked GitLab for the label.
    expect(gitlab.callsTo("GET", "/merge_requests")[0]).toBeDefined();
  });

  it("--max: starts the oldest labels first, the rest wait for the next run", async () => {
    const gitlab = new FakeGitLab();
    labeledMr(gitlab, 1, 5);
    labeledMr(gitlab, 2, 50);
    labeledMr(gitlab, 3, 20);
    const result = await previewSweep(await sweepContext(), { max: 2 });
    expect(created(gitlab)).toEqual([2, 3]);
    expect(result.data.mergeRequests.find((e) => e.number === 1)).toMatchObject({
      outcome: "skipped",
      skip: { code: "max" },
    });
    expect(result.ok).toBe(true);
    await expect(previewSweep(await sweepContext(), { max: 0 })).rejects.toMatchObject({
      code: "invalid-max",
    });
  });

  it("--dry-run reports, starts nothing", async () => {
    const gitlab = new FakeGitLab();
    labeledMr(gitlab, 1, 5);
    labeledMr(gitlab, 2, 5);
    gitlab.addPipeline(2, minutesAgo(1));
    const result = await previewSweep(await sweepContext(), { dryRun: true });
    expect(gitlab.callsTo("POST", "")).toEqual([]);
    expect(result.data.mergeRequests.map((e) => e.outcome)).toEqual(["would-create", "skipped"]);
    expect(result.data).toMatchObject({ dryRun: true, created: 1 });
    expect(result.lines[0]).toContain("Preview sweep (dry run)");
    expect(result.lines[1]).toBe("MR !1: would start a pipeline (dry run)");
  });

  it("one failing start: the others are still started, and the result fails", async () => {
    const gitlab = new FakeGitLab();
    labeledMr(gitlab, 1, 30);
    labeledMr(gitlab, 2, 20);
    labeledMr(gitlab, 3, 10);
    gitlab.failNext("POST", "/merge_requests/2/pipelines", 403);
    const result = await previewSweep(await sweepContext());
    expect(result.ok).toBe(false);
    expect(created(gitlab)).toEqual([1, 2, 3]);
    expect(gitlab.pipelines.map((p) => p.mr)).toEqual([1, 3]);
    const failed = result.data.mergeRequests.find((e) => e.number === 2);
    expect(failed?.outcome).toBe("failed");
    expect(failed?.error).toContain("(403)");
    expect(failed?.error).toContain("at least the Developer role");
    expect(result.data).toMatchObject({ created: 2, failed: 1 });
    expect(result.summary).toContain("> [!caution]");
  });

  it("a failing read for one MR doesn't stop the others", async () => {
    const gitlab = new FakeGitLab();
    labeledMr(gitlab, 1, 30);
    labeledMr(gitlab, 2, 20);
    gitlab.failNext("GET", "/merge_requests/1/resource_label_events", 500);
    const result = await previewSweep(await sweepContext());
    expect(result.ok).toBe(false);
    expect(created(gitlab)).toEqual([2]);
    expect(result.data.mergeRequests[0]?.outcome).toBe("failed");
  });

  it("is GitLab only", async () => {
    const project = setupProject({ config: { targets: { web: { type: "web" } } } });
    const context = await createContext({
      cwd: project.repo.dir,
      env: { LAUNCHSET_HOST: "github", GITHUB_TOKEN: "ghs_x", GITHUB_REPOSITORY: "acme/app" },
      now: NOW,
    });
    await expect(previewSweep(context)).rejects.toMatchObject({
      code: "gitlab-only",
      message: expect.stringContaining("pull_request `labeled` event"),
    });
  });

  it("needs LAUNCHSET_TOKEN, not the job token", async () => {
    const gitlab = new FakeGitLab();
    labeledMr(gitlab, 1, 5);
    const context = await sweepContext(undefined, { LAUNCHSET_TOKEN: undefined });
    await expect(previewSweep(context)).rejects.toMatchObject({
      code: "no-gitlab-token",
      message: expect.stringContaining("CI_JOB_TOKEN can't"),
    });
    expect(gitlab.calls).toEqual([]);
  });

  it("previews disabled: nothing to do, no API calls", async () => {
    const gitlab = new FakeGitLab();
    labeledMr(gitlab, 1, 5);
    const result = await previewSweep(
      await sweepContext({ preview: false, targets: { web: { type: "web" } } }),
    );
    expect(result.ok).toBe(true);
    expect(result.data.enabled).toBe(false);
    expect(result.lines).toEqual([
      "Previews are disabled in the config (preview: false): nothing to sweep.",
    ]);
    expect(gitlab.calls).toEqual([]);
  });

  it("rebuildOnPush false: refuses, since the preview job stays manual", async () => {
    const gitlab = new FakeGitLab();
    labeledMr(gitlab, 1, 5);
    const context = await sweepContext({
      preview: { rebuildOnPush: false },
      targets: { web: { type: "web" } },
    });
    for (const dryRun of [false, true]) {
      const error = await previewSweep(context, { dryRun }).catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: "preview-sweep-manual-previews",
        message: expect.stringContaining("preview.rebuildOnPush is false"),
        hint: expect.stringContaining("Set preview.rebuildOnPush to true"),
      });
    }
    expect(gitlab.calls).toEqual([]);
  });
});
