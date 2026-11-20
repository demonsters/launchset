import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CI_DETECTION_ORDER,
  CI_SYSTEMS,
  type CiSystem,
  ciFromEnv,
  ciOf,
  ciSystemFor,
  DEFAULT_HOST,
  FORGE_HOSTS,
  HOSTS,
  hostProfile,
  isForgeHost,
} from "../../src/core/hosts.ts";
import { hostFromEnv, hostFromRemoteName, readCiEnvironment } from "../../src/flow/ci/index.ts";
import { HOST_ADAPTERS } from "../../src/flow/hosts.ts";

const SRC = join(import.meta.dirname, "../../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("host table", () => {
  it("has a profile and an adapter for every host", () => {
    for (const host of FORGE_HOSTS) {
      expect(HOSTS[host].host).toBe(host);
      expect(HOST_ADAPTERS[host]).toBeDefined();
    }
    expect(Object.keys(HOSTS).sort()).toEqual([...FORGE_HOSTS].sort());
    expect(Object.keys(HOST_ADAPTERS).sort()).toEqual([...FORGE_HOSTS].sort());
  });

  it("has a CI profile for every CI system, each serving its hosts", () => {
    const systems = Object.keys(CI_SYSTEMS) as CiSystem[];
    for (const ci of systems) {
      expect(CI_SYSTEMS[ci].ci).toBe(ci);
      for (const host of CI_SYSTEMS[ci].hosts) expect(isForgeHost(host)).toBe(true);
    }
    // Every host's own CI system serves it.
    for (const host of FORGE_HOSTS) {
      expect(CI_SYSTEMS[hostProfile(host).ci].hosts).toContain(host);
    }
  });

  it("recognises every CI system from the environment, GitHub Actions last", () => {
    const systems = Object.keys(CI_SYSTEMS) as CiSystem[];
    expect([...CI_DETECTION_ORDER].sort()).toEqual([...systems].sort());
    expect(new Set(CI_DETECTION_ORDER).size).toBe(CI_DETECTION_ORDER.length);
    expect(CI_DETECTION_ORDER.at(-1)).toBe(hostProfile(DEFAULT_HOST).ci);
    const detects = systems.map((ci) => JSON.stringify(CI_SYSTEMS[ci].detect));
    expect(new Set(detects).size).toBe(systems.length);
  });

  it("detects a CI by its variable's value, not only `true`", () => {
    expect(ciFromEnv({ GITLAB_CI: "true" })).toBe("gitlab-ci");
    expect(ciFromEnv({ GITLAB_CI: "1" })).toBeUndefined();
    expect(ciFromEnv({ GITHUB_ACTIONS: "true" })).toBe("actions");
    expect(ciFromEnv({ CI: "true" })).toBeUndefined();
  });

  it("uses the environment's CI only for a host it serves", async () => {
    expect(ciSystemFor("gitlab", { GITLAB_CI: "true" })).toBe("gitlab-ci");
    expect(ciSystemFor("github", {})).toBe("actions");
    // LAUNCHSET_HOST=gitlab in a GitHub Actions job keeps reading GitLab's environment.
    expect(ciSystemFor("gitlab", { GITHUB_ACTIONS: "true" })).toBe("gitlab-ci");
    expect((await readCiEnvironment("gitlab", { GITHUB_ACTIONS: "true" })).system).toBe(
      "gitlab-ci",
    );
    expect((await readCiEnvironment("github", {})).system).toBe("actions");
  });

  it("checks the CI flags in detection order", () => {
    // Runners of Actions-compatible CI set GITHUB_ACTIONS too: the other flag wins.
    expect(hostFromEnv({ GITLAB_CI: "true", GITHUB_ACTIONS: "true" })).toEqual({
      host: "gitlab",
      source: "GITLAB_CI",
    });
    expect(hostFromEnv({ GITHUB_ACTIONS: "true" })).toEqual({
      host: "github",
      source: "GITHUB_ACTIONS",
    });
    expect(hostFromEnv({})).toBeUndefined();
  });

  it("names the host from a remote's host name, the default host needing none", () => {
    expect(hostFromRemoteName("gitlab.acme.dev")).toBe("gitlab");
    expect(hostFromRemoteName("github.com")).toBeUndefined();
    expect(HOSTS[DEFAULT_HOST].remoteMatches).toBeUndefined();
  });

  it("answers host names and CI systems", () => {
    expect(isForgeHost("gitlab")).toBe(true);
    expect(isForgeHost("gitea")).toBe(false);
    expect(hostProfile().host).toBe(DEFAULT_HOST);
    expect(ciOf("gitlab")).toBe("gitlab-ci");
    expect(ciOf("github")).toBe("actions");
    expect(ciOf("something else")).toBe(hostProfile(DEFAULT_HOST).ci);
  });

  it("keeps behaviour per host in traits, not host-name comparisons", () => {
    // Compare a trait of hostProfile(host) instead (or add one to core/hosts.ts), so a new host
    // needs a profile, not a new branch in every module. init's host guess weighs GitLab's own
    // evidence (GITLAB_CI, a gitlab remote, .gitlab-ci.yml) and stays as it is.
    const allowed = new Set(["init/detect.ts"]);
    const comparison = /[!=]==\s*"(?:github|gitlab)"|"(?:github|gitlab)"\s*[!=]==/;
    const offenders = sourceFiles(SRC).flatMap((file) => {
      const name = relative(SRC, file).split("\\").join("/");
      if (allowed.has(name)) return [];
      return readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => ({ line, at: `${name}:${i + 1}` }))
        .filter(({ line }) => comparison.test(line) && !/\bkind\s*===/.test(line))
        .map(({ at, line }) => `${at}: ${line.trim()}`);
    });
    expect(offenders).toEqual([]);
  });

  it("reads the CI systems' variables only through the CI profiles", () => {
    // Use ciFromEnv / ciSystemOf(context) and a trait of the CI profile instead. The
    // environment readers (flow/ci) and init's host guess read them on purpose.
    const variables = Object.values(CI_SYSTEMS).map((ci) => ci.detect.variable);
    const read = new RegExp(
      `env\\??\\.(?:${variables.join("|")})\\b|env\\[\\s*["'](?:${variables.join("|")})["']`,
    );
    const allowed = (name: string) =>
      name.startsWith("flow/ci/") || name === "core/hosts.ts" || name === "init/detect.ts";
    const offenders = sourceFiles(SRC).flatMap((file) => {
      const name = relative(SRC, file).split("\\").join("/");
      if (allowed(name)) return [];
      return readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => ({ line, at: `${name}:${i + 1}` }))
        .filter(({ line }) => read.test(line))
        .map(({ at, line }) => `${at}: ${line.trim()}`);
    });
    expect(offenders).toEqual([]);
    // The pattern itself catches a direct read.
    expect(read.test('if (io.env.GITLAB_CI === "true") {')).toBe(true);
  });
});
