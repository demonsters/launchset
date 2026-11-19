/**
 * Pushing from a GitHub Actions checkout of a Git LFS repo. actions/checkout persists the
 * read-only GITHUB_TOKEN as `http.<server>/.extraheader`; launchset pushes with the App token.
 * git-lfs's pre-push hook doesn't apply git's "empty value resets the list" rule, so it used to
 * send the read-only header first and its lock check failed with "You must have push access to
 * verify locks" (every `mark` in the first release of an LFS repo).
 *
 * The server here is smart-HTTP git (`git http-backend`) plus the git-lfs API on one host, like
 * github.com, and it judges only the first Authorization header. Needs git-lfs; skipped
 * without it (GitHub's ubuntu runners have it).
 */

import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Git } from "../../src/git/index.ts";
import { initRepo, sh, tempDir } from "./helpers.ts";

function hasGitLfs(): boolean {
  try {
    execFileSync("git", ["lfs", "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const READ = "ghs_ReadOnlyGitHubToken";
const APP = "ghs_AppInstallationToken";
const b64 = (token: string) => Buffer.from(`x-access-token:${token}`).toString("base64");

interface Request {
  path: string;
  /** Tokens of the Authorization headers, in order. */
  auth: string[];
}

/** Git over HTTP and the LFS API, serving `<root>/acme/app.git`. Pushing needs APP first. */
async function gitServer(root: string): Promise<{ server: Server; url: string; seen: Request[] }> {
  const seen: Request[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "http://x");
      const auth: string[] = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i]?.toLowerCase() !== "authorization") continue;
        const value = req.rawHeaders[i + 1] ?? "";
        auth.push(value.includes(b64(APP)) ? "APP" : value.includes(b64(READ)) ? "READ" : value);
      }
      seen.push({ path: url.pathname, auth });
      const app = auth[0] === "APP";
      if (url.pathname.includes("/info/lfs/")) {
        res.setHeader("content-type", "application/vnd.git-lfs+json");
        if (!app) {
          res.statusCode = 403;
          res.end('{"message":"You must have push access to verify locks"}');
        } else if (url.pathname.endsWith("/locks/verify")) {
          res.end('{"ours":[],"theirs":[]}');
        } else {
          // objects/batch: the server has every object already (nothing to upload).
          const objects = (JSON.parse(body.toString() || "{}").objects ?? []) as {
            oid: string;
            size: number;
          }[];
          res.end(JSON.stringify({ transfer: "basic", objects }));
        }
        return;
      }
      const pushing =
        url.searchParams.get("service") === "git-receive-pack" ||
        url.pathname.endsWith("/git-receive-pack");
      if (pushing && !app) {
        res.statusCode = 403;
        res.end("push access needed\n");
        return;
      }
      const cgi = spawn("git", ["http-backend"], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          REMOTE_USER: "x",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: req.method ?? "GET",
          CONTENT_TYPE: req.headers["content-type"] ?? "",
          CONTENT_LENGTH: String(body.length),
        },
      });
      const out: Buffer[] = [];
      cgi.stdout.on("data", (c: Buffer) => out.push(c));
      cgi.on("close", () => {
        const all = Buffer.concat(out);
        const split = all.indexOf("\r\n\r\n");
        for (const line of all.subarray(0, split).toString().split("\r\n")) {
          const [key = "", ...rest] = line.split(": ");
          if (key.toLowerCase() === "status") res.statusCode = Number.parseInt(rest.join(": "), 10);
          else if (key) res.setHeader(key, rest.join(": "));
        }
        res.end(all.subarray(split + 4));
      });
      cgi.stdin.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, url, seen };
}

describe.skipIf(!hasGitLfs())("pushing from a read-only checkout of a Git LFS repo", () => {
  it("pushes marker tags and the release branch with the App token, lock check included", async () => {
    const root = tempDir("lfs-server");
    const bare = join(root, "acme", "app.git");
    sh(root, "init", "--quiet", "--bare", "-b", "main", bare);
    sh(bare, "config", "http.receivepack", "true");

    const repo = initRepo();
    repo.git("config", "user.email", "test@example.com");
    repo.git("config", "user.name", "Test");
    repo.git("lfs", "install", "--local");
    repo.git("lfs", "track", "*.bin");
    repo.commit("assets", { "a.bin": "a".repeat(2048) });
    // Seed the remote directly (no hook): the release commit is already on GitHub.
    sh(repo.dir, "-c", "core.hooksPath=/dev/null", "push", "--quiet", bare, "main");

    const { server, url, seen } = await gitServer(root);
    try {
      // The checkout: origin without `.git` and the persisted read-only header, as
      // actions/checkout leaves them. GitHub verifies locks on push.
      repo.git("remote", "add", "origin", `${url}/acme/app`);
      repo.git("config", `http.${url}/.extraheader`, `AUTHORIZATION: basic ${b64(READ)}`);
      repo.git("config", "lfs.locksverify", "true");
      const git = new Git({ cwd: repo.dir, token: APP, serverUrl: url });
      // Async: a synchronous git call would block this process's server and hang.
      await git.run(["fetch", "--quiet", "origin"]);

      // mark: a tag at the release commit. No LFS requests at all.
      repo.git("tag", "launchset/web@1.0.0");
      seen.length = 0;
      expect(await git.pushTag("launchset/web@1.0.0")).toBe("created");
      expect(seen.filter((r) => r.path.includes("/info/lfs/"))).toEqual([]);
      expect(seen.every((r) => r.auth.join() === "APP")).toBe(true);

      // A branch with a new LFS object (the release branch never has one, but the hook runs
      // for branch pushes): the lock check and the upload check go out with the App token only.
      repo.git("checkout", "--quiet", "-b", "launchset/release/main");
      repo.commit("more assets", { "b.bin": "b".repeat(1024) });
      seen.length = 0;
      expect(await git.pushBranch("launchset/release/main", { force: true })).toBe("created");
      const lfs = seen.filter((r) => r.path.includes("/info/lfs/"));
      expect(lfs.map((r) => r.path)).toEqual([
        "/acme/app.git/info/lfs/locks/verify",
        "/acme/app.git/info/lfs/objects/batch",
      ]);
      expect(seen.every((r) => r.auth.join() === "APP")).toBe(true);
    } finally {
      server.close();
    }
  });
});
