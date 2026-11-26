/**
 * Custom targets from existing GitLab jobs (design/GITLAB.md phase 5, the trial fixes): a job
 * that runs on tags and builds or publishes something becomes a custom target, its keys are
 * copied into `.launchset-<target>` in `.gitlab/launchset-targets.yml`, and the hidden templates
 * it extends move to a file the child pipeline can include. Read-only: init writes the results.
 */

import { isScalar, type Pair, type Scalar, type YAMLMap } from "yaml";
import { indentAt, lineOf } from "../core/text.ts";
import { checkTemplateFile, targetJobName } from "../templates/gitlab-child.ts";
import {
  effective,
  effectiveFrom,
  type GitLabCi,
  type GitLabFile,
  type GitLabJob,
  runsOnlyOnTags,
  runsOnTags,
  templatesOf,
  usersOf,
} from "./gitlab-scan.ts";
import { gitlabCommandKinds, publishCommand } from "./machinery.ts";
import { commentsAbove } from "./retire.ts";
import { pairLines } from "./text-edit.ts";
import type { DetectedGitLabJob, DetectedTarget, Evidence } from "./types.ts";

/** Where init moves the templates the target jobs extend (`gitlab.include`). */
export const TEMPLATES_FILE = ".gitlab/ci-templates.yml";

/** Words in job names that say what a job does, not what it builds (`package:windows`). */
const GENERIC_WORDS = new Set([
  "build",
  "package",
  "pkg",
  "release",
  "publish",
  "deploy",
  "upload",
  "dist",
  "job",
  "tag",
  "tags",
  "ship",
  "make",
]);

/** A target name for a job (`package:windows` → `windows`, `site:release` → `site`). */
export function targetNameForJob(job: string): string {
  const words = job
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "");
  const kept = words.filter((w) => !GENERIC_WORDS.has(w));
  return (kept.length > 0 ? kept : words).join("-") || "job";
}

/** PowerShell in a script: its variables, cmdlets and parameters. */
const POWERSHELL =
  /\$env:|\b(?:Invoke-(?:WebRequest|RestMethod|Expression)|Get-(?:CimInstance|Command|ChildItem|Content)|Start-(?:Process|Sleep)|Stop-Process|Set-(?:Location|Content)|Write-(?:Host|Error|Output)|Test-Path|Remove-Item|New-Item|Copy-Item|Join-Path|Resolve-Path)\b|\s-ErrorAction\b/;

const flatStrings = (value: unknown): string[] => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(flatStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(flatStrings);
  return [];
};

/** The shell of a job's runner, from its scripts (through `extends`) and runner tags. */
function shellOf(ci: GitLabCi, job: GitLabJob): Pick<DetectedGitLabJob, "shell" | "shellEvidence"> {
  const evidence: Evidence[] = [];
  for (const key of ["hooks", "before_script", "script"]) {
    const found = effectiveFrom(ci, job, key);
    if (!found) continue;
    const line = flatStrings(found.value).find((l) => POWERSHELL.test(l));
    if (line === undefined) continue;
    const match = POWERSHELL.exec(line)?.[0]?.trim();
    evidence.push({
      path: found.job.path,
      line: found.job.line,
      note: `${key} of ${found.job === job ? "the job" : found.job.name} is PowerShell (${match})`,
    });
    break;
  }
  const tags = effectiveFrom(ci, job, "tags");
  const windows = flatStrings(tags?.value).find((t) => /windows|\bwin(?:\d+)?\b/i.test(t));
  if (tags && windows) {
    evidence.push({
      path: tags.job.path,
      line: tags.job.line,
      note: `${tags.job === job ? "the job runs" : `${tags.job.name} runs`} on runners tagged ${windows}`,
    });
  }
  return { shell: evidence.length > 0 ? "powershell" : "sh", shellEvidence: evidence };
}

/** What a tag job makes: artifacts, a deployment, or a publish or push command. */
function output(ci: GitLabCi, job: GitLabJob): string | undefined {
  const artifacts = effective(ci, job, "artifacts") as Record<string, unknown> | undefined;
  const paths = flatStrings(artifacts?.paths);
  if (paths.length > 0) {
    return `keeps ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ", …" : ""} as artifacts`;
  }
  if (effective(ci, job, "environment") !== undefined) return "deploys to an environment";
  const script = flatStrings(effective(ci, job, "script"));
  const push = script.find((l) => publishCommand(l) !== undefined);
  if (push !== undefined) {
    const line = push.replace(/\s+/g, " ").trim();
    return `publishes (\`${line.length > 72 ? `${line.slice(0, 71)}…` : line}\`)`;
  }
  // A job only release tags start is release work, whatever it does: once its tag rules go
  // nothing runs it, so it becomes a target rather than quietly disappearing.
  if (runsOnlyOnTags(ci, job)) {
    const own = script.find((l) => !/^\s*(?:echo|printf|true|:)(?:\s|$)/.test(l));
    if (own !== undefined) {
      const line = own.replace(/\s+/g, " ").trim();
      return `only runs for tags (\`${line.length > 72 ? `${line.slice(0, 71)}…` : line}\`)`;
    }
  }
  return undefined;
}

/** Jobs that are release machinery, not a build: launchset replaces them (retire). */
function isMachineryOnly(ci: GitLabCi, job: GitLabJob): boolean {
  if (effective(ci, job, "release") !== undefined) return true;
  const kinds = flatStrings(effective(ci, job, "script")).flatMap(gitlabCommandKinds);
  return kinds.some((k) => k === "tag-creation" || k === "changesets" || k === "release-tool");
}

const needsOf = (job: GitLabJob): string[] => {
  const needs = Array.isArray(job.data.needs) ? job.data.needs : [];
  const out = needs.flatMap((n) =>
    typeof n === "string"
      ? [n]
      : n && typeof n === "object" && typeof (n as Record<string, unknown>).job === "string"
        ? [(n as Record<string, unknown>).job as string]
        : [],
  );
  const dependencies = Array.isArray(job.data.dependencies) ? job.data.dependencies : [];
  return [...out, ...dependencies.filter((d): d is string => typeof d === "string")];
};

/**
 * Custom targets from the GitLab jobs that run on tags and keep artifacts, deploy or publish:
 * one per job, named from the job (`name` makes it unique). Jobs that build a Dockerfile a
 * Docker target covers (`skipJobs`) and release machinery (`release:`, tag or release commands)
 * are left out. A `needs` between two such jobs becomes `after`.
 */
export function gitlabJobTargets(
  ci: GitLabCi,
  options: { skipJobs: ReadonlySet<GitLabJob>; name: (base: string) => string },
): DetectedTarget[] {
  const found: { job: GitLabJob; target: DetectedTarget }[] = [];
  for (const job of ci.jobs.values()) {
    if (job.hidden || !runsOnTags(ci, job) || options.skipJobs.has(job)) continue;
    if (isMachineryOnly(ci, job)) continue;
    const makes = output(ci, job);
    if (makes === undefined) continue;
    const name = options.name(targetNameForJob(job.name));
    const reason = `GitLab job "${job.name}" runs on tags and ${makes}`;
    found.push({
      job,
      target: {
        name,
        type: "custom",
        dir: ".",
        files: [],
        builtBy: [{ path: job.path, line: job.line, note: reason }],
        proposed: "auto",
        reason,
        ask: true,
        gitlab: {
          job: job.name,
          path: job.path,
          line: job.line,
          ...shellOf(ci, job),
          after: [],
          templates: templatesOf(ci, job).map((t) => ({
            name: t.name,
            path: t.path,
            line: t.line,
          })),
        },
      },
    });
  }
  const byJob = new Map(found.map((f) => [f.job.name, f.target.name]));
  for (const { job, target } of found) {
    const after = needsOf(job)
      .map((n) => byJob.get(n))
      .filter((n): n is string => n !== undefined && n !== target.name);
    if (target.gitlab) target.gitlab.after = [...new Set(after)];
  }
  return found.map((f) => f.target);
}

/** The jobs whose Docker builds a detected Docker target covers (they aren't custom targets). */
export function dockerTargetJobs(
  ci: GitLabCi,
  builds: readonly { job: GitLabJob; file: string }[],
  dockerfiles: ReadonlySet<string>,
): Set<GitLabJob> {
  const out = new Set<GitLabJob>();
  for (const build of builds) {
    if (!dockerfiles.has(build.file)) continue;
    for (const user of usersOf(ci, build.job)) out.add(user);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prefilling .launchset-<target>

/** Keys the child pipeline decides (or that point at jobs it doesn't have): not copied. */
const DROPPED_KEYS = new Set([
  "rules",
  "only",
  "except",
  "when",
  "needs",
  "dependencies",
  "stage",
  "allow_failure",
  "parallel",
  "trigger",
  "release",
  "start_in",
  "manual_confirmation",
]);

/** The text of a job's block (its comment lines above it through its last line). */
export function jobBlock(text: string, pair: Pair): { start: number; end: number; text: string } {
  const [s, e] = pairLines(text, pair);
  const start = commentsAbove(text, s);
  return { start, end: e, text: text.slice(start, e) };
}

/** Re-indent lines from `from` to `to` (lines with less indentation stay as they are). */
function reindent(text: string, from: string, to: string): string {
  if (from === to) return text;
  return text
    .split("\n")
    .map((line) => (line.startsWith(from) ? `${to}${line.slice(from.length)}` : line))
    .join("\n");
}

/**
 * `.launchset-<target>` for a custom target from a GitLab job: its keys copied as written
 * (comments included), except `rules`, `needs`, `stage` and the other keys the child pipeline
 * decides. `$CI_COMMIT_TAG` becomes `$LAUNCHSET_TAG`: the child pipeline runs for a branch
 * commit, with no tag.
 */
export function prefillTargetJob(ci: GitLabCi, target: DetectedTarget): string | undefined {
  const source = target.gitlab;
  const job = source ? ci.jobs.get(source.job) : undefined;
  const file = job ? ci.files.find((f) => f.path === job.path) : undefined;
  if (!source || !job || !file) return undefined;
  const dropped: string[] = [];
  const parts: string[] = [];
  for (const item of (job.map as YAMLMap).items) {
    const key = isScalar(item.key) ? String((item.key as Scalar).value) : undefined;
    if (key === undefined) continue;
    if (DROPPED_KEYS.has(key)) {
      dropped.push(key);
      continue;
    }
    const block = jobBlock(file.text, item as Pair);
    const indent = indentAt(file.text, (item.key as Scalar).range?.[0] ?? block.start);
    parts.push(reindent(block.text.replace(/\r\n/g, "\n").replace(/\n$/, ""), indent, "  "));
  }
  let body = parts.join("\n");
  const tagVariable = /\bCI_COMMIT_TAG\b/.test(body);
  body = body.replace(/\bCI_COMMIT_TAG\b/g, "LAUNCHSET_TAG");
  const notes = [
    `--- ${target.name} (custom): from your job ${source.job} (${source.path}:${source.line}) ---`,
    `init copied the job's keys${dropped.length > 0 ? `, except ${dropped.join(", ")} (the child pipeline decides when the job runs${dropped.includes("needs") ? `; needs became "after" in launchset.config` : ""})` : ""}.`,
  ];
  const image = effective(ci, job, "image");
  const imageName =
    typeof image === "string"
      ? image
      : image && typeof image === "object" && typeof (image as { name?: unknown }).name === "string"
        ? ((image as { name: string }).name as string)
        : undefined;
  if (source.shell === "powershell") {
    notes.push(
      "launchset runs in this job: the runner needs Node 24 or later, npm and git on its PATH.",
    );
  } else if (imageName !== undefined && !/^node:|-node\b|nodejs/i.test(imageName)) {
    notes.push(
      `launchset runs in this job: its image (${imageName}) needs Node 24 or later, npm and git.`,
      /alpine/i.test(imageName)
        ? "Add `apk add --no-cache nodejs-current npm git` to its before_script."
        : "Install them in its before_script (or use an image that has them).",
    );
  }
  notes.push(
    "Previews run these steps too (LAUNCHSET_CHANNEL is preview): publish to release channels",
    'only when LAUNCHSET_CHANNEL is release, or leave the target out of "preview.targets".',
  );
  if (tagVariable) {
    notes.push(
      "$CI_COMMIT_TAG became $LAUNCHSET_TAG (the release tag, v<version>): the child pipeline runs",
      "for the release commit on a branch, not for a tag.",
    );
  }
  const lines = [
    "",
    ...notes.map((n) => `# ${n}`),
    `${targetJobName(target.name)}:`,
    body === "" ? "  script: []" : body,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The templates the target jobs extend

export interface TemplatePlan {
  /** Hidden jobs to move into {@link TEMPLATES_FILE}, with their files. */
  move: { job: GitLabJob; file: GitLabFile }[];
  /** Included files that already hold only templates: added to `gitlab.include` as they are. */
  include: string[];
  /** Templates that can't be moved, and why (anchors, aliases). */
  blocked: { name: string; why: string }[];
}

/** YAML anchors, aliases or merge keys in a block: moving it to another file would break them. */
function usesAnchors(text: string): boolean {
  return /(^|[\s[{,])[&*][A-Za-z0-9_-]+|<<\s*:/m.test(text.replace(/#.*$/gm, ""));
}

/** Which templates the target jobs need, and how the child pipeline gets them. */
export function planTemplates(ci: GitLabCi, targets: readonly DetectedTarget[]): TemplatePlan {
  const plan: TemplatePlan = { move: [], include: [], blocked: [] };
  const safe = new Map<string, boolean>();
  const childSafe = (file: GitLabFile) => {
    let ok = safe.get(file.path);
    if (ok === undefined) {
      try {
        checkTemplateFile(file.path, file.text);
        ok = file.path !== ci.files[0]?.path;
      } catch {
        ok = false;
      }
      safe.set(file.path, ok);
    }
    return ok;
  };
  for (const target of targets) {
    for (const t of target.gitlab?.templates ?? []) {
      const job = ci.jobs.get(t.name);
      const file = job ? ci.files.find((f) => f.path === job.path) : undefined;
      if (!job || !file) continue;
      if (childSafe(file)) {
        if (!plan.include.includes(file.path)) plan.include.push(file.path);
        continue;
      }
      if (plan.move.some((m) => m.job === job) || plan.blocked.some((b) => b.name === t.name)) {
        continue;
      }
      if (job.anchored || usesAnchors(jobBlock(file.text, job.pair).text)) {
        plan.blocked.push({ name: t.name, why: "it uses YAML anchors or aliases" });
        continue;
      }
      plan.move.push({ job, file });
    }
  }
  return plan;
}

/** The header of {@link TEMPLATES_FILE}. */
export const TEMPLATES_HEADER = [
  "# Hidden job templates (names starting with a dot) that .gitlab-ci.yml and launchset's child",
  "# pipeline share: .gitlab-ci.yml includes this file, and so does the child pipeline",
  "# (gitlab.include in launchset.config), so the .launchset-<target> jobs in",
  "# .gitlab/launchset-targets.yml can extend them. launchset init moved them here unchanged.",
  "#",
  "# Only hidden jobs, variables and default: a visible job here would run in every child pipeline",
  "# (launchset checks this file before it writes the child pipeline).",
].join("\n");

/** The moved templates' text, in their order in the source files. */
export function templatesText(plan: TemplatePlan): string {
  return plan.move
    .map(({ job, file }) => jobBlock(file.text, job.pair).text.replace(/\r\n/g, "\n"))
    .map((block) => block.replace(/\n+$/, ""))
    .join("\n\n");
}

/** 1-based line of a template in its file (for evidence). */
export function templateLine(file: GitLabFile, job: GitLabJob): number {
  return lineOf(file.text, jobBlock(file.text, job.pair).start);
}
