/**
 * Every stamper on a Windows checkout (`core.autocrlf=true`): stamping the CRLF copy of a fixture
 * gives the CRLF copy of stamping the LF fixture, and reads the same values on the same lines.
 * So a file is never converted to LF and never needs a different config on Windows.
 */
import { describe, expect, it } from "vitest";
import { expoAndroid, expoIos } from "../../src/platforms/expo.ts";
import { gradle } from "../../src/platforms/gradle.ts";
import { gradleProperties } from "../../src/platforms/gradle-properties.ts";
import { imageRefs } from "../../src/platforms/image.ts";
import { jsonValue } from "../../src/platforms/json.ts";
import { npmLockfile } from "../../src/platforms/npm-lockfile.ts";
import { pbxproj } from "../../src/platforms/pbxproj.ts";
import { plist } from "../../src/platforms/plist.ts";
import { regexFile } from "../../src/platforms/regex.ts";
import type { StampValues, TextStamper } from "../../src/platforms/types.ts";
import { xcconfig } from "../../src/platforms/xcconfig.ts";
import { yamlValue } from "../../src/platforms/yaml.ts";
import { fixture } from "./stamper-test-utils.ts";

interface Case {
  name: string;
  // biome-ignore lint/suspicious/noExplicitAny: cases hold stampers with different option types
  stamper: TextStamper<any>;
  fixture: string;
  options?: unknown;
  values: StampValues;
}

const ios = { marketing: "1.5.0", build: 345 };
const cases: Case[] = [
  {
    name: "json",
    stamper: jsonValue,
    fixture: "generic/package-2space.json",
    options: { key: "version" },
    values: { marketing: "1.5.0" },
  },
  {
    name: "npm lockfile",
    stamper: npmLockfile,
    fixture: "npm/package-lock.json",
    values: { marketing: "1.5.0" },
  },
  {
    name: "yaml",
    stamper: yamlValue,
    fixture: "generic/Chart.yaml",
    options: { key: "appVersion" },
    values: { marketing: "1.5.0" },
  },
  {
    name: "yaml (multi-document)",
    stamper: yamlValue,
    fixture: "generic/multi-doc.yaml",
    options: { key: "data.version" },
    values: { marketing: "1.5.0" },
  },
  {
    name: "image",
    stamper: imageRefs,
    fixture: "generic/docker-compose.yml",
    options: { images: ["ghcr.io/org/app", "ghcr.io/org/api"] },
    values: { marketing: "v1.5.0" },
  },
  {
    name: "regex",
    stamper: regexFile,
    fixture: "generic/version.txt",
    options: { pattern: "^APP_VERSION=.*$", flags: "m", replace: "APP_VERSION={version}" },
    values: { marketing: "1.5.0" },
  },
  {
    name: "regex (spans a line break)",
    stamper: regexFile,
    fixture: "generic/Cargo.lock",
    options: { pattern: '(name = "attica-core"\\nversion = ")[^"]*"', replace: '$1{version}"' },
    values: { marketing: "1.5.0" },
  },
  {
    name: "gradle (Groovy)",
    stamper: gradle,
    fixture: "android/capacitor-build.gradle",
    values: { marketing: "1.5.0", build: 99 },
  },
  {
    name: "gradle (Kotlin)",
    stamper: gradle,
    fixture: "android/app-build.gradle.kts",
    values: { marketing: "1.5.0", build: 99 },
  },
  {
    name: "gradle (React Native)",
    stamper: gradle,
    fixture: "android/react-native-build.gradle",
    values: { marketing: "1.5.0", build: 99 },
  },
  {
    name: "gradle-properties",
    stamper: gradleProperties,
    fixture: "android/gradle.properties",
    options: { versionNameKey: "VERSION_NAME", versionCodeKey: "VERSION_CODE" },
    values: { marketing: "1.5.0", build: 99 },
  },
  { name: "plist", stamper: plist, fixture: "ios/plist/Info-literal.plist", values: ios },
  {
    name: "pbxproj",
    stamper: pbxproj,
    fixture: "ios/multi-target.xcodeproj/project.pbxproj",
    options: {},
    values: ios,
  },
  {
    name: "pbxproj (React Native)",
    stamper: pbxproj,
    fixture: "react-native/ios/MyApp.xcodeproj/project.pbxproj",
    options: {},
    values: ios,
  },
  {
    name: "xcconfig",
    stamper: xcconfig,
    fixture: "ios/xcconfig/Version-plain.xcconfig",
    values: ios,
  },
  {
    name: "expo android",
    stamper: expoAndroid,
    fixture: "expo/app.json",
    values: { marketing: "1.5.0", build: 99 },
  },
  { name: "expo ios", stamper: expoIos, fixture: "expo/app.json", values: ios },
  // Insertions: the new property's line break must be CRLF too.
  {
    name: "expo android (inserts versionCode)",
    stamper: expoAndroid,
    fixture: "expo/app.no-build.json",
    values: { marketing: "1.5.0", build: 99 },
  },
  {
    name: "expo ios (inserts the ios object)",
    stamper: expoIos,
    fixture: "expo/app.no-platform.json",
    values: ios,
  },
];

const toCrlf = (text: string) => text.replaceAll("\n", "\r\n");

describe.each(cases)("$name on a CRLF checkout", ({ stamper, fixture: path, options, values }) => {
  const lf = fixture(path);
  const crlf = toCrlf(lf);
  const file = path.split("/").at(-1) as string;

  it("the fixture is LF", () => {
    expect(lf).not.toContain("\r");
  });

  it("writes the same change, with CRLF line endings", () => {
    const fromLf = stamper.write(lf, file, values, options);
    expect(fromLf).not.toBe(lf);
    const fromCrlf = stamper.write(crlf, file, values, options);
    expect(fromCrlf).toBe(toCrlf(fromLf));
    expect(fromCrlf).not.toMatch(/[^\r]\n/);
  });

  it("reads the same values on the same lines", () => {
    const strip = (found: { value: string }[]) =>
      found.map((f) => ({ ...f, value: f.value.replaceAll("\r\n", "\n") }));
    expect(strip(stamper.read(crlf, file, options))).toEqual(stamper.read(lf, file, options));
  });
});
