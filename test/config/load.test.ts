import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkReferencedFiles,
  expandFilePattern,
  findConfigFile,
  loadConfig,
  resolveSourcePaths,
} from "../../src/config/load.ts";
import {
  ConfigError,
  type ResolvedConfig,
  type ResolvedTarget,
  resolveConfig,
} from "../../src/core/config/schema.ts";
import { LaunchsetError } from "../../src/core/errors.ts";

const FIXTURES = resolve(import.meta.dirname, "../fixtures/config");
const fixture = (name: string) => join(FIXTURES, name);

function target(config: ResolvedConfig, name: string): ResolvedTarget {
  const found = config.targets[name];
  if (!found) throw new Error(`no target ${name}`);
  return found;
}

async function failure(promise: Promise<unknown>): Promise<LaunchsetError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LaunchsetError);
    return error as LaunchsetError;
  }
  throw new Error("expected a failure");
}

describe("loadConfig", () => {
  it("loads a TypeScript config that imports defineConfig and a local module", async () => {
    const { config, file, root } = await loadConfig(fixture("ts"));
    expect(file).toBe(join(fixture("ts"), "launchset.config.ts"));
    expect(root).toBe(fixture("ts"));
    expect(Object.keys(config.targets)).toEqual(["docker-api", "android", "ios", "sdk"]);
    expect(config.targets["docker-api"]).toMatchObject({
      image: ["ghcr.io/demonsters/api"],
      tags: { release: ["v{version}", "latest"] },
    });
    expect(config.targets.ios?.release).toBe("manual");
  });

  it("loads a TypeScript config that imports defineConfig from the old @demonsters/launchset", async () => {
    const { config } = await loadConfig(fixture("ts-old-name"));
    expect(Object.keys(config.targets)).toEqual(["web"]);
  });

  it("loads an .mjs config", async () => {
    const { config, file } = await loadConfig(fixture("mjs"));
    expect(file.endsWith("launchset.config.mjs")).toBe(true);
    expect(config.baseBranch).toBe("develop");
  });

  it("loads a CommonJS .js config", async () => {
    const { config } = await loadConfig(fixture("cjs"));
    expect(Object.keys(config.targets)).toEqual(["web"]);
  });

  it("loads a JSON config with $schema", async () => {
    const { config } = await loadConfig(fixture("json"));
    expect(config.version.file).toBe("version.json");
    expect(config.targets.ios).toMatchObject({
      source: { kind: "plist", files: ["ios/App/Info.plist", "ios/Widget/Info.plist"] },
    });
  });

  it("accepts a relative cwd", async () => {
    const relativeDir = join("test/fixtures/config", "mjs");
    expect((await loadConfig(relativeDir)).root).toBe(resolve(relativeDir));
  });

  it("names every missing file by field", async () => {
    const error = (await failure(loadConfig(fixture("missing")))) as ConfigError;
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.issues).toEqual([
      { path: "version.file", message: "file not found: nope/package.json" },
      { path: "targets.api.files.0.path", message: "no file matches deploy/k8s/*.yaml" },
      { path: "targets.api.files.1.path", message: "file not found: deploy/compose.yaml" },
      { path: "targets.api.files.2.path", message: "file not found: chart/Chart.yaml" },
      {
        path: "targets.android.source.dir",
        message: "file not found: apps/mobile/android/app/build.gradle (or build.gradle.kts)",
      },
      { path: "targets.gradle.source.file", message: "file not found: android/app/build.gradle" },
      {
        path: "targets.ios.source.dir",
        message: "file not found: apps/mobile/ios/App/App.xcodeproj/project.pbxproj",
      },
      {
        path: "targets.ios-proj.source.file",
        message: "file not found: ios/Fake.xcodeproj/project.pbxproj",
      },
      {
        path: "targets.ios-file.source.file",
        message: "expected the .xcodeproj directory, got a file: README.txt",
      },
      { path: "targets.plist.source.files.1", message: "file not found: ios/Info.plist" },
      { path: "targets.expo.source.file", message: "file not found: app.json" },
      { path: "targets.npm.npm.package", message: "file not found: package.json" },
    ]);
    expect(error.message).toContain(
      "Invalid launchset config in launchset.config.json:\n  - version.file: file not found: nope/package.json",
    );
  });

  it("errors when there is no config, suggesting init", async () => {
    const error = await failure(loadConfig(fixture("none")));
    expect(error.code).toBe("no-config");
    expect(error.message).toBe(`no launchset config found in ${fixture("none")}`);
    expect(error.hint).toContain("launchset init");
  });

  it("errors when the directory doesn't exist", async () => {
    expect((await failure(loadConfig(fixture("does-not-exist")))).code).toBe("no-config");
  });

  it("errors on more than one config", async () => {
    const error = await failure(findConfigFile(fixture("multiple")));
    expect(error.code).toBe("multiple-configs");
    expect(error.message).toContain("launchset.config.mjs, launchset.config.json");
  });

  it("reports syntax errors in TS and JSON configs with the file name", async () => {
    const ts = await failure(loadConfig(fixture("broken-ts")));
    expect(ts.message).toMatch(/^launchset\.config\.ts: failed to load: /);
    expect(ts.cause).toBeDefined();
    const json = await failure(loadConfig(fixture("broken-json")));
    expect(json.message).toMatch(/^launchset\.config\.json: invalid JSON \(/);
  });

  it("errors without a default export", async () => {
    const error = await failure(loadConfig(fixture("no-default")));
    expect(error.message).toBe("launchset.config.mts: no default export");
    expect(error.hint).toContain("export default defineConfig");
  });

  it("validates the loaded config, naming the file", async () => {
    const error = (await failure(loadConfig(fixture("invalid")))) as ConfigError;
    expect(error.issues).toEqual([
      {
        path: "targets.web.relase",
        message: "unknown key (check the spelling; see the configuration reference)",
      },
    ]);
    expect(error.message).toContain("in launchset.config.js");
  });
});

describe("resolveSourcePaths", () => {
  it("resolves capacitor aliases", async () => {
    const { config } = await loadConfig(fixture("ts"));
    const root = fixture("ts");
    const android = await resolveSourcePaths(target(config, "android"), root);
    expect(android).toEqual([
      {
        field: "targets.android.source.dir",
        format: "gradle",
        path: "apps/mobile/android/app/build.gradle",
        absolute: join(root, "apps/mobile/android/app/build.gradle"),
      },
    ]);
    const ios = await resolveSourcePaths(target(config, "ios"), root);
    expect(ios.map((f) => [f.format, f.path])).toEqual([
      ["pbxproj", "apps/mobile/ios/App/App.xcodeproj/project.pbxproj"],
    ]);
    expect(await resolveSourcePaths(target(config, "docker-api"), root)).toEqual([]);
  });

  it("picks build.gradle.kts for capacitor when that's the one that exists", async () => {
    const { config } = await loadConfig(fixture("capacitor-kts"));
    const files = await resolveSourcePaths(target(config, "android"), fixture("capacitor-kts"));
    expect(files.map((f) => f.path)).toEqual(["app/android/app/build.gradle.kts"]);
  });

  it("errors when both build.gradle and build.gradle.kts exist", async () => {
    const error = (await failure(loadConfig(fixture("capacitor-both")))) as ConfigError;
    expect(error.issues).toEqual([
      {
        path: "targets.android.source.dir",
        message:
          'both app/android/app/build.gradle and build.gradle.kts exist: use source { kind: "gradle", file } to pick one',
      },
    ]);
  });

  it("returns plist, xcconfig and expo files", async () => {
    const { config, root } = await loadConfig(fixture("json"));
    expect(
      (await resolveSourcePaths(target(config, "ios"), root)).map((f) => [
        f.field,
        f.format,
        f.path,
      ]),
    ).toEqual([
      ["targets.ios.source.files.0", "plist", "ios/App/Info.plist"],
      ["targets.ios.source.files.1", "plist", "ios/Widget/Info.plist"],
    ]);
    expect((await resolveSourcePaths(target(config, "ios-xc"), root)).map((f) => f.format)).toEqual(
      ["xcconfig"],
    );
    expect(
      (await resolveSourcePaths(target(config, "expo"), root)).map((f) => [f.format, f.path]),
    ).toEqual([["expo", "app.json"]]);
  });

  it("throws ConfigError for a missing source", async () => {
    const config = resolveConfig({
      targets: {
        a: { type: "android", source: { kind: "gradle-properties", file: "gradle.properties" } },
      },
    });
    const error = (await failure(
      resolveSourcePaths(target(config, "a"), fixture("none")),
    )) as ConfigError;
    expect(error.issues).toEqual([
      { path: "targets.a.source.file", message: "file not found: gradle.properties" },
    ]);
  });
});

describe("files helpers", () => {
  it("expands image globs and plain paths", async () => {
    const root = fixture("ts");
    expect(await expandFilePattern("deploy/k8s/*.yaml", root)).toEqual([
      "deploy/k8s/api.yaml",
      "deploy/k8s/other.yaml",
    ]);
    expect(await expandFilePattern("deploy/k8s/api.yaml", root)).toEqual(["deploy/k8s/api.yaml"]);
    expect(await expandFilePattern("deploy/*.json", root)).toEqual([]);
  });

  it("checkReferencedFiles is empty for a valid repo", async () => {
    const { config, root } = await loadConfig(fixture("ts"));
    expect(await checkReferencedFiles(config, root)).toEqual([]);
  });
});
