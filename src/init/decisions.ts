/**
 * Init decisions (spec 11.1 "Agent-assisted adoption"). Each decision has a stable id, the
 * options, a default and the evidence behind it. Later defaults depend on earlier answers
 * (the baseline default depends on the chosen version), so decisions are built in order.
 *
 * | id                         | values                         | default                                             |
 * |----------------------------|--------------------------------|-----------------------------------------------------|
 * | `version`                  | a plain X.Y.Z                  | the highest version found (never lower by default)  |
 * | `tags.release`             | a template with `{version}`    | `v{version}`                                        |
 * | `target.<name>`            | `auto` `manual` `none`         | auto when a workflow builds it; manual for native projects no workflow builds |
 * | `docker.<name>.image`      | an image name                  | read from the existing workflow; else a guess (ask) |
 * | `docker.<name>.tags`       | `default` or a comma list      | the tags the existing workflow pushes (`v{version}` keeps the v) |
 * | `docker.<name>.verify`     | `yes` `no`                     | yes: `verify: ["registry"]`, so a re-run skips an image that's already pushed |
 * | `machinery.<path>#<n>`     | `remove` `disable` `keep`      | disable (keep when no minimal edit exists)          |
 * | `image.<path>`             | `stamp` `leave`                | leave (deploy manifests are never aligned unasked)  |
 * | `file.<path>`              | `keep` `overwrite`             | keep (an existing generated file is never overwritten unasked) |
 * | `baseline`                 | `yes` `no`                     | yes only when a tag in another format marks the version as released |
 * | `offset`                   | an integer >= 0                | enough to stay above the highest build number found |
 * | `skill`                    | `yes` `no`                     | yes                                                 |
 * | `hook`                     | `yes` `no` (only with a hook setup whose file git doesn't ignore) | no               |
 */

import semver from "semver";
import { DOCKER_TAG_PLACEHOLDERS } from "../core/config/schema.ts";
import { LaunchsetError } from "../core/errors.ts";
import { renderTag } from "../core/tags.ts";
import type { DetectContext } from "./detect.ts";
import { evidenceOf } from "./detect.ts";
import type { Decision, DecisionOption, DetectedTarget, Evidence } from "./types.ts";

export type Answers = Record<string, string>;

interface Spec {
  id: string;
  build(answers: Answers): Decision;
  /** Error message for an invalid value, `undefined` when valid. */
  validate(value: string, decision: Decision): string | undefined;
}

const YES_NO: DecisionOption[] = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
];

const RELEASE_LABELS: Record<string, string> = {
  auto: "auto: built and shipped by every release",
  manual: "manual: version stamped by every release, shipped on demand",
  none: "none: not a launchset target",
};

function oneOf(value: string, decision: Decision): string | undefined {
  if (decision.options.some((o) => o.value === value)) return undefined;
  return `expected one of ${decision.options.map((o) => o.value).join(", ")}`;
}

export function isPlain(value: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
}

/** Validates a docker image name like the config schema does. */
function imageError(value: string): string | undefined {
  if (value.trim() === "" || /\s/.test(value)) return "expected an image name like ghcr.io/org/app";
  const last = value.slice(value.lastIndexOf("/") + 1);
  if (value.includes("@") || last.includes(":")) {
    return "expected an image name without tag or digest, like ghcr.io/org/app";
  }
  if (value !== value.toLowerCase()) return "image names must be lowercase";
  return undefined;
}

/** Image names from a comma-separated decision value. */
export function parseImages(value: string): string[] {
  return value
    .split(",")
    .map((i) => i.trim())
    .filter((i) => i !== "");
}

/** `default` or a comma-separated list of tag templates. */
export function parseTagList(value: string): string[] | "default" {
  if (value.trim() === "default") return "default";
  return value
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
}

function tagListError(value: string): string | undefined {
  const list = parseTagList(value);
  if (list === "default") return undefined;
  if (list.length === 0) return 'expected "default" or a comma-separated list of tag templates';
  for (const t of list) {
    for (const m of t.matchAll(/\{([^{}]*)\}/g)) {
      if (!(DOCKER_TAG_PLACEHOLDERS as readonly string[]).includes(m[1] as string)) {
        return `unknown placeholder ${m[0]} in "${t}"`;
      }
    }
  }
  if (!list.some((t) => t.includes("{version}"))) {
    return "expected at least one template containing {version} (it's the tag registry verify checks)";
  }
  return undefined;
}

function guessImage(ctx: DetectContext, target: DetectedTarget): string {
  const repo = ctx.detection.git.github?.toLowerCase();
  const root = target.docker?.dockerfile === "Dockerfile";
  if (repo) return root ? `ghcr.io/${repo}` : `ghcr.io/${repo}-${target.name}`;
  const name = (ctx.detection.packageJson?.name ?? target.name)
    .replace(/^@[^/]+\//, "")
    .toLowerCase();
  return root ? `ghcr.io/your-org/${name}` : `ghcr.io/your-org/${name}-${target.name}`;
}

/** The decision specs for a detection, in the order they're asked. */
export function decisionSpecs(ctx: DetectContext): Spec[] {
  const d = ctx.detection;
  const specs: Spec[] = [];

  // Canonical version
  specs.push({
    id: "version",
    build() {
      const plain = [
        ...new Set(
          d.versions
            .filter((v) => !v.ignored)
            .map((v) => v.plain)
            .filter((v): v is string => v !== null),
        ),
      ];
      if (!plain.includes(d.canonical.version)) plain.push(d.canonical.version);
      plain.sort(semver.rcompare);
      const options = plain.map((v) => ({
        value: v,
        label:
          v === d.canonical.version
            ? `${v} (${d.canonical.reason})`
            : `${v}${semver.lt(v, d.canonical.version) ? " (lower: stores reject lower versions, image tags would go backwards)" : ""}`,
      }));
      // Tags are older releases: only files that disagree with the result need a look.
      const files = d.versions.filter((v) => v.source !== "tag");
      const root = files.find((v) => v.source === "root");
      const differ =
        root?.plain !== d.canonical.version || files.some((v) => v.plain !== d.canonical.version);
      return {
        id: "version",
        question: "Which version is the repo on? Every target file is set to it.",
        options,
        freeform: "a plain X.Y.Z version",
        default: d.canonical.version,
        evidence: [
          ...d.canonical.evidence,
          ...d.versions
            .filter((v) => v.plain !== d.canonical.version)
            .slice(0, 20)
            .map((v) =>
              v.ignored
                ? { ...evidenceOf(v, "ignored"), note: `ignored: ${v.ignored}` }
                : evidenceOf(v, "also found"),
            ),
        ],
        ask: differ || d.versions.length === 0,
      };
    },
    validate: (value) =>
      isPlain(value) ? undefined : "expected a plain X.Y.Z version (no v prefix, no prerelease)",
  });

  // Release tag format
  specs.push({
    id: "tags.release",
    build() {
      const formats = [
        ...new Set(d.tags.filter((t) => !t.prerelease && t.counted).map((t) => t.format)),
      ];
      const options: DecisionOption[] = [
        { value: "v{version}", label: "v{version} (launchset default, e.g. v1.5.0)" },
      ];
      for (const f of formats) {
        if (f !== "v{version}") options.push({ value: f, label: `${f} (used by existing tags)` });
      }
      const evidence: Evidence[] = formats.map((f) => {
        const list = d.tags.filter((t) => t.format === f);
        return {
          path: list[0]?.tag ?? f,
          note: `${list.length} existing tag(s) like ${list[0]?.tag}`,
        };
      });
      return {
        id: "tags.release",
        question: "Release tag format (tags.release)?",
        options,
        freeform: "a tag template containing {version}",
        default: "v{version}",
        evidence,
        ask: formats.length > 0 && !formats.includes("v{version}"),
      };
    },
    validate: (value) =>
      value.includes("{version}") && !/\s/.test(value)
        ? /\{(?!version\})[^}]*\}/.test(value)
          ? "only {version} is allowed in the release tag template"
          : undefined
        : "expected a tag template containing {version}, like v{version}",
  });

  // Targets
  for (const t of d.targets) {
    specs.push({
      id: `target.${t.name}`,
      build(answers) {
        // A web target is the fallback: auto only when nothing else ended up auto.
        const otherAuto = d.targets.some(
          (o) => o.name !== t.name && (answers[`target.${o.name}`] ?? o.proposed) === "auto",
        );
        const proposed = t.type === "web" ? (otherAuto ? "none" : "auto") : t.proposed;
        const reason =
          t.type === "web"
            ? otherAuto
              ? "other targets already ship this repo"
              : "no other target is released automatically; a web target runs your own build steps for every release"
            : t.reason;
        const what =
          t.type === "docker"
            ? `the Docker image from ${t.docker?.dockerfile}`
            : t.type === "web"
              ? "a web target (your own build steps, nothing stamped)"
              : `the ${t.type === "ios" ? "iOS" : "Android"} app in ${t.dir === "." ? "the repo root" : t.dir} (${String(t.source?.kind)})`;
        return {
          id: `target.${t.name}`,
          question: `How is ${what} released?`,
          options: ["auto", "manual", "none"].map((v) => ({
            value: v,
            label: RELEASE_LABELS[v] as string,
          })),
          default: proposed,
          evidence:
            t.builtBy.length > 0
              ? t.builtBy
              : [{ path: t.files[0]?.path ?? t.docker?.dockerfile ?? t.dir, note: reason }],
          ask:
            t.ask === true ||
            ((t.type === "android" || t.type === "ios") && t.proposed === "manual"),
        };
      },
      validate: oneOf,
    });
  }

  // Docker image names and tags
  for (const t of d.targets) {
    if (t.type !== "docker") continue;
    const on = { id: `target.${t.name}`, values: ["auto", "manual"] };
    specs.push({
      id: `docker.${t.name}.image`,
      build() {
        const found = t.docker?.images?.join(", ");
        const guess = guessImage(ctx, t);
        const value = found ?? guess;
        return {
          id: `docker.${t.name}.image`,
          question: `Image name for ${t.name} (${t.docker?.dockerfile})?`,
          options: [
            {
              value,
              label: found
                ? `${value} (from the existing workflow)`
                : `${value} (a guess: no workflow pushes this image)`,
            },
          ],
          freeform: "an image name like ghcr.io/org/app (no tag), or several separated by commas",
          default: value,
          evidence: found
            ? (t.docker?.evidence ?? [])
            : [
                {
                  path: t.docker?.dockerfile ?? t.dir,
                  note: "no existing workflow names the image",
                },
              ],
          ask: !found,
          onlyIf: on,
        };
      },
      validate: (value) => {
        const images = parseImages(value);
        if (images.length === 0) return "expected an image name like ghcr.io/org/app";
        for (const image of images) {
          const error = imageError(image);
          if (error) return images.length > 1 ? `${image}: ${error}` : error;
        }
        return undefined;
      },
    });
    specs.push({
      id: `docker.${t.name}.tags`,
      build() {
        const found = t.docker?.tags;
        const options: DecisionOption[] = [];
        if (found)
          options.push({ value: found.join(", "), label: `${found.join(", ")} (as pushed today)` });
        options.push({
          value: "default",
          label: "default: {version}, {major}.{minor}, {major}, latest",
        });
        // Images tagged `v1.5.0` today (or, with no workflow showing the tags, `v1.5.0` git
        // tags): offer the default list with the `v` kept.
        const vFull = "v{version}, v{major}.{minor}, v{major}, latest";
        const vPrefix = found
          ? found.some((x) => x.startsWith("v{"))
          : d.tags.some((x) => x.format === "v{version}");
        if (vPrefix && found?.join(", ") !== vFull) {
          options.push({
            value: vFull,
            label: "v-prefixed: v{version}, v{major}.{minor}, v{major}, latest",
          });
        }
        return {
          id: `docker.${t.name}.tags`,
          question: `Release tags for the ${t.name} image?`,
          options,
          freeform: 'a comma-separated list of tag templates, or "default"',
          default: found ? found.join(", ") : "default",
          evidence: found
            ? (t.docker?.evidence ?? [])
            : [
                {
                  path: t.docker?.dockerfile ?? t.dir,
                  note: "no existing workflow shows the tags",
                },
              ],
          ask: false,
          onlyIf: on,
        };
      },
      validate: (value) => tagListError(value),
    });
    specs.push({
      id: `docker.${t.name}.verify`,
      build: () => ({
        id: `docker.${t.name}.verify`,
        question: `Check the registry before building ${t.name} (verify: ["registry"])? When the release tag is already pushed, a re-run skips the build instead of pushing it again.`,
        options: YES_NO,
        default: "yes",
        evidence: [],
        ask: false,
        onlyIf: on,
      }),
      validate: oneOf,
    });
  }

  // Machinery
  for (const m of ctx.machinery) {
    const item = m.item;
    if (item.actions.length < 2) continue;
    specs.push({
      id: item.id,
      build() {
        const def = item.actions.includes("disable") ? "disable" : "keep";
        return {
          id: item.id,
          question: `${item.what} (${item.path}:${item.line}) conflicts with launchset: it ${item.reasons.join("; it ")}. What should init do?`,
          options: item.actions.map((a) => ({
            value: a,
            label: `${a}: ${item.effects[a] ?? ""}`.replace(/: $/, ""),
          })),
          default: def,
          evidence: item.evidence,
          ask: def === "keep",
        };
      },
      validate: oneOf,
    });
  }

  // Image pins
  for (const pin of d.imagePins) {
    specs.push({
      id: `image.${pin.path}`,
      build() {
        return {
          id: `image.${pin.path}`,
          question: `${pin.path} pins ${pin.image} (${pin.refs.map((r) => r.tag).join(", ")}). Should the release PR update it to each release (kind: "image"), or is it deploy state you change by hand?`,
          options: [
            {
              value: "stamp",
              label: "stamp: the release PR sets the release tag (and init aligns it now)",
            },
            { value: "leave", label: "leave: deploy state, changed by hand" },
          ],
          default: "leave",
          evidence: pin.refs.map((r) => ({
            path: pin.path,
            line: r.line,
            note: `${pin.image}:${r.tag}`,
          })),
          ask: true,
          onlyIf: { id: `target.${pin.target}`, values: ["auto", "manual"] },
        };
      },
      validate: oneOf,
    });
  }

  // Files a re-run would overwrite
  for (const path of d.existingFiles) {
    specs.push({
      id: `file.${path}`,
      build: () => ({
        id: `file.${path}`,
        question: `${path} already exists. Keep it, or overwrite it with what init writes now?`,
        options: [
          { value: "keep", label: "keep: leave the existing file as it is" },
          { value: "overwrite", label: "overwrite: replace it with the newly generated file" },
        ],
        default: "keep",
        evidence: [{ path, note: "written by an earlier init, maybe edited since" }],
        ask: true,
      }),
      validate: oneOf,
    });
  }

  // Baseline tag
  specs.push({
    id: "baseline",
    build(answers) {
      const version = answers.version ?? d.canonical.version;
      const template = answers["tags.release"] ?? "v{version}";
      let tag: string;
      try {
        tag = renderTag(template, { version });
      } catch {
        tag = `v${version}`;
      }
      const canTag = d.git.repo && d.git.head !== undefined;
      const exists = ctx.tagNames.includes(tag);
      const others = d.tags.filter(
        (t) => t.version === version && !t.prerelease && t.counted && t.tag !== tag,
      );
      const base = {
        id: "baseline",
        options: canTag
          ? YES_NO
          : [{ value: "no", label: "No (not a git repository with commits)" }],
      };
      if (exists) {
        return {
          ...base,
          question: `${tag} already exists, so ${version} counts as released. Create a baseline tag?`,
          default: "no",
          evidence: [{ path: tag, note: "release tag exists" }],
          ask: false,
        };
      }
      if (others.length > 0 && canTag) {
        return {
          ...base,
          question: `Create ${tag} at HEAD, so ${version} counts as released (it's tagged as ${others.map((o) => o.tag).join(", ")})?`,
          default: "yes",
          evidence: others.map((o) => ({
            path: o.tag,
            note: `existing tag marks ${version} as released`,
          })),
          ask: false,
        };
      }
      return {
        ...base,
        question: `Create ${tag} at HEAD, so ${version} counts as released? No tag marks ${version} as released: it may never have been built. With a baseline tag launchset never builds ${version}, and pinned images might not exist.`,
        default: "no",
        evidence: [{ path: tag, note: `no tag marks ${version} as released` }],
        ask: canTag,
      };
    },
    validate: oneOf,
  });

  // Build-number offset
  specs.push({
    id: "offset",
    build() {
      const b = d.buildNumbers;
      const options: DecisionOption[] = [
        {
          value: String(b.offset),
          label: `${b.offset}${b.offset > 0 ? " (keeps new build numbers above the existing ones)" : " (no offset needed)"}`,
        },
      ];
      if (b.offset !== 0) options.push({ value: "0", label: "0 (no offset)" });
      return {
        id: "offset",
        question: "buildNumber.offset (added to every build number)?",
        options,
        freeform: "an integer >= 0",
        default: String(b.offset),
        evidence: b.highest
          ? [
              {
                path: b.highest.path,
                line: b.highest.line,
                note: `highest build number ${b.highest.value} (${b.highest.key}); the timestamp strategy gives ${b.strategyNow} now`,
              },
            ]
          : [
              {
                path: ".",
                note: `no build numbers found; the timestamp strategy gives ${b.strategyNow} now`,
              },
            ],
        ask: b.offset > 0,
      };
    },
    validate: (value) => (/^(0|[1-9]\d*)$/.test(value) ? undefined : "expected an integer >= 0"),
  });

  specs.push({
    id: "skill",
    build: () => ({
      id: "skill",
      question:
        "Install the launchset agent skill (.claude/skills/launchset/SKILL.md) and a launchset section in AGENTS.md?",
      options: YES_NO,
      default: "yes",
      evidence: [],
      ask: false,
    }),
    validate: oneOf,
  });

  const hook = d.hooks.find((h) => !h.installed);
  if (hook) {
    specs.push({
      id: "hook",
      build: () => ({
        id: "hook",
        question: `Add \`launchset check --push\` to the ${hook.tool} pre-push hook (${hook.path})? It warns when commits are pushed without a pending changeset; it never blocks.`,
        options: YES_NO,
        default: "no",
        evidence: [{ path: hook.path, note: `${hook.tool} is set up` }],
        ask: false,
      }),
      validate: oneOf,
    });
  }
  return specs;
}

export interface ResolveOptions {
  explicit: Answers;
  /** Ask a decision (interactive mode). */
  ask?: (decision: Decision, validate: (value: string) => string | undefined) => Promise<string>;
}

function applies(decision: Decision, answers: Answers): boolean {
  if (!decision.onlyIf) return true;
  const value = answers[decision.onlyIf.id];
  return value === undefined || decision.onlyIf.values.includes(value);
}

/** Build every decision and its answer: explicit answers, then asked ones, then defaults. */
export async function resolveDecisions(
  ctx: DetectContext,
  options: ResolveOptions,
): Promise<{ decisions: Decision[]; answers: Answers }> {
  const specs = decisionSpecs(ctx);
  const ids = specs.map((s) => s.id);
  const unknown = Object.keys(options.explicit).filter((id) => !ids.includes(id));
  if (unknown.length > 0) {
    throw new LaunchsetError(
      "unknown-decision",
      `Unknown decision ${unknown.map((u) => `"${u}"`).join(", ")}.`,
      {
        hint: `Valid decision ids: ${ids.join(", ")}. Run \`launchset init --detect --json\` to see them with their options.`,
      },
    );
  }
  const answers: Answers = {};
  const decisions: Decision[] = [];
  for (const spec of specs) {
    const decision = spec.build(answers);
    decisions.push(decision);
    const explicit = options.explicit[spec.id];
    const validate = (value: string) => spec.validate(value, decision);
    if (explicit !== undefined) {
      const error = validate(explicit);
      if (error) {
        throw new LaunchsetError("invalid-decision", `--decide ${spec.id}=${explicit}: ${error}.`, {
          hint: `Options: ${decision.options.map((o) => o.value).join(" | ")}${decision.freeform ? ` (or ${decision.freeform})` : ""}.`,
        });
      }
      answers[spec.id] = explicit;
    } else if (options.ask && applies(decision, answers)) {
      const value = await options.ask(decision, validate);
      const error = validate(value);
      if (error) throw new LaunchsetError("invalid-decision", `${spec.id}: ${error}.`);
      answers[spec.id] = value;
    } else {
      answers[spec.id] = decision.default;
    }
  }
  return { decisions, answers };
}
