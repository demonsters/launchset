import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/core/config/schema.ts";
import type { TargetPlan } from "../../src/core/types.ts";
import {
  checkConsistency,
  stampForBuild,
  stampForRelease,
  writeChanges,
} from "../../src/platforms/index.ts";

const FIXTURES = join(import.meta.dirname, "../fixtures");

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "launchset-stamp-"));
  await cp(join(FIXTURES, "capacitor/apps"), join(root, "apps"), { recursive: true });
  await cp(join(FIXTURES, "generic/deployment.yaml"), join(root, "deploy/app.yaml"));
  await writeFile(join(root, "package.json"), '{\n  "name": "app",\n  "version": "1.4.0"\n}\n');
  await writeFile(
    join(root, "package-lock.json"),
    '{\n  "name": "app",\n  "version": "1.4.0",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n      "name": "app",\n      "version": "1.4.0"\n    }\n  }\n}\n',
  );
  await writeFile(join(root, "version.txt"), "build=0 version=1.4.0\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function config() {
  return resolveConfig({
    targets: {
      api: {
        type: "docker",
        image: "ghcr.io/org/app",
        tags: ["v{version}", "latest"],
        files: [{ path: "deploy/*.yaml", kind: "image" }],
      },
      android: { type: "android", source: { kind: "capacitor", dir: "apps/mobile" } },
      ios: {
        type: "ios",
        source: { kind: "capacitor", dir: "apps/mobile" },
        release: "manual",
      },
      web: {
        type: "web",
        files: [
          {
            path: "version.txt",
            kind: "regex",
            pattern: "build=\\d+ version=\\S+",
            replace: "build={buildNumber} version={version}",
          },
        ],
      },
    },
  });
}

async function read(path: string) {
  return readFile(join(root, path), "utf8");
}

describe("stampForRelease", () => {
  it("writes marketing versions for every target (manual included) and never build numbers", async () => {
    const changes = await stampForRelease(config(), root, "1.5.0");
    expect(changes.map((c) => c.path).sort()).toEqual([
      "apps/mobile/android/app/build.gradle",
      "apps/mobile/ios/App/App.xcodeproj/project.pbxproj",
      "deploy/app.yaml",
      "package-lock.json",
      "package.json",
    ]);
    await writeChanges(changes);
    expect(await read("package.json")).toBe('{\n  "name": "app",\n  "version": "1.5.0"\n}\n');
    expect(await read("package-lock.json")).toContain('"version": "1.5.0",\n  "lockfileVersion"');
    const gradle = await read("apps/mobile/android/app/build.gradle");
    expect(gradle).toContain('versionName "1.5.0"');
    expect(gradle).toContain("versionCode 7");
    const pbx = await read("apps/mobile/ios/App/App.xcodeproj/project.pbxproj");
    expect(pbx).toContain("MARKETING_VERSION = 1.5.0;");
    expect(pbx).toContain("CURRENT_PROJECT_VERSION = 1;");
    expect(await read("deploy/app.yaml")).toContain("image: ghcr.io/org/app:v1.5.0");
    // CI-only regex entry ({buildNumber}) is untouched by the release PR.
    expect(await read("version.txt")).toBe("build=0 version=1.4.0\n");
  });
});

describe("stampForBuild", () => {
  it("writes the plan's version and build number for one target", async () => {
    const target: TargetPlan = {
      name: "android",
      type: "android",
      release: "auto",
      marketingVersion: "1.5.0-pr.12.3",
      buildNumber: 217000123,
    };
    const changes = await stampForBuild(config(), root, { version: "1.5.0-pr.12.3" }, target);
    await writeChanges(changes);
    const gradle = await read("apps/mobile/android/app/build.gradle");
    expect(gradle).toContain('versionName "1.5.0-pr.12.3"');
    expect(gradle).toContain("versionCode 217000123");
    expect(await read("package.json")).toContain('"version": "1.5.0-pr.12.3"');
    // The npm lockfile follows the version file in CI too (spec 6.6).
    const lock = await read("package-lock.json");
    expect(lock.match(/"version": "1\.5\.0-pr\.12\.3"/g)).toHaveLength(2);
    // Other targets' files are untouched.
    expect(await read("apps/mobile/ios/App/App.xcodeproj/project.pbxproj")).toContain(
      "MARKETING_VERSION = 1.0;",
    );
  });

  it("stamps CI-only regex entries with the build number", async () => {
    const target: TargetPlan = {
      name: "web",
      type: "web",
      release: "auto",
      marketingVersion: "1.5.0",
      buildNumber: 42,
    };
    await writeChanges(await stampForBuild(config(), root, { version: "1.5.0" }, target));
    expect(await read("version.txt")).toBe("build=42 version=1.5.0\n");
  });

  it("rejects an Android build number above the Play limit", async () => {
    const target: TargetPlan = {
      name: "android",
      type: "android",
      release: "auto",
      marketingVersion: "1.5.0",
      buildNumber: 2_100_000_001,
    };
    await expect(stampForBuild(config(), root, { version: "1.5.0" }, target)).rejects.toThrow(
      /2,?100,?000,?000/,
    );
  });
});

describe("checkConsistency", () => {
  it("reports files whose marketing version differs from the root version", async () => {
    const mismatches = await checkConsistency(config(), root);
    // The manifest pins :1.4.0 but releases use v{version}; the Capacitor pbxproj still has
    // 1.0. The gradle file and the lockfile match.
    expect(mismatches.map((m) => [m.target, m.path, m.expected])).toEqual([
      ["api", "deploy/app.yaml", "v1.4.0"],
      ["ios", "apps/mobile/ios/App/App.xcodeproj/project.pbxproj", "1.4.0"],
    ]);
    expect(mismatches[1]?.found.map((f) => f.value)).toEqual(["1.0", "1.0"]);
  });

  it("is clean after a release stamp", async () => {
    await writeChanges(await stampForRelease(config(), root, "1.5.0"));
    expect(await checkConsistency(config(), root)).toEqual([]);
  });
});
