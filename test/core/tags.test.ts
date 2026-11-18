import { describe, expect, it } from "vitest";
import {
  autoTargets,
  hasMarker,
  highestMarkerVersion,
  indexTags,
  isReleased,
  latestRelease,
  latestReleaseInLine,
  markersFor,
  markerTag,
  missingAutoTargets,
  parseTag,
  partialTag,
  releasedVersions,
  releasesAfter,
  releaseTag,
  renderTag,
  takenVersions,
  unfinishedReleases,
} from "../../src/core/tags.ts";

const TAGS = {
  release: "v{version}",
  marker: "launchset/{target}@{version}",
  partial: "launchset/partial/{version}",
};

const TARGETS = {
  "docker-api": { release: "auto" as const },
  android: { release: "auto" as const },
  ios: { release: "manual" as const },
};

describe("render", () => {
  it("renders the default templates", () => {
    expect(releaseTag(TAGS, "1.5.0")).toBe("v1.5.0");
    expect(markerTag(TAGS, "docker-api", "1.5.0")).toBe("launchset/docker-api@1.5.0");
    expect(partialTag(TAGS, "1.4.0")).toBe("launchset/partial/1.4.0");
  });

  it("errors when a value is missing", () => {
    expect(() => renderTag("{target}-{version}", { version: "1.0.0" })).toThrow(
      /needs a value for \{target\}/,
    );
  });
});

describe("parseTag", () => {
  it("parses tags back with the templates", () => {
    expect(parseTag("v1.5.0", TAGS.release)).toEqual({ version: "1.5.0" });
    expect(parseTag("v1.5.0-alpha.3", TAGS.release)).toEqual({ version: "1.5.0-alpha.3" });
    expect(parseTag("launchset/docker-api@1.5.0", TAGS.marker)).toEqual({
      target: "docker-api",
      version: "1.5.0",
    });
    expect(parseTag("1.5.0", TAGS.release)).toBeNull();
    expect(parseTag("v1.5", TAGS.release)).toBeNull();
    expect(parseTag("v01.5.0", TAGS.release)).toBeNull();
    expect(parseTag("xv1.5.0", TAGS.release)).toBeNull();
  });

  it("treats regex metacharacters in templates literally", () => {
    expect(parseTag("rel+1.2.3", "rel+{version}")).toEqual({ version: "1.2.3" });
    expect(parseTag("relll1.2.3", "rel+{version}")).toBeNull();
    expect(parseTag("(api).1.2.3", "({target}).{version}")).toEqual({
      target: "api",
      version: "1.2.3",
    });
    expect(parseTag("(api)x1.2.3", "({target}).{version}")).toBeNull();
  });

  it("handles dashes in target names next to the version", () => {
    expect(parseTag("docker-api-1.2.3", "{target}-{version}")).toEqual({
      target: "docker-api",
      version: "1.2.3",
    });
  });
});

describe("indexTags", () => {
  const index = indexTags(
    [
      "v1.3.0",
      "v1.4.0",
      "v1.4.1",
      "v1.5.0-alpha.0",
      "v1.5.0-alpha.1",
      "v2.0.0+build.1",
      "launchset/docker-api@1.3.0",
      "launchset/android@1.3.0",
      "launchset/ios@1.3.0",
      "launchset/docker-api@1.4.0",
      "launchset/android@1.4.0",
      "launchset/docker-api@1.4.1",
      "launchset/android@1.4.1",
      "launchset/docker-api@1.5.0",
      "launchset/docker-api@1.6.0",
      "launchset/old-web@1.3.0",
      "launchset/partial/1.5.0",
      "1.2.0",
      "something-else",
    ],
    { tags: TAGS, targets: TARGETS },
  );

  it("counts only plain X.Y.Z release tags as releases", () => {
    expect([...index.releases.keys()]).toEqual(["1.3.0", "1.4.0", "1.4.1"]);
    expect([...index.prereleases.keys()]).toEqual(["1.5.0-alpha.0", "1.5.0-alpha.1"]);
    expect(index.partials.get("1.5.0")).toBe("launchset/partial/1.5.0");
    expect(latestRelease(index)).toBe("1.4.1");
    expect(releasedVersions(index)).toEqual(["1.4.1", "1.4.0", "1.3.0"]);
    expect(isReleased(index, "1.4.0")).toBe(true);
    expect(isReleased(index, "1.5.0")).toBe(false);
    expect(isReleased(index, "1.5.0-alpha.1")).toBe(false);
  });

  it("indexes markers per version, exposing unknown targets", () => {
    expect([...markersFor(index, "1.3.0")].sort()).toEqual([
      "android",
      "docker-api",
      "ios",
      "old-web",
    ]);
    expect(markersFor(index, "9.9.9").size).toBe(0);
    expect(hasMarker(index, "android", "1.4.1")).toBe(true);
    expect(hasMarker(index, "ios", "1.4.1")).toBe(false);
    expect(index.unknownMarkers).toEqual([
      { tag: "launchset/old-web@1.3.0", target: "old-web", version: "1.3.0" },
    ]);
    expect(index.markerTags).toHaveLength(10);
  });

  it("finds the latest release in a line", () => {
    expect(latestReleaseInLine(index, { major: 1, minor: 4 })).toBe("1.4.1");
    expect(latestReleaseInLine(index, { major: 1, minor: 3 })).toBe("1.3.0");
    expect(latestReleaseInLine(index, { major: 1, minor: 5 })).toBeNull();
  });

  it("lists taken versions: releases, markers and partials, never prereleases", () => {
    expect([...takenVersions(index)].sort()).toEqual(["1.3.0", "1.4.0", "1.4.1", "1.5.0", "1.6.0"]);
  });

  it("finds the highest marker per target (never backwards, 9.8)", () => {
    expect(highestMarkerVersion(index, "ios")).toBe("1.3.0");
    expect(highestMarkerVersion(index, "docker-api")).toBe("1.6.0");
    expect(highestMarkerVersion(index, "web")).toBeNull();
  });

  it("counts releases after a version", () => {
    expect(releasesAfter(index, "1.3.0")).toBe(2);
    expect(releasesAfter(index, "1.4.1")).toBe(0);
  });

  it("finds unfinished releases and missing auto targets", () => {
    expect(unfinishedReleases(index)).toEqual(["1.6.0"]);
    expect(autoTargets({ targets: TARGETS })).toEqual(["docker-api", "android"]);
    expect(missingAutoTargets(index, { targets: TARGETS }, "1.6.0")).toEqual(["android"]);
    expect(missingAutoTargets(index, { targets: TARGETS }, "1.4.1")).toEqual([]);
  });

  it("works with custom templates", () => {
    const custom = indexTags(["1.0.0", "1.1.0-rc.0", "api-1.0.0", "partial-0.9.0"], {
      tags: { release: "{version}", marker: "{target}-{version}", partial: "partial-{version}" },
    });
    expect([...custom.releases.keys()]).toEqual(["1.0.0"]);
    expect([...custom.prereleases.keys()]).toEqual(["1.1.0-rc.0"]);
    expect(custom.markers.get("1.0.0")).toEqual(new Set(["api"]));
    expect([...custom.partials.keys()]).toEqual(["0.9.0"]);
    expect(custom.unknownMarkers).toEqual([]);
  });
});

describe("ambiguous custom templates", () => {
  it("prefers partial tags, then known markers, then releases", () => {
    const index = indexTags(["partial-0.9.0", "1.0.0-api", "1.0.0-alpha.0", "1.0.0-gone"], {
      tags: { release: "{version}", marker: "{version}-{target}", partial: "partial-{version}" },
      targets: { api: {} },
    });
    expect([...index.partials.keys()]).toEqual(["0.9.0"]);
    expect(index.markers.get("1.0.0")).toEqual(new Set(["api"]));
    expect([...index.prereleases.keys()]).toEqual(["1.0.0-alpha.0", "1.0.0-gone"]);
  });

  it("markers of unknown targets still count when nothing else fits", () => {
    const index = indexTags(["launchset/gone@1.0.0"], { tags: TAGS, targets: TARGETS });
    expect(index.unknownMarkers.map((m) => m.target)).toEqual(["gone"]);
    expect([...takenVersions(index)]).toEqual(["1.0.0"]);
  });
});

describe("marker templates with dashed target names", () => {
  const tags = {
    release: "v{version}",
    marker: "{version}-{target}",
    partial: "partial/{version}",
  };

  it("tries configured target names literally first", () => {
    expect(parseTag("1.4.0-docker-api", tags.marker)).toEqual({
      version: "1.4.0-docker",
      target: "api",
    });
    expect(parseTag("1.4.0-docker-api", tags.marker, ["api", "docker-api", "docker"])).toEqual({
      version: "1.4.0",
      target: "docker-api",
    });
    expect(parseTag("1.4.0-docker", tags.marker, ["docker-api", "docker"])).toEqual({
      version: "1.4.0",
      target: "docker",
    });
  });

  it("falls back to the generic pattern for unknown targets", () => {
    expect(parseTag("1.4.0-web", tags.marker, ["docker-api"])).toEqual({
      version: "1.4.0",
      target: "web",
    });
  });

  it("indexTags uses the configured names", () => {
    const index = indexTags(["1.4.0-docker-api", "1.4.0-android", "v1.4.0"], {
      tags,
      targets: { "docker-api": {}, android: {} },
    });
    expect(index.markers.get("1.4.0")).toEqual(new Set(["docker-api", "android"]));
    expect(index.markers.has("1.4.0-docker")).toBe(false);
    expect(index.unknownMarkers).toEqual([]);
  });
});
