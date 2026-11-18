/**
 * Builds the config init writes (spec 11.1 step 4): the `launchset.config.ts` object with
 * only non-default options, and its readable TypeScript source with comments.
 */

import { LaunchsetError } from "../core/errors.ts";
import type { Answers } from "./decisions.ts";
import { parseImages, parseTagList } from "./decisions.ts";
import type { DetectContext } from "./detect.ts";
import type { DetectedTarget } from "./types.ts";

export interface ConfigPlan {
  /** The config object (what `defineConfig` receives). */
  config: Record<string, unknown>;
  /** Comment lines above a key, by dotted path (`targets.android`). `""` is the file header. */
  comments: Map<string, string[]>;
  /** Hints for the workflow templates, per target. */
  hints: Record<string, { dockerfile?: string; context?: string; platforms?: string }>;
  /** Targets that are in the config, in order. */
  targets: DetectedTarget[];
}

export const CONFIG_FILE = "launchset.config.ts";

export function buildConfig(ctx: DetectContext, answers: Answers): ConfigPlan {
  const d = ctx.detection;
  const config: Record<string, unknown> = {};
  const comments = new Map<string, string[]>();
  const hints: ConfigPlan["hints"] = {};
  comments.set("", [
    "launchset configuration, written by `launchset init`.",
    "Options left out use their defaults: see the configuration reference in the launchset docs.",
  ]);

  const releaseTag = answers["tags.release"] ?? "v{version}";
  if (releaseTag !== "v{version}") {
    config.tags = { release: releaseTag };
    comments.set("tags", ["Release tags keep the format this repo already uses."]);
  }
  const offset = Number(answers.offset ?? "0");
  if (offset > 0) {
    config.buildNumber = { offset };
    const h = d.buildNumbers.highest;
    comments.set("buildNumber", [
      h
        ? `Existing build numbers go up to ${h.value} (${h.path}:${h.line}); the offset keeps new ones above them.`
        : "Keeps new build numbers above the existing ones.",
    ]);
  }

  const targets: Record<string, unknown> = {};
  const included: DetectedTarget[] = [];
  for (const t of d.targets) {
    const release = answers[`target.${t.name}`] ?? t.proposed;
    if (release === "none") continue;
    included.push(t);
    const entry: Record<string, unknown> = { type: t.type };
    const notes: string[] = [];
    if (t.type === "docker" && t.docker) {
      const images = parseImages(
        answers[`docker.${t.name}.image`] ?? t.docker.images?.join(", ") ?? "",
      );
      entry.image = images.length === 1 ? images[0] : images;
      const tags = parseTagList(answers[`docker.${t.name}.tags`] ?? "default");
      if (tags !== "default") entry.tags = tags;
      notes.push(`Built from ${t.docker.dockerfile} (context ${t.docker.context}).`);
      if (tags !== "default" && t.docker.tags && tags.join(",") === t.docker.tags.join(",")) {
        const e = t.docker.evidence[0];
        notes.push(`Tags as ${e ? `${e.path} pushes` : "pushed"} today.`);
      }
      const files: Record<string, unknown>[] = [];
      if (t.docker.packageJson) {
        files.push({ path: t.docker.packageJson, kind: "json", key: "version" });
        notes.push(`${t.docker.packageJson} gets the version too.`);
      }
      for (const pin of d.imagePins) {
        if (pin.target === t.name && answers[`image.${pin.path}`] === "stamp") {
          files.push({ path: pin.path, kind: "image" });
        }
      }
      if (files.some((f) => f.kind === "image"))
        notes.push("The image files are deploy manifests the release PR updates.");
      if (files.length > 0) entry.files = files;
      const hint: { dockerfile?: string; context?: string; platforms?: string } = {
        dockerfile: t.docker.dockerfile,
        context: t.docker.context,
      };
      if (t.docker.platforms) hint.platforms = t.docker.platforms;
      hints[t.name] = hint;
    } else if (t.source) {
      entry.source = t.source;
    }
    if (release === "manual") {
      entry.release = "manual";
      notes.push(
        "Shipped on demand: start the release workflow by hand with this target, or run `launchset ship`.",
      );
    }
    targets[t.name] = entry;
    if (notes.length > 0) comments.set(`targets.${t.name}`, notes);
  }
  if (included.length === 0) {
    throw new LaunchsetError(
      "no-targets",
      "No targets: every detected platform was decided as none.",
      {
        hint: `Decide at least one target as auto, e.g. --decide target.${d.targets[0]?.name ?? "web"}=auto.`,
      },
    );
  }
  if (!included.some((t) => (answers[`target.${t.name}`] ?? t.proposed) === "auto")) {
    throw new LaunchsetError(
      "no-auto-target",
      'At least one target must have release: "auto", otherwise no release ever completes.',
      { hint: `Decide one of them as auto, e.g. --decide target.${included[0]?.name}=auto.` },
    );
  }
  config.targets = targets;
  return { config, comments, hints, targets: included };
}

// ---------------------------------------------------------------------------
// TypeScript source

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function key(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function isPrimitive(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function inline(value: unknown): string | undefined {
  if (isPrimitive(value)) return JSON.stringify(value);
  if (Array.isArray(value) && value.every(isPrimitive)) {
    return `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (!entries.every(([, v]) => isPrimitive(v) || (Array.isArray(v) && v.every(isPrimitive)))) {
      return undefined;
    }
    return `{ ${entries.map(([k, v]) => `${key(k)}: ${inline(v)}`).join(", ")} }`;
  }
  return undefined;
}

function render(
  value: unknown,
  indent: string,
  path: string,
  comments: Map<string, string[]>,
): string {
  const short = inline(value);
  if (
    short !== undefined &&
    short.length + indent.length <= 90 &&
    !hasComments(path, value, comments)
  ) {
    return short;
  }
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    return `[\n${value.map((v, i) => `${inner}${render(v, inner, `${path}.${i}`, comments)},\n`).join("")}${indent}]`;
  }
  if (value && typeof value === "object") {
    const lines = Object.entries(value).map(([k, v]) => {
      const p = path ? `${path}.${k}` : k;
      const c = (comments.get(p) ?? []).map((line) => `${inner}// ${line}\n`).join("");
      return `${c}${inner}${key(k)}: ${render(v, inner, p, comments)},\n`;
    });
    return `{\n${lines.join("")}${indent}}`;
  }
  return JSON.stringify(value);
}

function hasComments(path: string, value: unknown, comments: Map<string, string[]>): boolean {
  if (!value || typeof value !== "object") return false;
  return [...comments.keys()].some((k) => k !== "" && k.startsWith(`${path}.`));
}

/** The `launchset.config.ts` text. */
export function renderConfigSource(plan: ConfigPlan): string {
  const header = (plan.comments.get("") ?? []).map((l) => `// ${l}\n`).join("");
  return `import { defineConfig } from "@demonsters/launchset";\n\n${header}export default defineConfig(${render(plan.config, "", "", plan.comments)});\n`;
}
