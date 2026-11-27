import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkReferencedFiles } from "../../src/config/load.ts";
import { type LaunchsetConfig, resolveConfig } from "../../src/core/config/schema.ts";
import type { TargetPlan } from "../../src/core/types.ts";
import {
  checkConsistency,
  readRootVersion,
  stampForBuild,
  stampForRelease,
  writeChanges,
} from "../../src/platforms/index.ts";

const APP = join(import.meta.dirname, "../fixtures/flutter/app");

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "launchset-flutter-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const read = (path: string) => readFile(join(root, path), "utf8");
const versionLine = async (path: string) =>
  (await read(path)).split("\n").find((l) => l.startsWith("version:"));

function plan(name: string, type: "android" | "ios" | "web", version: string, build: number) {
  const target: TargetPlan = {
    name,
    type,
    release: "auto",
    marketingVersion: type === "ios" ? (version.split("-")[0] as string) : version,
    buildNumber: build,
  };
  return target;
}

describe("a Flutter-only repo (version.file: pubspec.yaml)", () => {
  const input: LaunchsetConfig = {
    version: { file: "pubspec.yaml" },
    targets: {
      android: { type: "android", source: { kind: "flutter" } },
      ios: { type: "ios", source: { kind: "flutter" } },
      web: { type: "web" },
    },
  };

  beforeEach(async () => {
    await cp(APP, root, { recursive: true });
  });

  it("reads the root version without +N", async () => {
    expect(await readRootVersion(resolveConfig(input), root)).toBe("1.4.0");
  });

  it("an empty version gets a hint in pubspec syntax", async () => {
    await writeFile(join(root, "pubspec.yaml"), 'name: app\nversion: ""\n');
    await expect(readRootVersion(resolveConfig(input), root)).rejects.toMatchObject({
      hint: "Add a top-level version, e.g. `version: 0.1.0+1`.",
    });
  });

  it("the release PR writes the build name once and keeps +N", async () => {
    const changes = await stampForRelease(resolveConfig(input), root, "1.5.0");
    expect(changes.map((c) => c.path)).toEqual(["pubspec.yaml"]);
    await writeChanges(changes);
    expect(await versionLine("pubspec.yaml")).toBe("version: 1.5.0+12");
    expect(await checkConsistency(resolveConfig(input), root)).toEqual([]);
  });

  it("CI: android gets the full preview version, ios the plain one, both the build number", async () => {
    const config = resolveConfig(input);
    const version = "1.5.0-pr.12.3";
    await writeChanges(
      await stampForBuild(config, root, { version }, plan("android", "android", version, 217)),
    );
    expect(await versionLine("pubspec.yaml")).toBe("version: 1.5.0-pr.12.3+217");

    await cp(join(APP, "pubspec.yaml"), join(root, "pubspec.yaml"));
    await writeChanges(
      await stampForBuild(config, root, { version }, plan("ios", "ios", version, 218)),
    );
    expect(await versionLine("pubspec.yaml")).toBe("version: 1.5.0+218");
  });

  it("CI: a web target gets the run's version and build number through the version file", async () => {
    const version = "1.5.0-pr.12.3";
    await writeChanges(
      await stampForBuild(
        resolveConfig(input),
        root,
        { version },
        plan("web", "web", version, 219),
      ),
    );
    expect(await versionLine("pubspec.yaml")).toBe("version: 1.5.0-pr.12.3+219");
  });

  it("CI: an extra files entry in pubspec.yaml doesn't stop the version file stamp", async () => {
    await writeFile(
      join(root, "pubspec.yaml"),
      "name: app\nversion: 1.0.0+1\napp_version: 1.0.0\n",
    );
    const config = resolveConfig({
      ...input,
      targets: {
        web: {
          type: "web",
          files: [{ path: "pubspec.yaml", kind: "yaml", key: "app_version" }],
        },
      },
    });
    const version = "1.5.0-pr.12.3";
    await writeChanges(
      await stampForBuild(config, root, { version }, plan("web", "web", version, 220)),
    );
    expect(await read("pubspec.yaml")).toBe(
      "name: app\nversion: 1.5.0-pr.12.3+220\napp_version: 1.5.0-pr.12.3\n",
    );
  });

  it("the native projects are never touched", async () => {
    const before = await read("android/app/build.gradle.kts");
    const config = resolveConfig(input);
    await writeChanges(await stampForRelease(config, root, "1.5.0"));
    await writeChanges(
      await stampForBuild(
        config,
        root,
        { version: "1.5.0" },
        plan("android", "android", "1.5.0", 5),
      ),
    );
    expect(await read("android/app/build.gradle.kts")).toBe(before);
    expect(await read("ios/Runner/Info.plist")).toContain("$(FLUTTER_BUILD_NUMBER)");
  });
});

describe("a Flutter app next to an API and a web app (version.file: package.json)", () => {
  const input: LaunchsetConfig = {
    targets: {
      api: { type: "docker", image: "ghcr.io/acme/api" },
      web: { type: "web" },
      "mobile-android": { type: "android", source: { kind: "flutter", dir: "apps/mobile" } },
      "mobile-ios": {
        type: "ios",
        source: { kind: "flutter", dir: "apps/mobile" },
        release: "manual",
      },
    },
  };

  beforeEach(async () => {
    await cp(APP, join(root, "apps/mobile"), { recursive: true });
    await writeFile(join(root, "package.json"), '{\n  "name": "acme",\n  "version": "1.4.0"\n}\n');
  });

  it("the release PR stamps package.json and the app's pubspec", async () => {
    const config = resolveConfig(input);
    const changes = await stampForRelease(config, root, "1.5.0");
    expect(changes.map((c) => c.path).sort()).toEqual(["apps/mobile/pubspec.yaml", "package.json"]);
    await writeChanges(changes);
    expect(await versionLine("apps/mobile/pubspec.yaml")).toBe("version: 1.5.0+12");
    expect(await checkConsistency(config, root)).toEqual([]);
  });

  it("the version check reports a pubspec edited by hand", async () => {
    await writeFile(join(root, "package.json"), '{\n  "name": "acme",\n  "version": "1.5.0"\n}\n');
    const mismatches = await checkConsistency(resolveConfig(input), root);
    expect(mismatches.map((m) => [m.target, m.path, m.expected, m.found[0]?.value])).toEqual([
      ["mobile-android", "apps/mobile/pubspec.yaml", "1.5.0", "1.4.0"],
      ["mobile-ios", "apps/mobile/pubspec.yaml", "1.5.0", "1.4.0"],
    ]);
  });

  it("CI: the build number goes into the app's pubspec, never into package.json", async () => {
    await writeChanges(
      await stampForBuild(
        resolveConfig(input),
        root,
        { version: "1.5.0" },
        plan("mobile-android", "android", "1.5.0", 217),
      ),
    );
    expect(await versionLine("apps/mobile/pubspec.yaml")).toBe("version: 1.5.0+217");
    expect(await read("package.json")).toContain('"version": "1.5.0"');
  });

  it("rejects an Android build number above the Play limit", async () => {
    await expect(
      stampForBuild(
        resolveConfig(input),
        root,
        { version: "1.5.0" },
        plan("mobile-android", "android", "1.5.0", 2_100_000_001),
      ),
    ).rejects.toThrow(/2,?100,?000,?000/);
  });

  it("a missing pubspec.yaml is a config error on source.dir", async () => {
    const config = resolveConfig({
      targets: { android: { type: "android", source: { kind: "flutter", dir: "apps/other" } } },
    });
    expect(await checkReferencedFiles(config, root)).toEqual([
      { path: "targets.android.source.dir", message: "file not found: apps/other/pubspec.yaml" },
    ]);
  });
});
