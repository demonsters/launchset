import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isLaunchsetError } from "../../src/core/errors.ts";
import {
  detectHost,
  githubEnvironment,
  hostFromEnv,
  parseEvent,
  readCiEnvironment,
  remoteHost,
} from "../../src/flow/ci/index.ts";
import { createContext } from "../../src/flow/context.ts";
import { repoWithRemote, tempDir } from "../git/helpers.ts";

const remote = (url: string | undefined) => async () => url;

describe("host detection", () => {
  it("LAUNCHSET_HOST wins, case-insensitive; anything else is an error", async () => {
    expect(hostFromEnv({ LAUNCHSET_HOST: "gitlab", GITHUB_ACTIONS: "true" })).toEqual({
      host: "gitlab",
      source: "LAUNCHSET_HOST",
    });
    expect(hostFromEnv({ LAUNCHSET_HOST: "GitHub", GITLAB_CI: "true" })).toEqual({
      host: "github",
      source: "LAUNCHSET_HOST",
    });
    let error: unknown;
    try {
      hostFromEnv({ LAUNCHSET_HOST: "bitbucket" });
    } catch (e) {
      error = e;
    }
    expect(isLaunchsetError(error) && error.code).toBe("invalid-host");
    expect((error as Error).message).toBe(
      'LAUNCHSET_HOST is "bitbucket", expected "github" or "gitlab"',
    );
  });

  it("GITLAB_CI, then GITHUB_ACTIONS", () => {
    expect(hostFromEnv({ GITLAB_CI: "true", GITHUB_ACTIONS: "true" })?.host).toBe("gitlab");
    expect(hostFromEnv({ GITHUB_ACTIONS: "true" })).toEqual({
      host: "github",
      source: "GITHUB_ACTIONS",
    });
    expect(hostFromEnv({ GITLAB_CI: "1", LAUNCHSET_HOST: "" })).toBeUndefined();
  });

  it("then the remote's host name, else GitHub", async () => {
    expect(await detectHost({}, remote("git@gitlab.com:acme/mobile/app.git"))).toEqual({
      host: "gitlab",
      source: "remote",
    });
    expect((await detectHost({}, remote("https://gitlab.acme.dev/acme/app.git"))).host).toBe(
      "gitlab",
    );
    expect(await detectHost({}, remote("https://github.com/acme/app.git"))).toEqual({
      host: "github",
      source: "default",
    });
    expect((await detectHost({}, remote(undefined))).host).toBe("github");
    expect((await detectHost({})).host).toBe("github");
    const failing = async () => {
      throw new Error("no remote");
    };
    expect((await detectHost({}, failing)).host).toBe("github");
  });

  it("asks for the remote only when the environment doesn't decide", async () => {
    let asked = false;
    await detectHost({ GITHUB_ACTIONS: "true" }, async () => {
      asked = true;
      return "git@gitlab.com:acme/app.git";
    });
    expect(asked).toBe(false);
  });

  it("reads host names from remote URLs", () => {
    expect(remoteHost("git@GitLab.com:acme/app.git")).toBe("gitlab.com");
    expect(remoteHost("ssh://git@gitlab.acme.dev:2222/acme/app.git")).toBe("gitlab.acme.dev");
    expect(remoteHost("https://x:y@github.com/acme/app")).toBe("github.com");
    expect(remoteHost("/srv/git/app.git")).toBeUndefined();
  });
});

describe("GitHub environment", () => {
  it("reads the GITHUB_* variables", () => {
    const ci = githubEnvironment({
      GITHUB_ACTIONS: "true",
      GITHUB_SERVER_URL: "https://github.example.com/",
      GITHUB_API_URL: "https://github.example.com/api/v3",
      GITHUB_REPOSITORY: "acme/app",
      GITHUB_TOKEN: "workflow",
      LAUNCHSET_TOKEN: "app",
      GITHUB_RUN_ID: "99",
      GITHUB_RUN_NUMBER: "17",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_REF: "refs/heads/main",
      GITHUB_REF_NAME: "main",
      GITHUB_SHA: "abc",
    });
    expect(ci).toEqual({
      host: "github",
      inCi: true,
      serverUrl: "https://github.example.com",
      apiUrl: "https://github.example.com/api/v3",
      repository: "acme/app",
      token: "app",
      fallbackToken: "workflow",
      run: { id: 99, number: 17, attempt: 2 },
      ref: "refs/heads/main",
      refName: "main",
      sha: "abc",
    });
    expect(githubEnvironment({})).toEqual({
      host: "github",
      inCi: false,
      serverUrl: "https://github.com",
    });
  });

  it("normalizes the event kind and keeps the raw name", () => {
    const kind = (name: string) => parseEvent({ name, payload: {} });
    expect(kind("pull_request")).toMatchObject({ name: "pull_request", kind: "pr" });
    expect(kind("push").kind).toBe("push");
    expect(kind("workflow_dispatch").kind).toBe("dispatch");
    expect(kind("pull_request_target")).toMatchObject({
      name: "pull_request_target",
      kind: "other",
    });
    expect(kind("schedule").kind).toBe("other");
  });

  it("reads the event payload file", async () => {
    const dir = tempDir();
    const file = join(dir, "event.json");
    writeFileSync(file, JSON.stringify({ ref: "refs/heads/main", after: "def", inputs: { x: 1 } }));
    const ci = await readCiEnvironment("github", {
      GITHUB_EVENT_NAME: "push",
      GITHUB_EVENT_PATH: file,
    });
    expect(ci.event).toEqual({
      name: "push",
      kind: "push",
      ref: "refs/heads/main",
      sha: "def",
      inputs: { x: "1" },
    });
  });
});

describe("createContext and the host", () => {
  const project = () => {
    const { repo } = repoWithRemote();
    repo.commit("init", {
      "launchset.config.json": JSON.stringify({ targets: { web: { type: "web" } } }),
      "package.json": JSON.stringify({ version: "1.0.0" }),
    });
    return repo;
  };

  it("puts the run URL on the run", async () => {
    const repo = project();
    const context = await createContext({
      cwd: repo.dir,
      repository: "acme/app",
      env: { GITHUB_RUN_ID: "7", GITHUB_RUN_NUMBER: "3" },
    });
    expect(context.run).toEqual({
      id: 7,
      number: 3,
      url: "https://github.com/acme/app/actions/runs/7",
    });
  });
});
