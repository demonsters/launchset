/** The git layer on GitLab: auth user and scope, push failure hints, the commit identity. */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  authConfigEnv,
  basicAuthHeader,
  Git,
  parseRepoFromRemote,
  remoteAuthScope,
} from "../../src/git/index.ts";
import { initRepo, repoWithRemote, sh } from "./helpers.ts";

const b64 = (text: string) => Buffer.from(text).toString("base64");

describe("auth header", () => {
  it("uses oauth2 as the basic-auth user on GitLab, x-access-token on GitHub", () => {
    expect(basicAuthHeader("glpat-x", "gitlab")).toBe(
      `AUTHORIZATION: basic ${b64("oauth2:glpat-x")}`,
    );
    expect(basicAuthHeader("ghs_x")).toBe(`AUTHORIZATION: basic ${b64("x-access-token:ghs_x")}`);
  });

  it("scopes the header to a nested namespace, reset first", () => {
    const header = basicAuthHeader("glpat-x", "gitlab");
    expect(
      authConfigEnv("glpat-x", "https://gitlab.acme.dev", {}, "group/sub team", "gitlab"),
    ).toEqual({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "http.https://gitlab.acme.dev/group/sub%20team/.extraheader",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "http.https://gitlab.acme.dev/group/sub%20team/.extraheader",
      GIT_CONFIG_VALUE_1: header,
    });
    // Without a server: gitlab.com.
    expect(authConfigEnv("glpat-x", undefined, {}, undefined, "gitlab").GIT_CONFIG_KEY_0).toBe(
      "http.https://gitlab.com/.extraheader",
    );
  });

  it.each([
    [
      "https://gitlab-ci-token:glcbt-secret@gitlab.acme.dev:8443/group/sub/app.git",
      "https://gitlab.acme.dev:8443/group/sub/",
    ],
    ["https://gitlab.com/group/app", "https://gitlab.com/group/"],
    ["http://127.0.0.1:9000/gitlab/group/app.git?x=1", "http://127.0.0.1:9000/gitlab/group/"],
    ["https://gitlab.com/app.git", undefined],
    ["git@gitlab.com:group/app.git", undefined],
    ["ssh://git@gitlab.com/group/app.git", undefined],
    ["/tmp/remote.git", undefined],
  ])("remoteAuthScope(%s)", (url, expected) => {
    expect(remoteAuthScope(url)).toBe(expected);
  });

  it("masks the GitLab header and the URL's job token", () => {
    const git = new Git({ cwd: "/", token: "glpat-x", host: "gitlab" });
    expect(git.mask(`${b64("oauth2:glpat-x")} https://gitlab-ci-token:jobtok@gitlab.com/a/b`)).toBe(
      "*** https://***@gitlab.com/a/b",
    );
  });

  it("reads a project below a relative URL root", () => {
    const server = "https://acme.dev/gitlab";
    expect(parseRepoFromRemote("https://acme.dev/gitlab/group/sub/app.git", server, "gitlab")).toBe(
      "group/sub/app",
    );
    expect(parseRepoFromRemote("git@acme.dev:group/app.git", server, "gitlab")).toBe("group/app");
  });
});

describe("push failure hints", () => {
  const fail = (stderr: string, options: { host?: "github" | "gitlab"; token?: string } = {}) =>
    new Git({
      cwd: "/",
      host: options.host ?? "gitlab",
      ...(options.token === "" ? {} : { token: options.token ?? "glpat-x" }),
    }).error(["push", "--porcelain", "origin", "refs/heads/main:refs/heads/main"], {
      stdout: "",
      stderr,
      code: 1,
    });

  it("protected branches and tags name the Maintainer role and the allowed lists", () => {
    const branch = fail(
      "remote: GitLab: You are not allowed to push code to protected branches on this project.\nTo https://gitlab.com/a/b.git\n ! [remote rejected] main -> main (pre-receive hook declined)",
    );
    expect(branch.reason).toBe("protected");
    expect(branch.hint).toMatch(/Maintainer role.*Allowed to push and merge.*Allowed to create/);
    const tag = fail(
      "remote: GitLab: You are not allowed to create this tag as it is protected.\n ! [remote rejected] v1.0.0 -> v1.0.0 (pre-receive hook declined)",
    );
    expect(tag.reason).toBe("protected");
  });

  it("other declined pushes point to the push rules", () => {
    const error = fail(
      "remote: GitLab: Author 'x@y' is not a member of team\n ! [remote rejected] main -> main (pre-receive hook declined)",
    );
    expect(error.reason).toBe("protected");
    expect(error.hint).toMatch(/push rule/);
    // GitHub (Enterprise pre-receive hooks): unchanged.
    expect(
      fail("! [remote rejected] main (pre-receive hook declined)", { host: "github" }).reason,
    ).toBe("other");
  });

  it("auth and access failures name LAUNCHSET_TOKEN, or the job token git fell back to", () => {
    const denied = fail(
      "remote: HTTP Basic: Access denied. If a password was provided for Git authentication, the password was incorrect.\nfatal: Authentication failed for 'https://gitlab.com/a/b.git/'",
    );
    expect(denied.reason).toBe("auth");
    expect(denied.hint).toMatch(/LAUNCHSET_TOKEN must be a valid project or group access token/);
    const forbidden = fail(
      "remote: You are not allowed to push code to this project.\nfatal: unable to access 'https://gitlab.com/a/b.git/': The requested URL returned error: 403",
    );
    expect(forbidden.reason).toBe("forbidden");
    expect(forbidden.hint).toMatch(/write_repository scope and the Maintainer role/);
    expect(forbidden.hint).toMatch(/CI_JOB_TOKEN never/);
    const noToken = fail("The requested URL returned error: 403", { token: "" });
    expect(noToken.hint).toMatch(/git used the runner's CI_JOB_TOKEN/);
  });

  it("missing history points to GIT_DEPTH", () => {
    expect(fail("fatal: bad object abc").hint).toMatch(/GIT_DEPTH: "0"/);
    expect(fail("fatal: bad object abc", { host: "github" }).hint).toMatch(/fetch-depth: 0/);
  });
});

describe("commit identity", () => {
  it("resolves a lazy identity once, at the first commit", async () => {
    const repo = initRepo();
    repo.commit("a");
    let calls = 0;
    const git = new Git({
      cwd: repo.dir,
      host: "gitlab",
      identity: async () => {
        calls++;
        return { name: "launchset", email: "project_1_bot_x@noreply.gitlab.com" };
      },
    });
    await git.headSha();
    expect(calls).toBe(0);
    repo.write("x.txt", "x");
    await git.commitAll("x", ["x.txt"]);
    repo.write("y.txt", "y");
    await git.commitAll("y", ["y.txt"]);
    expect(calls).toBe(1);
    expect(repo.git("log", "-1", "--format=%an <%ae>|%cn <%ce>")).toBe(
      "launchset <project_1_bot_x@noreply.gitlab.com>|launchset <project_1_bot_x@noreply.gitlab.com>",
    );
  });
});

describe("push options", () => {
  it("pushTag sends them (git push -o), and fails where the remote doesn't take them", async () => {
    const { remote, repo } = repoWithRemote();
    const git = new Git({ cwd: repo.dir });
    await git.createTag("plain", repo.head());
    await expect(git.pushTag("plain", { pushOptions: ["ci.skip"] })).rejects.toThrow(
      /push options/,
    );
    // Like GitLab: the remote advertises push options; a hook records them.
    sh(remote, "config", "receive.advertisePushOptions", "true");
    const log = join(remote, "options.log");
    writeFileSync(
      join(remote, "hooks", "post-receive"),
      `#!/bin/sh\nenv | sed -n 's/^GIT_PUSH_OPTION_[0-9]*=//p' >> '${log}'\n`,
      { mode: 0o755 },
    );
    expect(await git.createAndPushTag("skipped", repo.head(), { pushOptions: ["ci.skip"] })).toBe(
      "created",
    );
    expect(readFileSync(log, "utf8")).toBe("ci.skip\n");
    await expect(git.pushTag("plain", { pushOptions: ["a\nb"] })).rejects.toThrow(
      /Invalid push option/,
    );
  });
});
