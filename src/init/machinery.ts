/**
 * Existing release machinery that conflicts with launchset (spec 11.1 step 1, "Existing
 * release machinery"), with the edits each action (`remove`, `disable`) would make.
 * Read-only: `retire.ts` applies the edits.
 *
 * Rules for `disable` (it never deletes a file):
 * - triggers: remove the conflicting tag patterns / filter / trigger, or make a plain
 *   `push` skip tags; a workflow left without triggers gets `workflow_dispatch`;
 * - steps: remove the step, or only the conflicting commands of its `run` script. A command
 *   is deleted only when that's structurally safe, otherwise it's replaced by the no-op `:`
 *   plus a `# launchset: disabled — …` comment; commands in heredocs or compound lines get
 *   no disable;
 * - references to a removed step or job (`steps.<id>.…`, `needs.<job>.…`) are listed as
 *   evidence here and as manual steps after writing; they don't block `disable`.
 */

import { isMap, isScalar, isSeq, type Pair, parseDocument, type YAMLMap } from "yaml";
import { joinRel, lineAt, linesOf, normalizeRel } from "./fs.ts";
import { matchesFilter } from "./github-filter.ts";
import type { Evidence, MachineryAction, MachineryItem, MachineryKind } from "./types.ts";
import {
  type DockerBuild,
  type LatestRef,
  type RunCommand,
  runCommands,
  type ScalarRef,
  type Workflow,
  type WorkflowJob,
  type WorkflowStep,
} from "./workflow-scan.ts";

// ---------------------------------------------------------------------------
// Edits

export type WorkflowOp =
  | { op: "remove-step"; job: WorkflowJob; step: WorkflowStep }
  | { op: "remove-commands"; job: WorkflowJob; step: WorkflowStep; commands: RunCommand[] }
  | {
      op: "neutralize-commands";
      job: WorkflowJob;
      step: WorkflowStep;
      commands: RunCommand[];
      reason: string;
    }
  | { op: "remove-run-line"; job: WorkflowJob; step: WorkflowStep; line: number }
  | { op: "remove-latest"; job: WorkflowJob; step: WorkflowStep; refs: LatestRef[] }
  /** Some (not all) patterns of `on.push.tags`. */
  | { op: "remove-tag-patterns"; patterns: ScalarRef[] }
  /** A `tags` / `tags-ignore` filter of a push that also has a branch filter. */
  | { op: "remove-filter"; pair: Pair }
  /** A whole trigger of the `on` map (`push`, `release`). */
  | { op: "remove-trigger"; pair: Pair }
  /** Make an unfiltered `push` skip tags. */
  | { op: "exclude-tags" };

export type Edit =
  | { kind: "delete-file"; path: string }
  | { kind: "workflow"; path: string; workflow: Workflow; op: WorkflowOp }
  | { kind: "gitlab-job"; path: string; text: string; pair: Pair }
  | {
      kind: "script";
      /** The package.json. */
      path: string;
      script: string;
      /** `&&`-separated parts to drop; undefined drops the whole entry. */
      segments?: string[];
    }
  /** Comment out lines (Ruby/shell `#`), e.g. fastlane version actions. */
  | { kind: "comment-lines"; path: string; lines: number[]; reason: string };

export interface MachineryFinding {
  item: MachineryItem;
  edits: Partial<Record<Exclude<MachineryAction, "keep">, Edit[]>>;
}

export interface PackageScripts {
  /** package.json path. */
  path: string;
  dir: string;
  scripts: Record<string, string>;
  /** 1-based line of each script entry. */
  lines: Record<string, number>;
}

export interface MachineryInput {
  workflows: Workflow[];
  dockerBuilds: DockerBuild[];
  packages: PackageScripts[];
  /** Script files to inspect (repo-relative) with their text. */
  scriptFiles: { path: string; text: string }[];
  /** `.gitlab-ci.yml` text, if present. */
  gitlab?: { path: string; text: string };
  /** Fastfiles with their text. */
  fastfiles: { path: string; text: string }[];
  /** CLAUDE.md, AGENTS.md, README with their text. */
  docs: { path: string; text: string }[];
  /** Tags launchset would push, to test tag filters against (see {@link sampleTags}). */
  samples?: { tag: string; what: string }[];
}

// ---------------------------------------------------------------------------
// Patterns

const CHANGESET_COMMAND = /\bchangeset\s+(version|status|publish|tag|pre)\b/;
const TAG_COMMANDS: RegExp[] = [
  /\bgit\s+tag\s+(?:-[asfmu]\b|--(?:annotate|sign|force|message)\b|["'$\w])/,
  /\bgit\s+push\b[^\n]*(?:--tags|--follow-tags|refs\/tags\/|\s["']?v\$|\s["']?v\d)/,
  /\bgh\s+release\s+create\b/,
  /\bcreateRelease\b/,
  /\b(?:npm|pnpm)\s+version\b(?![^\n]*--no-git-tag-version)/,
];
const RELEASE_TOOL_COMMAND =
  /\b(?:semantic-release|release-it|standard-version|release-please|commit-and-tag-version)\b/;
const VERSION_KEYS =
  /\b(MARKETING_VERSION|CURRENT_PROJECT_VERSION|versionCode|versionName|CFBundleVersion|CFBundleShortVersionString)\b/;
const VERSION_WRITE_COMMANDS = [
  /\bagvtool\s+(?:new-version|new-marketing-version|next-version|bump)\b/,
  /PlistBuddy[^\n]*Set\s*:?\s*(?:CFBundleVersion|CFBundleShortVersionString)/,
];
const FILE_WRITE =
  /\b(?:writeFile|writeFileSync|outputFile|outputFileSync|appendFile)\b|\bfs\.write\b|\bsed\s+(?:-\w*\s+)*-i|\bagvtool\b|PlistBuddy|File\.write|\.write_text\(|open\([^)]*["']w/;
const RELEASE_ACTIONS =
  /^(?:softprops\/action-gh-release|actions\/create-release|ncipollo\/release-action|marvinpinto\/action-automatic-releases|elgohr\/Github-Release-Action|mathieudutour\/github-tag-action|anothrNick\/github-tag-action|rickstaa\/action-create-tag)$/;
const RELEASE_TOOL_ACTIONS =
  /^(?:googleapis\/release-please-action|google-github-actions\/release-please-action|cycjimmy\/semantic-release-action|codfish\/semantic-release-action)$/;
const FASTLANE_WRITERS =
  /^\s*(?:increment_build_number|increment_version_number|increment_version_code|android_set_version_code|android_set_version_name|increment_version_name)\b|set_info_plist_value[^\n]*CFBundle(?:Short)?Version/;
const DOC_LINES = /\bnpm\s+version\b|\bgit\s+tag\b|\bchangesets?\b/i;
/** Steps that publish or deploy something (for unfiltered `push` workflows). */
const PUBLISH_COMMAND =
  /\b(?:npm|pnpm|yarn)\s+publish\b|\bgh\s+release\b|\bdocker\s+(?:buildx\s+build[^\n]*--push|push)\b|\bkubectl\s+(?:apply|set\s+image|rollout)\b|\bhelm\s+(?:upgrade|install)\b|\b(?:vercel|netlify|flyctl|fly|wrangler|firebase|eas)\s+(?:deploy|publish|submit)\b|\baws\s+s3\s+(?:sync|cp)\b|\bfastlane\b|\btwine\s+upload\b|\bcargo\s+publish\b/;
const PUBLISH_ACTION =
  /deploy|gh-pages|action-gh-release|create-release|release-action|publish|upload-google-play|upload-testflight|vercel|netlify|wrangler|firebase|ssh-action/i;

const REASON: Record<MachineryKind, string> = {
  "tag-trigger":
    "fires again when launchset pushes its tags (with the App token), so its build or publish steps run a second time",
  "release-trigger":
    "fires when launchset's finalize creates the GitHub Release, so its steps run for every release",
  changesets:
    "runs Changesets, which opens its own release PR and bumps versions; launchset's release PR replaces it",
  "release-tool":
    "runs another release tool (semantic-release, release-it, standard-version or release-please), which bumps versions and creates tags or releases; launchset does that now",
  "tag-creation":
    "creates release tags or GitHub Releases, which launchset's finalize creates (it would create v{version} before finalize)",
  "docker-latest":
    "moves the Docker latest tag on branch pushes; launchset moves latest only when a release ships",
  "version-writer":
    "writes version or build numbers (MARKETING_VERSION, CURRENT_PROJECT_VERSION, versionCode, versionName), which would overwrite what launchset stamps in CI",
  "changesets-write":
    "writes Changesets files (@changesets/write); launchset reads .launchset/ instead",
  "release-docs":
    "describes the old release process (npm version, git tag, changeset); launchset releases through the release PR",
};

/** Short reasons for `# launchset: disabled — <reason>` comments. */
const SHORT: Record<MachineryKind, string> = {
  "tag-trigger": "runs on launchset's tags",
  "release-trigger": "runs on launchset's releases",
  changesets: "Changesets is replaced by launchset",
  "release-tool": "launchset does the releases now",
  "tag-creation": "launchset's finalize creates tags and releases",
  "docker-latest": "launchset moves latest when a release ships",
  "version-writer": "launchset stamps versions and build numbers",
  "changesets-write": "launchset reads .launchset/",
  "release-docs": "launchset releases through the release PR",
};

/** The machinery kinds a shell command matches. */
export function commandKinds(command: string): MachineryKind[] {
  const kinds: MachineryKind[] = [];
  if (CHANGESET_COMMAND.test(command)) kinds.push("changesets");
  if (RELEASE_TOOL_COMMAND.test(command)) kinds.push("release-tool");
  if (TAG_COMMANDS.some((t) => t.test(command))) kinds.push("tag-creation");
  if (
    VERSION_WRITE_COMMANDS.some((p) => p.test(command)) ||
    (/\bsed\b/.test(command) && /\s-i\b|\s-i['"]/.test(command) && VERSION_KEYS.test(command))
  ) {
    kinds.push("version-writer");
  }
  return kinds;
}

/** The machinery kinds of a script file's content. */
export function scriptFileKinds(text: string): { kinds: MachineryKind[]; line: number } {
  const kinds: MachineryKind[] = [];
  let line = 0;
  const lines = linesOf(text);
  const first = (pattern: RegExp) => lines.find((l) => pattern.test(l.text))?.number ?? 0;
  const note = (kind: MachineryKind, at: number) => {
    if (at === 0) return;
    kinds.push(kind);
    if (line === 0 || at < line) line = at;
  };
  note("changesets", first(CHANGESET_COMMAND));
  note("release-tool", first(RELEASE_TOOL_COMMAND));
  const tagLines = TAG_COMMANDS.map((t) => first(t)).filter((n) => n > 0);
  note("tag-creation", tagLines.length > 0 ? Math.min(...tagLines) : 0);
  if (FILE_WRITE.test(text)) note("version-writer", first(VERSION_KEYS));
  note("changesets-write", first(/@changesets\/write/));
  return { kinds, line };
}

/** Tags launchset pushes, for a set of release tag formats and target names (spec 2, 9.6, 9.9). */
export function sampleTags(
  releaseFormats: string[],
  targets: string[],
): { tag: string; what: string }[] {
  const out: { tag: string; what: string }[] = [];
  const add = (tag: string, what: string) => {
    if (!out.some((o) => o.tag === tag)) out.push({ tag, what });
  };
  for (const format of new Set(["v{version}", ...releaseFormats])) {
    add(format.replace("{version}", "1.2.3"), `release tag ${format}`);
    add(format.replace("{version}", "1.2.3-alpha.0"), `prerelease tag ${format}`);
  }
  for (const target of targets.length > 0 ? targets : ["web"]) {
    add(`launchset/${target}@1.2.3`, "marker tag launchset/{target}@{version}");
  }
  add("launchset/partial/1.2.3", "partial tag launchset/partial/{version}");
  return out;
}

const DEFAULT_SAMPLES = sampleTags([], []);

// ---------------------------------------------------------------------------
// Workflows

interface Draft {
  kinds: MachineryKind[];
  path: string;
  line: number;
  what: string;
  /** `disable` edits; undefined when no minimal edit exists. */
  disable?: Edit[];
  /** `remove` edits. */
  remove: Edit[];
  effects: Partial<Record<MachineryAction, string>>;
  evidence: Evidence[];
  /** Why there's no `disable`. */
  why?: string;
  /** Overrides the default reasons of the kinds. */
  reasons?: string[];
}

function addKind(draft: Draft, kind: MachineryKind) {
  if (!draft.kinds.includes(kind)) draft.kinds.push(kind);
}

function isFlowMap(node: unknown): boolean {
  return isMap(node) && (node as YAMLMap).flow === true;
}

/** True when a workflow pushes images, publishes packages or deploys. */
export function publishesOrDeploys(workflow: Workflow, builds: DockerBuild[]): boolean {
  if (builds.some((b) => b.workflow === workflow && b.pushes)) return true;
  return workflow.jobs.some((job) =>
    job.steps.some((step) => {
      const uses = step.uses?.replace(/@.*/, "") ?? "";
      if (
        uses &&
        !/^actions\/(?:upload|download)-artifact$/.test(uses) &&
        PUBLISH_ACTION.test(uses)
      ) {
        return true;
      }
      if (uses === "docker/build-push-action" && step.with.get("push")?.value !== "false") {
        return step.with.has("push");
      }
      return step.run !== undefined && PUBLISH_COMMAND.test(step.run.value);
    }),
  );
}

function workflowEdit(workflow: Workflow, op: WorkflowOp): Edit {
  return { kind: "workflow", path: workflow.path, workflow, op };
}

function triggerDrafts(
  workflow: Workflow,
  samples: { tag: string; what: string }[],
  publishes: boolean,
): Draft[] {
  const t = workflow.triggers;
  const drafts: Draft[] = [];
  const base = (line: number, what: string): Draft => ({
    kinds: ["tag-trigger"],
    path: workflow.path,
    line,
    what,
    remove: [{ kind: "delete-file", path: workflow.path }],
    effects: { remove: "deletes the workflow file", keep: "leaves it as is" },
    evidence: [],
  });
  const flowPush = isFlowMap(t.pair?.value) || isFlowMap(t.pushPair?.value);
  const removePush = (d: Draft, filter: Pair | undefined, label: string) => {
    if (flowPush) {
      d.why = "the trigger is written in flow style ({ ... }); edit it by hand";
      return;
    }
    if (t.hasBranchFilter && filter) {
      d.disable = [workflowEdit(workflow, { op: "remove-filter", pair: filter })];
      d.effects.disable = `removes the on.push.${label} filter (branch pushes still run it)`;
    } else if (t.pushPair) {
      d.disable = [workflowEdit(workflow, { op: "remove-trigger", pair: t.pushPair })];
      d.effects.disable =
        "removes the push trigger (workflow_dispatch replaces it when no other trigger is left)";
    }
  };

  if (t.tagsPair) {
    const conflicting = t.tagPatterns.filter((p) =>
      samples.some((s) => matchesFilter([p.value], s.tag)),
    );
    if (conflicting.length > 0) {
      const d = base(
        conflicting[0]?.line ?? 1,
        `workflow trigger on.push.tags: ${t.tagPatterns.map((p) => p.value).join(", ")}`,
      );
      d.evidence = conflicting.map((p) => ({
        path: workflow.path,
        line: p.line,
        note: `tag pattern ${p.value} matches ${samples
          .filter((s) => matchesFilter([p.value], s.tag))
          .map((s) => s.tag)
          .join(", ")}`,
      }));
      if (conflicting.length < t.tagPatterns.length && isSeq(t.tagsPair.value) && !flowPush) {
        d.disable = [workflowEdit(workflow, { op: "remove-tag-patterns", patterns: conflicting })];
        d.effects.disable = `removes ${conflicting.map((p) => p.value).join(", ")} from on.push.tags`;
      } else {
        removePush(d, t.tagsPair, "tags");
      }
      drafts.push(d);
    }
  } else if (t.tagsIgnorePair) {
    const ignore = t.tagsIgnore.map((p) => p.value);
    const firing = samples.filter((s) => !matchesFilter(ignore, s.tag));
    if (firing.length > 0) {
      const line = lineAt(
        workflow.text,
        (t.tagsIgnorePair.key as { range?: number[] }).range?.[0] ?? 0,
      );
      const d = base(line, `workflow trigger on.push.tags-ignore: ${ignore.join(", ")}`);
      d.evidence = [
        {
          path: workflow.path,
          line,
          note: `tags-ignore doesn't exclude ${firing.map((s) => s.tag).join(", ")}`,
        },
      ];
      removePush(d, t.tagsIgnorePair, "tags-ignore");
      drafts.push(d);
    }
  } else if (t.unfilteredPush && publishes) {
    const line = lineAt(
      workflow.text,
      ((t.pushPair ?? t.pair)?.key as { range?: number[] } | undefined)?.range?.[0] ?? 0,
    );
    const d = base(line, "workflow trigger on: push (no branch or tag filter)");
    d.reasons = ["runs on every push, including launchset's tags, and it publishes or deploys"];
    d.evidence = [
      { path: workflow.path, line, note: "push without filters runs for every pushed tag too" },
    ];
    const onValue = t.pair?.value;
    const supported =
      !isFlowMap(onValue) &&
      !isFlowMap(t.pushPair?.value) &&
      (isScalar(onValue) ||
        (isSeq(onValue) && onValue.items.every((i) => isScalar(i))) ||
        t.pushPair !== undefined);
    if (supported) {
      d.disable = [workflowEdit(workflow, { op: "exclude-tags" })];
      d.effects.disable =
        'adds branches: ["**"] and tags-ignore: ["**"] to the push trigger, so tags no longer start it';
    } else {
      d.why = "the triggers are written in flow style; edit them by hand";
    }
    drafts.push(d);
  }

  const release = t.release;
  if (
    release &&
    (release.types === null ||
      release.types.some((x) => ["published", "created", "released"].includes(x)))
  ) {
    const d = base(
      release.line,
      `workflow trigger on.release${release.types ? ` (types: ${release.types.join(", ")})` : ""}`,
    );
    d.kinds = ["release-trigger"];
    d.evidence = [
      {
        path: workflow.path,
        line: release.line,
        note: release.types ? `release types ${release.types.join(", ")}` : "every release event",
      },
    ];
    if (release.pair && !isFlowMap(t.pair?.value)) {
      d.disable = [workflowEdit(workflow, { op: "remove-trigger", pair: release.pair })];
      d.effects.disable =
        "removes the release trigger (workflow_dispatch replaces it when no other trigger is left)";
    } else {
      d.why = "the triggers are a list or flow style; edit them by hand";
    }
    drafts.push(d);
  }
  return drafts;
}

/** Lines of a run script that invoke one of the script files (handled by that file's item). */
function invokesScriptFile(command: string, scriptPaths: string[], wd: string): boolean {
  return scriptPaths.some((p) => {
    const rel = wd === "." ? p : p.startsWith(`${wd}/`) ? p.slice(wd.length + 1) : p;
    return command.includes(p) || command.includes(rel);
  });
}

/**
 * Edits that take `commands` out of a step (all of them: the step goes), or `undefined`
 * when one of them can't be taken out safely.
 */
function commandEdits(
  workflow: Workflow,
  job: WorkflowJob,
  step: WorkflowStep,
  commands: RunCommand[],
  all: RunCommand[],
  reason: string,
): Edit[] | undefined {
  if (commands.length === all.length) {
    return [workflowEdit(workflow, { op: "remove-step", job, step })];
  }
  if (commands.some((c) => c.removal === null)) return undefined;
  const del = commands.filter((c) => c.removal === "delete");
  const neutral = commands.filter((c) => c.removal === "neutralize");
  const edits: Edit[] = [];
  if (del.length > 0)
    edits.push(workflowEdit(workflow, { op: "remove-commands", job, step, commands: del }));
  if (neutral.length > 0) {
    edits.push(
      workflowEdit(workflow, { op: "neutralize-commands", job, step, commands: neutral, reason }),
    );
  }
  return edits;
}

function commandEffect(edits: Edit[], step: WorkflowStep): string {
  const ops = edits.map((e) => (e.kind === "workflow" ? e.op.op : ""));
  if (ops.includes("remove-step")) return `removes ${step.label}`;
  const parts: string[] = [];
  if (ops.includes("remove-commands")) parts.push("removes the conflicting commands");
  if (ops.includes("neutralize-commands")) {
    parts.push(
      "turns the conflicting commands inside if/for/case or a chain into `:` no-ops with a `# launchset: disabled` comment",
    );
  }
  return `${parts.join(" and ")} from ${step.label}`;
}

/** Places outside `step` that use its outputs (`steps.<id>.…`). */
function stepReferences(workflow: Workflow, job: WorkflowJob, step: WorkflowStep): Evidence[] {
  if (!step.id) return [];
  const [start, end] = step.node.range ?? [0, 0];
  const [jobStart, jobEnd] = job.node.range ?? [0, workflow.text.length];
  const pattern = new RegExp(`\\bsteps\\.${step.id.replace(/[-]/g, "\\-")}\\.`, "g");
  const found: Evidence[] = [];
  for (const m of workflow.text.matchAll(pattern)) {
    const at = m.index;
    if (at < jobStart || at >= jobEnd || (at >= start && at < end)) continue;
    found.push({
      path: workflow.path,
      line: lineAt(workflow.text, at),
      note: `uses steps.${step.id} outputs: check it once the step is gone`,
    });
  }
  return found;
}

function stepDrafts(workflow: Workflow, builds: DockerBuild[], scriptPaths: string[]): Draft[] {
  const drafts = new Map<WorkflowStep, Draft>();
  const draftFor = (job: WorkflowJob, step: WorkflowStep): Draft => {
    let d = drafts.get(step);
    if (!d) {
      d = {
        kinds: [],
        path: workflow.path,
        line: step.line,
        what: `${step.label} in job "${job.id}"`,
        disable: [],
        remove: [{ kind: "delete-file", path: workflow.path }],
        effects: { remove: "deletes the workflow file", keep: "leaves it as is" },
        evidence: [],
      };
      drafts.set(step, d);
    }
    return d;
  };
  const removeStep = (d: Draft, job: WorkflowJob, step: WorkflowStep) => {
    d.disable = [workflowEdit(workflow, { op: "remove-step", job, step })];
    d.effects.disable = `removes ${step.label} from job "${job.id}"`;
  };

  for (const job of workflow.jobs) {
    for (const step of job.steps) {
      const uses = step.uses?.replace(/@.*/, "");
      const script = step.with.get("script")?.value ?? "";
      const usesKind: MachineryKind | undefined =
        uses === "changesets/action"
          ? "changesets"
          : uses && RELEASE_TOOL_ACTIONS.test(uses)
            ? "release-tool"
            : (uses && RELEASE_ACTIONS.test(uses)) ||
                (uses === "actions/github-script" &&
                  /createRelease|createTag|refs\/tags\//.test(script))
              ? "tag-creation"
              : undefined;
      if (usesKind) {
        const d = draftFor(job, step);
        addKind(d, usesKind);
        d.evidence.push({ path: workflow.path, line: step.line, note: `uses ${uses}` });
        removeStep(d, job, step);
        continue;
      }
      if (!step.run) continue;
      const wd = step.workingDirectory ? normalizeRel(step.workingDirectory) : ".";
      const matched: RunCommand[] = [];
      const all = runCommands(step.run, workflow.text);
      const kindsFound: MachineryKind[] = [];
      for (const command of all) {
        if (invokesScriptFile(command.command, scriptPaths, wd)) continue;
        const kinds = commandKinds(command.command);
        if (kinds.length === 0) continue;
        const d = draftFor(job, step);
        for (const k of kinds) {
          addKind(d, k);
          if (!kindsFound.includes(k)) kindsFound.push(k);
        }
        d.evidence.push({
          path: workflow.path,
          line: command.lines[0]?.number ?? step.line,
          note: `runs \`${command.command.slice(0, 80)}\``,
        });
        matched.push(command);
      }
      if (matched.length > 0) {
        const d = draftFor(job, step);
        const edits = commandEdits(
          workflow,
          job,
          step,
          matched,
          all,
          SHORT[kindsFound[0] as MachineryKind],
        );
        if (edits) {
          d.disable = edits;
          d.effects.disable = commandEffect(edits, step);
        } else {
          d.disable = undefined;
          d.why =
            "a conflicting command is part of a heredoc or a compound line (if/case on one line); edit it by hand";
        }
      }
    }
  }

  // Docker latest on branch pushes.
  if (workflow.triggers.onBranchPush) {
    for (const build of builds) {
      if (!build.pushes) continue;
      const byStep = new Map<WorkflowStep, LatestRef[]>();
      for (const ref of build.latest) {
        const list = byStep.get(ref.step) ?? [];
        list.push(ref);
        byStep.set(ref.step, list);
      }
      for (const [step, refs] of byStep) {
        const d = draftFor(build.job, step);
        const hadDisable = (d.disable?.length ?? 0) > 0;
        addKind(d, "docker-latest");
        for (const ref of refs) {
          d.evidence.push({ path: workflow.path, line: ref.line, note: `pushes ${ref.entry}` });
        }
        if (hadDisable) {
          // Already removing the step (or commands); a latest edit on top would overlap.
          d.disable = undefined;
          d.why = "it both runs a release command and pushes latest; remove or edit it by hand";
          continue;
        }
        const runRefs = refs.filter((r) => r.run);
        if (runRefs.length > 0) {
          const noDisable = (why: string) => {
            d.disable = undefined;
            d.why = why;
          };
          if (runRefs.some((r) => !r.run?.removal)) {
            noDisable("the latest tag is part of a longer command that can't be edited safely");
            continue;
          }
          const all = step.run ? runCommands(step.run, workflow.text) : [];
          const commands = runRefs
            .filter((r) => r.run?.removal === "command")
            .map((r) => r.run?.command as RunCommand);
          if (commands.length > 0 && commands.length === all.length) {
            noDisable("pushing latest is all this step does; remove it or keep it");
            continue;
          }
          const commandOps =
            commands.length > 0
              ? commandEdits(workflow, build.job, step, commands, all, SHORT["docker-latest"])
              : [];
          if (commandOps === undefined) {
            noDisable(
              "the command that pushes latest can't be taken out safely (heredoc or compound line)",
            );
            continue;
          }
          d.disable = [
            ...commandOps,
            ...runRefs
              .filter((r) => r.run?.removal === "line")
              .map((r) =>
                workflowEdit(workflow, {
                  op: "remove-run-line",
                  job: build.job,
                  step,
                  line: r.run?.lineNumber as number,
                }),
              ),
          ];
        } else {
          // The only tag being latest would leave an empty tags input.
          const entries = new Map<unknown, number>();
          for (const r of refs.filter((x) => !x.flavor)) {
            entries.set(r.node, (entries.get(r.node) ?? 0) + 1);
          }
          const onlyLatest = [...entries].some(([node, count]) => {
            const value = String((node as { value?: unknown }).value ?? "");
            const total = value
              .split(/[\n,]/)
              .map((x) => x.trim())
              .filter((x) => x !== "" && !x.startsWith("#")).length;
            return total <= count;
          });
          if (onlyLatest) {
            d.disable = undefined;
            d.why =
              "latest is the only tag it pushes, so removing it would leave an empty tags input";
            continue;
          }
          d.disable = [workflowEdit(workflow, { op: "remove-latest", job: build.job, step, refs })];
        }
        d.effects.disable = `stops pushing latest from ${step.label}`;
      }
    }
  }
  for (const [step, d] of drafts) {
    d.line = Math.min(...d.evidence.map((e) => e.line ?? d.line));
    const removesStep = d.disable?.some((e) => e.kind === "workflow" && e.op.op === "remove-step");
    if (removesStep) {
      const job = workflow.jobs.find((j) => j.steps.includes(step)) as WorkflowJob;
      const refs = stepReferences(workflow, job, step);
      if (refs.length > 0) {
        d.evidence.push(...refs);
        d.effects.disable = `${d.effects.disable} (check ${refs.map((r) => `line ${r.line}`).join(", ")}: it uses the step's outputs)`;
      }
    }
  }
  return [...drafts.values()];
}

// ---------------------------------------------------------------------------
// GitLab

/** Top-level `.gitlab-ci.yml` keys that aren't jobs. */
const GITLAB_RESERVED = new Set([
  "default",
  "include",
  "stages",
  "variables",
  "workflow",
  "image",
  "services",
  "cache",
  "before_script",
  "after_script",
  "types",
  "spec",
]);

function gitlabDrafts(path: string, text: string): Draft[] {
  const doc = parseDocument(text);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return [];
  const root = doc.contents as YAMLMap;
  const byName = new Map<string, YAMLMap>();
  for (const pair of root.items) {
    if (isScalar(pair.key) && isMap(pair.value))
      byName.set(String(pair.key.value), pair.value as YAMLMap);
  }
  /** `key` of a job, following `extends` (later templates win, the job's own value wins). */
  const effective = (job: YAMLMap, key: string, seen = new Set<YAMLMap>()): unknown => {
    if (seen.has(job)) return undefined;
    seen.add(job);
    const own = job.get(key, true);
    if (own !== undefined) return own;
    const ext = job.get("extends", true);
    const names = isSeq(ext)
      ? ext.items.map((i) => String((i as { value?: unknown }).value))
      : isScalar(ext)
        ? [String(ext.value)]
        : [];
    for (const name of [...names].reverse()) {
      const parent = byName.get(name);
      const value = parent ? effective(parent, key, seen) : undefined;
      if (value !== undefined) return value;
    }
    return undefined;
  };
  const json = (node: unknown) =>
    node && typeof node === "object" && "toJSON" in node
      ? JSON.stringify((node as { toJSON(): unknown }).toJSON())
      : "";
  const drafts: Draft[] = [];
  for (const pair of root.items) {
    if (!isScalar(pair.key) || !isMap(pair.value)) continue;
    const name = String(pair.key.value);
    if (GITLAB_RESERVED.has(name) || name.startsWith(".")) continue;
    const job = pair.value as YAMLMap;
    const onlyText = json(effective(job, "only"));
    const rulesText = json(effective(job, "rules"));
    const onTags =
      /"tags"/.test(onlyText) ||
      /(?<![!])\$CI_COMMIT_TAG(?!\s*==\s*null)(?!\s*==\s*"")/.test(rulesText);
    if (!onTags) continue;
    const line = lineAt(text, (pair.key as { range?: number[] }).range?.[0] ?? 0);
    drafts.push({
      kinds: ["tag-trigger"],
      path,
      line,
      what: `GitLab job "${name}" (runs on tags)`,
      disable: [{ kind: "gitlab-job", path, text, pair: pair as Pair }],
      remove: [{ kind: "delete-file", path }],
      effects: {
        disable: `removes the job "${name}"`,
        remove: `deletes ${path}`,
        keep: "leaves it as is",
      },
      evidence: [{ path, line, note: `job "${name}" runs on tag pipelines` }],
    });
  }
  return drafts;
}

// ---------------------------------------------------------------------------
// package.json scripts and script files

/** `&&`-separated parts of a script command. */
export function scriptSegments(command: string): string[] {
  return command.split(/\s*&&\s*/).filter((s) => s.trim() !== "");
}

function referencesFile(segment: string, file: string, packageDir: string): boolean {
  const rel =
    packageDir === "."
      ? file
      : file.startsWith(`${packageDir}/`)
        ? file.slice(packageDir.length + 1)
        : undefined;
  if (rel === undefined) return false;
  return new RegExp(
    `(?:^|[\\s"'=/])(?:\\./)?${rel.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?:$|[\\s"'])`,
  ).test(segment);
}

function scriptDrafts(pkg: PackageScripts, scriptPaths: string[]): Draft[] {
  const drafts: Draft[] = [];
  for (const [name, command] of Object.entries(pkg.scripts)) {
    const segments = scriptSegments(command);
    const matched: string[] = [];
    const kinds: MachineryKind[] = [];
    for (const segment of segments) {
      if (scriptPaths.some((p) => referencesFile(segment, p, pkg.dir))) continue;
      const found = commandKinds(segment);
      if (/@changesets\/write/.test(segment)) found.push("changesets-write");
      if (found.length === 0) continue;
      matched.push(segment);
      for (const k of found) if (!kinds.includes(k)) kinds.push(k);
    }
    if (matched.length === 0) continue;
    const line = pkg.lines[name] ?? 1;
    const everything = matched.length === segments.length;
    drafts.push({
      kinds,
      path: pkg.path,
      line,
      what: `script "${name}": ${command}`,
      disable: [
        everything
          ? { kind: "script", path: pkg.path, script: name }
          : { kind: "script", path: pkg.path, script: name, segments: matched },
      ],
      remove: [{ kind: "script", path: pkg.path, script: name }],
      effects: {
        disable: everything
          ? `removes the script "${name}"`
          : `removes ${matched.map((m) => `\`${m}\``).join(", ")} from the script "${name}"`,
        remove: `removes the script "${name}"`,
        keep: "leaves it as is",
      },
      evidence: [
        { path: pkg.path, line, note: `script "${name}" runs \`${matched.join(" && ")}\`` },
      ],
    });
  }
  return drafts;
}

function scriptFileDraft(
  file: { path: string; text: string },
  input: MachineryInput,
): Draft | undefined {
  const { kinds, line } = scriptFileKinds(file.text);
  if (kinds.length === 0) return undefined;
  const references: Edit[] = [];
  let unsafe = false;
  const evidence: Evidence[] = [{ path: file.path, line, note: "the script itself" }];
  for (const pkg of input.packages) {
    for (const [name, command] of Object.entries(pkg.scripts)) {
      const segments = scriptSegments(command);
      const hits = segments.filter((s) => referencesFile(s, file.path, pkg.dir));
      if (hits.length === 0) continue;
      references.push(
        hits.length === segments.length
          ? { kind: "script", path: pkg.path, script: name }
          : { kind: "script", path: pkg.path, script: name, segments: hits },
      );
      evidence.push({
        path: pkg.path,
        line: pkg.lines[name] ?? 1,
        note: `script "${name}" runs it`,
      });
    }
  }
  for (const workflow of input.workflows) {
    for (const job of workflow.jobs) {
      for (const step of job.steps) {
        if (!step.run) continue;
        const wd = step.workingDirectory ? normalizeRel(step.workingDirectory) : ".";
        const all = runCommands(step.run, workflow.text);
        const hits = all.filter((c) => invokesScriptFile(c.command, [file.path], wd));
        if (hits.length === 0) continue;
        const edits = commandEdits(
          workflow,
          job,
          step,
          hits,
          all,
          SHORT[kinds[0] as MachineryKind],
        );
        if (edits) references.push(...edits);
        else unsafe = true;
        evidence.push({
          path: workflow.path,
          line: hits[0]?.lines[0]?.number ?? step.line,
          note: `${step.label} runs it`,
        });
      }
    }
  }
  const draft: Draft = {
    kinds,
    path: file.path,
    line,
    what: `script file ${file.path}`,
    remove: [{ kind: "delete-file", path: file.path }, ...references],
    effects: {
      remove:
        references.length > 0
          ? `deletes ${file.path} and the ${references.length === 1 ? "place that runs" : "places that run"} it`
          : `deletes ${file.path}`,
      keep: "leaves it as is",
    },
    evidence,
  };
  if (unsafe) {
    draft.why = "a workflow runs it inside a heredoc or a compound line; edit that by hand";
  } else if (references.length > 0) {
    draft.disable = references;
    draft.effects.disable = `stops running it (${evidence
      .slice(1)
      .map((e) => `${e.path}:${e.line}`)
      .join(", ")}); the file stays`;
  } else {
    draft.why = "nothing in package.json or the workflows runs it, so there is nothing to disable";
  }
  return draft;
}

/** A Ruby line that continues on the next one. */
const RUBY_CONTINUES = /(?:\\|,|\(|\[|\{|\+|&&|\|\|)\s*$/;
/** A Ruby line that opens a block. */
const RUBY_BLOCK = /\bdo(?:\s*\|[^|]*\|)?\s*$/;

function fastfileDraft(file: { path: string; text: string }): Draft | undefined {
  const lines = linesOf(file.text);
  const hits = lines.filter((l) => FASTLANE_WRITERS.test(l.text) && !/LAUNCHSET_/.test(l.text));
  if (hits.length === 0) return undefined;
  const safe = hits.every((l) => {
    const open = (l.text.match(/[([{]/g) ?? []).length;
    const close = (l.text.match(/[)\]}]/g) ?? []).length;
    const prev = lines
      .slice(0, l.number - 1)
      .reverse()
      .find((p) => p.text.trim() !== "" && !p.text.trim().startsWith("#"));
    return (
      open === close &&
      !RUBY_CONTINUES.test(l.text) &&
      !RUBY_BLOCK.test(l.text) &&
      !(prev && RUBY_CONTINUES.test(prev.text))
    );
  });
  const draft: Draft = {
    kinds: ["version-writer"],
    path: file.path,
    line: hits[0]?.number ?? 1,
    what: `fastlane version actions in ${file.path}`,
    remove: [],
    effects: { keep: "leaves it as is" },
    evidence: hits.map((l) => ({ path: file.path, line: l.number, note: l.text.trim() })),
  };
  if (safe) {
    draft.disable = [
      {
        kind: "comment-lines",
        path: file.path,
        lines: hits.map((l) => l.number),
        reason: SHORT["version-writer"],
      },
    ];
    draft.effects.disable = `comments out ${hits.length === 1 ? "that line" : "those lines"} (# launchset: disabled — …)`;
  } else {
    draft.why = "a call spans several lines; edit it by hand";
  }
  return draft;
}

const AGENTS_START = "<!-- launchset:start -->";
const AGENTS_END = "<!-- launchset:end -->";

function docsDraft(file: { path: string; text: string }): Draft | undefined {
  let inside = false;
  const hits: { number: number; text: string }[] = [];
  for (const line of linesOf(file.text)) {
    if (line.text.includes(AGENTS_START)) inside = true;
    if (line.text.includes(AGENTS_END)) {
      inside = false;
      continue;
    }
    if (inside) continue;
    if (DOC_LINES.test(line.text) && !/launchset/i.test(line.text)) hits.push(line);
  }
  if (hits.length === 0) return undefined;
  return {
    kinds: ["release-docs"],
    path: file.path,
    line: hits[0]?.number ?? 1,
    what: `release instructions in ${file.path}`,
    remove: [],
    effects: { keep: "left as is: update these instructions by hand" },
    evidence: hits
      .slice(0, 10)
      .map((l) => ({ path: file.path, line: l.number, note: l.text.trim() })),
    why: "prose can't be edited automatically",
  };
}

// ---------------------------------------------------------------------------

/** Every conflicting piece of machinery, numbered per file. */
export function detectMachinery(input: MachineryInput): MachineryFinding[] {
  const samples = input.samples ?? DEFAULT_SAMPLES;
  const scriptItems = input.scriptFiles
    .map((f) => scriptFileDraft(f, input))
    .filter((d): d is Draft => d !== undefined);
  const scriptPaths = scriptItems.map((d) => d.path);
  const drafts: Draft[] = [];
  for (const workflow of input.workflows) {
    const builds = input.dockerBuilds.filter((b) => b.workflow === workflow);
    drafts.push(...triggerDrafts(workflow, samples, publishesOrDeploys(workflow, builds)));
    drafts.push(...stepDrafts(workflow, builds, scriptPaths));
  }
  if (input.gitlab) drafts.push(...gitlabDrafts(input.gitlab.path, input.gitlab.text));
  for (const pkg of input.packages) drafts.push(...scriptDrafts(pkg, scriptPaths));
  drafts.push(...scriptItems);
  for (const f of input.fastfiles) {
    const d = fastfileDraft(f);
    if (d) drafts.push(d);
  }
  for (const f of input.docs) {
    const d = docsDraft(f);
    if (d) drafts.push(d);
  }

  const byPath = new Map<string, Draft[]>();
  for (const d of drafts) {
    const list = byPath.get(d.path) ?? [];
    list.push(d);
    byPath.set(d.path, list);
  }
  const findings: MachineryFinding[] = [];
  for (const [path, list] of [...byPath].sort(([a], [b]) => a.localeCompare(b))) {
    list.sort((a, b) => a.line - b.line);
    list.forEach((d, index) => {
      const actions: MachineryAction[] = [];
      if (d.remove.length > 0) actions.push("remove");
      if (d.disable && d.disable.length > 0) actions.push("disable");
      actions.push("keep");
      const effects = { ...d.effects };
      if (!actions.includes("disable")) {
        delete effects.disable;
        if (d.why) effects.keep = `${effects.keep ?? "leaves it as is"} (no disable: ${d.why})`;
      }
      const item: MachineryItem = {
        id: `machinery.${path}#${index + 1}`,
        kinds: d.kinds,
        path,
        line: d.line,
        what: d.what,
        reasons: d.reasons ?? d.kinds.map((k) => REASON[k]),
        actions,
        effects,
        evidence: d.evidence,
      };
      const edits: MachineryFinding["edits"] = {};
      if (actions.includes("remove")) edits.remove = d.remove;
      if (d.disable && d.disable.length > 0) edits.disable = d.disable;
      findings.push({ item, edits });
    });
  }
  return findings;
}

/** Script file paths referenced from package.json scripts or workflow `run` lines. */
export function referencedScriptFiles(packages: PackageScripts[], workflows: Workflow[]): string[] {
  const found = new Set<string>();
  const pattern =
    /(?:^|[\s"'=])((?:\.\/)?[\w@./-]+\.(?:mjs|cjs|js|ts|mts|cts|sh|bash|rb|py))(?=$|[\s"';&|)])/g;
  for (const pkg of packages) {
    for (const command of Object.values(pkg.scripts)) {
      for (const m of command.matchAll(pattern)) {
        const p = normalizeRel(m[1] as string);
        if (!p.startsWith("node_modules/") && !p.includes("/node_modules/"))
          found.add(joinRel(pkg.dir, p));
      }
    }
  }
  for (const workflow of workflows) {
    for (const job of workflow.jobs) {
      for (const step of job.steps) {
        if (!step.run) continue;
        const wd = step.workingDirectory ? normalizeRel(step.workingDirectory) : ".";
        for (const m of step.run.value.matchAll(pattern)) {
          const p = normalizeRel(m[1] as string);
          if (!p.includes("node_modules/")) found.add(joinRel(wd, p));
        }
      }
    }
  }
  return [...found].sort();
}
