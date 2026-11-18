/**
 * npm check (spec 7.5): fetch the package document and look for the exact version.
 * 404 means "not published yet"; any other failure is an error.
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { basicAuth, errorDetail, paren, readJson, send } from "./http.ts";
import { redactUrls } from "./redact.ts";
import { type VerifyContext, VerifyError, type VerifyResult } from "./types.ts";

export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org/";
/** Checked in this order; the launchset-specific one wins. */
export const NPM_TOKEN_ENV = ["LAUNCHSET_NPM_TOKEN", "NODE_AUTH_TOKEN"] as const;
const API = "npm registry";

export interface NpmCheck {
  /** Package file relative to `ctx.cwd`. Default `package.json`. */
  packageFile?: string;
  /** Exact version to look for. */
  version: string;
}

/** Parse the `key=value` lines of an `.npmrc`, with `${VAR}` substitution. */
export function parseNpmrc(text: string, env: VerifyContext["env"]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    value = value.replace(/\$\{([^}]+)\}/g, (_, name: string) => env[name] ?? "");
    result[key] = value;
  }
  return result;
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new VerifyError(`Couldn't read ${file} (${(error as Error).message}).`);
  }
}

interface PackageInfo {
  name: string;
  registry: string;
  /** Where the registry setting came from, for messages. */
  registrySource: string;
}

/**
 * Package name and registry: `publishConfig.registry`, then `.npmrc` (`@scope:registry`
 * before `registry`; the package directory's `.npmrc` before the repo root's), then
 * `https://registry.npmjs.org`.
 */
export async function readPackageInfo(
  packageFile: string,
  ctx: VerifyContext,
): Promise<PackageInfo> {
  const file = resolve(ctx.cwd, packageFile);
  const text = await readOptional(file);
  if (text === undefined) {
    throw new VerifyError(
      `npm verification reads the package name from ${packageFile}, but ${file} doesn't exist. Set npm.package on the target to the right package.json.`,
    );
  }
  let json: { name?: unknown; publishConfig?: { registry?: unknown } };
  try {
    json = JSON.parse(text) as typeof json;
  } catch (error) {
    throw new VerifyError(`${file} isn't valid JSON (${(error as Error).message}).`);
  }
  if (typeof json.name !== "string" || !json.name) {
    throw new VerifyError(`${file} has no "name"; npm verification needs the package name.`);
  }
  const name = json.name;
  const publishRegistry = json.publishConfig?.registry;
  if (typeof publishRegistry === "string" && publishRegistry) {
    return {
      name,
      registry: publishRegistry,
      registrySource: `publishConfig.registry in ${packageFile}`,
    };
  }

  const scope = name.startsWith("@") ? name.slice(0, name.indexOf("/")) : undefined;
  const dirs = [...new Set([dirname(file), resolve(ctx.cwd)])];
  for (const dir of dirs) {
    const npmrcFile = resolve(dir, ".npmrc");
    const npmrc = await readOptional(npmrcFile);
    if (npmrc === undefined) continue;
    const config = parseNpmrc(npmrc, ctx.env);
    const scoped = scope ? config[`${scope}:registry`] : undefined;
    if (scoped)
      return { name, registry: scoped, registrySource: `${scope}:registry in ${npmrcFile}` };
    if (config.registry)
      return { name, registry: config.registry, registrySource: `registry in ${npmrcFile}` };
  }
  return { name, registry: DEFAULT_NPM_REGISTRY, registrySource: "the default registry" };
}

export interface PackageRequest {
  /** `<registry>/<name>`, without any `user:password@`. */
  url: string;
  /** `Basic …` from credentials embedded in the registry URL, if any. */
  basicAuth?: string;
}

/**
 * The package document URL: `<registry>/<name>`, keeping a registry path
 * (`https://host/api/npm/`) and encoding scoped names. Credentials in the registry URL
 * (`https://user:pass@host/`) are removed from the URL (fetch refuses them, and they'd
 * end up in messages) and returned as a Basic Authorization header instead.
 */
export function packageRequest(registry: string, name: string): PackageRequest {
  let base: URL;
  try {
    base = new URL(registry);
  } catch {
    throw new VerifyError(`The npm registry "${redactUrls(registry)}" isn't a valid URL.`);
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new VerifyError(`The npm registry "${redactUrls(registry)}" must be an http(s) URL.`);
  }
  let authorization: string | undefined;
  if (base.username || base.password) {
    const user = decodeURIComponent(base.username);
    const pass = decodeURIComponent(base.password);
    authorization = basicAuth(user, pass);
    base.username = "";
    base.password = "";
  }
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  base.search = "";
  base.hash = "";
  const encoded = name.startsWith("@")
    ? `@${encodeURIComponent(name.slice(1))}`
    : encodeURIComponent(name);
  return {
    url: `${base.toString()}${encoded}`,
    ...(authorization ? { basicAuth: authorization } : {}),
  };
}

/** `packageRequest(...).url`. */
export function packageUrl(registry: string, name: string): string {
  return packageRequest(registry, name).url;
}

/** npm check (spec 7.5). */
export async function verifyNpm(check: NpmCheck, ctx: VerifyContext): Promise<VerifyResult> {
  const packageFile = check.packageFile ?? "package.json";
  const info = await readPackageInfo(packageFile, ctx);
  const { url, basicAuth: urlAuth } = packageRequest(info.registry, info.name);
  const registry = redactUrls(info.registry);
  const tokenEnv = NPM_TOKEN_ENV.find((name) => ctx.env[name]?.trim());
  const headers: Record<string, string> = {
    accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*",
  };
  // A token wins over credentials embedded in the registry URL.
  if (tokenEnv) headers.authorization = `Bearer ${ctx.env[tokenEnv]?.trim()}`;
  else if (urlAuth) headers.authorization = urlAuth;
  const ref = `${info.name}@${check.version}`;

  const response = await send(ctx, API, url, { headers });
  if (response.status === 404) {
    const note =
      tokenEnv || urlAuth
        ? ""
        : ` (no ${NPM_TOKEN_ENV.join(" or ")} was set; a private package also answers 404 without a token)`;
    return {
      alreadyPublished: false,
      message: `${info.name} isn't on ${registry} yet (404 from ${url}), so ${ref} isn't published${note}`,
    };
  }
  if (!response.ok) {
    const auth = tokenEnv
      ? `with the token from ${tokenEnv}`
      : urlAuth
        ? "with the credentials from the registry URL"
        : "without a token";
    const hint =
      response.status === 401 || response.status === 403
        ? ` Set ${NPM_TOKEN_ENV.join(" or ")} to a token that can read ${info.name}${tokenEnv ? ` (the one in ${tokenEnv} was refused)` : ""}.`
        : " The registry may be unavailable; try again later.";
    throw new VerifyError(
      `${API}: checking ${ref} (GET ${url}, registry from ${info.registrySource}) failed with HTTP ${response.status}${paren(await errorDetail(response))} ${auth}.${hint}`,
    );
  }
  const doc = await readJson<{ versions?: Record<string, unknown> }>(response, API, url);
  if (!doc.versions || typeof doc.versions !== "object") {
    throw new VerifyError(
      `${API}: the package document at ${url} has no "versions" object. Check that the registry (from ${info.registrySource}) is an npm registry.`,
    );
  }
  if (Object.hasOwn(doc.versions, check.version)) {
    return { alreadyPublished: true, message: `${ref} is already published on ${url}` };
  }
  return {
    alreadyPublished: false,
    message: `${ref} isn't published yet (${url} has ${Object.keys(doc.versions).length} other versions)`,
  };
}
