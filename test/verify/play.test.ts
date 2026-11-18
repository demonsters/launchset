import { jwtVerify } from "jose";
import { HttpResponse, http } from "msw";
import { beforeAll, describe, expect, it } from "vitest";
import { PLAY_API, PLAY_SCOPE, verifyPlay } from "../../src/verify/play.ts";
import { makeCtx, makeKeys, NOW, useServer } from "./helpers.ts";

const server = useServer();
const PKG = "com.example.app";
const BASE = `${PLAY_API}/applications/${PKG}`;
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const EMAIL = "launchset@project.iam.gserviceaccount.com";

let keys: Awaited<ReturnType<typeof makeKeys>>;
let accountJson: string;

beforeAll(async () => {
  keys = await makeKeys("RS256");
  accountJson = JSON.stringify({
    type: "service_account",
    project_id: "project",
    private_key_id: "key-123",
    private_key: keys.privatePem,
    client_email: EMAIL,
    token_uri: TOKEN_URI,
  });
});

interface TokenRequest {
  contentType: string | null;
  grantType: string | null;
  assertion: string;
}

interface Calls {
  tokenRequests: TokenRequest[];
  deleted: string[];
}

/**
 * Check a recorded token request in the test body (not in the handler, where a failed
 * expect would only turn into an HTTP 500).
 */
async function expectValidAssertion(request: TokenRequest | undefined) {
  expect(request?.contentType).toContain("application/x-www-form-urlencoded");
  expect(request?.grantType).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
  const { payload, protectedHeader } = await jwtVerify(request?.assertion ?? "", keys.publicKey, {
    issuer: EMAIL,
    audience: TOKEN_URI,
    currentDate: NOW,
  });
  expect(protectedHeader).toMatchObject({ alg: "RS256", kid: "key-123", typ: "JWT" });
  expect(payload.scope).toBe(PLAY_SCOPE);
  expect(payload.iat).toBe(Math.floor(NOW.getTime() / 1000));
  expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBeLessThanOrEqual(3600);
}

/** Handlers for a Play app whose bundles/APKs have the given version codes. */
function playHandlers(
  opts: { bundles?: number[]; apks?: number[]; bundlesStatus?: number; deleteStatus?: number } = {},
): Calls {
  const calls: Calls = { tokenRequests: [], deleted: [] };
  const authed = (request: Request) => request.headers.get("authorization") === "Bearer play-token";
  server.use(
    http.post(TOKEN_URI, async ({ request }) => {
      const form = new URLSearchParams(await request.text());
      const assertion = form.get("assertion") ?? "";
      calls.tokenRequests.push({
        contentType: request.headers.get("content-type"),
        grantType: form.get("grant_type"),
        assertion,
      });
      // Like Google: only a correctly signed assertion gets a token.
      try {
        await jwtVerify(assertion, keys.publicKey, { currentDate: NOW });
      } catch {
        return HttpResponse.json(
          { error: "invalid_grant", error_description: "Invalid JWT Signature." },
          { status: 400 },
        );
      }
      return HttpResponse.json({
        access_token: "play-token",
        expires_in: 3599,
        token_type: "Bearer",
      });
    }),
    http.post(`${BASE}/edits`, ({ request }) =>
      authed(request)
        ? HttpResponse.json({ id: "edit-1", expiryTimeSeconds: "1800" })
        : new HttpResponse(null, { status: 401 }),
    ),
    http.get(`${BASE}/edits/edit-1/bundles`, ({ request }) => {
      if (!authed(request)) return new HttpResponse(null, { status: 401 });
      if (opts.bundlesStatus) {
        return HttpResponse.json(
          { error: { code: opts.bundlesStatus, message: "Backend error", status: "INTERNAL" } },
          { status: opts.bundlesStatus },
        );
      }
      const list = (opts.bundles ?? []).map((versionCode) => ({
        versionCode,
        sha1: "x",
        sha256: "y",
      }));
      return HttpResponse.json(
        list.length ? { kind: "androidpublisher#bundlesListResponse", bundles: list } : {},
      );
    }),
    http.get(`${BASE}/edits/edit-1/apks`, ({ request }) => {
      if (!authed(request)) return new HttpResponse(null, { status: 401 });
      const list = (opts.apks ?? []).map((versionCode) => ({ versionCode, binary: { sha1: "x" } }));
      return HttpResponse.json(list.length ? { apks: list } : {});
    }),
    http.delete(`${BASE}/edits/edit-1`, ({ request }) => {
      calls.deleted.push(request.headers.get("authorization") ?? "");
      return new HttpResponse(null, { status: opts.deleteStatus ?? 204 });
    }),
  );
  return calls;
}

const check = (buildNumber: number | null, offset = 0) => ({
  packageName: PKG,
  version: "1.5.0",
  buildNumber,
  offset,
  target: "android",
});

describe("verifyPlay", () => {
  it("is not published when the store's highest versionCode is lower, and deletes the edit", async () => {
    const calls = playHandlers({ bundles: [100, 250], apks: [90] });
    const result = await verifyPlay(
      check(300),
      makeCtx({ LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON: accountJson }),
    );
    expect(result.alreadyPublished).toBe(false);
    expect(result.message).toContain("highest versionCode is 250");
    expect(calls.tokenRequests).toHaveLength(1);
    await expectValidAssertion(calls.tokenRequests[0]);
    expect(calls.deleted).toEqual(["Bearer play-token"]);
  });

  it("is not published for an app without any uploads in the lists", async () => {
    playHandlers();
    const result = await verifyPlay(
      check(300),
      makeCtx({ LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON: accountJson }),
    );
    expect(result).toMatchObject({ alreadyPublished: false });
    expect(result.message).toContain("no builds yet");
  });

  it("is already published when the versionCode exists (also among APKs)", async () => {
    playHandlers({ bundles: [100], apks: [300] });
    const result = await verifyPlay(
      check(300),
      makeCtx({ LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON: accountJson }),
    );
    expect(result.alreadyPublished).toBe(true);
    expect(result.message).toContain("versionCode 300 of version 1.5.0 is already uploaded");
  });

  it("accepts the service account JSON base64-encoded", async () => {
    const calls = playHandlers({ bundles: [300] });
    const encoded = Buffer.from(accountJson).toString("base64");
    const result = await verifyPlay(
      check(300),
      makeCtx({ LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON: encoded }),
    );
    expect(result.alreadyPublished).toBe(true);
    await expectValidAssertion(calls.tokenRequests[0]);
  });

  it("fails when the store is ahead and suggests an offset", async () => {
    const calls = playHandlers({ bundles: [217_500_000] });
    await expect(
      verifyPlay(
        check(217_000_000, 1000),
        makeCtx({ LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON: accountJson }),
      ),
    ).rejects.toThrow(
      /already has versionCode 217500000, which is >= this run's build number 217000000.*from 1000 to 510000 \(at least 501001\)/,
    );
    expect(calls.deleted).toHaveLength(1);
  });

  it("fails when the store is ahead by one, suggesting the minimal offset", async () => {
    playHandlers({ bundles: [301] });
    await expect(
      verifyPlay(check(300), makeCtx({ LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON: accountJson })),
    ).rejects.toThrow(/raise buildNumber\.offset in the launchset config from 0 to 2/i);
  });

  it("deletes the edit when listing fails, and reports the HTTP status", async () => {
    const calls = playHandlers({ bundlesStatus: 500 });
    await expect(
      verifyPlay(check(300), makeCtx({ LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON: accountJson })),
    ).rejects.toThrow(/listing bundles .* failed with HTTP 500 \(INTERNAL: Backend error\)/);
    expect(calls.deleted).toEqual(["Bearer play-token"]);
  });

  it("only warns when deleting the edit fails", async () => {
    playHandlers({ bundles: [100], deleteStatus: 500 });
    const result = await verifyPlay(
      check(300),
      makeCtx({ LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON: accountJson }),
    );
    expect(result.alreadyPublished).toBe(false);
    expect(result.message).toContain("warning: deleting the temporary edit failed with HTTP 500");
  });

  it("fails with the token endpoint's error", async () => {
    server.use(
      http.post(TOKEN_URI, () =>
        HttpResponse.json(
          { error: "invalid_grant", error_description: "Invalid JWT Signature." },
          { status: 400 },
        ),
      ),
    );
    await expect(
      verifyPlay(check(300), makeCtx({ LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON: accountJson })),
    ).rejects.toThrow(
      /token exchange .* failed with HTTP 400 \(invalid_grant: Invalid JWT Signature\.\)/,
    );
  });

  it("explains a 403 when opening the edit", async () => {
    playHandlers();
    server.use(
      http.post(`${BASE}/edits`, () =>
        HttpResponse.json(
          {
            error: {
              code: 403,
              message: "The caller does not have permission",
              status: "PERMISSION_DENIED",
            },
          },
          { status: 403 },
        ),
      ),
    );
    await expect(
      verifyPlay(check(300), makeCtx({ LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON: accountJson })),
    ).rejects.toThrow(/opening an edit .* HTTP 403 .*Users and permissions/);
  });

  it("names the missing environment variable", async () => {
    await expect(verifyPlay(check(300), makeCtx())).rejects.toThrow(
      /needs the environment variable LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON/,
    );
  });

  it("rejects invalid JSON without echoing the secret", async () => {
    const error = await verifyPlay(
      check(300),
      makeCtx({ LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON: '{"private_key": "SECRET-VALUE"' }),
    ).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("isn't valid JSON");
    expect((error as Error).message).not.toContain("SECRET-VALUE");
  });

  it("names missing fields of the service account", async () => {
    await expect(
      verifyPlay(
        check(300),
        makeCtx({ LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON: '{"client_email":"x"}' }),
      ),
    ).rejects.toThrow(/missing private_key/);
  });

  it("fails clearly for a null (eas) build number, before any request", async () => {
    await expect(
      verifyPlay(check(null), makeCtx({ LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON: accountJson })),
    ).rejects.toThrow(/Target "android" has no build number \(buildNumber.strategy is "eas"/);
  });
});
