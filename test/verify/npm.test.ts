import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { packageUrl, parseNpmrc, verifyNpm } from "../../src/verify/npm.ts";
import { makeCtx, tempDir, useServer } from "./helpers.ts";

const server = useServer();

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function repo(files: Record<string, string | object>): Promise<string> {
  const { dir, cleanup } = await tempDir();
  cleanups.push(cleanup);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(
      join(dir, path),
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }
  return dir;
}

/** A registry document handler; records the Authorization header. */
function packument(url: string, versions: string[] | number, seen: { auth?: string | null } = {}) {
  server.use(
    http.get(url, ({ request }) => {
      seen.auth = request.headers.get("authorization");
      if (typeof versions === "number") {
        return HttpResponse.json(
          { error: versions === 404 ? "Not found" : "unauthorized" },
          { status: versions },
        );
      }
      return HttpResponse.json({
        name: "x",
        "dist-tags": { latest: versions.at(-1) },
        versions: Object.fromEntries(versions.map((v) => [v, { version: v }])),
      });
    }),
  );
  return seen;
}

describe("packageUrl", () => {
  it("encodes scoped names and keeps registry paths", () => {
    expect(packageUrl("https://registry.npmjs.org", "left-pad")).toBe(
      "https://registry.npmjs.org/left-pad",
    );
    expect(packageUrl("https://registry.npmjs.org/", "@demonsters/launchset")).toBe(
      "https://registry.npmjs.org/@demonsters%2Flaunchset",
    );
    expect(packageUrl("https://npm.pkg.github.com/", "@org/pkg")).toBe(
      "https://npm.pkg.github.com/@org%2Fpkg",
    );
    expect(packageUrl("https://host/api/npm/npm-local", "@org/pkg")).toBe(
      "https://host/api/npm/npm-local/@org%2Fpkg",
    );
    expect(packageUrl("https://host/api/npm/", "pkg")).toBe("https://host/api/npm/pkg");
    expect(() => packageUrl("not a url", "pkg")).toThrow(/isn't a valid URL/);
  });
});

describe("parseNpmrc", () => {
  it("reads keys, skips comments and substitutes env variables", () => {
    expect(
      parseNpmrc(
        '# comment\n; other\n@org:registry=https://npm.pkg.github.com\nregistry = "https://r.example/"\n//npm.pkg.github.com/:_authToken=$' +
          "{TOKEN}\n",
        { TOKEN: "abc" },
      ),
    ).toEqual({
      "@org:registry": "https://npm.pkg.github.com",
      registry: "https://r.example/",
      "//npm.pkg.github.com/:_authToken": "abc",
    });
  });
});

describe("verifyNpm", () => {
  it("is already published when the version exists (default registry)", async () => {
    const cwd = await repo({ "package.json": { name: "left-pad", version: "1.5.0" } });
    packument("https://registry.npmjs.org/left-pad", ["1.4.0", "1.5.0"]);
    const result = await verifyNpm({ version: "1.5.0" }, makeCtx({}, cwd));
    expect(result).toEqual({
      alreadyPublished: true,
      message: "left-pad@1.5.0 is already published on https://registry.npmjs.org/left-pad",
    });
  });

  it("is not published when the version is missing", async () => {
    const cwd = await repo({ "package.json": { name: "left-pad" } });
    packument("https://registry.npmjs.org/left-pad", ["1.4.0"]);
    const result = await verifyNpm({ version: "1.5.0" }, makeCtx({}, cwd));
    expect(result.alreadyPublished).toBe(false);
    expect(result.message).toContain("left-pad@1.5.0 isn't published yet");
  });

  it("404 is not published, and mentions the missing token", async () => {
    const cwd = await repo({ "package.json": { name: "brand-new" } });
    packument("https://registry.npmjs.org/brand-new", 404);
    const result = await verifyNpm({ version: "1.0.0" }, makeCtx({}, cwd));
    expect(result.alreadyPublished).toBe(false);
    expect(result.message).toContain("a private package also answers 404 without a token");
  });

  it("404 with a token doesn't mention it", async () => {
    const cwd = await repo({ "package.json": { name: "brand-new" } });
    packument("https://registry.npmjs.org/brand-new", 404);
    const result = await verifyNpm({ version: "1.0.0" }, makeCtx({ NODE_AUTH_TOKEN: "t" }, cwd));
    expect(result.alreadyPublished).toBe(false);
    expect(result.message).not.toContain("without a token");
  });

  it("401 is an error naming the token variable", async () => {
    const cwd = await repo({ "package.json": { name: "@demonsters/launchset" } });
    packument("https://registry.npmjs.org/@demonsters%2Flaunchset", 401);
    await expect(
      verifyNpm({ version: "1.0.0" }, makeCtx({ NODE_AUTH_TOKEN: "bad" }, cwd)),
    ).rejects.toThrow(
      /failed with HTTP 401 \(unauthorized\) with the token from NODE_AUTH_TOKEN\..*was refused/,
    );
  });

  it("500 is an error, never 'not published'", async () => {
    const cwd = await repo({ "package.json": { name: "left-pad" } });
    server.use(
      http.get(
        "https://registry.npmjs.org/left-pad",
        () => new HttpResponse("oops", { status: 500 }),
      ),
    );
    await expect(verifyNpm({ version: "1.0.0" }, makeCtx({}, cwd))).rejects.toThrow(
      /HTTP 500 \(oops\)/,
    );
  });

  it("network errors are errors", async () => {
    const cwd = await repo({ "package.json": { name: "left-pad" } });
    server.use(http.get("https://registry.npmjs.org/left-pad", () => HttpResponse.error()));
    await expect(verifyNpm({ version: "1.0.0" }, makeCtx({}, cwd))).rejects.toThrow(
      /npm registry: GET https:\/\/registry.npmjs.org\/left-pad failed before a response arrived/,
    );
  });

  it("sends a Bearer token; LAUNCHSET_NPM_TOKEN wins over NODE_AUTH_TOKEN", async () => {
    const cwd = await repo({ "package.json": { name: "@org/pkg" } });
    const seen = packument("https://registry.npmjs.org/@org%2Fpkg", ["1.0.0"]);
    await verifyNpm({ version: "1.0.0" }, makeCtx({ NODE_AUTH_TOKEN: "node" }, cwd));
    expect(seen.auth).toBe("Bearer node");
    await verifyNpm(
      { version: "1.0.0" },
      makeCtx({ NODE_AUTH_TOKEN: "node", LAUNCHSET_NPM_TOKEN: "ls" }, cwd),
    );
    expect(seen.auth).toBe("Bearer ls");
  });

  it("uses publishConfig.registry, with a path, over .npmrc", async () => {
    const cwd = await repo({
      "packages/lib/package.json": {
        name: "@org/lib",
        publishConfig: { registry: "https://host.example/api/npm/npm-local/" },
      },
      ".npmrc": "registry=https://wrong.example/\n",
    });
    packument("https://host.example/api/npm/npm-local/@org%2Flib", ["2.0.0"]);
    const result = await verifyNpm(
      { packageFile: "packages/lib/package.json", version: "2.0.0" },
      makeCtx({}, cwd),
    );
    expect(result.alreadyPublished).toBe(true);
  });

  it("uses the scoped registry from .npmrc before the plain registry", async () => {
    const cwd = await repo({
      "package.json": { name: "@demonsters/launchset" },
      ".npmrc":
        "registry=https://wrong.example/\n@demonsters:registry=https://npm.pkg.github.com/\n",
    });
    packument("https://npm.pkg.github.com/@demonsters%2Flaunchset", ["1.0.0"]);
    const result = await verifyNpm({ version: "1.0.0" }, makeCtx({}, cwd));
    expect(result.alreadyPublished).toBe(true);
  });

  it("uses registry= from .npmrc for unscoped names", async () => {
    const cwd = await repo({
      "package.json": { name: "tool" },
      ".npmrc": "@other:registry=https://wrong.example/\nregistry=https://npm.internal.example/\n",
    });
    packument("https://npm.internal.example/tool", ["1.0.0"]);
    expect((await verifyNpm({ version: "1.0.0" }, makeCtx({}, cwd))).alreadyPublished).toBe(true);
  });

  it("moves credentials in the registry URL into a Basic header and out of messages", async () => {
    const cwd = await repo({
      "package.json": {
        name: "@org/pkg",
        publishConfig: { registry: "https://ci-user:p%40ss-SECRET@npm.example/api/npm/" },
      },
    });
    const requests: { url: string; auth: string | null }[] = [];
    server.use(
      http.get("https://npm.example/api/npm/:name", ({ request }) => {
        requests.push({ url: request.url, auth: request.headers.get("authorization") });
        return HttpResponse.json({ versions: {} });
      }),
    );
    const result = await verifyNpm({ version: "1.0.0" }, makeCtx({}, cwd));
    expect(requests).toEqual([
      {
        url: "https://npm.example/api/npm/@org%2Fpkg",
        auth: `Basic ${Buffer.from("ci-user:p@ss-SECRET").toString("base64")}`,
      },
    ]);
    expect(result.message).not.toContain("SECRET");

    // A token wins over the URL credentials.
    await verifyNpm({ version: "1.0.0" }, makeCtx({ NODE_AUTH_TOKEN: "tok" }, cwd));
    expect(requests[1]?.auth).toBe("Bearer tok");
  });

  it("never puts URL credentials into errors (HTTP, network, 404 message)", async () => {
    const cwd = await repo({
      "package.json": { name: "pkg" },
      ".npmrc": "registry=https://user:SECRET@npm.example/\n",
    });
    server.use(
      http.get("https://npm.example/pkg", () => new HttpResponse("down", { status: 503 })),
    );
    const httpError = (await verifyNpm({ version: "1.0.0" }, makeCtx({}, cwd)).catch(
      (e: unknown) => e,
    )) as Error;
    expect(httpError.message).toContain("HTTP 503");
    expect(httpError.message).not.toContain("SECRET");

    server.use(http.get("https://npm.example/pkg", () => HttpResponse.error()));
    const networkError = (await verifyNpm({ version: "1.0.0" }, makeCtx({}, cwd)).catch(
      (e: unknown) => e,
    )) as Error;
    expect(networkError.message).toContain("failed before a response arrived");
    expect(networkError.message).not.toContain("SECRET");

    server.use(http.get("https://npm.example/pkg", () => new HttpResponse(null, { status: 404 })));
    const result = await verifyNpm({ version: "1.0.0" }, makeCtx({}, cwd));
    expect(result.message).toContain("https://***@npm.example/");
    expect(result.message).not.toContain("SECRET");
  });

  it("masks URL credentials in an invalid registry URL", async () => {
    expect(() => packageUrl("ftp://user:SECRET@host/", "pkg")).toThrow(/ftp:\/\/\*\*\*@host/);
  });

  it("errors for a missing package file or name", async () => {
    const cwd = await repo({ "package.json": { version: "1.0.0" } });
    await expect(
      verifyNpm({ version: "1.0.0", packageFile: "nope/package.json" }, makeCtx({}, cwd)),
    ).rejects.toThrow(/doesn't exist\. Set npm.package/);
    await expect(verifyNpm({ version: "1.0.0" }, makeCtx({}, cwd))).rejects.toThrow(
      /has no "name"/,
    );
  });
});

describe("verifyNpm with trusted publishing (OIDC)", () => {
  const OIDC_ENV = {
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.example/token?api-version=2.0",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-request-token",
  };
  const EXCHANGE =
    "https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/@demonsters%2flaunchset";

  function oidcProvider(seen: { audience?: string | null; auth?: string | null } = {}) {
    server.use(
      http.get("https://pipelines.actions.example/token", ({ request }) => {
        seen.audience = new URL(request.url).searchParams.get("audience");
        seen.auth = request.headers.get("authorization");
        return HttpResponse.json({ value: "github-oidc-jwt" });
      }),
    );
    return seen;
  }

  it("exchanges the workflow's OIDC token and reads the private package with it", async () => {
    const cwd = await repo({ "package.json": { name: "@demonsters/launchset" } });
    const provider = oidcProvider();
    const exchange: { auth?: string | null } = {};
    server.use(
      http.post(EXCHANGE, ({ request }) => {
        exchange.auth = request.headers.get("authorization");
        return HttpResponse.json({ token: "npm-short-lived" });
      }),
    );
    const seen = packument("https://registry.npmjs.org/@demonsters%2Flaunchset", ["1.0.0"]);
    const result = await verifyNpm({ version: "1.0.0" }, makeCtx(OIDC_ENV, cwd));
    expect(result.alreadyPublished).toBe(true);
    expect(provider).toEqual({
      audience: "npm:registry.npmjs.org",
      auth: "Bearer runner-request-token",
    });
    expect(exchange.auth).toBe("Bearer github-oidc-jwt");
    expect(seen.auth).toBe("Bearer npm-short-lived");
  });

  it("goes on without a token when npm has no trusted publisher (first publish), and says so", async () => {
    const cwd = await repo({ "package.json": { name: "@demonsters/launchset" } });
    oidcProvider();
    server.use(
      http.post(EXCHANGE, () => HttpResponse.json({ error: "not found" }, { status: 404 })),
    );
    const seen = packument("https://registry.npmjs.org/@demonsters%2Flaunchset", 404);
    const result = await verifyNpm({ version: "1.0.0" }, makeCtx(OIDC_ENV, cwd));
    expect(result.alreadyPublished).toBe(false);
    expect(seen.auth).toBeNull();
    expect(result.message).toContain("no trusted publisher");
  });

  it("fails clearly when the job can't get an OIDC token", async () => {
    const cwd = await repo({ "package.json": { name: "@demonsters/launchset" } });
    server.use(
      http.get("https://pipelines.actions.example/token", () =>
        HttpResponse.json({ message: "no" }, { status: 403 }),
      ),
    );
    await expect(verifyNpm({ version: "1.0.0" }, makeCtx(OIDC_ENV, cwd))).rejects.toThrow(
      /id-token: write/,
    );
  });

  it("prefers an explicit token over OIDC", async () => {
    const cwd = await repo({ "package.json": { name: "@demonsters/launchset" } });
    const seen = packument("https://registry.npmjs.org/@demonsters%2Flaunchset", ["1.0.0"]);
    const result = await verifyNpm(
      { version: "1.0.0" },
      makeCtx({ ...OIDC_ENV, NODE_AUTH_TOKEN: "classic" }, cwd),
    );
    expect(result.alreadyPublished).toBe(true);
    expect(seen.auth).toBe("Bearer classic");
  });
});
