/** createContext on GitLab: the server from the remote, requireForge, the commit identity. */

import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { gitlabEnvironment, serverUrlFromRemote } from "../../src/flow/ci/index.ts";
import { createContext, requireForge } from "../../src/flow/context.ts";
import { tagPushOptions } from "../../src/flow/git-ops.ts";
import { server } from "../forge/helpers.ts";
import { repoWithRemote } from "../git/helpers.ts";

const project = (remote: string) => {
  const { repo } = repoWithRemote();
  repo.commit("init", {
    "launchset.config.json": JSON.stringify({ targets: { web: { type: "web" } } }),
    "package.json": JSON.stringify({ version: "1.0.0" }),
  });
  repo.git("remote", "set-url", "origin", remote);
  return repo;
};

describe("server URL outside CI", () => {
  it.each([
    ["https://oauth2:tok@gitlab.acme.dev:8443/group/app.git", "https://gitlab.acme.dev:8443"],
    ["http://gitlab.local/group/app.git", "http://gitlab.local"],
    ["git@gitlab.acme.dev:group/app.git", "https://gitlab.acme.dev"],
    ["ssh://git@gitlab.acme.dev:2222/group/app.git", "https://gitlab.acme.dev"],
    ["/tmp/remote.git", undefined],
  ])("serverUrlFromRemote(%s)", (url, expected) => {
    expect(serverUrlFromRemote(url)).toBe(expected);
  });

  it("a self-managed GitLab remote sets the server, the API and the repository", async () => {
    const repo = project("git@gitlab.acme.dev:acme/mobile/app.git");
    const context = await createContext({
      cwd: repo.dir,
      env: { LAUNCHSET_HOST: "gitlab", LAUNCHSET_TOKEN: "glpat-x" },
    });
    expect(context.serverUrl).toBe("https://gitlab.acme.dev");
    expect(context.ci.apiUrl).toBe("https://gitlab.acme.dev/api/v4");
    expect(context.repository).toBe("acme/mobile/app");
    let url = "";
    server.use(
      http.get("https://gitlab.acme.dev/api/v4/projects/:id/merge_requests/:iid", ({ request }) => {
        url = request.url;
        return HttpResponse.json({
          iid: 3,
          title: "x",
          state: "opened",
          source_branch: "a",
          target_branch: "main",
          web_url: "https://gitlab.acme.dev/acme/mobile/app/-/merge_requests/3",
        });
      }),
    );
    await context.forge?.getPr(3);
    expect(url).toBe(
      "https://gitlab.acme.dev/api/v4/projects/acme%2Fmobile%2Fapp/merge_requests/3",
    );
  });

  it("a remote on gitlab.com keeps gitlab.com; CI_SERVER_URL wins over the remote", async () => {
    const repo = project("https://gitlab.com/acme/app.git");
    expect((await createContext({ cwd: repo.dir, env: {} })).serverUrl).toBe("https://gitlab.com");
    const ci = await createContext({
      cwd: repo.dir,
      env: { GITLAB_CI: "true", CI_SERVER_URL: "https://git.other.dev" },
    });
    expect(ci.serverUrl).toBe("https://git.other.dev");
  });

  it("GitHub is unchanged: github.com without GITHUB_SERVER_URL", async () => {
    const repo = project("git@ghe.acme.dev:acme/app.git");
    expect((await createContext({ cwd: repo.dir, env: {} })).serverUrl).toBe("https://github.com");
  });
});

describe("GitLab environment", () => {
  it("reads the manual preview job's variable", () => {
    const env = {
      GITLAB_CI: "true",
      CI_PIPELINE_SOURCE: "merge_request_event",
      CI_MERGE_REQUEST_IID: "4",
      LAUNCHSET_PREVIEW_MANUAL: "true",
    };
    expect(gitlabEnvironment(env).event?.pr?.manual).toBe(true);
    const { LAUNCHSET_PREVIEW_MANUAL: _, ...plain } = env;
    expect(gitlabEnvironment(plain).event?.pr?.manual).toBeUndefined();
  });
});

describe("requireForge on GitLab", () => {
  it("names LAUNCHSET_TOKEN, its scopes and role", async () => {
    const repo = project("https://gitlab.com/acme/app.git");
    const context = await createContext({ cwd: repo.dir, env: {} });
    expect(() => requireForge(context, "The release MR")).toThrow(
      "The release MR needs a GitLab token (LAUNCHSET_TOKEN: a project or group access token with the api and write_repository scopes, role Maintainer) and the project.",
    );
  });
});

describe("commit identity", () => {
  it("is the token's user, looked up only when committing", async () => {
    const repo = project("https://gitlab.com/acme/app.git");
    let calls = 0;
    server.use(
      http.get("https://gitlab.com/api/v4/user", () => {
        calls++;
        return HttpResponse.json({
          id: 9,
          username: "group_3_bot_ff",
          name: "release bot",
          commit_email: "group_3_bot_ff@noreply.gitlab.com",
        });
      }),
    );
    const context = await createContext({ cwd: repo.dir, env: { LAUNCHSET_TOKEN: "glpat-x" } });
    expect(calls).toBe(0);
    expect(await context.git.identity()).toEqual({
      name: "release bot",
      email: "group_3_bot_ff@noreply.gitlab.com",
    });
    expect(calls).toBe(1);
  });

  it("falls back to launchset@noreply.<host> without a token", async () => {
    const repo = project("https://gitlab.acme.dev/acme/app.git");
    const context = await createContext({ cwd: repo.dir, env: { LAUNCHSET_HOST: "gitlab" } });
    expect(await context.git.identity()).toEqual({
      name: "launchset",
      email: "launchset@noreply.gitlab.acme.dev",
    });
  });

  it("GitHub keeps launchset[bot]", async () => {
    const repo = project("https://github.com/acme/app.git");
    const context = await createContext({ cwd: repo.dir, env: {} });
    expect((await context.git.identity()).email).toBe("launchset[bot]@users.noreply.github.com");
  });
});

describe("after is GitLab only", () => {
  const withAfter = (remote: string) => {
    const repo = project(remote);
    repo.commit("after", {
      "launchset.config.json": JSON.stringify({
        targets: { web: { type: "web" }, site: { type: "custom", after: ["web"] } },
      }),
    });
    return repo;
  };

  it("fails on GitHub Actions and with LAUNCHSET_HOST=github", async () => {
    const repo = withAfter("https://github.com/acme/app.git");
    for (const env of [{ GITHUB_ACTIONS: "true" }, { LAUNCHSET_HOST: "github" }]) {
      await expect(createContext({ cwd: repo.dir, env })).rejects.toMatchObject({
        code: "invalid-config",
        message: expect.stringContaining("targets.site.after: is GitLab only"),
      });
    }
  });

  it("works on GitLab, and where nothing says GitHub (no CI, no GitLab remote)", async () => {
    const gitlab = withAfter("git@gitlab.com:acme/app.git");
    expect((await createContext({ cwd: gitlab.dir, env: {} })).host).toBe("gitlab");
    const local = withAfter("/tmp/nowhere.git");
    expect((await createContext({ cwd: local.dir, env: {} })).host).toBe("github");
  });
});

describe("tagPushOptions", () => {
  const context = async (remote: string, config: object) => {
    const repo = project(remote);
    repo.commit("config", { "launchset.config.json": JSON.stringify(config) });
    return createContext({ cwd: repo.dir, env: {} });
  };
  const targets = { web: { type: "web" } };

  it("GitLab: ci.skip for every launchset tag by default", async () => {
    const gitlab = await context("git@gitlab.com:acme/app.git", { targets });
    for (const tag of [
      "launchset/web@1.5.0",
      "launchset/partial/1.5.0",
      "v1.5.0",
      "v1.6.0-beta.0",
    ]) {
      expect(tagPushOptions(gitlab, tag)).toEqual(["ci.skip"]);
    }
  });

  it("GitLab with tagPipelines: release and prerelease tags start pipelines, internal tags don't", async () => {
    const gitlab = await context("git@gitlab.com:acme/app.git", {
      gitlab: { tagPipelines: true },
      targets,
    });
    expect(tagPushOptions(gitlab, "v1.5.0")).toEqual([]);
    expect(tagPushOptions(gitlab, "v1.6.0-beta.0")).toEqual([]);
    expect(tagPushOptions(gitlab, "launchset/web@1.5.0")).toEqual(["ci.skip"]);
    expect(tagPushOptions(gitlab, "launchset/partial/1.5.0")).toEqual(["ci.skip"]);
  });

  it("GitHub: none", async () => {
    const github = await context("https://github.com/acme/app.git", { targets });
    expect(tagPushOptions(github, "launchset/web@1.5.0")).toEqual([]);
    expect(tagPushOptions(github, "v1.5.0")).toEqual([]);
  });
});
