import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { plist } from "../../src/platforms/plist.ts";
import { StampError } from "../../src/platforms/types.ts";

const fixture = (path: string): string =>
  readFileSync(join(import.meta.dirname, "../fixtures", path), "utf8");

const FILE = "ios/App/Info.plist";
const LITERAL = "ios/plist/Info-literal.plist";
const REFERENCE = "ios/plist/Info-reference.plist";

function stampError(fn: () => unknown): StampError {
  try {
    fn();
  } catch (e) {
    if (e instanceof StampError) return e;
    throw e;
  }
  throw new Error("expected a StampError, nothing was thrown");
}

function changedLines(before: string, after: string): { before: string; after: string }[] {
  const a = before.split("\n");
  const b = after.split("\n");
  expect(b.length).toBe(a.length);
  return a.flatMap((line, i) => (line === b[i] ? [] : [{ before: line, after: b[i] as string }]));
}

describe("plist read", () => {
  it("finds the literal values on the right lines, ignoring nested dictionaries", () => {
    const text = fixture(LITERAL);
    const found = plist.read(text, FILE, undefined);
    expect(found).toEqual([
      { field: "marketing", key: "CFBundleShortVersionString", value: "1.4.0", line: 19 },
      { field: "build", key: "CFBundleVersion", value: "12", line: 21 },
    ]);
    const lines = text.split("\n");
    expect(lines[18]).toBe("\t<string>1.4.0</string>");
    expect(lines[20]).toBe("\t<string>12</string>");
  });

  it("returns build-setting references as the value", () => {
    const found = plist.read(fixture(REFERENCE), FILE, undefined);
    expect(found.map((f) => f.value)).toEqual([
      "$(MARKETING_VERSION)",
      "$(CURRENT_PROJECT_VERSION)",
    ]);
    const cap = plist.read(
      fixture("capacitor/apps/mobile/ios/App/App/Info.plist"),
      FILE,
      undefined,
    );
    expect(cap.map((f) => f.value)).toEqual(["$(MARKETING_VERSION)", "$(CURRENT_PROJECT_VERSION)"]);
    const rn = plist.read(fixture("react-native/ios/MyApp/Info.plist"), FILE, undefined);
    expect(rn.map((f) => f.value)).toEqual(["$(MARKETING_VERSION)", "$(CURRENT_PROJECT_VERSION)"]);
  });

  it("reads only the marketing version when the build key is missing", () => {
    const text = fixture(LITERAL).replace(
      "\t<key>CFBundleVersion</key>\n\t<string>12</string>\n",
      "",
    );
    expect(plist.read(text, FILE, undefined).map((f) => f.field)).toEqual(["marketing"]);
  });
});

describe("plist write", () => {
  const text = fixture(LITERAL);

  it("replaces both values exactly", () => {
    const out = plist.write(text, FILE, { marketing: "1.5.0", build: 345 }, undefined);
    expect(out).toBe(
      text
        .replace("<string>1.4.0</string>", "<string>1.5.0</string>")
        .replace("<string>12</string>", "<string>345</string>"),
    );
    expect(changedLines(text, out)).toEqual([
      { before: "\t<string>1.4.0</string>", after: "\t<string>1.5.0</string>" },
      { before: "\t<string>12</string>", after: "\t<string>345</string>" },
    ]);
  });

  it("leaves the nested CFBundleVersion alone", () => {
    expect(plist.write(text, FILE, { build: 9 }, undefined)).toContain(
      "<string>decoy-nested</string>",
    );
  });

  it("writes only the given field", () => {
    expect(
      changedLines(text, plist.write(text, FILE, { marketing: "1.5.0" }, undefined)),
    ).toHaveLength(1);
    const buildOnly = plist.write(text, FILE, { build: 7 }, undefined);
    expect(changedLines(text, buildOnly)).toEqual([
      { before: "\t<string>12</string>", after: "\t<string>7</string>" },
    ]);
  });

  it("returns the input unchanged when there is nothing to write", () => {
    expect(plist.write(text, FILE, {}, undefined)).toBe(text);
    // Even a reference isn't touched when its field isn't written.
    const ref = fixture(REFERENCE);
    expect(plist.write(ref, FILE, {}, undefined)).toBe(ref);
  });

  it("keeps CRLF line endings, spaces for indentation and a missing trailing newline", () => {
    const odd = text.replaceAll("\t", "    ").replaceAll("\n", "\r\n").trimEnd();
    const out = plist.write(odd, FILE, { marketing: "1.5.0", build: 345 }, undefined);
    expect(out).toBe(
      odd
        .replace("<string>1.4.0</string>", "<string>1.5.0</string>")
        .replace("<string>12</string>", "<string>345</string>"),
    );
    expect(out.endsWith("</plist>")).toBe(true);
  });

  it("fills an empty self-closing <string/>", () => {
    const empty = text.replace("<string>12</string>", "<string/>");
    const out = plist.write(empty, FILE, { build: 3 }, undefined);
    expect(out).toBe(text.replace("<string>12</string>", "<string>3</string>"));
  });

  it("is not confused by comments, nested arrays and self-closing elements before the keys", () => {
    const tricky = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0">',
      "<dict>",
      "  <key>CFBundleURLTypes</key><array><dict><key>CFBundleVersion</key><string>nested</string></dict></array>",
      "  <key>Empty</key><dict/>",
      "  <key>LSRequiresIPhoneOS</key><true/>",
      "  <!-- <key>CFBundleVersion</key><string>commented</string> -->",
      "  <key>CFBundleShortVersionString</key><string>1.0.0</string>",
      "  <key>CFBundleVersion</key><string>1</string>",
      "</dict>",
      "</plist>",
      "",
    ].join("\n");
    expect(plist.write(tricky, FILE, { marketing: "2.0.0", build: 2 }, undefined)).toBe(
      tricky
        .replace("<string>1.0.0</string>", "<string>2.0.0</string>")
        .replace("<string>1</string>", "<string>2</string>"),
    );
  });
});

describe("plist errors", () => {
  const ref = fixture(REFERENCE);

  it("says to use xcodeproj when a written field is a build-setting reference", () => {
    const m = stampError(() => plist.write(ref, FILE, { marketing: "1.5.0" }, undefined));
    expect(m.file).toBe(FILE);
    expect(m.reason).toBe(
      'CFBundleShortVersionString uses the build setting $(MARKETING_VERSION); use source kind "xcodeproj" (or "xcconfig") instead',
    );
    expect(m.message).toBe(
      `${FILE}: CFBundleShortVersionString uses the build setting $(MARKETING_VERSION); use source kind "xcodeproj" (or "xcconfig") instead`,
    );
    expect(stampError(() => plist.write(ref, FILE, { build: 3 }, undefined)).reason).toBe(
      'CFBundleVersion uses the build setting $(CURRENT_PROJECT_VERSION); use source kind "xcodeproj" (or "xcconfig") instead',
    );
  });

  it("only complains about the field being written", () => {
    // Marketing is literal, build is a reference.
    const mixed = fixture(LITERAL).replace(
      "<string>12</string>",
      "<string>$(CURRENT_PROJECT_VERSION)</string>",
    );
    expect(() => plist.write(mixed, FILE, { marketing: "1.5.0" }, undefined)).not.toThrow();
    expect(() => plist.write(mixed, FILE, { marketing: "1.5.0", build: 1 }, undefined)).toThrow(
      StampError,
    );
  });

  it("rejects a binary plist", () => {
    const err = stampError(() => plist.read("bplist00\u0000\u0001", FILE, undefined));
    expect(err.reason).toContain("binary property list");
    expect(err.reason).toContain("plutil -convert xml1");
    expect(() => plist.write("bplist00\u0000", FILE, { build: 1 }, undefined)).toThrow(StampError);
  });

  it("rejects missing keys when they are written", () => {
    const noBuild = fixture(LITERAL).replace(
      "\t<key>CFBundleVersion</key>\n\t<string>12</string>\n",
      "",
    );
    expect(stampError(() => plist.write(noBuild, FILE, { build: 3 }, undefined)).reason).toBe(
      "CFBundleVersion not found in the top-level <dict>. Add the key with a placeholder value, or use another source kind.",
    );
    expect(() => plist.write(noBuild, FILE, { marketing: "1.5.0" }, undefined)).not.toThrow();
    const noMarketing = fixture(LITERAL).replace(
      "\t<key>CFBundleShortVersionString</key>\n\t<string>1.4.0</string>\n",
      "",
    );
    expect(stampError(() => plist.read(noMarketing, FILE, undefined)).reason).toContain(
      "CFBundleShortVersionString not found",
    );
  });

  it("does not take a nested key for a top-level one", () => {
    const onlyNested = fixture(LITERAL).replace(
      "\t<key>CFBundleVersion</key>\n\t<string>12</string>\n",
      "",
    );
    expect(onlyNested).toContain("decoy-nested");
    expect(() => plist.write(onlyNested, FILE, { build: 3 }, undefined)).toThrow(
      /CFBundleVersion not found/,
    );
  });

  it("rejects duplicate keys, non-string values and non-plists", () => {
    const dup = fixture(LITERAL).replace(
      "\t<key>LSRequiresIPhoneOS</key>",
      "\t<key>CFBundleVersion</key>\n\t<string>13</string>\n\t<key>LSRequiresIPhoneOS</key>",
    );
    expect(stampError(() => plist.write(dup, FILE, { build: 3 }, undefined)).reason).toBe(
      "CFBundleVersion appears 2 times in the top-level <dict>, can't tell which to change",
    );
    const integer = fixture(LITERAL).replace("<string>12</string>", "<integer>12</integer>");
    expect(stampError(() => plist.write(integer, FILE, { build: 3 }, undefined)).reason).toBe(
      "CFBundleVersion is a <integer> (line 21), expected a <string>",
    );
    expect(stampError(() => plist.read('{ "a" = "b"; }', FILE, undefined)).reason).toBe(
      "not an XML property list: no <plist> element found",
    );
  });

  it("rejects a prerelease marketing version and a bad build number", () => {
    const text = fixture(LITERAL);
    expect(
      stampError(() => plist.write(text, FILE, { marketing: "1.5.0-pr.1.2" }, undefined)).reason,
    ).toBe(
      'iOS marketing version must be plain X.Y.Z (Apple rejects prerelease suffixes), got "1.5.0-pr.1.2"',
    );
    expect(stampError(() => plist.write(text, FILE, { build: 0 }, undefined)).reason).toBe(
      "build number must be a positive integer, got 0",
    );
  });
});
