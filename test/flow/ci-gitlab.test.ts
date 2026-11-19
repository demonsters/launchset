import { describe, expect, it } from "vitest";
import { gitlabEnvironment, readCiEnvironment } from "../../src/flow/ci/index.ts";
import { createContext } from "../../src/flow/context.ts";
import { repoWithRemote } from "../git/helpers.ts";

const BASE = {
  GITLAB_CI: "true",
  CI_SERVER_URL: "https://gitlab.acme.dev/",
  CI_API_V4_URL: "https://gitlab.acme.dev/api/v4",
  CI_PROJECT_PATH: "acme/mobile/app",
  CI_COMMIT_SHA: "c0ffee",
  CI_COMMIT_REF_NAME: "feature",
  CI_PIPELINE_ID: "900",
  CI_PIPELINE_IID: "12",
};

const MR = {
  ...BASE,
  CI_PIPELINE_SOURCE: "merge_request_event",
  CI_COMMIT_REF_NAME: "feature",
  CI_MERGE_REQUEST_IID: "7",
  CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "feature",
  CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main",
  CI_MERGE_REQUEST_SOURCE_PROJECT_ID: "5",
  CI_MERGE_REQUEST_PROJECT_ID: "5",
  CI_MERGE_REQUEST_SOURCE_PROJECT_PATH: "acme/mobile/app",
  CI_MERGE_REQUEST_PROJECT_PATH: "acme/mobile/app",
};

describe("GitLab environment: basics", () => {
  it("reads the server, repository, run and ref", () => {
    const ci = gitlabEnvironment({ ...BASE, CI_COMMIT_BRANCH: "main" });
    expect(ci).toMatchObject({
      host: "gitlab",
      inCi: true,
      serverUrl: "https://gitlab.acme.dev",
      apiUrl: "https://gitlab.acme.dev/api/v4",
      repository: "acme/mobile/app",
      run: { id: 900, number: 12 },
      ref: "refs/heads/main",
      refName: "feature",
      sha: "c0ffee",
    });
    expect(ci.run).not.toHaveProperty("attempt");
  });

  it("is empty outside CI and defaults to gitlab.com", () => {
    expect(gitlabEnvironment({})).toEqual({
      host: "gitlab",
      inCi: false,
      serverUrl: "https://gitlab.com",
    });
  });

  it("uses the tag as the ref of a tag pipeline, and ignores bad run numbers", () => {
    const ci = gitlabEnvironment({
      ...BASE,
      CI_COMMIT_TAG: "v1.0.0",
      CI_PIPELINE_ID: "0",
      CI_PIPELINE_IID: "x",
    });
    expect(ci.ref).toBe("refs/tags/v1.0.0");
    expect(ci.run).toBeUndefined();
  });

  it("LAUNCHSET_TOKEN beats GITLAB_TOKEN; CI_JOB_TOKEN is the job-token fallback", () => {
    expect(
      gitlabEnvironment({ LAUNCHSET_TOKEN: "a", GITLAB_TOKEN: "b", CI_JOB_TOKEN: "j" }),
    ).toMatchObject({
      token: "a",
      fallbackToken: "j",
      fallbackTokenKind: "job",
    });
    expect(gitlabEnvironment({ GITLAB_TOKEN: "b" }).token).toBe("b");
    const jobOnly = gitlabEnvironment({ CI_JOB_TOKEN: "j" });
    expect(jobOnly.token).toBeUndefined();
    expect(jobOnly.fallbackToken).toBe("j");
    expect(gitlabEnvironment({}).fallbackTokenKind).toBeUndefined();
  });

  it("readCiEnvironment picks the adapter by host", async () => {
    expect((await readCiEnvironment("gitlab", BASE)).repository).toBe("acme/mobile/app");
  });
});

describe("GitLab environment: events", () => {
  it("a plain merge request pipeline: the head is CI_COMMIT_SHA", () => {
    const { event, ref } = gitlabEnvironment({
      ...MR,
      CI_MERGE_REQUEST_LABELS: "preview, bug,,",
    });
    expect(ref).toBeUndefined();
    expect(event).toEqual({
      name: "merge_request_event",
      kind: "pr",
      inputs: {},
      pr: {
        number: 7,
        headRef: "feature",
        headSha: "c0ffee",
        headRepo: "acme/mobile/app",
        baseRef: "main",
        baseRepo: "acme/mobile/app",
        labels: ["preview", "bug"],
        fork: false,
      },
    });
  });

  it("a merged results pipeline: the source branch sha is the head, the target sha is known", () => {
    const pr = gitlabEnvironment({
      ...MR,
      CI_MERGE_REQUEST_SOURCE_BRANCH_SHA: "src111",
      CI_MERGE_REQUEST_TARGET_BRANCH_SHA: "tgt222",
    }).event?.pr;
    expect(pr).toMatchObject({ headSha: "src111", baseSha: "tgt222" });
    expect(pr?.labels).toEqual([]);
  });

  it("a merge request from a fork", () => {
    const pr = gitlabEnvironment({
      ...MR,
      CI_MERGE_REQUEST_SOURCE_PROJECT_ID: "9",
      CI_MERGE_REQUEST_SOURCE_PROJECT_PATH: "fork/app",
    }).event?.pr;
    expect(pr).toMatchObject({ fork: true, headRepo: "fork/app", baseRepo: "acme/mobile/app" });
  });

  it("a branch push, a tag push and an unusable push", () => {
    expect(
      gitlabEnvironment({ ...BASE, CI_PIPELINE_SOURCE: "push", CI_COMMIT_BRANCH: "main" }).event,
    ).toEqual({
      name: "push",
      kind: "push",
      ref: "refs/heads/main",
      sha: "c0ffee",
      inputs: {},
    });
    const tag = gitlabEnvironment({
      ...BASE,
      CI_PIPELINE_SOURCE: "push",
      CI_COMMIT_TAG: "v1.0.0",
    }).event;
    expect(tag?.kind).toBe("other");
    expect(
      gitlabEnvironment({
        ...BASE,
        CI_PIPELINE_SOURCE: "push",
        CI_COMMIT_BRANCH: "main",
        CI_COMMIT_SHA: "0".repeat(40),
      }).event,
    ).toEqual({ name: "push", kind: "push", ref: "refs/heads/main", inputs: {} });
  });

  it.each(["web", "api", "trigger", "pipeline", "chat"])(
    "%s is a dispatch with inputs from variables",
    (source) => {
      const event = gitlabEnvironment({
        ...BASE,
        CI_PIPELINE_SOURCE: source,
        CI_COMMIT_BRANCH: "main",
        LAUNCHSET_TARGET: "web,ios",
        LAUNCHSET_RELEASE_VERSION: "1.2.3",
        LAUNCHSET_FORCE: "true",
        LAUNCHSET_VERSION: "9.9.9",
      }).event;
      expect(event).toEqual({
        name: source,
        kind: "dispatch",
        ref: "refs/heads/main",
        sha: "c0ffee",
        inputs: { target: "web,ios", targets: "web,ios", version: "1.2.3", force: "true" },
      });
    },
  );

  it("a dispatch sets only the non-empty inputs", () => {
    const event = gitlabEnvironment({
      ...BASE,
      CI_PIPELINE_SOURCE: "web",
      LAUNCHSET_TARGET: "",
      LAUNCHSET_FORCE: "false",
    }).event;
    expect(event?.inputs).toEqual({ force: "false" });
    expect(event?.ref).toBeUndefined();
  });

  it("a child pipeline carries the parent's merge request, branch or neither", () => {
    const child = { ...BASE, CI_PIPELINE_SOURCE: "parent_pipeline" };
    const pr = gitlabEnvironment({ ...child, ...MR, CI_PIPELINE_SOURCE: "parent_pipeline" }).event;
    expect(pr).toMatchObject({
      name: "parent_pipeline",
      kind: "pr",
      pr: { number: 7, baseRef: "main" },
    });
    expect(gitlabEnvironment({ ...child, CI_COMMIT_BRANCH: "main" }).event).toMatchObject({
      kind: "push",
      ref: "refs/heads/main",
    });
    expect(gitlabEnvironment(child).event).toMatchObject({
      name: "parent_pipeline",
      kind: "other",
    });
  });

  it("schedules and unknown sources are 'other', with ref and sha", () => {
    expect(
      gitlabEnvironment({ ...BASE, CI_PIPELINE_SOURCE: "schedule", CI_COMMIT_BRANCH: "main" })
        .event,
    ).toEqual({
      name: "schedule",
      kind: "other",
      ref: "refs/heads/main",
      sha: "c0ffee",
      inputs: {},
    });
    expect(gitlabEnvironment({ ...BASE, CI_PIPELINE_SOURCE: "external" }).event?.kind).toBe(
      "other",
    );
  });

  it("has no event without CI_PIPELINE_SOURCE", () => {
    expect(gitlabEnvironment(BASE).event).toBeUndefined();
  });
});

describe("createContext on GitLab", () => {
  const project = () => {
    const { repo } = repoWithRemote();
    repo.commit("init", {
      "launchset.config.json": JSON.stringify({ targets: { web: { type: "web" } } }),
      "package.json": JSON.stringify({ version: "1.0.0" }),
    });
    return repo;
  };

  it("builds a GitLab forge with the run URL from the CI environment", async () => {
    const repo = project();
    const context = await createContext({
      cwd: repo.dir,
      env: { ...BASE, LAUNCHSET_TOKEN: "glpat-x", CI_JOB_TOKEN: "jobtok" },
    });
    expect(context.host).toBe("gitlab");
    expect(context.serverUrl).toBe("https://gitlab.acme.dev");
    expect(context.repository).toBe("acme/mobile/app");
    expect(context.forge?.repository).toBe("acme/mobile/app");
    expect(context.token).toBe("glpat-x");
    expect(context.fallbackForge).toBeDefined();
    expect(context.run).toEqual({
      id: 900,
      number: 12,
      url: "https://gitlab.acme.dev/acme/mobile/app/-/pipelines/900",
    });
  });

  it("with only CI_JOB_TOKEN, reads through a job-token forge and has no token", async () => {
    const repo = project();
    const seen: Record<string, string | null> = {};
    const context = await createContext({
      cwd: repo.dir,
      env: { ...BASE, CI_JOB_TOKEN: "jobtok" },
    });
    expect(context.token).toBeUndefined();
    expect(context.fallbackForge).toBeUndefined();
    expect(context.forge).toBeDefined();
    // The forge sends the job token as JOB-TOKEN.
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.job = headers.get("job-token");
      seen.private = headers.get("private-token");
      return new Response("[]", { status: 200 });
    }) as typeof fetch;
    try {
      await context.forge?.findOpenPrByHead("x");
    } finally {
      globalThis.fetch = original;
    }
    expect(seen).toEqual({ job: "jobtok", private: null });
  });

  it("no token at all: no forge", async () => {
    const context = await createContext({ cwd: project().dir, env: BASE });
    expect(context.forge).toBeUndefined();
  });

  it("a GitLab remote selects GitLab and reads a nested repository path", async () => {
    const repo = project();
    repo.git(
      "remote",
      "set-url",
      "origin",
      "https://gitlab-ci-token:secret@gitlab.com/acme/mobile/app.git",
    );
    const context = await createContext({ cwd: repo.dir, env: { LAUNCHSET_TOKEN: "t" } });
    expect(context.host).toBe("gitlab");
    expect(context.ci.host).toBe("gitlab");
    expect(context.repository).toBe("acme/mobile/app");
    expect(context.serverUrl).toBe("https://gitlab.com");
    expect(context.forge?.repository).toBe("acme/mobile/app");
  });

  it("LAUNCHSET_HOST=gitlab outside CI", async () => {
    const context = await createContext({
      cwd: project().dir,
      repository: "acme/app",
      env: { LAUNCHSET_HOST: "gitlab", LAUNCHSET_TOKEN: "t", CI_PIPELINE_ID: "5" },
    });
    expect(context.host).toBe("gitlab");
    expect(context.run?.url).toBe("https://gitlab.com/acme/app/-/pipelines/5");
  });
});
