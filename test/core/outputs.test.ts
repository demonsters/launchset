import { describe, expect, it } from "vitest";
import type { LaunchsetError } from "../../src/core/errors.ts";
import { actionOutputs, envOutputs, parsePlan } from "../../src/core/outputs.ts";
import { planPreview } from "../../src/core/preview.ts";
import { BUILD, HEAD, makeConfig, NOW, plan, tags } from "./plan-fixtures.ts";

const publish = plan({ version: "1.5.0", headIsReleaseCommit: true });

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as LaunchsetError).code;
  }
  return "no error";
}

describe("actionOutputs (10)", () => {
  it("has the plan-level outputs", () => {
    const out = actionOutputs(publish);
    expect(out.mode).toBe("publish");
    expect(out.matrix).toBe('["docker-api","web","android"]');
    expect(JSON.parse(out.plan as string)).toEqual(publish);
    expect(out.version).toBe("1.5.0");
    expect(out["marketing-version"]).toBe("1.5.0");
    expect(out["build-number"]).toBe(String(BUILD));
    expect(out.channel).toBe("release");
    expect(out["release-sha"]).toBe(HEAD);
    expect(out.tag).toBe("v1.5.0");
    expect(out["dist-tag"]).toBe("latest");
    expect(out["pr-number"]).toBe("");
    expect(out["docker-tags"]).toBe("");
    expect(out["docker-refs-json"]).toBe("[]");
    expect(out["docker-labels"]).toBe("");
  });

  it("has per-target Docker outputs", () => {
    const out = actionOutputs(publish, "docker-api");
    expect(out["docker-tags"]).toBe(
      [
        "ghcr.io/demonsters/api:1.5.0",
        "ghcr.io/demonsters/api:1.5",
        "ghcr.io/demonsters/api:1",
        "ghcr.io/demonsters/api:latest",
      ].join("\n"),
    );
    expect(JSON.parse(out["docker-refs-json"] as string)).toHaveLength(4);
    expect(out["docker-labels"]).toBe(
      [
        "org.opencontainers.image.version=1.5.0",
        `org.opencontainers.image.revision=${HEAD}`,
        `org.opencontainers.image.created=${NOW.toISOString()}`,
      ].join("\n"),
    );
  });

  it("uses the target's build number and marketing version, '' for eas", () => {
    const config = makeConfig({ buildNumber: { strategy: "eas" } });
    const eas = plan({ config, version: "1.5.0", headIsReleaseCommit: true });
    expect(actionOutputs(eas, "android")["build-number"]).toBe("");
    expect(envOutputs(eas, "android")).toEqual({
      LAUNCHSET_VERSION: "1.5.0",
      LAUNCHSET_BUILD_NUMBER: "",
      LAUNCHSET_CHANNEL: "release",
    });
  });

  it("gives iOS its plain marketing version in previews, and no mode output", () => {
    const config = makeConfig();
    const decision = planPreview({
      config,
      trigger: { kind: "pr", number: 9, labels: ["launchset:preview"] },
      branch: "x",
      headSha: HEAD,
      version: "1.4.0",
      changesets: [],
      tags: tags(config, []),
      now: NOW,
      run: { number: 3 },
    });
    if (decision.kind !== "plan") throw new Error("expected a plan");
    const out = actionOutputs(decision.plan, "ios");
    expect(out.mode).toBeUndefined();
    expect(out.version).toBe("1.4.1-pr.9.3");
    expect(out["marketing-version"]).toBe("1.4.1");
    expect(out["pr-number"]).toBe("9");
    expect(out["dist-tag"]).toBe("pr-9");
    expect(envOutputs(decision.plan, "ios").LAUNCHSET_VERSION).toBe("1.4.1");
    expect(envOutputs(decision.plan).LAUNCHSET_CHANNEL).toBe("preview");
  });

  it("refuses targets that aren't in the plan", () => {
    expect(code(() => actionOutputs(publish, "ios"))).toBe("target-not-in-plan");
  });
});

describe("parsePlan", () => {
  it("round-trips a plan", () => {
    expect(parsePlan(JSON.stringify(publish))).toEqual(publish);
  });

  it("keeps unknown fields (forward compatible)", () => {
    expect(parsePlan(JSON.stringify({ ...publish, extra: 1 }))).toMatchObject({ extra: 1 });
  });

  it("says when the plan is missing, not JSON or not a plan", () => {
    expect(code(() => parsePlan(undefined))).toBe("missing-plan");
    expect(code(() => parsePlan("  "))).toBe("missing-plan");
    expect(code(() => parsePlan("{oops"))).toBe("invalid-plan");
    let message = "";
    try {
      parsePlan(JSON.stringify({ ...publish, schemaVersion: 2, version: 5 }));
    } catch (error) {
      message = (error as Error).message;
      expect((error as LaunchsetError).hint).toContain("needs.launchset.outputs.plan");
    }
    expect(message).toContain("schemaVersion");
    expect(message).toContain("version");
    const broken = { ...publish, matrix: ["ghost"] };
    expect(code(() => parsePlan(JSON.stringify(broken)))).toBe("invalid-plan");
  });
});
