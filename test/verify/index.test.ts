import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { type ResolvedTarget, resolveConfig } from "../../src/core/config/schema.ts";
import type { TargetPlan } from "../../src/core/types.ts";
import { VerifyError, verifyTarget } from "../../src/verify/index.ts";
import { compareBuildVersions, parseBuildVersion, roundUpOffset } from "../../src/verify/store.ts";
import { makeCtx, tempDir, useServer } from "./helpers.ts";

const server = useServer();

/** Resolve a config with one target and return it. */
function resolved(name: string, target: Record<string, unknown>): ResolvedTarget {
  const result = resolveConfig({ targets: { [name]: target }, preview: false }).targets[name];
  if (!result) throw new Error(`target ${name} missing`);
  return result;
}

function plan(name: string, overrides: Partial<TargetPlan> = {}): TargetPlan {
  return {
    name,
    type: "custom",
    release: "auto",
    marketingVersion: "1.5.0",
    buildNumber: 217_000_000,
    ...overrides,
  };
}

describe("verifyTarget", () => {
  it("reports no verification for targets without verify entries", async () => {
    const web = resolved("web", { type: "web" });
    expect(await verifyTarget(web, { version: "1.5.0", target: plan("web") }, makeCtx())).toEqual({
      alreadyPublished: false,
      message: "no verification configured",
    });
  });

  it("runs the registry check with the plan's verify tag", async () => {
    const api = resolved("api", {
      type: "docker",
      image: "ghcr.io/org/api",
      tags: ["v{version}"],
      verify: ["registry"],
    });
    server.use(
      http.head(
        "https://ghcr.io/v2/org/api/manifests/:tag",
        ({ params }) => new HttpResponse(null, { status: params.tag === "v1.5.0" ? 200 : 404 }),
      ),
    );
    const docker = {
      images: ["ghcr.io/org/api"],
      tags: ["v1.5.0"],
      refs: ["ghcr.io/org/api:v1.5.0"],
      verifyTag: "v1.5.0",
      labels: {},
    };
    const result = await verifyTarget(
      api,
      { version: "1.5.0", target: plan("api", { type: "docker", docker }) },
      makeCtx(),
    );
    expect(result).toEqual({
      alreadyPublished: true,
      message: "ghcr.io/org/api:v1.5.0 already exists",
    });
  });

  it("fails when a docker plan has no verify tag", async () => {
    const api = resolved("api", { type: "docker", image: "ghcr.io/org/api", verify: ["registry"] });
    await expect(
      verifyTarget(api, { version: "1.5.0", target: plan("api", { type: "docker" }) }, makeCtx()),
    ).rejects.toThrow(/no docker verify tag/);
  });

  it("runs the npm check with the run version and npm.package", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await writeFile(join(dir, "pkg.json"), JSON.stringify({ name: "tool" }));
      const npm = resolved("npm", {
        type: "custom",
        npm: { package: "pkg.json" },
        verify: ["npm"],
      });
      server.use(
        http.get("https://registry.npmjs.org/tool", () =>
          HttpResponse.json({ versions: { "1.5.0": {} } }),
        ),
      );
      const result = await verifyTarget(
        npm,
        { version: "1.5.0", target: plan("npm") },
        makeCtx({}, dir),
      );
      expect(result.alreadyPublished).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("fails clearly for an eas (null) build number on a store check", async () => {
    const ios = resolved("ios", {
      type: "ios",
      source: { kind: "expo" },
      store: { appId: "123" },
      buildNumber: { strategy: "eas" },
      verify: ["store"],
    });
    await expect(
      verifyTarget(
        ios,
        { version: "1.5.0", target: plan("ios", { type: "ios", buildNumber: null }) },
        makeCtx(),
      ),
    ).rejects.toThrow(/Target "ios" has no build number \(buildNumber.strategy is "eas"/);
  });

  it("dispatches android store checks to Google Play", async () => {
    const android = resolved("android", {
      type: "android",
      source: { kind: "expo" },
      store: { packageName: "com.example" },
      verify: ["store"],
    });
    await expect(
      verifyTarget(
        android,
        { version: "1.5.0", target: plan("android", { type: "android" }) },
        makeCtx(),
      ),
    ).rejects.toThrow(/LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON/);
  });
});

describe("test setup", () => {
  it("never lets an unhandled request reach the network", async () => {
    const error = (await fetch("https://example.invalid/unhandled").catch(
      (e: unknown) => e,
    )) as Error;
    expect(String(error.cause)).toContain("[MSW]");
  });
});

describe("store helpers", () => {
  it("parses and compares build versions numerically", () => {
    expect(parseBuildVersion("10")).toEqual([10]);
    expect(parseBuildVersion("1.2.0")).toEqual([1, 2]);
    expect(parseBuildVersion("abc")).toBeUndefined();
    expect(compareBuildVersions([10], [9])).toBeGreaterThan(0);
    expect(compareBuildVersions([1, 2], [1, 2, 0])).toBe(0);
    expect(compareBuildVersions([1, 2, 1], [1, 2])).toBeGreaterThan(0);
  });

  it("rounds suggested offsets up to two significant digits", () => {
    expect(roundUpOffset(1)).toBe(1);
    expect(roundUpOffset(57)).toBe(57);
    expect(roundUpOffset(124)).toBe(130);
    expect(roundUpOffset(83_000_001)).toBe(84_000_000);
    expect(roundUpOffset(500_000)).toBe(500_000);
  });
});

describe("VerifyError", () => {
  it("masks credentials in URLs anywhere in the message", () => {
    const error = new VerifyError(
      "GET https://user:SECRET@host/x failed; also http://tok@other/ and https://plain.example/",
    );
    expect(error.message).toBe(
      "GET https://***@host/x failed; also http://***@other/ and https://plain.example/",
    );
  });
});
