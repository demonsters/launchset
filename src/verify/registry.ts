/**
 * OCI registry check (spec 7.4): does the verify tag exist? `HEAD /v2/<name>/manifests/<tag>`
 * with token auth (Bearer challenge) or basic auth, per the OCI distribution spec and
 * the Docker registry token protocol.
 *
 * Credentials: `LAUNCHSET_REGISTRY_USERNAME` / `_PASSWORD` belong to exactly one registry,
 * `LAUNCHSET_REGISTRY_HOST` if set, else the registry of the target's first image. They
 * go only to that registry and to the token endpoint (realm) it names, which may be on
 * another host (Docker Hub's auth.docker.io). Every other registry uses its Docker config
 * file entry, or anonymous access.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { errorDetail, paren, send } from "./http.ts";
import { type VerifyContext, VerifyError, type VerifyResult } from "./types.ts";

export const REGISTRY_ENV = {
  username: "LAUNCHSET_REGISTRY_USERNAME",
  password: "LAUNCHSET_REGISTRY_PASSWORD",
  /** The one registry the env credentials belong to. Default: the first image's registry. */
  host: "LAUNCHSET_REGISTRY_HOST",
} as const;

export const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const DOCKER_HUB_HOST = "registry-1.docker.io";
const DOCKER_HUB_AUTH_KEY = "https://index.docker.io/v1/";
const DOCKER_HUB_ALIASES = new Set(["docker.io", "index.docker.io", "registry-1.docker.io"]);
const API = "Registry";

/** Repository path component rules of the OCI distribution spec. */
const REPOSITORY =
  /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*)*$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

export interface ImageName {
  /** As configured, e.g. `org/app`. */
  image: string;
  /** API host, e.g. `ghcr.io`, `registry-1.docker.io`, `localhost:5000`. */
  host: string;
  /** Repository, e.g. `org/app`, `library/nginx`. */
  repository: string;
  /** `https://<host>`, or `http://` for localhost registries. */
  baseUrl: string;
  /** Key in the Docker config `auths`. */
  authKey: string;
  dockerHub: boolean;
}

/** Parse an image name without tag or digest (`ghcr.io/org/app`, `org/app`, `nginx`). */
export function parseImageName(image: string): ImageName {
  const trimmed = image.trim();
  if (trimmed.includes("@")) {
    throw new VerifyError(
      `Image "${image}" contains a digest. Configure the image name without tag or digest (e.g. ghcr.io/org/app); launchset adds the tags.`,
    );
  }
  const slash = trimmed.indexOf("/");
  const first = slash === -1 ? "" : trimmed.slice(0, slash);
  const hasHost =
    slash !== -1 && (first.includes(".") || first.includes(":") || first === "localhost");
  const host = hasHost ? first.toLowerCase() : "docker.io";
  const path = hasHost ? trimmed.slice(slash + 1) : trimmed;
  const lastPart = path.slice(path.lastIndexOf("/") + 1);
  if (lastPart.includes(":")) {
    throw new VerifyError(
      `Image "${image}" contains a tag. Configure the image name without tag (e.g. ghcr.io/org/app); launchset adds the tags.`,
    );
  }
  const dockerHub = DOCKER_HUB_ALIASES.has(host);
  const repository = dockerHub && !path.includes("/") ? `library/${path}` : path;
  if (!REPOSITORY.test(repository)) {
    throw new VerifyError(
      `Image "${image}" isn't a valid image name: the repository "${repository}" must be lowercase letters, digits and separators (. _ __ -), split by /.`,
    );
  }
  const apiHost = dockerHub ? DOCKER_HUB_HOST : host;
  const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/.test(apiHost);
  return {
    image: trimmed,
    host: apiHost,
    repository,
    baseUrl: `${local ? "http" : "https"}://${apiHost}`,
    authKey: dockerHub ? DOCKER_HUB_AUTH_KEY : host,
    dockerHub,
  };
}

// ---------------------------------------------------------------------------
// Credentials

export interface Credentials {
  username: string;
  password: string;
  /** Where they came from, for messages. */
  source: string;
}

interface DockerConfigAuth {
  auth?: string;
  username?: string;
  password?: string;
  identitytoken?: string;
}

interface DockerConfig {
  auths?: Record<string, DockerConfigAuth>;
  credsStore?: string;
  credHelpers?: Record<string, string>;
}

export interface CredentialLookup {
  credentials?: Credentials;
  /** Why no credentials were found although some are configured (credential helpers). */
  note?: string;
}

/** Path of the Docker config file: `$DOCKER_CONFIG/config.json` or `~/.docker/config.json`. */
export function dockerConfigPath(env: VerifyContext["env"]): string {
  if (env.DOCKER_CONFIG) return join(env.DOCKER_CONFIG, "config.json");
  return join(env.HOME || homedir(), ".docker", "config.json");
}

async function readDockerConfig(file: string): Promise<DockerConfig | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new VerifyError(
      `Couldn't read the Docker config file ${file} (${(error as Error).message}). Fix its permissions, or set ${REGISTRY_ENV.username} and ${REGISTRY_ENV.password}.`,
    );
  }
  try {
    return JSON.parse(text) as DockerConfig;
  } catch {
    throw new VerifyError(
      `The Docker config file ${file} isn't valid JSON. Fix or remove it, or set ${REGISTRY_ENV.username} and ${REGISTRY_ENV.password}.`,
    );
  }
}

/**
 * Normalize a registry host or `auths` key (`https://ghcr.io/v2/` → `ghcr.io`); every
 * Docker Hub alias becomes `docker.io`.
 */
export function registryHostKey(key: string): string {
  if (key === DOCKER_HUB_AUTH_KEY) return "docker.io";
  const host = key
    .replace(/^[a-z]+:\/\//i, "")
    .split("/")[0]
    ?.toLowerCase();
  return host && DOCKER_HUB_ALIASES.has(host) ? "docker.io" : (host ?? "");
}

/** The registry key of an image (`docker.io` for Docker Hub, else the host). */
export function imageRegistryKey(name: ImageName): string {
  return name.dockerHub ? "docker.io" : registryHostKey(name.host);
}

/**
 * The registry the env credentials belong to: `LAUNCHSET_REGISTRY_HOST`, else the
 * registry of the target's first image. They are never sent to any other registry.
 */
export function envCredentialsHost(env: VerifyContext["env"], firstImage: ImageName): string {
  const configured = env[REGISTRY_ENV.host]?.trim();
  return configured ? registryHostKey(configured) : imageRegistryKey(firstImage);
}

/**
 * Credentials for a registry: `LAUNCHSET_REGISTRY_USERNAME` / `_PASSWORD` when this is
 * the registry they belong to (`boundHost`, see `envCredentialsHost`), else the Docker
 * config file entry for the host, else none (anonymous).
 */
export async function findCredentials(
  name: ImageName,
  env: VerifyContext["env"],
  boundHost: string,
): Promise<CredentialLookup> {
  const username = env[REGISTRY_ENV.username];
  const password = env[REGISTRY_ENV.password];
  const wanted = imageRegistryKey(name);
  let envNote: string | undefined;
  if (username || password) {
    if (!username || !password) {
      const missing = username ? REGISTRY_ENV.password : REGISTRY_ENV.username;
      throw new VerifyError(
        `${missing} is not set, but ${username ? REGISTRY_ENV.username : REGISTRY_ENV.password} is. Set both, or neither to use the Docker config file.`,
      );
    }
    if (wanted === boundHost) {
      return {
        credentials: {
          username,
          password,
          source: `${REGISTRY_ENV.username} / ${REGISTRY_ENV.password}`,
        },
      };
    }
    envNote = `${REGISTRY_ENV.username} / ${REGISTRY_ENV.password} belong to ${boundHost} and aren't sent to ${wanted} (${REGISTRY_ENV.host} picks their registry; other registries use the Docker config file, e.g. via docker/login-action)`;
  }

  const lookup = await dockerConfigCredentials(env, wanted);
  if (envNote && !lookup.credentials) {
    lookup.note = lookup.note ? `${envNote}; ${lookup.note}` : envNote;
  }
  return lookup;
}

async function dockerConfigCredentials(
  env: VerifyContext["env"],
  wanted: string,
): Promise<CredentialLookup> {
  const file = dockerConfigPath(env);
  const config = await readDockerConfig(file);
  if (!config) return {};
  const entry = Object.entries(config.auths ?? {}).find(
    ([key]) => registryHostKey(key) === wanted,
  )?.[1];

  if (entry?.auth) {
    const decoded = Buffer.from(entry.auth, "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon <= 0) {
      throw new VerifyError(
        `The Docker config file ${file} has an auth entry for ${wanted} that isn't base64 "user:password". Run docker login again, or set ${REGISTRY_ENV.username} and ${REGISTRY_ENV.password}.`,
      );
    }
    return {
      credentials: {
        username: decoded.slice(0, colon),
        password: decoded.slice(colon + 1),
        source: file,
      },
    };
  }
  if (entry?.username && entry.password) {
    return { credentials: { username: entry.username, password: entry.password, source: file } };
  }

  const helper =
    Object.entries(config.credHelpers ?? {}).find(
      ([key]) => registryHostKey(key) === wanted,
    )?.[1] ?? config.credsStore;
  if (helper) {
    return {
      note: `${file} keeps the credentials for ${wanted} in the credential helper "${helper}", which launchset can't read; set ${REGISTRY_ENV.username} and ${REGISTRY_ENV.password} (and ${REGISTRY_ENV.host}) instead`,
    };
  }
  if (entry?.identitytoken) {
    return {
      note: `${file} only has an identity token for ${wanted}, which launchset can't use; set ${REGISTRY_ENV.username} and ${REGISTRY_ENV.password} instead`,
    };
  }
  return {};
}

// ---------------------------------------------------------------------------
// Challenge + token

export interface Challenge {
  scheme: string;
  params: Record<string, string>;
}

const AUTH_TOKEN = /[A-Za-z0-9!#$%&'*+.^_`|~-]+/y;
const AUTH_QUOTED = /"((?:[^"\\]|\\.)*)"/y;
const AUTH_BARE = /[^\s,]*/y;

function stickyMatch(re: RegExp, text: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos;
  return re.exec(text);
}

/**
 * Parse every challenge of a `WWW-Authenticate` header (RFC 9110 11.6.1). Several
 * challenges may share one header (`Bearer realm="…",service="…", Basic realm="…"`); a
 * token followed by `=` is a parameter of the current challenge, any other token starts
 * a new challenge.
 */
export function parseChallenges(header: string | null): Challenge[] {
  if (!header) return [];
  const challenges: Challenge[] = [];
  let current: Challenge | undefined;
  let pos = 0;
  while (pos < header.length) {
    const char = header[pos] ?? "";
    if (char === "," || /\s/.test(char)) {
      pos++;
      continue;
    }
    const token = stickyMatch(AUTH_TOKEN, header, pos);
    if (!token) break; // Malformed: keep what was parsed so far.
    pos += token[0].length;
    let after = pos;
    while (header[after] === " " || header[after] === "\t") after++;
    if (header[after] === "=" && current) {
      after++;
      while (header[after] === " " || header[after] === "\t") after++;
      const quoted = stickyMatch(AUTH_QUOTED, header, after);
      let value: string;
      if (quoted) {
        value = (quoted[1] ?? "").replace(/\\(.)/g, "$1");
        pos = after + quoted[0].length;
      } else {
        const bare = stickyMatch(AUTH_BARE, header, after);
        value = bare?.[0] ?? "";
        pos = after + value.length;
      }
      current.params[token[0].toLowerCase()] = value;
    } else {
      current = { scheme: token[0].toLowerCase(), params: {} };
      challenges.push(current);
    }
  }
  return challenges;
}

/** The challenge to answer: Bearer if offered, else the first one. */
export function parseChallenge(header: string | null): Challenge | undefined {
  const challenges = parseChallenges(header);
  return challenges.find((c) => c.scheme === "bearer") ?? challenges[0];
}

function basicHeader(credentials: Credentials): string {
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;
}

async function fetchBearerToken(
  ctx: VerifyContext,
  name: ImageName,
  challenge: Challenge,
  credentials: Credentials | undefined,
  describe: () => string,
): Promise<string> {
  const realm = challenge.params.realm;
  if (!realm) {
    throw new VerifyError(
      `${API}: ${name.host} asked for Bearer auth without a token realm. The registry isn't speaking the Docker token protocol; check the image name.`,
    );
  }
  let url: URL;
  try {
    url = new URL(realm);
  } catch {
    throw new VerifyError(`${API}: ${name.host} sent an invalid token realm "${realm}".`);
  }
  if (challenge.params.service) url.searchParams.set("service", challenge.params.service);
  url.searchParams.set("scope", challenge.params.scope || `repository:${name.repository}:pull`);
  const headers: Record<string, string> = { accept: "application/json" };
  if (credentials) headers.authorization = basicHeader(credentials);
  const response = await send(ctx, `${API} token`, url.toString(), { headers });
  if (!response.ok) {
    throw new VerifyError(
      `${API}: getting a pull token for ${name.image} from ${url.origin}${url.pathname} failed with HTTP ${response.status}${paren(await errorDetail(response))} ${describe()}.${authHint(name)}`,
    );
  }
  let body: { token?: unknown; access_token?: unknown };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new VerifyError(
      `${API}: the token endpoint ${url.origin}${url.pathname} for ${name.image} answered with invalid JSON.`,
    );
  }
  const token = typeof body.token === "string" && body.token ? body.token : body.access_token;
  if (typeof token !== "string" || !token) {
    throw new VerifyError(
      `${API}: the token endpoint ${url.origin}${url.pathname} for ${name.image} answered without a token.`,
    );
  }
  return token;
}

function authHint(name: ImageName): string {
  const parts = [
    ` For private images, give verify read access before it runs: set ${REGISTRY_ENV.username} and ${REGISTRY_ENV.password}, or run docker/login-action before the verify step`,
  ];
  if (name.host === "ghcr.io") {
    parts.push(
      '; for GHCR the job needs "permissions: packages: read" and the password can be the GITHUB_TOKEN',
    );
  }
  if (name.dockerHub) {
    parts.push(
      "; Docker Hub also refuses anonymous access to repositories that don't exist yet, so the first release needs credentials",
    );
  }
  return `${parts.join("")}.`;
}

// ---------------------------------------------------------------------------
// Manifest check

export interface TagCheck {
  ref: string;
  exists: boolean;
}

/** Whether `name:tag` exists. Throws for anything but a clear 200 or 404. */
export async function tagExists(
  name: ImageName,
  tag: string,
  ctx: VerifyContext,
  boundHost: string = envCredentialsHost(ctx.env, name),
): Promise<TagCheck> {
  const ref = `${name.image}:${tag}`;
  const url = `${name.baseUrl}/v2/${name.repository}/manifests/${encodeURIComponent(tag)}`;
  const lookup = await findCredentials(name, ctx.env, boundHost);
  const credentials = lookup.credentials;
  let auth = "anonymously";
  const describe = () => `${auth}${lookup.note ? ` (${lookup.note})` : ""}`;

  const head = (authorization?: string) =>
    send(ctx, API, url, {
      method: "HEAD",
      headers: { accept: MANIFEST_ACCEPT, ...(authorization ? { authorization } : {}) },
    });

  let response = await head();
  if (response.status === 401) {
    const challenge = parseChallenge(response.headers.get("www-authenticate"));
    if (challenge?.scheme === "bearer") {
      if (credentials) auth = `with credentials from ${credentials.source}`;
      const token = await fetchBearerToken(ctx, name, challenge, credentials, describe);
      response = await head(`Bearer ${token}`);
    } else if (challenge?.scheme === "basic" && credentials) {
      auth = `with credentials from ${credentials.source}`;
      response = await head(basicHeader(credentials));
    }
  }

  if (response.status === 200) return { ref, exists: true };
  if (response.status === 404) return { ref, exists: false };

  const challenge = parseChallenge(response.headers.get("www-authenticate"));
  const reason = challenge?.params.error ? ` (${challenge.params.error})` : "";
  const hint = response.status === 401 || response.status === 403 ? authHint(name) : "";
  throw new VerifyError(
    `${API}: checking ${ref} (HEAD ${url}) failed with HTTP ${response.status}${reason} ${describe()}.${hint || " The registry may be unavailable; try again later."}`,
  );
}

export interface RegistryCheck {
  /** Image names without tag. */
  images: string[];
  /** The rendered verify tag (spec 7.4), e.g. `1.5.0` or `v1.5.0`. */
  tag: string;
}

/**
 * Registry check (spec 7.4). Already published only if the tag exists in every image;
 * if it exists in some but not all, it's not published (the push re-runs) and the
 * message says which.
 */
export async function verifyRegistry(
  check: RegistryCheck,
  ctx: VerifyContext,
): Promise<VerifyResult> {
  if (check.images.length === 0) {
    throw new VerifyError(
      "Registry verification needs at least one image, but none is configured.",
    );
  }
  if (!TAG.test(check.tag)) {
    throw new VerifyError(
      `The verify tag "${check.tag}" isn't a valid image tag (letters, digits, _ . -, max 128 characters, not starting with . or -). Check the target's tags templates.`,
    );
  }
  const names = check.images.map(parseImageName);
  // The env credentials belong to one registry only (LAUNCHSET_REGISTRY_HOST, else the
  // first image's): a multi-registry target never sends them to the other registries.
  const firstImage = names[0] as ImageName;
  const boundHost = envCredentialsHost(ctx.env, firstImage);
  const results = await Promise.all(
    names.map((name) => tagExists(name, check.tag, ctx, boundHost)),
  );
  const present = results.filter((r) => r.exists).map((r) => r.ref);
  const missing = results.filter((r) => !r.exists).map((r) => r.ref);
  if (missing.length === 0) {
    return {
      alreadyPublished: true,
      message: `${present.join(", ")} already exist${present.length === 1 ? "s" : ""}`,
    };
  }
  if (present.length === 0) {
    return {
      alreadyPublished: false,
      message: `${missing.join(", ")} ${missing.length === 1 ? "doesn't" : "don't"} exist yet`,
    };
  }
  return {
    alreadyPublished: false,
    message: `only some images have the tag: ${present.join(", ")} exist${present.length === 1 ? "s" : ""}, ${missing.join(", ")} missing; not published`,
  };
}
