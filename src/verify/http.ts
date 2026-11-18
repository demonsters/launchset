/** Small helpers shared by the verify clients: fetch with clear errors, secrets decoding. */

import { type VerifyContext, VerifyError } from "./types.ts";

/**
 * `fetch` that turns network failures into a `VerifyError` naming the API and URL.
 * HTTP error statuses are returned as-is: each client decides what they mean.
 */
export async function send(
  ctx: VerifyContext,
  api: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const fetchFn = ctx.fetch ?? globalThis.fetch;
  const method = init.method ?? "GET";
  try {
    return await fetchFn(url, init);
  } catch (error) {
    throw new VerifyError(
      `${api}: ${method} ${url} failed before a response arrived (${describeError(error)}). Check the network connection and that the host is reachable from this runner.`,
      { cause: error },
    );
  }
}

/** Error text including the `cause` chain (undici puts the useful part in `cause`). */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth++) {
    if (current instanceof Error) {
      const code = (current as { code?: unknown }).code;
      parts.push(typeof code === "string" ? `${current.message} [${code}]` : current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(": ") || "unknown error";
}

/**
 * A short description of an error response body for messages: the `error_description`,
 * `error.message`, `errors[].detail` etc. of common JSON error shapes, else the text,
 * truncated.
 */
export async function errorDetail(response: Response): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return "";
  }
  text = text.trim();
  if (!text) return "";
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const detail = jsonErrorDetail(json);
    if (detail) return truncate(detail);
  } catch {
    // Not JSON: use the text.
  }
  return truncate(text.replace(/\s+/g, " "));
}

function jsonErrorDetail(json: Record<string, unknown>): string | undefined {
  const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  // OAuth: { error, error_description }
  if (typeof json.error === "string") {
    return [json.error, str(json.error_description)].filter(Boolean).join(": ");
  }
  // Google APIs: { error: { code, message, status } }
  if (json.error && typeof json.error === "object") {
    const e = json.error as Record<string, unknown>;
    const message = [str(e.status), str(e.message)].filter(Boolean).join(": ");
    if (message) return message;
  }
  // App Store Connect / OCI: { errors: [{ code, title, detail, message }] }
  if (Array.isArray(json.errors)) {
    const messages = json.errors
      .map((e: Record<string, unknown>) =>
        [str(e.code), str(e.detail) ?? str(e.message) ?? str(e.title)].filter(Boolean).join(": "),
      )
      .filter(Boolean);
    if (messages.length > 0) return messages.join("; ");
  }
  // npm: { error } handled above; { message }
  return str(json.message);
}

function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** ` (detail)` or empty, for appending to a message. */
export function paren(detail: string): string {
  return detail ? ` (${detail})` : "";
}

/** Parse a JSON body, or throw a `VerifyError` naming the API and URL. */
export async function readJson<T>(response: Response, api: string, url: string): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new VerifyError(
      `${api}: ${url} answered ${response.status} with a body that isn't valid JSON. The API may be down or a proxy may be in the way; try again later.`,
    );
  }
}

const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * Decode a secret that may be given raw or base64-encoded. `looksRaw` decides whether
 * the value is already in its raw form. Returns `undefined` when it's neither.
 * Never puts the secret into an error message.
 */
export function decodeSecret(
  value: string,
  looksRaw: (text: string) => boolean,
): string | undefined {
  const trimmed = value.trim();
  if (looksRaw(trimmed)) return trimmed;
  const compact = trimmed.replace(/\s+/g, "");
  if (!BASE64.test(compact)) return undefined;
  const decoded = Buffer.from(compact, "base64").toString("utf8").trim();
  return looksRaw(decoded) ? decoded : undefined;
}

/** Names of the variables in `names` that are unset or empty. */
export function missingEnv(env: VerifyContext["env"], names: string[]): string[] {
  return names.filter((name) => !env[name]?.trim());
}
