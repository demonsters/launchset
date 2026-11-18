/**
 * Google Play check (spec 7.3): open an edit, list bundles and APKs, take the max
 * `versionCode`, delete the edit. Auth: OAuth 2 JWT bearer grant with a service account.
 *
 * Play doesn't report `versionName` per bundle, so "this exact build exists" means the
 * `versionCode` exists.
 */

import { importPKCS8, SignJWT } from "jose";
import { decodeSecret, errorDetail, missingEnv, paren, readJson, send } from "./http.ts";
import { decideStore, requireBuildNumber } from "./store.ts";
import { type StoreCheck, type VerifyContext, VerifyError, type VerifyResult } from "./types.ts";

export const PLAY_ENV = "LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON";
export const PLAY_SCOPE = "https://www.googleapis.com/auth/androidpublisher";
export const PLAY_API = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const API = "Google Play";

export interface PlayCheck extends StoreCheck {
  packageName: string;
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  token_uri: string;
}

/** Read and validate the service account from `LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON`. */
export function readServiceAccount(env: VerifyContext["env"]): ServiceAccount {
  const missing = missingEnv(env, [PLAY_ENV]);
  if (missing.length > 0) {
    throw new VerifyError(
      `Google Play verification needs the environment variable ${PLAY_ENV} (the service account JSON key, raw or base64-encoded). Set it from a repository secret in the verify step.`,
    );
  }
  const text = decodeSecret(env[PLAY_ENV] ?? "", (t) => t.startsWith("{"));
  let json: Record<string, unknown> | undefined;
  if (text) {
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // The parser's message would quote the secret; report without it below.
    }
  }
  if (!json || typeof json !== "object") {
    throw new VerifyError(
      `${PLAY_ENV} isn't valid JSON or base64-encoded JSON. Paste the whole service account key file (from Google Cloud → IAM → Service accounts → Keys) into the secret.`,
    );
  }
  const missingFields = ["client_email", "private_key"].filter(
    (key) => typeof json[key] !== "string" || !json[key],
  );
  if (missingFields.length > 0) {
    throw new VerifyError(
      `${PLAY_ENV} is missing ${missingFields.join(" and ")}. Use a service account key file of type "service_account" (JSON key), not an OAuth client file.`,
    );
  }
  return {
    client_email: json.client_email as string,
    private_key: json.private_key as string,
    private_key_id: typeof json.private_key_id === "string" ? json.private_key_id : undefined,
    token_uri:
      typeof json.token_uri === "string" && json.token_uri ? json.token_uri : DEFAULT_TOKEN_URI,
  };
}

/** Exchange a signed RS256 assertion for an access token (JWT bearer grant). */
export async function getPlayAccessToken(
  account: ServiceAccount,
  ctx: VerifyContext,
): Promise<string> {
  let key: CryptoKey;
  try {
    key = await importPKCS8(account.private_key, "RS256");
  } catch (error) {
    throw new VerifyError(
      `The private_key in ${PLAY_ENV} isn't a valid PKCS#8 RSA key (${(error as Error).message}). Download a new JSON key for the service account.`,
    );
  }
  const now = Math.floor((ctx.now?.() ?? new Date()).getTime() / 1000);
  const assertion = await new SignJWT({ scope: PLAY_SCOPE })
    .setProtectedHeader({
      alg: "RS256",
      typ: "JWT",
      ...(account.private_key_id ? { kid: account.private_key_id } : {}),
    })
    .setIssuer(account.client_email)
    .setAudience(account.token_uri)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);

  const response = await send(ctx, `${API} token exchange`, account.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  if (!response.ok) {
    throw new VerifyError(
      `${API}: the token exchange at ${account.token_uri} failed with HTTP ${response.status}${paren(await errorDetail(response))}. Check that the service account key in ${PLAY_ENV} is current and not deleted or disabled.`,
    );
  }
  const body = await readJson<{ access_token?: unknown }>(
    response,
    `${API} token exchange`,
    account.token_uri,
  );
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new VerifyError(
      `${API}: the token exchange at ${account.token_uri} answered without an access_token. Try again; if it persists, create a new service account key.`,
    );
  }
  return body.access_token;
}

function playHint(status: number, packageName: string): string {
  if (status === 401 || status === 403) {
    return ` Check that the service account has access to ${packageName} in Play Console (Users and permissions) and that the Google Play Android Developer API is enabled in its Google Cloud project.`;
  }
  if (status === 404) {
    return ` Check the package name (store.packageName) and that the app exists in Play Console with at least one upload (the API can't see apps that were never uploaded by hand).`;
  }
  return "";
}

/** Google Play check for one app (spec 7.3). */
export async function verifyPlay(check: PlayCheck, ctx: VerifyContext): Promise<VerifyResult> {
  const store = `Google Play (${check.packageName})`;
  const ours = requireBuildNumber(check, store);
  const account = readServiceAccount(ctx.env);
  const token = await getPlayAccessToken(account, ctx);
  const auth = { authorization: `Bearer ${token}`, accept: "application/json" };
  const base = `${PLAY_API}/applications/${encodeURIComponent(check.packageName)}`;

  const call = async <T>(what: string, url: string, init: RequestInit = {}): Promise<T> => {
    const response = await send(ctx, API, url, { ...init, headers: auth });
    if (!response.ok) {
      throw new VerifyError(
        `${API}: ${what} (${init.method ?? "GET"} ${url}) failed with HTTP ${response.status}${paren(await errorDetail(response))}.${playHint(response.status, check.packageName)}`,
      );
    }
    return readJson<T>(response, API, url);
  };

  const edit = await call<{ id?: unknown }>("opening an edit", `${base}/edits`, {
    method: "POST",
  });
  if (typeof edit.id !== "string" || !edit.id) {
    throw new VerifyError(`${API}: opening an edit for ${check.packageName} returned no edit id.`);
  }
  const editUrl = `${base}/edits/${encodeURIComponent(edit.id)}`;

  let numbers: string[];
  let deleteWarning: string | undefined;
  try {
    // allSettled: both requests finish before the edit is deleted, even if one fails.
    const [bundlesResult, apksResult] = await Promise.allSettled([
      call<{ bundles?: { versionCode?: unknown }[] }>("listing bundles", `${editUrl}/bundles`),
      call<{ apks?: { versionCode?: unknown }[] }>("listing APKs", `${editUrl}/apks`),
    ]);
    if (bundlesResult.status === "rejected") throw bundlesResult.reason;
    if (apksResult.status === "rejected") throw apksResult.reason;
    const bundles = bundlesResult.value;
    const apks = apksResult.value;
    numbers = [...(bundles.bundles ?? []), ...(apks.apks ?? [])]
      .map((entry) => entry.versionCode)
      .filter((code) => typeof code === "number" || typeof code === "string")
      .map(String);
  } finally {
    deleteWarning = await deleteEdit(ctx, editUrl, auth);
  }

  return decideStore(check, ours, {
    store,
    unit: "versionCode",
    numbers,
    exact: numbers.some((n) => Number(n) === ours),
    notes: deleteWarning ? [deleteWarning] : [],
  });
}

/** Delete the edit. A failure is only a warning: edits expire on their own. */
async function deleteEdit(
  ctx: VerifyContext,
  editUrl: string,
  headers: Record<string, string>,
): Promise<string | undefined> {
  try {
    const response = await send(ctx, API, editUrl, { method: "DELETE", headers });
    if (response.ok) return undefined;
    return `warning: deleting the temporary edit failed with HTTP ${response.status}${paren(await errorDetail(response))}; it expires on its own`;
  } catch (error) {
    return `warning: deleting the temporary edit failed (${(error as Error).message}); it expires on its own`;
  }
}
