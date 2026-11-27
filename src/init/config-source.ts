/**
 * Builds the config init writes (spec 11.1 step 4): the `launchset.config.ts` object with
 * only non-default options, and its readable TypeScript source with comments.
 */

import { LaunchsetError } from "../core/errors.ts";
import { ciOf } from "../core/hosts.ts";
import { joinWords } from "../core/plan-common.ts";
import { renderTag } from "../core/tags.ts";
import type { WorkflowHint } from "../templates/workflows.ts";
import type { Answers } from "./decisions.ts";
import { parseImages, parseTagList } from "./decisions.ts";
import type { DetectContext } from "./detect.ts";
import { missingTargetJobs } from "./gitlab-edit.ts";
import { planTemplates, prefillTargetJob, TEMPLATES_FILE } from "./gitlab-targets.ts";
import type { DetectedTarget } from "./types.ts";

export interface ConfigPlan {
  /** The config object (what `defineConfig` receives). */
  config: Record<string, unknown>;
  /** Comment lines above a key, by dotted path (`targets.android`). `""` is the file header. */
  comments: Map<string, string[]>;
  /** Hints for the workflow templates, per target. */
  hints: Record<string, WorkflowHint>;
  /** Targets that are in the config, in order. */
  targets: DetectedTarget[];
}

export const CONFIG_FILE = "launchset.config.ts";

export function buildConfig(
  ctx: DetectContext,
  answers: Answers,
  options: { kept?: KeptTargetFile } = {},
): ConfigPlan {
  const d = ctx.detection;
  const config: Record<string, unknown> = {};
  const comments = new Map<string, string[]>();
  const hints: ConfigPlan["hints"] = {};
  comments.set("", [
    "launchset configuration, written by `launchset init`.",
    "Options left out use their defaults: see the configuration reference in the launchset docs.",
  ]);

  const versionFile = answers["version.file"];
  if (versionFile !== undefined && versionFile !== "package.json") {
    config.version = { file: versionFile };
    comments.set("version", [
      "The repo has no package.json: the Flutter app's pubspec.yaml holds the version.",
    ]);
  }

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

  const version = answers.version ?? d.canonical.version;
  const baselineTag = renderTag(releaseTag, { version });
  if (answers.baseline === "yes" && !ctx.tagNames.includes(baselineTag)) {
    config.baseline = version;
    comments.set(
      "baseline",
      wrap(
        `${version} was released before launchset. The first release workflow run on the base branch after this file is merged creates ${baselineTag} at that commit, so ${version} counts as released and isn't built again. Don't create ${baselineTag} by hand: pushing a tag runs the tag-triggered workflows of the commit it points to, and before the merge those are the old release workflows. You can remove this line once ${baselineTag} exists.`,
      ),
    );
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
      const verify = (answers[`docker.${t.name}.verify`] ?? "yes") === "yes";
      if (verify) entry.verify = ["registry"];
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
      if (verify)
        notes.push("verify: a re-run skips the build when the release tag is already pushed.");
      const hint: { dockerfile?: string; context?: string; platforms?: string } = {
        dockerfile: t.docker.dockerfile,
        context: t.docker.context,
      };
      if (t.docker.platforms) hint.platforms = t.docker.platforms;
      hints[t.name] = hint;
    } else if (t.source) {
      entry.source = t.source;
      if (t.source.kind === "flutter") {
        const dir = String(t.source.dir);
        notes.push(
          `Stamps the version in ${dir === "." ? "" : `${dir}/`}pubspec.yaml; Flutter passes it to ${t.type === "ios" ? "Xcode" : "Gradle"}.`,
        );
      }
    } else if (t.type === "custom" && t.gitlab) {
      const job = t.gitlab;
      notes.push(
        `The build steps of GitLab job "${job.job}" (${job.path}:${job.line}), in .gitlab/launchset-targets.yml. Add "files" for the files that hold the version, so stamp writes it in CI.`,
      );
      if ((answers[`gitlab.${t.name}.shell`] ?? job.shell) === "powershell") {
        entry.gitlab = { shell: "powershell" };
        notes.push("Its runner uses PowerShell: launchset's lines of the job are PowerShell.");
      }
      const after: string[] = [];
      for (const other of job.after) {
        const otherRelease =
          answers[`target.${other}`] ?? d.targets.find((o) => o.name === other)?.proposed;
        if (otherRelease === undefined || otherRelease === "none") continue;
        if (release === "auto" && otherRelease === "manual") {
          notes.push(
            `"${job.job}" needed ${other}'s job, but ${other} is manual (a release doesn't build it), so it isn't in "after".`,
          );
          continue;
        }
        after.push(other);
      }
      if (after.length > 0) {
        entry.after = after;
        notes.push(
          `Built after ${after.join(" and ")}, with their artifacts ("${job.job}" needed their jobs).`,
        );
      }
    } else if (t.type === "custom" && t.github) {
      const job = t.github;
      notes.push(
        `Built by job "${job.job}" in ${job.path}:${job.line} before; its steps are in launchset-release.yml, commented out. Add "files" for the files that hold the version, so stamp writes it in CI.`,
      );
      hints[t.name] = {
        moved: {
          path: job.path,
          job: job.job,
          steps: job.steps,
          ...(job.runsOn !== undefined ? { runsOn: job.runsOn } : {}),
          ...(job.checkoutWith ? { checkoutWith: job.checkoutWith } : {}),
          ...(job.notes ? { notes: job.notes } : {}),
        },
      };
    } else if (t.type === "custom" && t.npm) {
      entry.verify = ["npm"];
      if (t.npm.package !== "package.json") entry.npm = { package: t.npm.package };
      const e = t.builtBy[0];
      notes.push(
        `Publishes ${t.npm.name} to npm${e ? `, as ${e.path}:${e.line} did before` : ""}; its publish step is in the release workflow. verify skips a version that is already on the registry.`,
      );
    } else if (t.type === "custom") {
      notes.push(
        `Declared with --decide: add its build steps to the CI files, and "files" for the files that hold the version.`,
      );
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
      d.targets.length === 0
        ? "No targets: init detected nothing to release (no Dockerfile, app project, package.json or CI job that builds on tags)."
        : "No targets: every detected platform was decided as none.",
      {
        hint: `${d.targets.length > 0 ? `Decide at least one target as auto, e.g. --decide target.${d.targets[0]?.name ?? "web"}=auto, or declare` : "Declare"} a custom target with --decide target.<name>=custom (e.g. --decide target.app=custom); its build steps go in the CI files.`,
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
  const host = answers.host ?? ctx.host.host;
  const gitlabCi = ciOf(host) === "gitlab-ci";
  const guarded = guardedTargets(ctx, included, gitlabCi, options.kept);
  if (guarded.length > 0) {
    config.preview = {
      targets: included.filter((t) => !guarded.includes(t.name)).map((t) => t.name),
    };
    const where = gitlabCi
      ? ".gitlab/launchset-targets.yml"
      : "launchset-release.yml and launchset-preview.yml";
    const one = guarded.length === 1;
    comments.set(
      "preview",
      wrap(
        `Previews build only the targets with build steps. ${joinWords(guarded)} ${one ? "has" : "have"} only the "build steps missing" placeholder in ${where}, which fails on purpose: add ${one ? "it" : "them"} here once ${one ? "its" : "their"} build steps are in (or set targets: "all").`,
      ),
    );
  }
  if (gitlabCi && ctx.gitlab) {
    const plan = planTemplates(
      ctx.gitlab,
      included.filter((t) => t.gitlab),
    );
    const include = [
      ...(answers["gitlab.templates"] === "move" && plan.move.length > 0 ? [TEMPLATES_FILE] : []),
      ...plan.include,
    ];
    if (include.length > 0) {
      config.gitlab = { include };
      comments.set("gitlab", [
        "The child pipeline includes these files, so the target jobs can extend their templates.",
      ]);
    }
  }
  config.targets = targets;
  return { config, comments, hints, targets: included };
}

/** `text` as comment lines of at most `width` characters. */
function wrap(text: string, width = 88): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line !== "" && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/**
 * The file that holds the preview build steps when init keeps it instead of writing it: the
 * existing `launchset-preview.yml` (GitHub, `file.<path>=keep`) or `.gitlab/launchset-targets.yml`
 * (GitLab, where init only appends the jobs it lacks).
 */
export interface KeptTargetFile {
  text: string;
}

/**
 * Targets whose CI steps are only the "build steps missing" placeholder, which fails on purpose
 * so a release can't mark them shipped while nothing builds them. In what init writes: every
 * target except Docker, npm and (on GitLab) custom targets whose job init copied. In a file init
 * keeps (`kept`): the targets whose placeholder is still in it, and on GitHub those it doesn't
 * mention at all (nothing builds them there).
 */
export function guardedTargets(
  ctx: DetectContext,
  targets: readonly DetectedTarget[],
  gitlab: boolean,
  kept?: KeptTargetFile,
): string[] {
  const generated = (t: DetectedTarget): boolean => {
    if (t.type === "docker") return false;
    if (t.type === "custom" && t.npm) return false;
    if (gitlab && t.type === "custom" && t.gitlab && ctx.gitlab) {
      return prefillTargetJob(ctx.gitlab, t) === undefined;
    }
    return true;
  };
  if (kept === undefined) return targets.filter(generated).map((t) => t.name);
  const text = kept.text;
  if (gitlab) {
    const missing = missingTargetJobs(
      text,
      targets.map((t) => t.name),
    );
    // Unreadable: init keeps it as is and asks for a fix; assume nothing builds the targets.
    if (!Array.isArray(missing)) return targets.map((t) => t.name);
    return targets
      .filter((t) =>
        missing.includes(t.name) ? generated(t) : text.includes(`No build steps for ${t.name} yet`),
      )
      .map((t) => t.name);
  }
  return targets
    .filter(
      (t) =>
        text.includes(`Build steps missing (${t.name})`) ||
        !(text.includes(`'${t.name}'`) || text.includes(`"${t.name}"`)),
    )
    .map((t) => t.name);
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
  return `import { defineConfig } from "launchset";\n\n${header}export default defineConfig(${render(plan.config, "", "", plan.comments)});\n`;
}
