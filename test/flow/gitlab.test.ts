/**
 * The flows on GitLab, end to end: a runner's checkout (detached HEAD, the job token in the
 * clone URL, CI_* variables), git over HTTP against a server with GitLab's auth rules, and a
 * fake GitLab REST API.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { check } from "../../src/flow/check.ts";
import { finalize } from "../../src/flow/finalize.ts";
import { mark } from "../../src/flow/mark.ts";
import { previewComment, previewPlan } from "../../src/flow/preview.ts";
import { release } from "../../src/flow/release.ts";
import { stamp } from "../../src/flow/stamp.ts";
import {
  authorOf,
  BOT_USER,
  FakeGitLab,
  type GitLabProject,
  gitlabContext,
  mrEnv,
  pushEnv,
  runnerCheckout,
  SERVER,
  setupGitLabProject,
  WEB,
} from "./gitlab-helpers.ts";
import { changesetText, execShow, versionFiles } from "./helpers.ts";

const CONFIG = { targets: { web: { type: "web" } } };

const open: GitLabProject[] = [];
afterEach(async () => {
  for (const project of open.splice(0)) await project.git.close();
});

async function project(options: Parameters<typeof setupGitLabProject>[0] = {}) {
  const created = await setupGitLabProject({ config: CONFIG, ...options });
  open.push(created);
  return created;
}

/** A pushed `feature` branch off main with `files`, its MR `iid` and the MR head ref. */
function featureMr(p: GitLabProject, files: Record<string, string>, iid = 1): string {
  p.repo.checkout("-b", "feature");
  const head = p.push("Feature work", files);
  p.setMrHead(iid, head);
  return head;
}

const minor = { ".launchset/brave-lions-sing.md": changesetText("minor", "Add offline mode.") };

/** Every git request used LAUNCHSET_TOKEN as `oauth2`, none the runner's job token. */
function expectOauth2Only(p: GitLabProject, push = true): void {
  expect(p.git.seen.length).toBeGreaterThan(0);
  expect(p.git.seen.every((r) => r.user === "oauth2" && r.valid)).toBe(true);
  if (push) expect(p.git.seen.some((r) => r.service === "receive-pack")).toBe(true);
}

describe("check in a merge request pipeline", () => {
  it("passes with a changeset and posts one note with LAUNCHSET_TOKEN", async () => {
    const p = await project();
    const head = featureMr(p, minor);
    const gitlab = new FakeGitLab();
    gitlab.addMr({ iid: 1, source: "feature", sha: head });
    const ci = runnerCheckout(p, head);
    const env = mrEnv({ iid: 1, source: "feature", sha: head });

    const first = await check(await gitlabContext(ci, env));
    expect(first.ok).toBe(true);
    expect(first.data.result).toMatchObject({ reason: "changeset", nextVersion: "1.5.0" });
    expect(first.data.comment?.action).toBe("created");
    expect(first.data.comment?.url).toMatch(`${WEB}/-/merge_requests/1#note_`);
    expect(gitlab.notes).toHaveLength(1);
    expect(gitlab.notes[0]?.body).toContain("<!-- launchset:check -->");
    expect(gitlab.notes[0]?.body).toContain("This MR's bump: **minor**");
    expect(gitlab.callsTo("POST", "/merge_requests/1/notes")[0]?.auth).toBe("token");
    // The fetches (tags, the target branch) authenticated with the token, not the clone URL.
    expectOauth2Only(p, false);

    const again = await check(await gitlabContext(ci, env));
    expect(again.data.comment?.action).toBe("unchanged");
    expect(gitlab.notes).toHaveLength(1);
  });

  it("fails without a changeset and says so in the note", async () => {
    const p = await project();
    const head = featureMr(p, { "src.txt": "x\n" });
    const gitlab = new FakeGitLab();
    gitlab.addMr({ iid: 1, source: "feature", sha: head });
    const ci = runnerCheckout(p, head);
    const result = await check(
      await gitlabContext(ci, mrEnv({ iid: 1, source: "feature", sha: head })),
    );
    expect(result.ok).toBe(false);
    expect(result.data.result.failures.map((f) => f.code)).toEqual(["no-changeset"]);
    expect(result.data.result.failures[0]?.message).toContain("this MR adds no changeset");
    expect(gitlab.notes[0]?.body).toContain("This MR has no changeset, so the check fails.");
  });

  it("with only CI_JOB_TOKEN: reads over the clone URL, warns that the note can't be posted", async () => {
    const p = await project();
    const head = featureMr(p, minor);
    const gitlab = new FakeGitLab();
    gitlab.addMr({ iid: 1, source: "feature", sha: head });
    const ci = runnerCheckout(p, head);
    const result = await check(
      await gitlabContext(
        ci,
        mrEnv({ iid: 1, source: "feature", sha: head }, { LAUNCHSET_TOKEN: undefined }),
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.data.comment).toBeUndefined();
    expect(result.data.commentWarning).toMatch(/^Couldn't post the check note on !1: CI_JOB_TOKEN/);
    expect(result.data.commentWarning).toContain("The check result above still counts.");
    expect(result.summary).toContain("> [!warning]");
    expect(gitlab.notes).toHaveLength(0);
    expect(gitlab.callsTo("POST", "/notes")[0]?.auth).toBe("job");
    // git used the runner's job token from the clone URL.
    expect(p.git.seen.some((r) => r.user === "gitlab-ci-token" && r.valid)).toBe(true);
    expect(p.git.seen.some((r) => r.user === "oauth2")).toBe(false);
  });

  it("recognises a bot MR by its author, read from the API", async () => {
    const p = await project();
    const head = featureMr(p, { "deps.txt": "lodash\n" });
    const gitlab = new FakeGitLab();
    gitlab.addMr({ iid: 1, source: "feature", sha: head, author: "renovate-bot" });
    const ci = runnerCheckout(p, head);
    const result = await check(
      await gitlabContext(ci, mrEnv({ iid: 1, source: "feature", sha: head })),
    );
    expect(result.ok).toBe(true);
    expect(result.data.result.reason).toBe("bot");
    expect(gitlab.callsTo("GET", "/merge_requests/1")[0]).toBeDefined();
    expect(gitlab.notes[0]?.body).toContain("### 🚀 launchset: bot MR");
  });

  it("warns for a fork MR whose pipeline can't write notes", async () => {
    const p = await project();
    const head = featureMr(p, minor);
    const gitlab = new FakeGitLab();
    gitlab.addMr({ iid: 1, source: "feature", sha: head });
    gitlab.failNext("POST", "/merge_requests/1/notes", 403);
    const ci = runnerCheckout(p, head);
    const result = await check(
      await gitlabContext(
        ci,
        mrEnv(
          { iid: 1, source: "feature", sha: head },
          { CI_MERGE_REQUEST_SOURCE_PROJECT_ID: "99" },
        ),
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.data.commentWarning).toMatch(/it comes from a fork/);
  });

  it("fails with a GitLab hint when the token may not write notes", async () => {
    const p = await project();
    const head = featureMr(p, minor);
    const gitlab = new FakeGitLab();
    gitlab.addMr({ iid: 1, source: "feature", sha: head });
    gitlab.failNext("POST", "/merge_requests/1/notes", 403);
    const ci = runnerCheckout(p, head);
    const error = await check(
      await gitlabContext(ci, mrEnv({ iid: 1, source: "feature", sha: head })),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "comment-forbidden",
      hint: expect.stringContaining("api scope and at least the Developer role"),
    });
  });

  /**
   * main released 1.5.0 after the MR branched off: the release commit consumed the changeset
   * the MR branch still has. The target branch after the merge has only the MR's patch.
   */
  function releasedSinceBranching(p: GitLabProject) {
    p.push("Old feature", {
      ".launchset/old-change.md": changesetText("minor", "Old feature."),
    });
    p.repo.checkout("-b", "feature");
    const head = p.push("Fix", { ".launchset/calm-cats-nap.md": changesetText("patch", "Fix.") });
    p.setMrHead(1, head);
    p.repo.checkout("main");
    p.repo.git("rm", "--quiet", ".launchset/old-change.md");
    const tip = p.push("Release v1.5.0", versionFiles("1.5.0"));
    p.repo.git("tag", "v1.5.0");
    p.repo.git("push", "--quiet", "origin", "v1.5.0");
    return { head, tip };
  }

  it("plain MR pipeline (HEAD is the MR head): pending changesets and version as merged", async () => {
    const p = await project();
    const { head } = releasedSinceBranching(p);
    const gitlab = new FakeGitLab();
    gitlab.addMr({ iid: 1, source: "feature", sha: head });
    const ci = runnerCheckout(p, head);
    expect(ci.git("rev-parse", "HEAD")).toBe(head);
    const result = await check(
      await gitlabContext(ci, mrEnv({ iid: 1, source: "feature", sha: head })),
    );
    expect(result.ok).toBe(true);
    expect(result.data.result.prChangesets.map((c) => c.path)).toEqual([
      ".launchset/calm-cats-nap.md",
    ]);
    expect(result.data.result).toMatchObject({ bump: "patch", nextVersion: "1.5.1" });
  });

  it("merged results pipeline (HEAD is the merge commit): the same result", async () => {
    const p = await project();
    const { head, tip } = releasedSinceBranching(p);
    const gitlab = new FakeGitLab();
    gitlab.addMr({ iid: 1, source: "feature", sha: head });
    const ci = runnerCheckout(p, tip);
    ci.git("merge", "--quiet", "--no-ff", "-m", "Merge feature", head);
    const merge = ci.head();
    const result = await check(
      await gitlabContext(
        ci,
        mrEnv(
          { iid: 1, source: "feature", sha: merge },
          {
            CI_MERGE_REQUEST_EVENT_TYPE: "merged_result",
            CI_MERGE_REQUEST_SOURCE_BRANCH_SHA: head,
            CI_MERGE_REQUEST_TARGET_BRANCH_SHA: tip,
          },
        ),
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.data.result).toMatchObject({ bump: "patch", nextVersion: "1.5.1" });
  });

  it("fetches the MR head from refs/merge-requests/<iid>/head when the checkout lacks it", async () => {
    const p = await project();
    const main = p.repo.head();
    p.repo.checkout("-b", "feature");
    const head = p.repo.commit("Feature", minor);
    // Only the MR ref has it (the source branch lives elsewhere, e.g. a deleted branch).
    p.repo.git("push", "--quiet", "origin", "HEAD:refs/merge-requests/3/head");
    new FakeGitLab().addMr({ iid: 3, source: "feature", sha: head });
    const ci = runnerCheckout(p, main);
    expect(() => ci.git("cat-file", "-e", `${head}^{commit}`)).toThrow();
    await check(
      await gitlabContext(
        ci,
        mrEnv(
          { iid: 3, source: "feature", sha: main },
          {
            CI_MERGE_REQUEST_EVENT_TYPE: "merged_result",
            CI_MERGE_REQUEST_SOURCE_BRANCH_SHA: head,
          },
        ),
      ),
    );
    expect(ci.git("rev-parse", "refs/remotes/origin/pr/3")).toBe(head);
  });
});

describe("release on GitLab", () => {
  it("pushes the release branch with oauth2 auth, opens the MR as the token's user, then updates it", async () => {
    const p = await project();
    const sha = p.push("Offline mode", minor);
    const gitlab = new FakeGitLab();
    const result = await release(await gitlabContext(runnerCheckout(p, sha), pushEnv("main", sha)));
    expect(result.data.mode).toBe("release-pr");
    expect(result.data.releasePr).toMatchObject({ number: 1, action: "created", pushed: true });
    expect(result.lines).toContain(`release MR !1 created: ${WEB}/-/merge_requests/1`);

    const branch = p.remoteBranch("launchset/release/main");
    expect(branch).toBeDefined();
    const identity = `${BOT_USER.name} <${BOT_USER.email}>`;
    expect(authorOf(p, "launchset/release/main")).toBe(`${identity}|${identity}`);
    expect(gitlab.callsTo("GET", "/user")).toHaveLength(1);
    const [create] = gitlab.callsTo("POST", "/merge_requests");
    expect(create?.auth).toBe("token");
    expect(create?.body).toMatchObject({
      source_branch: "launchset/release/main",
      target_branch: "main",
      title: "Release v1.5.0",
    });
    const mr = gitlab.openMrs()[0];
    expect(mr?.description).toContain("Merging this MR releases **v1.5.0** (minor)");
    expect(mr?.description).toContain("launchset rebuilds this MR from `main`");
    expectOauth2Only(p);

    // A second changeset on main: the branch is rebuilt and the MR updated.
    p.repo.checkout("main");
    const next = p.push("Fix", { ".launchset/calm-cats-nap.md": changesetText("patch", "Fix.") });
    const second = await release(
      await gitlabContext(runnerCheckout(p, next), pushEnv("main", next)),
    );
    expect(second.data.releasePr).toMatchObject({ number: 1, action: "updated" });
    expect(gitlab.openMrs()).toHaveLength(1);
    expect(gitlab.callsTo("PUT", "/merge_requests/1")).toHaveLength(1);
    expect(gitlab.openMrs()[0]?.description).toContain("Fix.");
    expect(p.remoteBranch("launchset/release/main")).not.toBe(branch);
  });

  it("commits as launchset@noreply.<CI_SERVER_HOST> when GET /user fails", async () => {
    const p = await project();
    const sha = p.push("Offline mode", minor);
    const gitlab = new FakeGitLab();
    gitlab.userStatus = 403;
    await release(await gitlabContext(runnerCheckout(p, sha), pushEnv("main", sha)));
    const identity = "launchset <launchset@noreply.gitlab.example.com>";
    expect(authorOf(p, "launchset/release/main")).toBe(`${identity}|${identity}`);
  });

  it("says MR, not PR, when the release MR can't be built (a dirty checkout)", async () => {
    const p = await project();
    const sha = p.push("Offline mode", minor);
    new FakeGitLab();
    const ci = runnerCheckout(p, sha);
    writeFileSync(join(ci.dir, "coverage.xml"), "<coverage/>");
    const error = await release(await gitlabContext(ci, pushEnv("main", sha))).catch(
      (e: Error) => e,
    );
    expect((error as Error).message).toBe(
      "Building the release MR needs a clean working tree, but there are uncommitted changes",
    );
  });

  it("without LAUNCHSET_TOKEN the push fails with a hint about CI_JOB_TOKEN", async () => {
    const p = await project();
    const sha = p.push("Offline mode", minor);
    new FakeGitLab();
    const error = await release(
      await gitlabContext(
        runnerCheckout(p, sha),
        pushEnv("main", sha, { LAUNCHSET_TOKEN: undefined }),
      ),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({
      reason: "forbidden",
      hint: expect.stringContaining("used the runner's CI_JOB_TOKEN"),
    });
  });

  it("publishes the merged release: plan, stamp, mark, finalize with a GitLab release", async () => {
    const p = await project();
    const sha = p.push("Offline mode", minor);
    const gitlab = new FakeGitLab();
    await release(await gitlabContext(runnerCheckout(p, sha), pushEnv("main", sha)));

    // The release MR is merged (merge commit), and the push pipeline of main runs.
    p.repo.checkout("main");
    p.repo.git("fetch", "--quiet", "origin");
    const merged = p.repo.merge(
      "origin/launchset/release/main",
      "Merge branch 'launchset/release/main' into 'main'",
    );
    p.repo.git("push", "--quiet", "origin", "main");
    const ci = runnerCheckout(p, merged);
    const env = pushEnv("main", merged);
    const planned = await release(await gitlabContext(ci, env));
    expect(planned.data.mode).toBe("publish");
    const plan = planned.outputs.plan ?? "";
    expect(planned.data.plan).toMatchObject({ version: "1.5.0", releaseSha: merged });

    const stamped = await stamp(await gitlabContext(ci, env), { target: "web", plan });
    expect(stamped.ok).toBe(true);
    ci.git("checkout", "--quiet", "--", ".");
    const marked = await mark(await gitlabContext(ci, env), { target: "web", plan });
    expect(marked.data.result).toBe("created");
    expect(p.remoteTags().get("launchset/web@1.5.0")).toBe(merged);

    const result = await finalize(await gitlabContext(ci, env), { plan });
    expect(result.ok).toBe(true);
    expect(result.data.result.status).toBe("released");
    expect(p.remoteTags().get("v1.5.0")).toBe(merged);
    const [create] = gitlab.callsTo("POST", "/releases");
    expect(create?.auth).toBe("token");
    const body = create?.body as { tag_name: string; name: string; description: string };
    expect(body.tag_name).toBe("v1.5.0");
    expect(body.name).toBe("v1.5.0");
    expect(body.description).toContain("Add offline mode.");
    expect(body.description).toBe(gitlab.release("v1.5.0")?.description);
    expect(body.description).not.toMatch(/\[![A-Z]+\]/);
    expect(execShow(p.remote, "v1.5.0", "CHANGELOG.md")).toContain("## 1.5.0");
    expectOauth2Only(p);
    // launchset's tags start no tag pipeline (git push -o ci.skip); branch pushes are unchanged.
    const pushes = p.pushes();
    expect(pushes.filter((l) => l.startsWith("refs/tags/"))).toEqual([
      "refs/tags/launchset/web@1.5.0 ci.skip",
      "refs/tags/v1.5.0 ci.skip",
    ]);
    expect(pushes.filter((l) => l.startsWith("refs/heads/") && l.includes(" "))).toEqual([]);
  });

  it("gitlab.tagPipelines: the release tag starts its pipeline, the marker tag still doesn't", async () => {
    const p = await project({
      config: { gitlab: { tagPipelines: true }, targets: { web: { type: "web" } } },
    });
    const sha = p.push("Offline mode", minor);
    new FakeGitLab();
    await release(await gitlabContext(runnerCheckout(p, sha), pushEnv("main", sha)));
    p.repo.checkout("main");
    p.repo.git("fetch", "--quiet", "origin");
    const merged = p.repo.merge("origin/launchset/release/main", "Merge the release MR");
    p.repo.git("push", "--quiet", "origin", "main");
    const ci = runnerCheckout(p, merged);
    const env = pushEnv("main", merged);
    const plan = (await release(await gitlabContext(ci, env))).outputs.plan ?? "";
    await mark(await gitlabContext(ci, env), { target: "web", plan });
    expect((await finalize(await gitlabContext(ci, env), { plan })).ok).toBe(true);
    expect(p.pushes().filter((l) => l.startsWith("refs/tags/"))).toEqual([
      "refs/tags/launchset/web@1.5.0 ci.skip",
      "refs/tags/v1.5.0",
    ]);
  });

  it("a superseded partial release: lowercase alert, created before the real release", async () => {
    const p = await project({
      config: { targets: { web: { type: "web" }, site: { type: "web" } } },
    });
    const gitlab = new FakeGitLab();
    /** Run the release job on main's tip, merge the release MR, return the publish plan. */
    const publish = async () => {
      const tip = p.repo.head();
      await release(await gitlabContext(runnerCheckout(p, tip), pushEnv("main", tip)));
      p.repo.git("fetch", "--quiet", "origin");
      const merged = p.repo.merge("origin/launchset/release/main", "Merge the release MR");
      p.repo.git("push", "--quiet", "origin", "main");
      const ci = runnerCheckout(p, merged);
      const env = pushEnv("main", merged);
      const planned = await release(await gitlabContext(ci, env));
      expect(planned.data.mode).toBe("publish");
      return { ci, env, plan: planned.outputs.plan ?? "" };
    };

    p.push("Offline mode", minor);
    const first = await publish();
    await mark(await gitlabContext(first.ci, first.env), { target: "web", plan: first.plan });
    const incomplete = await finalize(await gitlabContext(first.ci, first.env), {
      plan: first.plan,
    });
    expect(incomplete.data.result.status).toBe("incomplete");

    p.push("Fix", { ".launchset/calm-cats-nap.md": changesetText("patch", "Fix.") });
    const second = await publish();
    for (const target of ["web", "site"]) {
      await mark(await gitlabContext(second.ci, second.env), { target, plan: second.plan });
    }
    const result = await finalize(await gitlabContext(second.ci, second.env), {
      plan: second.plan,
    });
    expect(result.data.result.status).toBe("released");
    const created = gitlab
      .callsTo("POST", "/releases")
      .map((c) => c.body as Record<string, string>);
    expect(created.map((b) => b.tag_name)).toEqual(["launchset/partial/1.5.0", "v1.5.1"]);
    expect(p.pushes()).toContain("refs/tags/launchset/partial/1.5.0 ci.skip");
    expect(created[0]?.name).toBe("v1.5.0 (partial, superseded by v1.5.1)");
    expect(created[0]?.description).toMatch(/^> \[!warning\]\n> v1\.5\.0 was never fully released/);
    expect(result.lines.join("\n")).not.toContain("pre-release");
  });
});

describe("previews in merge request pipelines", () => {
  async function previewSetup(labels: string[] = []) {
    const p = await project();
    const head = featureMr(p, minor);
    const gitlab = new FakeGitLab();
    gitlab.addMr({ iid: 1, source: "feature", sha: head, labels });
    return { p, head, gitlab, ci: runnerCheckout(p, head) };
  }

  it("builds with the preview label", async () => {
    const { head, ci } = await previewSetup(["launchset:preview"]);
    const env = mrEnv({ iid: 1, source: "feature", sha: head, labels: ["launchset:preview"] });
    const result = await previewPlan(await gitlabContext(ci, env));
    expect(result.data.outcome).toBe("plan");
    expect(result.data.plan).toMatchObject({ version: "1.5.0-pr.1.17", prNumber: 1 });
    expect(result.summary).toContain("Building MR !1");
  });

  it("skips without the label, pointing to the manual job", async () => {
    const { head, ci } = await previewSetup();
    const result = await previewPlan(
      await gitlabContext(ci, mrEnv({ iid: 1, source: "feature", sha: head })),
    );
    expect(result.data.skip).toEqual({
      code: "no-label",
      reason:
        "MR !1 doesn't have the `launchset:preview` label: add the label and push, or start the manual preview job.",
    });
  });

  it("names GitLab's variables when the MR pipeline lacks the MR", async () => {
    const { head, ci } = await previewSetup(["launchset:preview"]);
    const env = mrEnv({ iid: 1, source: "feature", sha: head }, { CI_MERGE_REQUEST_IID: "" });
    const error = await previewPlan(await gitlabContext(ci, env)).catch((e: Error) => e);
    expect((error as Error).message).toContain("CI_MERGE_REQUEST_IID");
    expect((error as Error).message).not.toContain("pull_request");
  });

  it("builds without the label when the manual preview job runs", async () => {
    const { head, ci } = await previewSetup();
    const env = mrEnv(
      { iid: 1, source: "feature", sha: head },
      { LAUNCHSET_PREVIEW_MANUAL: "true" },
    );
    const result = await previewPlan(await gitlabContext(ci, env));
    expect(result.data.outcome).toBe("plan");
    expect(result.data.plan?.version).toBe("1.5.0-pr.1.17");
  });

  it("posts the results of the child pipeline's jobs as a note", async () => {
    const { head, ci, gitlab } = await previewSetup(["launchset:preview"]);
    const env = mrEnv({ iid: 1, source: "feature", sha: head, labels: ["launchset:preview"] });
    const plan = (await previewPlan(await gitlabContext(ci, env))).outputs.plan ?? "";
    gitlab.jobs.set(500, [
      { id: 1, name: "launchset-preview", status: "success", web_url: `${WEB}/-/jobs/1` },
    ]);
    gitlab.children.set(500, [501]);
    gitlab.jobs.set(501, [
      { id: 2, name: "preview-web", status: "failed", web_url: `${WEB}/-/jobs/2` },
    ]);
    const result = await previewComment(await gitlabContext(ci, env), { plan });
    expect(result.data.results).toEqual({
      web: { status: "failure", jobUrl: `${WEB}/-/jobs/2` },
    });
    expect(result.data.unmatched).toEqual([]);
    const note = gitlab.notes[0]?.body ?? "";
    expect(note).toContain("<!-- launchset:preview -->");
    expect(note).toContain("Preview of this MR: `web` failed.");
    expect(note).toContain(`[**failed**](${WEB}/-/jobs/2)`);
    expect(note).toContain(`[pipeline](${SERVER}/acme/app/-/pipelines/500)`);
    expect(gitlab.callsTo("GET", "/pipelines/501/jobs")[0]?.auth).toBe("token");
  });

  it("in the child pipeline: lists its own jobs, links the MR pipeline", async () => {
    const { head, ci, gitlab } = await previewSetup();
    const env = mrEnv(
      { iid: 1, source: "feature", sha: head },
      { LAUNCHSET_PREVIEW_MANUAL: "true" },
    );
    const plan = (await previewPlan(await gitlabContext(ci, env))).outputs.plan ?? "";
    gitlab.jobs.set(501, [
      { id: 2, name: "preview-web", status: "success", web_url: `${WEB}/-/jobs/2` },
      { id: 3, name: "launchset-preview-comment", status: "running", web_url: `${WEB}/-/jobs/3` },
    ]);
    // The child's job: the parent's variables (the MR's among them), its own pipeline id.
    const child = {
      ...env,
      CI_PIPELINE_SOURCE: "parent_pipeline",
      CI_PIPELINE_ID: "501",
      CI_JOB_NAME: "launchset-preview-comment",
    };
    const result = await previewComment(await gitlabContext(ci, child), { plan });
    expect(result.data.kind).toBe("pr");
    expect(result.data.results).toEqual({ web: { status: "success", jobUrl: `${WEB}/-/jobs/2` } });
    expect(gitlab.notes[0]?.body).toContain(`[pipeline](${SERVER}/acme/app/-/pipelines/500)`);
    expect(gitlab.callsTo("GET", "/pipelines/501/jobs")).toHaveLength(1);
  });

  it("the old comment job of the parent pipeline does nothing and says to remove it", async () => {
    const { head, ci, gitlab } = await previewSetup(["launchset:preview"]);
    const env = mrEnv({ iid: 1, source: "feature", sha: head, labels: ["launchset:preview"] });
    const plan = (await previewPlan(await gitlabContext(ci, env))).outputs.plan ?? "";
    const parent = { ...env, CI_JOB_NAME: "launchset-preview-comment" };
    for (const input of [plan, ""]) {
      const result = await previewComment(await gitlabContext(ci, parent), { plan: input });
      expect(result.ok).toBe(true);
      expect(result.data.kind).toBe("none");
      expect(result.summary).toContain(
        "Remove the job launchset-preview-comment from .gitlab/launchset.yml",
      );
    }
    expect(gitlab.notes).toEqual([]);
    expect(gitlab.callsTo("GET", "/pipelines/500/jobs")).toEqual([]);
  });

  it("can't list the jobs: says why, and never retries with CI_JOB_TOKEN", async () => {
    const { head, ci, gitlab } = await previewSetup(["launchset:preview"]);
    const env = mrEnv({ iid: 1, source: "feature", sha: head, labels: ["launchset:preview"] });
    const plan = (await previewPlan(await gitlabContext(ci, env))).outputs.plan ?? "";
    gitlab.failNext("GET", "/pipelines/500/jobs", 403);
    const result = await previewComment(await gitlabContext(ci, env), { plan });
    expect(result.data.results).toEqual({ web: { status: "unknown" } });
    expect(gitlab.notes[0]?.body).toContain("Listing pipeline jobs needs LAUNCHSET_TOKEN");
    expect(gitlab.calls.filter((c) => c.path.includes("/pipelines") && c.auth === "job")).toEqual(
      [],
    );
  });
});
