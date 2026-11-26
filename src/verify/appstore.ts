/**
 * App Store Connect check (spec 7.3): list every build of the app (following
 * pagination), take the max build `version`, compared numerically (it's a string, and
 * the API's sort order isn't numeric). Auth: ES256 JWT from an App Store Connect API key.
 *
 * Only iOS builds count. One app record can also hold tvOS, visionOS and macOS (incl.
 * Mac Catalyst) builds, with their own build numbers. Each build's preReleaseVersion
 * carries the `platform`; the filtering happens here, on the client, rather than with
 * `filter[preReleaseVersion.platform]`, so a filter the API silently ignored could never
 * let other platforms through. A build whose platform is unknown still counts (counting
 * too much can only cause a false "store is ahead", never a duplicate upload).
 */

import { importPKCS8, SignJWT } from "jose";
import { decodeSecret, errorDetail, missingEnv, paren, readJson, send } from "./http.ts";
import {
  compareBuildVersions,
  decideStore,
  parseBuildVersion,
  requireBuildNumber,
} from "./store.ts";
import { type StoreCheck, type VerifyContext, VerifyError, type VerifyResult } from "./types.ts";

export const ASC_ENV = {
  keyId: "LAUNCHSET_ASC_KEY_ID",
  issuerId: "LAUNCHSET_ASC_ISSUER_ID",
  privateKey: "LAUNCHSET_ASC_PRIVATE_KEY",
} as const;
export const ASC_API = "https://api.appstoreconnect.apple.com/v1";
export const ASC_AUDIENCE = "appstoreconnect-v1";
/** Apple rejects tokens that live longer than 20 minutes. */
const TOKEN_LIFETIME_SECONDS = 15 * 60;
/** Safety stop for pagination (200 builds per page). */
const MAX_PAGES = 500;
const API = "App Store Connect";
/** `platform` of an iOS preReleaseVersion. */
const IOS = "IOS";

export interface AppStoreCheck extends StoreCheck {
  /** Numeric Apple ID of the app. */
  appId: string;
}

/** Normalize the private key: raw PEM, PEM with literal `\n`, base64 PEM, or base64 DER body. */
export function normalizeP8(value: string): string | undefined {
  const isPem = (text: string) => text.includes("-----BEGIN");
  const unescaped =
    value.includes("\\n") && !value.includes("\n") ? value.replace(/\\n/g, "\n") : value;
  const pem = decodeSecret(unescaped, isPem);
  if (pem) return pem;
  // The bare base64 body of a .p8 file (PEM without the header lines).
  const body = unescaped.replace(/\s+/g, "");
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(body) && body.length > 40) {
    const lines = body.match(/.{1,64}/g) ?? [];
    return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
  }
  return undefined;
}

/** Sign an App Store Connect API token from the `LAUNCHSET_ASC_*` variables. */
export async function createAscToken(ctx: VerifyContext): Promise<string> {
  const missing = missingEnv(ctx.env, Object.values(ASC_ENV));
  if (missing.length > 0) {
    throw new VerifyError(
      `App Store Connect verification needs the environment variable${missing.length > 1 ? "s" : ""} ${missing.join(", ")} (from an App Store Connect API key: key ID, issuer ID and the .p8 private key, raw or base64-encoded). Set ${missing.length > 1 ? "them" : "it"} from repository secrets in the verify step.`,
    );
  }
  const pem = normalizeP8(ctx.env[ASC_ENV.privateKey] ?? "");
  let key: Awaited<ReturnType<typeof importPKCS8>> | undefined;
  let reason = "not PEM or base64";
  if (pem) {
    try {
      key = await importPKCS8(pem, "ES256");
    } catch (error) {
      reason = (error as Error).message;
    }
  }
  if (!key) {
    throw new VerifyError(
      `${ASC_ENV.privateKey} isn't a valid PKCS#8 EC private key (${reason}). Use the contents of the AuthKey_XXXX.p8 file downloaded from App Store Connect (Users and Access → Integrations).`,
    );
  }
  const now = Math.floor((ctx.now?.() ?? new Date()).getTime() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: ctx.env[ASC_ENV.keyId]?.trim() ?? "", typ: "JWT" })
    .setIssuer(ctx.env[ASC_ENV.issuerId]?.trim() ?? "")
    .setAudience(ASC_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + TOKEN_LIFETIME_SECONDS)
    .sign(key);
}

/** First page of the builds list. */
export function ascBuildsUrl(appId: string): string {
  const params = new URLSearchParams({
    "filter[app]": appId,
    "fields[builds]": "version,preReleaseVersion",
    include: "preReleaseVersion",
    "fields[preReleaseVersions]": "version,platform",
    limit: "200",
  });
  return `${ASC_API}/builds?${params.toString()}`;
}

interface Resource {
  type: string;
  id: string;
  attributes?: { version?: unknown; platform?: unknown };
  relationships?: { preReleaseVersion?: { data?: { type: string; id: string } | null } };
}

interface BuildsPage {
  data?: Resource[];
  included?: Resource[];
  links?: { next?: unknown };
}

function ascHint(status: number): string {
  if (status === 401) {
    return ` Check ${ASC_ENV.keyId}, ${ASC_ENV.issuerId} and ${ASC_ENV.privateKey}: they must belong to the same, non-revoked API key.`;
  }
  if (status === 403) {
    return " The API key needs access to the app (role App Manager, Developer or Admin).";
  }
  if (status === 404) return " Check store.appId (the numeric Apple ID of the app).";
  return "";
}

/** App Store Connect check for one app (spec 7.3). */
export async function verifyAppStore(
  check: AppStoreCheck,
  ctx: VerifyContext,
): Promise<VerifyResult> {
  const store = `App Store Connect (app ${check.appId})`;
  const ours = requireBuildNumber(check, store);
  const token = await createAscToken(ctx);
  const headers = { authorization: `Bearer ${token}`, accept: "application/json" };

  const numbers: string[] = [];
  let exact = false;
  let sameNumberVersion: string | undefined;
  let ignored = 0;
  let otherPlatforms = 0;
  const marketing = parseBuildVersion(check.version);
  const seen = new Set<string>();
  let url: string | undefined = ascBuildsUrl(check.appId);

  while (url) {
    if (seen.has(url) || seen.size >= MAX_PAGES) {
      throw new VerifyError(
        `${API}: listing builds didn't finish after ${seen.size} pages (pagination loops or never ends). Try again later.`,
      );
    }
    seen.add(url);
    const response = await send(ctx, API, url, { headers });
    if (!response.ok) {
      throw new VerifyError(
        `${API}: listing builds (GET ${url}) failed with HTTP ${response.status}${paren(await errorDetail(response))}.${ascHint(response.status)}`,
      );
    }
    const page: BuildsPage = await readJson<BuildsPage>(response, API, url);
    const versions = new Map<string, { version?: string; platform?: string }>();
    for (const item of page.included ?? []) {
      if (item.type !== "preReleaseVersions") continue;
      const { version, platform } = item.attributes ?? {};
      versions.set(item.id, {
        ...(typeof version === "string" ? { version } : {}),
        ...(typeof platform === "string" ? { platform } : {}),
      });
    }
    for (const build of page.data ?? []) {
      const relation = build.relationships?.preReleaseVersion?.data;
      const preRelease = relation ? versions.get(relation.id) : undefined;
      if (preRelease?.platform && preRelease.platform !== IOS) {
        otherPlatforms++;
        continue;
      }
      const raw = build.attributes?.version;
      const parsed = typeof raw === "string" ? parseBuildVersion(raw) : undefined;
      if (typeof raw !== "string" || !parsed) {
        ignored++;
        continue;
      }
      numbers.push(raw);
      if (compareBuildVersions(parsed, [ours]) !== 0) continue;
      const buildMarketing = preRelease?.version;
      const parsedMarketing = buildMarketing ? parseBuildVersion(buildMarketing) : undefined;
      if (
        buildMarketing === check.version ||
        (marketing && parsedMarketing && compareBuildVersions(marketing, parsedMarketing) === 0)
      ) {
        exact = true;
      } else {
        sameNumberVersion = buildMarketing ?? "an unknown version";
      }
    }
    url = typeof page.links?.next === "string" && page.links.next ? page.links.next : undefined;
    if (url && !url.startsWith(`${ASC_API}/`)) {
      // Never send the token anywhere but the App Store Connect API.
      throw new VerifyError(
        `${API}: the builds list points its next page at ${url}, outside ${ASC_API}. Try again later.`,
      );
    }
  }

  const notes: string[] = [];
  if (!exact && sameNumberVersion) {
    notes.push(`build ${ours} exists for version ${sameNumberVersion}, not ${check.version}`);
  }
  if (ignored > 0) notes.push(`ignored ${ignored} build(s) without a numeric version`);
  if (otherPlatforms > 0) notes.push(`ignored ${otherPlatforms} non-iOS build(s)`);
  return decideStore(check, ours, { store, unit: "build", numbers, exact, notes });
}
