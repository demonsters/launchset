import { jwtVerify } from "jose";
import { HttpResponse, http } from "msw";
import { beforeAll, describe, expect, it } from "vitest";
import { ASC_API, normalizeP8, verifyAppStore } from "../../src/verify/appstore.ts";
import { makeCtx, makeKeys, NOW, useServer } from "./helpers.ts";

const server = useServer();
const APP_ID = "1234567890";
const KEY_ID = "ABC123DEFG";
const ISSUER = "57246542-96fe-1a63-e053-0824d011072a";

let keys: Awaited<ReturnType<typeof makeKeys>>;
let env: Record<string, string>;

beforeAll(async () => {
  keys = await makeKeys("ES256");
  env = {
    LAUNCHSET_ASC_KEY_ID: KEY_ID,
    LAUNCHSET_ASC_ISSUER_ID: ISSUER,
    LAUNCHSET_ASC_PRIVATE_KEY: keys.privatePem,
  };
});

type Build = [buildVersion: string, marketingVersion: string, platform?: string];

interface Seen {
  pages: number;
  tokens: string[];
  urls: URL[];
}

/** Check a recorded token in the test body (a failed expect in a handler is only a 500). */
async function expectValidToken(token: string | undefined) {
  const { payload, protectedHeader } = await jwtVerify(token ?? "", keys.publicKey, {
    issuer: ISSUER,
    audience: "appstoreconnect-v1",
    currentDate: NOW,
  });
  expect(protectedHeader).toMatchObject({ alg: "ES256", kid: KEY_ID, typ: "JWT" });
  expect(payload.iat).toBe(Math.floor(NOW.getTime() / 1000));
  expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBeLessThanOrEqual(20 * 60);
}

/**
 * Serve builds in pages of `pageSize`, JSON:API style with included preReleaseVersions
 * (platform `IOS` unless given). Records every request for assertions in the test body.
 */
function ascHandlers(builds: Build[], pageSize = 200): Seen {
  const seen: Seen = { pages: 0, tokens: [], urls: [] };
  server.use(
    http.get(`${ASC_API}/builds`, async ({ request }) => {
      const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      const url = new URL(request.url);
      seen.tokens.push(token);
      seen.urls.push(url);
      // Like Apple: only a token signed with the API key is accepted.
      try {
        await jwtVerify(token, keys.publicKey, { currentDate: NOW });
      } catch {
        return HttpResponse.json(
          {
            errors: [
              {
                status: "401",
                code: "NOT_AUTHORIZED",
                title: "Authentication credentials are missing or invalid.",
              },
            ],
          },
          { status: 401 },
        );
      }
      const cursor = Number(url.searchParams.get("cursor") ?? "0");
      const slice = builds.slice(cursor, cursor + pageSize);
      seen.pages++;
      const prvId = ([, m, platform = "IOS"]: Build) => `prv-${platform}-${m}`;
      const included = new Map<string, { version: string; platform: string }>();
      for (const build of slice) {
        included.set(prvId(build), { version: build[1], platform: build[2] ?? "IOS" });
      }
      const next = cursor + pageSize < builds.length ? new URL(url) : undefined;
      next?.searchParams.set("cursor", String(cursor + pageSize));
      return HttpResponse.json({
        data: slice.map((build, i) => ({
          type: "builds",
          id: `build-${cursor + i}`,
          attributes: { version: build[0] },
          relationships: {
            preReleaseVersion: { data: { type: "preReleaseVersions", id: prvId(build) } },
          },
        })),
        included: [...included].map(([id, attributes]) => ({
          type: "preReleaseVersions",
          id,
          attributes,
        })),
        links: { self: request.url, ...(next ? { next: next.toString() } : {}) },
        meta: { paging: { total: builds.length, limit: 200 } },
      });
    }),
  );
  return seen;
}

const check = (buildNumber: number | null, version = "1.5.0", offset = 0) => ({
  appId: APP_ID,
  version,
  buildNumber,
  offset,
  target: "ios",
});

describe("verifyAppStore", () => {
  it("is not published when every build is lower", async () => {
    const seen = ascHandlers([
      ["100", "1.4.0"],
      ["120", "1.4.1"],
    ]);
    const result = await verifyAppStore(check(200), makeCtx(env));
    expect(result).toMatchObject({ alreadyPublished: false });
    expect(result.message).toContain("highest build is 120, below this run's 200");
    expect(seen.tokens).toHaveLength(1);
    await expectValidToken(seen.tokens[0]);
    const params = seen.urls[0]?.searchParams;
    expect(params?.get("filter[app]")).toBe(APP_ID);
    expect(params?.get("include")).toBe("preReleaseVersion");
    expect(params?.get("fields[builds]")).toBe("version,preReleaseVersion");
    expect(params?.get("fields[preReleaseVersions]")).toBe("version,platform");
    expect(params?.get("limit")).toBe("200");
  });

  it("is already published when the build exists for this version", async () => {
    ascHandlers([
      ["100", "1.4.0"],
      ["200", "1.5.0"],
    ]);
    const result = await verifyAppStore(check(200), makeCtx(env));
    expect(result.alreadyPublished).toBe(true);
    expect(result.message).toContain("build 200 of version 1.5.0 is already uploaded");
  });

  it("fails when the same build number belongs to another version, saying so", async () => {
    ascHandlers([["200", "1.4.0"]]);
    await expect(verifyAppStore(check(200), makeCtx(env))).rejects.toThrow(
      /already has build 200, which is >= .*\(build 200 exists for version 1.4.0, not 1.5.0\)/,
    );
  });

  it("fails when the store is ahead and suggests an offset", async () => {
    ascHandlers([
      ["216999999", "1.4.0"],
      ["217000123", "1.4.0"],
    ]);
    await expect(verifyAppStore(check(217_000_000), makeCtx(env))).rejects.toThrow(
      /already has build 217000123.*from 0 to 130 \(at least 124\)/,
    );
  });

  it("compares versions numerically, not as strings or by API order", async () => {
    // "9" > "10" as strings; numerically 10 is the highest. Served in descending string order.
    ascHandlers([
      ["9", "1.0.0"],
      ["10", "1.0.0"],
      ["1.2.3", "0.9.0"],
    ]);
    const result = await verifyAppStore(check(11), makeCtx(env));
    expect(result.message).toContain("highest build is 10, below this run's 11");
    await expect(verifyAppStore(check(10), makeCtx(env))).rejects.toThrow(/already has build 10\b/);
  });

  it("follows links.next pagination across pages", async () => {
    const builds: Build[] = Array.from({ length: 450 }, (_, i) => [String(i + 1), "1.4.0"]);
    builds[300] = ["5000", "1.5.0"];
    const seen = ascHandlers(builds);
    const result = await verifyAppStore(check(5000), makeCtx(env));
    expect(seen.pages).toBe(3);
    expect(seen.urls.map((u) => u.searchParams.get("cursor"))).toEqual([null, "200", "400"]);
    expect(result.alreadyPublished).toBe(true);
  });

  it("finds the highest build on a later page", async () => {
    const builds: Build[] = Array.from({ length: 250 }, (_, i) => [String(i + 1), "1.4.0"]);
    builds[240] = ["9000", "1.4.0"];
    ascHandlers(builds);
    await expect(verifyAppStore(check(5000), makeCtx(env))).rejects.toThrow(
      /already has build 9000/,
    );
  });

  it("ignores builds of other platforms in the same app record", async () => {
    ascHandlers([
      ["100", "1.4.0"],
      ["900", "1.0.0", "TV_OS"],
      ["950", "2.0.0", "MAC_OS"],
      ["990", "1.0.0", "VISION_OS"],
      ["200", "1.5.0", "TV_OS"],
    ]);
    const result = await verifyAppStore(check(200), makeCtx(env));
    expect(result.alreadyPublished).toBe(false);
    expect(result.message).toContain("highest build is 100, below this run's 200");
    expect(result.message).toContain("ignored 4 non-iOS build(s)");
  });

  it("refuses a next page outside the App Store Connect API", async () => {
    server.use(
      http.get(`${ASC_API}/builds`, () =>
        HttpResponse.json({ data: [], links: { next: "https://evil.example/v1/builds?cursor=1" } }),
      ),
    );
    await expect(verifyAppStore(check(1), makeCtx(env))).rejects.toThrow(
      /next page at https:\/\/evil.example\/v1\/builds\?cursor=1, outside/,
    );
  });

  it("is not published for an app without builds", async () => {
    ascHandlers([]);
    const result = await verifyAppStore(check(1), makeCtx(env));
    expect(result).toEqual({
      alreadyPublished: false,
      message: `App Store Connect (app ${APP_ID}): no builds yet, build 1 is free`,
    });
  });

  it("accepts a base64-encoded private key and a PEM with literal \\n", async () => {
    ascHandlers([["1", "1.5.0"]]);
    const b64 = Buffer.from(keys.privatePem).toString("base64");
    const escaped = keys.privatePem.trim().replace(/\n/g, "\\n");
    expect(
      (await verifyAppStore(check(1), makeCtx({ ...env, LAUNCHSET_ASC_PRIVATE_KEY: b64 })))
        .alreadyPublished,
    ).toBe(true);
    expect(
      (await verifyAppStore(check(1), makeCtx({ ...env, LAUNCHSET_ASC_PRIVATE_KEY: escaped })))
        .alreadyPublished,
    ).toBe(true);
  });

  it("accepts the bare base64 body of a .p8 file", () => {
    const body = keys.privatePem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
    expect(normalizeP8(body)).toContain("-----BEGIN PRIVATE KEY-----");
  });

  it("reports an auth error with hints", async () => {
    ascHandlers([]);
    const other = await makeKeys("ES256");
    await expect(
      verifyAppStore(check(1), makeCtx({ ...env, LAUNCHSET_ASC_PRIVATE_KEY: other.privatePem })),
    ).rejects.toThrow(
      /HTTP 401 \(NOT_AUTHORIZED: Authentication credentials.*\)\. Check LAUNCHSET_ASC_KEY_ID/,
    );
  });

  it("rejects a key that isn't an EC PKCS#8 key", async () => {
    await expect(
      verifyAppStore(check(1), makeCtx({ ...env, LAUNCHSET_ASC_PRIVATE_KEY: "not a key" })),
    ).rejects.toThrow(/LAUNCHSET_ASC_PRIVATE_KEY isn't a valid PKCS#8 EC private key/);
  });

  it("names exactly which environment variables are missing", async () => {
    await expect(
      verifyAppStore(check(1), makeCtx({ LAUNCHSET_ASC_KEY_ID: KEY_ID })),
    ).rejects.toThrow(
      /environment variables LAUNCHSET_ASC_ISSUER_ID, LAUNCHSET_ASC_PRIVATE_KEY \(/,
    );
    await expect(
      verifyAppStore(check(1), makeCtx({ ...env, LAUNCHSET_ASC_ISSUER_ID: "" })),
    ).rejects.toThrow(/environment variable LAUNCHSET_ASC_ISSUER_ID \(/);
  });

  it("fails clearly for a null (eas) build number", async () => {
    await expect(verifyAppStore(check(null), makeCtx(env))).rejects.toThrow(/"eas"/);
  });
});
