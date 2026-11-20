import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CI_DETECTION_ORDER,
  ciOf,
  DEFAULT_HOST,
  FORGE_HOSTS,
  HOSTS,
  hostProfile,
  isForgeHost,
} from "../../src/core/hosts.ts";
import { hostFromEnv, hostFromRemoteName } from "../../src/flow/ci/index.ts";
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

  it("recognises every host from its CI flag, the default host last", () => {
    expect([...CI_DETECTION_ORDER].sort()).toEqual([...FORGE_HOSTS].sort());
    expect(new Set(CI_DETECTION_ORDER).size).toBe(CI_DETECTION_ORDER.length);
    expect(CI_DETECTION_ORDER.at(-1)).toBe(DEFAULT_HOST);
    expect(new Set(FORGE_HOSTS.map((h) => HOSTS[h].ciFlag)).size).toBe(FORGE_HOSTS.length);
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
});
