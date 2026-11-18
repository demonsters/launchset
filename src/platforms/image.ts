/**
 * Image reference stamper (spec 6.6, kind `image`): in deploy manifests (k8s, Compose, Helm
 * values) every `<image>:<tag>` of the given images gets `values.marketing` as its tag.
 *
 * Matching rules:
 * - The image name must match as a whole: not preceded by a name character or `/` (so
 *   `other.io/ghcr.io/org/app` doesn't match `ghcr.io/org/app`) and not followed by one (so
 *   `ghcr.io/org/app-worker` and `…/app/sub` don't match). Matching is case-sensitive.
 * - Tags follow the OCI grammar `[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}`; the reference may be quoted.
 * - A reference without a tag (`image: ghcr.io/org/app`) or with a templated tag
 *   (`app:${TAG}`, `app:{{ .Values.tag }}`) is not stamped and doesn't count as a reference.
 * - Digest pins (`app:1.0@sha256:…`, `app@sha256:…`) are an error: a stamped tag would no longer
 *   say what runs.
 * - Comments are not special: a commented-out `# image: ghcr.io/org/app:1.0.0` is stamped too.
 *
 * `read` returns one FoundValue per occurrence (key = image, value = tag).
 */

import { applySplices, type FoundValue, lineOf, StampError, type TextStamper } from "./types.ts";

export interface ImageRefsOptions {
  images: string[];
}

const TAG = "[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}";

interface Occurrence {
  image: string;
  /** `undefined` for an untagged or templated reference. */
  tag: string | undefined;
  tagStart: number;
  tagEnd: number;
  digest: boolean;
  /** Set when the tag's end can't be told; reported as an error by `analyse`. */
  problem?: string;
  line: number;
}

/** What may follow a tag: whitespace, a quote, `,` `]` `}` `)` `#`, or the end of the text. */
const AFTER_TAG = /^(?:$|[\s"',\]})#])/;

function scan(text: string, images: string[], file: string): Occurrence[] {
  if (images.length === 0) throw new StampError(file, "no images given to stamp");
  const names = [...images]
    .sort((a, b) => b.length - a.length)
    .map((i) => i.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&"));
  // The tag candidate is greedy; its real end is decided below.
  const re = new RegExp(
    `(?<![A-Za-z0-9_.\\-/@])(${names.join("|")})(?![A-Za-z0-9_.\\-/])(?::([A-Za-z0-9_][A-Za-z0-9_.\\-]*))?(@[^\\s"']+)?`,
    "dg",
  );
  const found: Occurrence[] = [];
  for (const m of text.matchAll(re)) {
    const indices = (m as RegExpMatchArray & { indices: [number, number][] }).indices;
    const line = lineOf(text, m.index);
    const occurrence: Occurrence = {
      image: m[1] as string,
      tag: m[2],
      tagStart: indices[2]?.[0] ?? -1,
      tagEnd: indices[2]?.[1] ?? -1,
      digest: m[3] !== undefined,
      line,
    };
    found.push(occurrence);
    if (m[2] === undefined || occurrence.digest) continue;

    let tag = m[2];
    let sentenceDot = false;
    // A sentence-ending dot after the tag (`app:1.0.0.`) is not part of it.
    if (tag.length > 1 && tag.endsWith(".") && AFTER_TAG.test(text.slice(occurrence.tagEnd))) {
      tag = tag.slice(0, -1);
      occurrence.tagEnd--;
      sentenceDot = true;
    }
    occurrence.tag = tag;
    const ref = `${occurrence.image}:${tag}`;
    const next = text.slice(occurrence.tagEnd, occurrence.tagEnd + 1);
    if (/[.-]$/.test(tag)) {
      occurrence.problem = `the tag in ${ref} ends with "${tag.slice(-1)}", which is not valid; can't tell where the tag ends`;
    } else if (tag.length > 128) {
      occurrence.problem = `the tag in ${ref} is longer than 128 characters, which is not a valid tag`;
    } else if (!sentenceDot && !AFTER_TAG.test(text.slice(occurrence.tagEnd))) {
      occurrence.problem = `the tag in ${ref} is followed by "${next}"; can't tell where the tag ends (a tag may be followed by whitespace, a quote, , ] } ) or #)`;
    }
  }
  return found;
}

/** True if the text has a stampable or digest-pinned reference to one of the images. */
export function hasImageRef(text: string, images: string[]): boolean {
  return scan(text, images, "").some((o) => o.tag !== undefined || o.digest);
}

function analyse(text: string, file: string, images: string[]): Occurrence[] {
  const all = scan(text, images, file);
  for (const o of all) {
    if (o.digest) {
      throw new StampError(
        file,
        `${o.image} is pinned by digest on line ${o.line}; a digest-pinned reference can't be stamped. ` +
          "Reference it by tag, or leave this file out of the image files.",
      );
    }
    if (o.problem) throw new StampError(file, `line ${o.line}: ${o.problem}`);
  }
  const refs = all.filter((o) => o.tag !== undefined);
  if (refs.length === 0) {
    const untagged =
      all.length > 0
        ? ` (found ${all.length} without a plain tag, on line ${all.map((o) => o.line).join(", ")})`
        : "";
    throw new StampError(
      file,
      `no reference of the form <image>:<tag> to ${images.join(" or ")}${untagged}`,
    );
  }
  return refs;
}

export const imageRefs: TextStamper<ImageRefsOptions> = {
  read(text, file, options) {
    return analyse(text, file, options.images).map(
      (o): FoundValue => ({
        field: "marketing",
        key: o.image,
        value: o.tag as string,
        line: o.line,
      }),
    );
  },

  write(text, file, values, options) {
    const tag = values.marketing;
    if (tag === undefined) return text;
    if (!new RegExp(`^${TAG}$`).test(tag) || /[.-]$/.test(tag)) {
      throw new StampError(file, `can't use "${tag}" as an image tag: tags must match ${TAG}`);
    }
    const splices = analyse(text, file, options.images).map((o) => ({
      start: o.tagStart,
      end: o.tagEnd,
      text: tag,
    }));
    return applySplices(text, splices);
  },
};
