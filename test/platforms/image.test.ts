import { describe, expect, it } from "vitest";
import { hasImageRef, imageRefs } from "../../src/platforms/image.ts";
import {
  changedLines,
  expectStampError,
  fixture,
  lineOfText,
  replaceEach,
  replaceOnce,
} from "./stamper-test-utils.ts";

const F = "deploy/app.yaml";
const APP = ["ghcr.io/org/app"];
const write = (text: string, images: string[], marketing?: string, file = F) =>
  imageRefs.write(text, file, { marketing }, { images });

describe("imageRefs", () => {
  it("k8s Deployment: every reference to the image, nothing else", () => {
    const text = fixture("generic/deployment.yaml");
    const out = write(text, APP, "v1.5.0");
    expect(out).toBe(
      replaceEach(text, [
        [
          "image: ghcr.io/org/app:1.4.0\n          command",
          "image: ghcr.io/org/app:v1.5.0\n          command",
        ],
        ['image: "ghcr.io/org/app:1.4.0"', 'image: "ghcr.io/org/app:v1.5.0"'],
      ]),
    );
    expect(changedLines(text, out)).toBe(2);
    // similar names, a longer path, other images, the label and the untagged reference stay as they were
    expect(out).toContain("ghcr.io/org/app-worker:1.4.0");
    expect(out).toContain("other.io/ghcr.io/org/app:1.4.0");
    expect(out).toContain("redis:7.2");
    expect(out).toContain('app.kubernetes.io/version: "1.4.0"');
    expect(out).toMatch(/image: ghcr\.io\/org\/app\n$/);
  });

  it("reads each occurrence with image, tag and line", () => {
    const text = fixture("generic/deployment.yaml");
    expect(imageRefs.read(text, F, { images: APP })).toEqual([
      {
        field: "marketing",
        key: "ghcr.io/org/app",
        value: "1.4.0",
        line: lineOfText(text, "image: ghcr.io/org/app:1.4.0"),
      },
      {
        field: "marketing",
        key: "ghcr.io/org/app",
        value: "1.4.0",
        line: lineOfText(text, 'image: "ghcr.io/org/app:1.4.0"'),
      },
    ]);
  });

  it("docker-compose: several images, quote styles, prerelease tags", () => {
    const text = fixture("generic/docker-compose.yml");
    const out = write(text, ["ghcr.io/org/app", "ghcr.io/org/api"], "v1.5.0");
    expect(out).toBe(
      replaceEach(text, [
        ["app:v1.4.0\n    ports", "app:v1.5.0\n    ports"],
        ["api:1.4.0-rc.1 #", "api:v1.5.0 #"],
      ]),
    );
    expect(changedLines(text, out)).toBe(2);
    expect(out).toContain("SENTRY_RELEASE=v1.4.0");
    expect(out).toContain("'ghcr.io/org/app-worker:v1.4.0'");
  });

  it("single-quoted reference and the second image only", () => {
    const text = fixture("generic/docker-compose.yml");
    const out = write(text, ["ghcr.io/org/app-worker"], "2.0.0");
    expect(out).toBe(
      replaceOnce(text, "'ghcr.io/org/app-worker:v1.4.0'", "'ghcr.io/org/app-worker:2.0.0'"),
    );
  });

  it("CRLF, no trailing newline, images in shell-ish and flow contexts", () => {
    const text =
      "a: {image: ghcr.io/org/app:1}\r\nrun: docker run --rm ghcr.io/org/app:2 sh\r\nenv=ghcr.io/org/app:3";
    expect(write(text, APP, "9.9.9")).toBe(
      "a: {image: ghcr.io/org/app:9.9.9}\r\nrun: docker run --rm ghcr.io/org/app:9.9.9 sh\r\nenv=ghcr.io/org/app:9.9.9",
    );
  });

  it("registry with a port and regex characters in the name", () => {
    const text = "image: localhost:5000/org/app.v2:1.0\nimage: localhostX5000/org/appXv2:1.0\n";
    expect(write(text, ["localhost:5000/org/app.v2"], "1.1")).toBe(
      "image: localhost:5000/org/app.v2:1.1\nimage: localhostX5000/org/appXv2:1.0\n",
    );
  });

  it("a name ending the sentence or followed by a longer path is not a match", () => {
    const text =
      "image: ghcr.io/org/app/sub:1\nimage: ghcr.io/org/app.old:1\nimage: ghcr.io/org/app:1\n";
    expect(write(text, APP, "2")).toBe(
      "image: ghcr.io/org/app/sub:1\nimage: ghcr.io/org/app.old:1\nimage: ghcr.io/org/app:2\n",
    );
  });

  it("tags follow the OCI grammar (max 128 chars)", () => {
    const long = "a".repeat(128);
    const tooLong = "a".repeat(129);
    expect(write(`image: ghcr.io/org/app:${long}\n`, APP, "2")).toBe("image: ghcr.io/org/app:2\n");
    expect(() => write(`image: ghcr.io/org/app:${tooLong}\n`, APP, "2")).toThrow(
      "longer than 128 characters",
    );
    expectStampError(
      () => write("image: ghcr.io/org/app:1\n", APP, "-bad"),
      F,
      'can\'t use "-bad" as an image tag',
    );
    expectStampError(() => write("image: ghcr.io/org/app:1\n", APP, "a b"), F, "can't use");
  });

  it("templated tags and untagged references are not stamped and don't count", () => {
    const text =
      "a: ghcr.io/org/app:$" +
      "{TAG}\nb: ghcr.io/org/app:{{ .Values.tag }}\nc: ghcr.io/org/app\nd: ghcr.io/org/app:1.0\n";
    expect(write(text, APP, "2.0")).toBe(
      "a: ghcr.io/org/app:$" +
        "{TAG}\nb: ghcr.io/org/app:{{ .Values.tag }}\nc: ghcr.io/org/app\nd: ghcr.io/org/app:2.0\n",
    );
    expect(hasImageRef(text, APP)).toBe(true);
    expect(hasImageRef("c: ghcr.io/org/app\n", APP)).toBe(false);
    expectStampError(
      () => write("c: ghcr.io/org/app\n", APP, "2.0"),
      F,
      "no reference of the form <image>:<tag>",
      "found 1 without a plain tag, on line 1",
    );
  });

  it("digest pins are an error", () => {
    const withTag = fixture("generic/deployment-digest.yaml");
    expectStampError(
      () => write(withTag, APP, "1.5.0"),
      F,
      "ghcr.io/org/app is pinned by digest on line 8",
      "a digest-pinned reference can't be stamped",
    );
    const only = fixture("generic/deployment-digest-only.yaml");
    expectStampError(() => write(only, APP, "1.5.0"), F, "pinned by digest on line 2");
    expectStampError(() => imageRefs.read(only, F, { images: APP }), F, "pinned by digest");
    expect(hasImageRef(only, APP)).toBe(true);
    expect(hasImageRef(withTag, APP)).toBe(true);
  });

  it("no reference at all is an error; hasImageRef reports false", () => {
    const text = fixture("generic/deployment-no-ref.yaml");
    expect(hasImageRef(text, APP)).toBe(false);
    expectStampError(
      () => write(text, APP, "1.5.0"),
      F,
      "no reference of the form <image>:<tag> to ghcr.io/org/app",
    );
    expectStampError(() => imageRefs.read(text, F, { images: APP }), F, "no reference");
  });

  it("no marketing value returns the input unchanged; empty image list is an error", () => {
    const text = fixture("generic/deployment.yaml");
    expect(write(text, APP, undefined)).toBe(text);
    expect(write(fixture("generic/deployment-no-ref.yaml"), APP, undefined)).toBe(
      fixture("generic/deployment-no-ref.yaml"),
    );
    expectStampError(() => write(text, [], "1.0.0"), F, "no images given");
  });
});

describe("imageRefs: tag boundaries", () => {
  const w = (text: string) => write(text, APP, "2.0.0");

  it("a sentence-ending dot stays outside the tag", () => {
    expect(w("# bump ghcr.io/org/app:1.0.0.\nimage: ghcr.io/org/app:1.0.0\n")).toBe(
      "# bump ghcr.io/org/app:2.0.0.\nimage: ghcr.io/org/app:2.0.0\n",
    );
    expect(w("see ghcr.io/org/app:1.0.0.")).toBe("see ghcr.io/org/app:2.0.0.");
    expect(imageRefs.read("see ghcr.io/org/app:1.0.0.\n", F, { images: APP })[0]?.value).toBe(
      "1.0.0",
    );
  });

  it.each([
    ["tag ending in -", "image: ghcr.io/org/app:1.0.0-\n", 'ends with "-"'],
    ["tag ending in two dots", "image: ghcr.io/org/app:1.0.0..\n", 'ends with "."'],
    ["build metadata", "image: ghcr.io/org/app:1.0.0+b1\n", 'is followed by "+"'],
    ["extra colon", "image: ghcr.io/org/app:1.0.0:extra\n", 'is followed by ":"'],
    ["semicolon", "run: docker run ghcr.io/org/app:1.0.0; echo\n", 'is followed by ";"'],
    ["partly templated", `image: ghcr.io/org/app:v$\{VERSION}\n`, 'is followed by "$"'],
  ])("%s is ambiguous", (_name, text, reason) => {
    expectStampError(() => w(text), F, "line 1:", reason, "can't tell where the tag ends");
    expectStampError(() => imageRefs.read(text, F, { images: APP }), F, reason);
    expect(hasImageRef(text, APP)).toBe(true);
  });

  it.each([
    ['image: "ghcr.io/org/app:1.0.0"', 'image: "ghcr.io/org/app:2.0.0"'],
    ["image: 'ghcr.io/org/app:1.0.0'", "image: 'ghcr.io/org/app:2.0.0'"],
    ["images: [ghcr.io/org/app:1.0.0, x]", "images: [ghcr.io/org/app:2.0.0, x]"],
    ["images: [x, ghcr.io/org/app:1.0.0]", "images: [x, ghcr.io/org/app:2.0.0]"],
    ["a: {image: ghcr.io/org/app:1.0.0}", "a: {image: ghcr.io/org/app:2.0.0}"],
    ["(ghcr.io/org/app:1.0.0)", "(ghcr.io/org/app:2.0.0)"],
    ["image: ghcr.io/org/app:1.0.0 # c", "image: ghcr.io/org/app:2.0.0 # c"],
    ["image: ghcr.io/org/app:1.0.0#c", "image: ghcr.io/org/app:2.0.0#c"],
    ["image: ghcr.io/org/app:1.0.0\r\n", "image: ghcr.io/org/app:2.0.0\r\n"],
    ["image: ghcr.io/org/app:1.0.0\t", "image: ghcr.io/org/app:2.0.0\t"],
  ])("accepted boundary: %s", (text, expected) => {
    expect(w(text)).toBe(expected);
  });

  it("can't write a tag that ends in . or -", () => {
    expectStampError(() => write("image: ghcr.io/org/app:1\n", APP, "1.0-"), F, "can't use");
  });
});
