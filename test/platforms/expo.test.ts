import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expoAndroid, expoIos } from "../../src/platforms/expo.ts";
import { StampError } from "../../src/platforms/types.ts";

const fixture = (path: string): string =>
  readFileSync(join(import.meta.dirname, "../fixtures", path), "utf8");

const FILE = "app.json";

function stampError(fn: () => unknown): StampError {
  try {
    fn();
  } catch (e) {
    if (e instanceof StampError) return e;
    throw e;
  }
  throw new Error("expected a StampError, nothing was thrown");
}

describe("expoAndroid", () => {
  const text = fixture("expo/app.json");

  it("reads expo.version and expo.android.versionCode with their lines", () => {
    expect(expoAndroid.read(text, FILE, undefined)).toEqual([
      { field: "marketing", key: "expo.version", value: "1.4.0", line: 5 },
      { field: "build", key: "expo.android.versionCode", value: "12", line: 25 },
    ]);
    expect(text.split("\n")[24]).toBe('      "versionCode": 12');
  });

  it("replaces version (string) and versionCode (bare integer), nothing else", () => {
    const out = expoAndroid.write(
      text,
      FILE,
      { marketing: "1.5.0-pr.12.3", build: 345 },
      undefined,
    );
    expect(out).toBe(
      text
        .replace('"version": "1.4.0"', '"version": "1.5.0-pr.12.3"')
        .replace('"versionCode": 12', '"versionCode": 345'),
    );
    expect(out).toContain('"buildNumber": "12"');
  });

  it("writes only the given field, and returns the input for no values", () => {
    expect(expoAndroid.write(text, FILE, { marketing: "1.5.0" }, undefined)).toBe(
      text.replace('"version": "1.4.0"', '"version": "1.5.0"'),
    );
    expect(expoAndroid.write(text, FILE, { build: 13 }, undefined)).toBe(
      text.replace('"versionCode": 12', '"versionCode": 13'),
    );
    expect(expoAndroid.write(text, FILE, {}, undefined)).toBe(text);
  });

  it("keeps tab indentation and CRLF line endings", () => {
    const tabs = fixture("expo/app.tabs.json");
    expect(expoAndroid.write(tabs, FILE, { marketing: "1.5.0", build: 9 }, undefined)).toBe(
      tabs.replace('"1.4.0"', '"1.5.0"').replace('"versionCode": 12', '"versionCode": 9'),
    );
    const crlf = fixture("expo/app.crlf.json");
    expect(crlf).toContain("\r\n");
    expect(expoAndroid.write(crlf, FILE, { marketing: "1.5.0", build: 9 }, undefined)).toBe(
      crlf.replace('"1.4.0"', '"1.5.0"').replace('"versionCode": 12', '"versionCode": 9'),
    );
  });

  it("inserts a missing versionCode after the last android key (2 spaces)", () => {
    const noBuild = fixture("expo/app.no-build.json");
    const out = expoAndroid.write(noBuild, FILE, { build: 345 }, undefined);
    expect(out).toBe(
      noBuild.replace(
        '      "package": "com.example.app"\n    }\n  }\n}',
        '      "package": "com.example.app",\n      "versionCode": 345\n    }\n  }\n}',
      ),
    );
    expect(out).not.toBe(noBuild);
  });

  it("inserts the whole android object when it is missing", () => {
    const noPlatform = fixture("expo/app.no-platform.json");
    expect(expoAndroid.write(noPlatform, FILE, { build: 345 }, undefined)).toBe(
      [
        "{",
        '  "expo": {',
        '    "name": "Example",',
        '    "slug": "example",',
        '    "version": "1.4.0",',
        '    "orientation": "portrait",',
        '    "android": {',
        '      "versionCode": 345',
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("inserts with tabs and CRLF when the file uses them", () => {
    const tabs = fixture("expo/app.tabs.json").replace(',\n\t\t\t"versionCode": 12', "");
    expect(tabs).not.toContain("versionCode");
    expect(expoAndroid.write(tabs, FILE, { build: 7 }, undefined)).toBe(
      tabs.replace(
        '"package": "com.example.app"',
        '"package": "com.example.app",\n\t\t\t"versionCode": 7',
      ),
    );
    const crlf = fixture("expo/app.crlf.json").replace(',\r\n      "versionCode": 12', "");
    expect(crlf).not.toContain("versionCode");
    expect(expoAndroid.write(crlf, FILE, { build: 7 }, undefined)).toBe(
      crlf.replace(
        '"package": "com.example.app"',
        '"package": "com.example.app",\r\n      "versionCode": 7',
      ),
    );
  });

  it("replaces the version and inserts the build number in one write", () => {
    const noBuild = fixture("expo/app.no-build.json");
    const out = expoAndroid.write(noBuild, FILE, { marketing: "1.5.0", build: 8 }, undefined);
    expect(out).toBe(
      noBuild
        .replace('"version": "1.4.0"', '"version": "1.5.0"')
        .replace(
          '"package": "com.example.app"\n    }\n  }',
          '"package": "com.example.app",\n      "versionCode": 8\n    }\n  }',
        ),
    );
  });

  it("inserts into a single-line file without reformatting it", () => {
    const min = '{"expo":{"version":"1.0.0","android":{"package":"a.b"}}}';
    expect(expoAndroid.write(min, FILE, { build: 3 }, undefined)).toBe(
      '{"expo":{"version":"1.0.0","android":{"package":"a.b", "versionCode": 3}}}',
    );
  });

  it("rejects a versionCode above the Play limit and a bad build number", () => {
    expect(
      stampError(() => expoAndroid.write(text, FILE, { build: 2_100_000_001 }, undefined)).reason,
    ).toBe("versionCode 2100000001 is above the Play Store limit of 2100000000");
    expect(expoAndroid.write(text, FILE, { build: 2_100_000_000 }, undefined)).toContain(
      '"versionCode": 2100000000',
    );
    expect(stampError(() => expoAndroid.write(text, FILE, { build: 0 }, undefined)).reason).toBe(
      "build number must be a positive integer, got 0",
    );
  });

  it("rejects an android entry that is not an object", () => {
    const bad = '{\n  "expo": {\n    "version": "1.0.0",\n    "android": "nope"\n  }\n}\n';
    expect(stampError(() => expoAndroid.write(bad, FILE, { build: 1 }, undefined)).reason).toBe(
      "expo.android is a string, expected an object, so expo.android.versionCode can't be added",
    );
  });
});

describe("expoIos", () => {
  const text = fixture("expo/app.json");

  it("reads expo.version and expo.ios.buildNumber", () => {
    expect(expoIos.read(text, FILE, undefined)).toEqual([
      { field: "marketing", key: "expo.version", value: "1.4.0", line: 5 },
      { field: "build", key: "expo.ios.buildNumber", value: "12", line: 17 },
    ]);
  });

  it("writes the build number as a string", () => {
    const out = expoIos.write(text, FILE, { marketing: "1.5.0", build: 345 }, undefined);
    expect(out).toBe(
      text
        .replace('"version": "1.4.0"', '"version": "1.5.0"')
        .replace('"buildNumber": "12"', '"buildNumber": "345"'),
    );
    expect(out).toContain('"versionCode": 12');
  });

  it("returns the input for no values", () => {
    expect(expoIos.write(text, FILE, {}, undefined)).toBe(text);
  });

  it("inserts a missing buildNumber as a string", () => {
    const noBuild = fixture("expo/app.no-build.json");
    expect(expoIos.write(noBuild, FILE, { build: 345 }, undefined)).toBe(
      noBuild.replace(
        '"bundleIdentifier": "com.example.app"\n    }',
        '"bundleIdentifier": "com.example.app",\n      "buildNumber": "345"\n    }',
      ),
    );
  });

  it("inserts into a CRLF file with CRLF", () => {
    const crlf = fixture("expo/app.crlf.json");
    expect(expoIos.write(crlf, FILE, { build: 345 }, undefined)).toBe(
      crlf.replace(
        '"bundleIdentifier": "com.example.app"\r\n',
        '"bundleIdentifier": "com.example.app",\r\n      "buildNumber": "345"\r\n',
      ),
    );
  });

  it("inserts the whole ios object when it is missing", () => {
    const noPlatform = fixture("expo/app.no-platform.json");
    expect(expoIos.write(noPlatform, FILE, { build: 5 }, undefined)).toContain(
      '    "orientation": "portrait",\n    "ios": {\n      "buildNumber": "5"\n    }\n  }',
    );
  });

  it("rejects a prerelease marketing version", () => {
    const err = stampError(() =>
      expoIos.write(text, FILE, { marketing: "1.5.0-pr.12.3" }, undefined),
    );
    expect(err.reason).toBe(
      'iOS marketing version must be plain X.Y.Z (Apple rejects prerelease suffixes), got "1.5.0-pr.12.3"',
    );
  });
});

describe("expo insertion is minimal", () => {
  it("does not reflow neighbouring JSON, comments or odd spacing", () => {
    const text = [
      "{",
      '  "expo": {',
      '    "version":    "1.0.0",   // keep this spacing',
      '    "platforms": ["ios",   "android"],',
      '    "android": {',
      '        "package":"com.example.app",',
      '        "permissions": [ "CAMERA" ]   /* trailing comment */',
      "    },",
      '    "extra": { "a":1,"b" : [1,2,3] }',
      "  }",
      "}",
      "",
    ].join("\n");
    const out = expoAndroid.write(text, FILE, { build: 7 }, undefined);
    // Exactly one insertion, right after the last property of `android`.
    expect(out).toBe(
      text.replace(
        '"permissions": [ "CAMERA" ]',
        '"permissions": [ "CAMERA" ],\n        "versionCode": 7',
      ),
    );
  });

  it("fills an empty object in the file's style", () => {
    const empty = '{\n\t"expo": {\n\t\t"version": "1.0.0",\n\t\t"ios": {}\n\t}\n}\n';
    expect(expoIos.write(empty, FILE, { build: 3 }, undefined)).toBe(
      '{\n\t"expo": {\n\t\t"version": "1.0.0",\n\t\t"ios": {\n\t\t\t"buildNumber": "3"\n\t\t}\n\t}\n}\n',
    );
    const emptyExpoBlock = '{\n  "expo": {\n    "version": "1.0.0"\n  }\n}\n';
    expect(expoIos.write(emptyExpoBlock, FILE, { build: 3 }, undefined)).toBe(
      '{\n  "expo": {\n    "version": "1.0.0",\n    "ios": {\n      "buildNumber": "3"\n    }\n  }\n}\n',
    );
  });

  it("keeps a trailing comma after the last property", () => {
    const text =
      '{\n  "expo": {\n    "version": "1.0.0",\n    "ios": {\n      "bundleIdentifier": "x",\n    },\n  },\n}\n';
    expect(expoIos.write(text, FILE, { build: 3 }, undefined)).toBe(
      '{\n  "expo": {\n    "version": "1.0.0",\n    "ios": {\n      "bundleIdentifier": "x",\n      "buildNumber": "3",\n    },\n  },\n}\n',
    );
  });
});

describe("expo BOM", () => {
  const BOM = "\uFEFF";

  it("reads and writes a file that starts with a byte order mark, keeping it", () => {
    const text = BOM + fixture("expo/app.json");
    expect(expoAndroid.read(text, FILE, undefined)).toEqual([
      { field: "marketing", key: "expo.version", value: "1.4.0", line: 5 },
      { field: "build", key: "expo.android.versionCode", value: "12", line: 25 },
    ]);
    const out = expoAndroid.write(text, FILE, { marketing: "1.5.0", build: 345 }, undefined);
    expect(out).toBe(
      text
        .replace('"version": "1.4.0"', '"version": "1.5.0"')
        .replace('"versionCode": 12', '"versionCode": 345'),
    );
    expect(out.startsWith(BOM)).toBe(true);
  });

  it("inserts a missing build number into a file with a BOM", () => {
    const text = BOM + fixture("expo/app.no-build.json");
    expect(expoIos.write(text, FILE, { build: 5 }, undefined)).toBe(
      text.replace(
        '"bundleIdentifier": "com.example.app"\n    }',
        '"bundleIdentifier": "com.example.app",\n      "buildNumber": "5"\n    }',
      ),
    );
    // The first line of a BOM file isn't indented by the BOM.
    const flat = `${BOM}{"expo":{"version":"1.0.0"}}`;
    expect(expoIos.write(flat, FILE, { build: 5 }, undefined)).toBe(
      `${BOM}{"expo":{"version":"1.0.0", "ios": { "buildNumber": "5" }}}`,
    );
  });
});

describe("expo errors", () => {
  it("fails without an expo object", () => {
    const plain = '{\n  "name": "x",\n  "version": "1.0.0"\n}\n';
    for (const stamper of [expoAndroid, expoIos]) {
      expect(stampError(() => stamper.read(plain, FILE, undefined)).reason).toContain(
        'no top-level "expo" object',
      );
      expect(
        stampError(() => stamper.write(plain, FILE, { build: 1 }, undefined)).reason,
      ).toContain('no top-level "expo" object');
    }
  });

  it("fails when expo.version is missing and a marketing version is given", () => {
    const noVersion = '{\n  "expo": {\n    "name": "x"\n  }\n}\n';
    for (const stamper of [expoAndroid, expoIos]) {
      expect(
        stampError(() => stamper.write(noVersion, FILE, { marketing: "1.0.0" }, undefined)).reason,
      ).toBe("expo.version is missing; add it, it is the marketing version");
      expect(() => stamper.read(noVersion, FILE, undefined)).toThrow(StampError);
    }
    // A build number alone doesn't need it.
    expect(() => expoIos.write(noVersion, FILE, { build: 1 }, undefined)).not.toThrow();
  });

  it("rejects duplicate keys on the stamped paths", () => {
    const dupVersion = '{"expo":{"version":"1.0.0","version":"1.1.0"}}';
    const dupAndroid =
      '{"expo":{"version":"1.0.0","android":{"versionCode":1},"android":{"versionCode":2}}}';
    const dupLeaf = '{"expo":{"version":"1.0.0","android":{"versionCode":1,"versionCode":2}}}';
    const dupExpo = '{"expo":{"version":"1.0.0"},"expo":{"version":"2.0.0"}}';
    const dupIos = '{"expo":{"version":"1.0.0","ios":{},"ios":{}}}';
    expect(
      stampError(() => expoAndroid.write(dupVersion, FILE, { marketing: "2.0.0" }, undefined))
        .reason,
    ).toBe('key "version" appears 2 times in the same object; can\'t tell which one to stamp');
    expect(() => expoAndroid.read(dupVersion, FILE, undefined)).toThrow(
      /key "version" appears 2 times/,
    );
    expect(() => expoAndroid.write(dupAndroid, FILE, { build: 3 }, undefined)).toThrow(
      /key "android" appears 2 times/,
    );
    expect(() => expoAndroid.read(dupAndroid, FILE, undefined)).toThrow(
      /key "android" appears 2 times/,
    );
    expect(() => expoAndroid.write(dupLeaf, FILE, { build: 3 }, undefined)).toThrow(
      /key "versionCode" appears 2 times/,
    );
    expect(() => expoAndroid.write(dupExpo, FILE, { marketing: "1.0.1" }, undefined)).toThrow(
      /key "expo" appears 2 times/,
    );
    // Missing build key + duplicated parent: also refuses instead of inserting into one of them.
    expect(() => expoIos.write(dupIos, FILE, { build: 3 }, undefined)).toThrow(
      /key "ios" appears 2 times/,
    );
    // A duplicated android object doesn't matter to iOS.
    expect(() => expoIos.write(dupAndroid, FILE, { marketing: "1.0.1" }, undefined)).not.toThrow();
  });

  it("fails on invalid JSON and on values of the wrong shape", () => {
    expect(stampError(() => expoIos.read('{\n  "expo": {\n', FILE, undefined)).reason).toMatch(
      /^invalid JSON \(line \d+\)$/,
    );
    const objectVersion = '{ "expo": { "version": { "a": 1 } } }';
    expect(stampError(() => expoAndroid.read(objectVersion, FILE, undefined)).reason).toBe(
      "expo.version is a object, expected a string or number",
    );
    const numberVersion = '{ "expo": { "version": 1 } }';
    expect(stampError(() => expoAndroid.read(numberVersion, FILE, undefined)).reason).toBe(
      "expo.version must be a string, got number",
    );
  });
});
