import { describe, expect, it } from "vitest";
import { baselineAction } from "../../src/core/baseline.ts";
import { resolveConfig } from "../../src/core/config/schema.ts";
import { indexTags } from "../../src/core/tags.ts";

const config = resolveConfig({ baseline: "1.4.0", targets: { web: { type: "web" } } });
const index = (tags: string[]) => indexTags(tags, config);

describe("baselineAction", () => {
  it("creates the release tag on the base branch while the root version is the baseline", () => {
    expect(baselineAction(config, { branch: "main", version: "1.4.0", index: index([]) })).toEqual({
      kind: "create",
      version: "1.4.0",
      tag: "v1.4.0",
    });
  });

  it("does nothing elsewhere, for another version, once released, or without a baseline", () => {
    const none = [
      { branch: "release/1.4.x", version: "1.4.0", tags: [] },
      { branch: "feature", version: "1.4.0", tags: [] },
      { branch: "main", version: "1.5.0", tags: [] },
      { branch: "main", version: "1.4.0", tags: ["v1.4.0"] },
    ];
    for (const c of none) {
      expect(baselineAction(config, { ...c, index: index(c.tags) }), JSON.stringify(c)).toBe(
        undefined,
      );
    }
    const without = resolveConfig({ targets: { web: { type: "web" } } });
    expect(baselineAction(without, { branch: "main", version: "1.4.0", index: index([]) })).toBe(
      undefined,
    );
  });

  it("uses the configured release tag format", () => {
    const custom = resolveConfig({
      baseline: "1.4.0",
      tags: { release: "app@{version}" },
      targets: { web: { type: "web" } },
    });
    expect(
      baselineAction(custom, { branch: "main", version: "1.4.0", index: indexTags([], custom) }),
    ).toMatchObject({ kind: "create", tag: "app@1.4.0" });
  });

  it("skips with a warning after a partial release", () => {
    const action = baselineAction(config, {
      branch: "main",
      version: "1.4.0",
      index: index(["launchset/partial/1.4.0"]),
    });
    expect(action).toMatchObject({ kind: "skip" });
  });

  it("rejects a baseline that isn't a plain version", () => {
    expect(() => resolveConfig({ baseline: "v1.4.0", targets: { web: { type: "web" } } })).toThrow(
      'expected a plain version like "1.4.0"',
    );
  });
});
