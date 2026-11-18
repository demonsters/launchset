import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";
import type { VerifyContext } from "../../src/verify/types.ts";

/** An msw server that fails every request without a handler (no real network). */
export function useServer() {
  const server = setupServer();
  beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
  return server;
}

export const NOW = new Date("2026-11-18T12:00:00Z");

export function makeCtx(
  env: Record<string, string | undefined> = {},
  cwd = "/nonexistent",
): VerifyContext {
  // HOME points nowhere, so a developer's ~/.docker/config.json never leaks into tests.
  return { cwd, env: { HOME: "/nonexistent-home", ...env }, now: () => NOW };
}

export async function makeKeys(alg: "RS256" | "ES256") {
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  return {
    publicKey,
    privatePem: await exportPKCS8(privateKey),
    publicPem: await exportSPKI(publicKey),
  };
}

export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "launchset-verify-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
