/**
 * `launchset init` (spec 11.1): detect, decide, write.
 *
 * Modes:
 * - `--detect [--json]`: steps 1–3 plus the decisions; writes nothing ({@link InitDetectJson}).
 * - interactive (TTY, no `--yes`): asks every decision, default preselected.
 * - `--yes [--decide id=value …]` (or no TTY): no prompts, defaults for undecided ids.
 * - `--convert-only`: only step 6, converting `.changeset/*.md`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { applyEdits, modify, parseTree } from "jsonc-parser";
import semver from "semver";
import { CHANGELOG_TITLE } from "../core/changelog.ts";
import { resolveConfig, TARGET_NAME } from "../core/config/schema.ts";
import { LaunchsetError } from "../core/errors.ts";
import { ciOf } from "../core/hosts.ts";
import { joinWords } from "../core/plan-common.ts";
import { renderTag } from "../core/tags.ts";
import { REQUIRED_APP_PERMISSIONS } from "../forge/github/permissions.ts";
import { stampForRelease, writeChanges } from "../platforms/index.ts";
import { GITLAB_FILES } from "../templates/gitlab.ts";
import { renderWorkflows } from "../templates/workflows.ts";
import { installSkill } from "./agents.ts";
import {
  buildConfig,
  CONFIG_FILE,
  guardedTargets,
  type KeptTargetFile,
  renderConfigSource,
} from "./config-source.ts";
import type { PlannedConversion } from "./convert.ts";
import {
  DELETE_CHANGESET_HINT,
  findChangesets,
  PRE_MODE_WARNING,
  planConversion,
  writeConversion,
} from "./convert.ts";
import { type Answers, resolveDecisions } from "./decisions.ts";
import { type DetectContext, detect } from "./detect.ts";
import { INIT_FLAGS } from "./flags.ts";
import { insertPubspecVersion } from "./flutter.ts";
import { absolute, joinRel, readTextOrNull } from "./fs.ts";
import { pickStage } from "./gitlab-edit.ts";
import { gitlabStages, hasWorkflowRules } from "./gitlab-scan.ts";
import {
  type GitLabPlan,
  gitlabManualSteps,
  gitlabSweepStep,
  planGitLab,
  writeGitLabRoot,
  writeTargetsFile,
  writeTemplatesFile,
} from "./gitlab-write.ts";
import { installHook } from "./hooks.ts";
import { readPackageFile } from "./package-files.ts";
import { clackPrompter } from "./prompter.ts";
import { applyRetirement } from "./retire.ts";
import { jsonFormatting } from "./text-edit.ts";

const PLACEHOLDER_WARNING = (p: PlannedConversion) =>
  `${p.from} has a bump but no summary; ${p.to} got a TODO placeholder summary.`;
const PLACEHOLDER_STEP = (p: PlannedConversion) =>
  `Write the changelog summary in ${p.to} (it says "TODO: describe this change").`;

import type {
  Change,
  Decision,
  Detection,
  InitDetectJson,
  InitOptions,
  InitOutput,
  InitResult,
} from "./types.ts";

export { INIT_FLAGS, type InitFlag, parseDecide } from "./flags.ts";
export { packageFile, packageRoot } from "./package-files.ts";
export { clackPrompter } from "./prompter.ts";
export type * from "./types.ts";

function explicitAnswers(options: InitOptions, ctx: DetectContext): Answers {
  const answers: Answers = { ...options.decide };
  const hasHook = ctx.detection.hooks.some((h) => !h.installed);
  for (const flag of INIT_FLAGS) {
    const value = options[flag.option];
    if (!flag.decision || typeof value !== "boolean") continue;
    if (flag.decision === "hook" && !hasHook) {
      if (value) {
        throw new LaunchsetError(
          "no-hook-setup",
          ctx.detection.hooks.length > 0
            ? "--hook: the pre-push hook already runs `launchset check --push`."
            : "--hook: no pre-push hook setup found (simple-git-hooks, husky or lefthook).",
          { hint: "init only adds the check to an existing hook setup." },
        );
      }
      continue;
    }
    const v = value ? "yes" : "no";
    const decided = answers[flag.decision];
    if (decided !== undefined && decided !== v) {
      throw new LaunchsetError(
        "invalid-decision",
        `${value ? flag.flag : flag.flag.replace("--", "--no-")} conflicts with --decide ${flag.decision}=${decided}.`,
      );
    }
    answers[flag.decision] = v;
  }
  return answers;
}

/**
 * `--decide target.<name>=custom` declares a custom target (released automatically) that
 * detection didn't find, so a project init detects nothing in can be set up; its build steps go
 * in the CI files by hand. For a custom target init did detect, `custom` means `auto`.
 */
function declareTargets(ctx: DetectContext, answers: Answers): Answers {
  const out = { ...answers };
  for (const [id, value] of Object.entries(answers)) {
    const name = /^target\.(.+)$/.exec(id)?.[1];
    if (name === undefined || value !== "custom") continue;
    const found = ctx.detection.targets.find((t) => t.name === name);
    if (found && found.type !== "custom") {
      throw new LaunchsetError(
        "invalid-decision",
        `--decide ${id}=custom: ${name} is a detected ${found.type} target.`,
        {
          hint: `Answer auto, manual or none for it, or declare the custom target under another name.`,
        },
      );
    }
    if (!found) {
      if (!TARGET_NAME.test(name)) {
        throw new LaunchsetError(
          "invalid-decision",
          `--decide ${id}=custom: "${name}" isn't a valid target name.`,
          {
            hint: "Target names are lowercase letters, digits and dashes, starting with a letter or digit.",
          },
        );
      }
      ctx.detection.targets.push({
        name,
        type: "custom",
        dir: ".",
        files: [],
        builtBy: [],
        proposed: "auto",
        reason: `declared with --decide ${id}=custom`,
        declared: true,
      });
    }
    out[id] = "auto";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Output

function consoleOutput(): InitOutput {
  return {
    log: (line) => process.stdout.write(`${line}\n`),
    warn: (line) => process.stderr.write(`Warning: ${line}\n`),
    json: (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`),
  };
}

function at(path: string, line?: number): string {
  return line ? `${path}:${line}` : path;
}

/** The host line and the GitLab CI summary (only when something points at GitLab). */
function describeHost(ctx: DetectContext): string[] {
  if (!ctx.host.gitlabSignals) return [];
  const out = [
    `Host: ${ctx.host.host} (${ctx.host.evidence.map((e) => e.note).join("; ")})${ctx.host.ask ? " (check this)" : ""}`,
  ];
  const ci = ctx.gitlab;
  if (ci && ci.files.length > 0) {
    const stages = gitlabStages(ci);
    const stage = stages ? pickStage(stages.stages) : undefined;
    out.push(
      `GitLab CI: ${ci.files.map((f) => f.path).join(", ")}; ${stages ? `stages ${stages.stages.join(", ")} (launchset's jobs would go in ${stage ?? "test"})` : "no stages: (launchset's jobs go in test)"}; ${hasWorkflowRules(ci) ? "has workflow: rules" : "no workflow: rules (init prints the recommended ones)"}`,
    );
  }
  return out;
}

/** Human-readable summary of the detection (detect mode and the start of interactive mode). */
export function describeDetection(
  d: Detection,
  decisions: Decision[],
  ctx?: DetectContext,
): string[] {
  const out: string[] = ctx ? describeHost(ctx) : [];
  out.push("Versions found:");
  if (d.versions.length === 0) out.push("  (none)");
  for (const v of d.versions.filter((x) => x.source !== "tag")) {
    out.push(`  ${at(v.path, v.line)}  ${v.key} = ${v.value}`);
  }
  const tags = d.tags.slice(-5).map((t) => t.tag);
  if (d.tags.length > 0) out.push(`  tags: ${d.tags.length} (latest: ${tags.join(", ")})`);
  out.push(`  canonical: ${d.canonical.version} (${d.canonical.reason})`);
  out.push("Targets:");
  for (const t of d.targets) {
    out.push(
      `  ${t.name} (${t.type}${t.source ? `, ${String(t.source.kind)}` : ""}): ${t.proposed}, ${t.reason}`,
    );
  }
  if (d.machinery.length > 0) {
    out.push("Release machinery that conflicts with launchset:");
    for (const m of d.machinery)
      out.push(`  ${at(m.path, m.line)}  ${m.what}: it ${m.reasons.join("; it ")}`);
  }
  if (d.imagePins.length > 0) {
    out.push("Deploy manifests pinning an image:");
    for (const p of d.imagePins)
      out.push(`  ${p.path}  ${p.image}:${p.refs.map((r) => r.tag).join(", ")}`);
  }
  const b = d.buildNumbers;
  out.push(
    `Build numbers: ${b.highest ? `highest ${b.highest.value} (${at(b.highest.path, b.highest.line)})` : "none found"}; timestamp strategy now ${b.strategyNow}${b.offset > 0 ? `; offset ${b.offset} needed` : ""}`,
  );
  for (const n of d.notes)
    out.push(
      `${n.level === "warning" ? "Warning" : "Note"}: ${n.path ? `${at(n.path, n.line)}: ` : ""}${n.message}`,
    );
  if (decisions.length > 0) {
    out.push("Decisions (default in brackets; answer with --decide <id>=<value>):");
    for (const decision of decisions) {
      out.push(
        `  ${decision.id} [${decision.default}]${decision.ask ? " (check this)" : ""}: ${decision.question}`,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

export async function runInit(options: InitOptions): Promise<InitResult> {
  const root = resolve(options.cwd);
  const out = options.output ?? consoleOutput();
  const lines: string[] = [];
  const warnings: string[] = [];
  const log = (line: string) => {
    lines.push(line);
    if (!options.json) out.log(line);
  };
  const warn = (line: string) => {
    warnings.push(line);
    lines.push(`Warning: ${line}`);
    if (!options.json) out.warn(line);
  };

  if (options.convertOnly && options.detect) {
    throw new LaunchsetError(
      "invalid-flags",
      "--convert-only writes files, so it can't be combined with --detect.",
      { hint: "Run `launchset init --detect` and `launchset init --convert-only` separately." },
    );
  }
  if (options.convertOnly) return convertOnly(root, options, { log, warn, out, lines, warnings });

  const ctx = await detect(root, options.now ? { now: options.now } : {});
  const explicit = declareTargets(ctx, explicitAnswers(options, ctx));

  if (options.detect) {
    const { decisions, answers } = await resolveDecisions(ctx, { explicit });
    const json: InitDetectJson = { schemaVersion: 1, detection: ctx.detection, decisions };
    if (options.json) out.json(json);
    else for (const line of describeDetection(ctx.detection, decisions, ctx)) log(line);
    return { mode: "detect", detect: json, answers, changes: [], warnings, manualSteps: [], lines };
  }

  if (ctx.detection.existingConfig) {
    throw new LaunchsetError(
      "already-initialized",
      `${ctx.detection.existingConfig} already exists, so init won't overwrite it.`,
      {
        hint: "Delete it to run init again, or use `launchset init --convert-only` to convert Changesets files only.",
      },
    );
  }

  const interactive = options.interactive && !options.yes;
  const prompter = interactive ? (options.prompter ?? clackPrompter()) : undefined;
  if (prompter?.note) {
    prompter.note(
      describeDetection(ctx.detection, [], ctx).join("\n"),
      "launchset init: what was found",
    );
  }
  const { answers } = await resolveDecisions(ctx, {
    explicit,
    ...(prompter ? { ask: (d, validate) => prompter.ask(d, validate) } : {}),
  });

  const result = await writeAll(root, ctx, answers, options, { log, warn });
  const manualSteps = result.manualSteps;
  log("");
  log("Changes:");
  for (const c of result.changes)
    log(`  ${c.action.padEnd(8)} ${c.path}${c.summary ? `  (${c.summary})` : ""}`);
  if (manualSteps.length > 0) {
    log("");
    log("What's left to do:");
    manualSteps.forEach((s, i) => {
      log(`  ${i + 1}. ${s}`);
    });
  }
  if (options.json) out.json({ answers, changes: result.changes, warnings, manualSteps });
  if (prompter?.note)
    prompter.note(`${result.changes.length} files changed. See the list above.`, "Done");
  return { mode: "write", answers, changes: result.changes, warnings, manualSteps, lines };
}

interface Log {
  log(line: string): void;
  warn(line: string): void;
}

async function convertOnly(
  root: string,
  options: InitOptions,
  io: Log & { out: InitOutput; lines: string[]; warnings: string[] },
): Promise<InitResult> {
  const found = await findChangesets(root);
  const planned = await planConversion(root, found);
  const changes = await writeConversion(root, planned);
  const manualSteps: string[] = [];
  for (const p of planned.filter((x) => x.placeholder && !x.exists)) {
    io.warn(PLACEHOLDER_WARNING(p));
    manualSteps.push(PLACEHOLDER_STEP(p));
  }
  if (found.preMode) io.warn(PRE_MODE_WARNING);
  if (found.files.length === 0) io.log("No .changeset/*.md files to convert.");
  for (const c of changes) io.log(`  ${c.action.padEnd(8)} ${c.path}  (${c.summary})`);
  const skipped = planned.filter((p) => p.exists);
  if (skipped.length > 0) io.log(`  ${skipped.length} already converted.`);
  if (found.files.length > 0) manualSteps.push(DELETE_CHANGESET_HINT);
  for (const s of manualSteps) io.log(s);
  if (options.json) io.out.json({ changes, warnings: io.warnings, manualSteps });
  return {
    mode: "convert-only",
    answers: {},
    changes,
    warnings: io.warnings,
    manualSteps,
    lines: io.lines,
  };
}

async function writeText(
  root: string,
  path: string,
  text: string,
  summary: string,
): Promise<Change | null> {
  const file = absolute(root, path);
  const before = await readTextOrNull(file);
  if (before === text) return null;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  return { path, action: before === null ? "created" : "updated", summary };
}

async function writeAll(
  root: string,
  ctx: DetectContext,
  answers: Answers,
  options: InitOptions,
  io: Log,
): Promise<{ changes: Change[]; manualSteps: string[] }> {
  const d = ctx.detection;
  const version = answers.version as string;
  const changes: Change[] = [];
  const manualSteps: string[] = [
    "Review the changes (`git status`, `git diff`), commit them and open a pull request.",
  ];

  // --- Plan everything first, so a problem stops init before anything is written.
  const kept = await keptTargetFile(root, ctx, answers);
  const plan = buildConfig(ctx, answers, kept ? { kept } : {});
  const resolved = resolveConfig(plan.config, { file: CONFIG_FILE });
  const configSource = renderConfigSource(plan);
  const conversions = await planConversion(root, d.changesets);
  const host = answers.host ?? ctx.host.host;
  const gitlab: GitLabPlan | undefined =
    ciOf(host) === "gitlab-ci"
      ? planGitLab(ctx, resolved, plan, { moveTemplates: answers["gitlab.templates"] === "move" })
      : undefined;
  const workflows = gitlab
    ? []
    : renderWorkflows({
        config: resolved,
        hints: plan.hints,
        allPreviewSteps: true,
        ...(options.actionRef ? { actionRef: options.actionRef } : {}),
      });
  const readme = readPackageFile("templates", "launchset-readme.md");
  const chosen = ctx.machinery
    .filter((m) => m.item.actions.length > 1)
    .map((m) => ({
      finding: m,
      action: (answers[m.item.id] ?? "keep") as "remove" | "disable" | "keep",
    }));
  // Moving the templates the target jobs extend: removed from their files with the retirement.
  const moves = gitlab?.templates
    ? [{ finding: gitlab.templates.finding, action: "remove" as const }]
    : [];
  await applyRetirement(root, [...chosen, ...moves], { write: false });
  const overwrite = (path: string) => answers[`file.${path}`] !== "keep";

  for (const v of d.versions) {
    // Compare the value as written (2.0.0-rc.1 too), or its plain form (1.0 → 1.0.0).
    const value = semver.valid(v.value) ?? v.plain;
    if (v.source !== "tag" && !v.ignored && value && semver.gt(value, version)) {
      io.warn(
        `${at(v.path, v.line)} ${v.key} goes down from ${v.value} to ${version} (decided explicitly).`,
      );
    }
  }

  // --- Root version file
  // A Flutter app's pubspec.yaml without a version gets one (the alignment below needs it).
  const versionFile = answers["version.file"];
  const pubspecs = new Set(
    plan.targets.flatMap((t) =>
      t.source?.kind === "flutter" ? [joinRel(String(t.source.dir), "pubspec.yaml")] : [],
    ),
  );
  const pubspecVersionFile = versionFile !== undefined && versionFile !== "package.json";
  if (pubspecVersionFile) pubspecs.add(versionFile);
  for (const path of pubspecs) {
    const text = (await readTextOrNull(absolute(root, path))) ?? "";
    if (/^version:[ \t]*\S/m.test(text)) continue;
    await writeFile(absolute(root, path), insertPubspecVersion(text, version));
    changes.push({ path, action: "updated", summary: `added "version: ${version}+1"` });
  }
  if (pubspecVersionFile) {
    // The pubspec.yaml holds the version: no package.json is needed.
  } else if (ctx.packageJsonText === null) {
    const name = (d.packageJson?.name ?? root.split(/[\\/]/).at(-1) ?? "app")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-");
    const text = `${JSON.stringify({ name, version, private: true }, null, 2)}\n`;
    const c = await writeText(
      root,
      "package.json",
      text,
      `holds the version ${version} (launchset's single source of truth)`,
    );
    if (c) changes.push(c);
  } else if (d.packageJson?.version === undefined) {
    const text = ctx.packageJsonText;
    const tree = parseTree(text);
    const edited = applyEdits(
      text,
      modify(text, ["version"], version, {
        formattingOptions: jsonFormatting(text),
        // Right after "name" when there is one, else first.
        getInsertionIndex: () => {
          const props = tree?.children ?? [];
          const at = props.findIndex((p) => p.children?.[0]?.value === "name");
          return at + 1;
        },
      }),
    );
    await writeFile(absolute(root, "package.json"), edited);
    changes.push({
      path: "package.json",
      action: "updated",
      summary: `added "version": "${version}"`,
    });
  }

  // --- Align every target file to the canonical version (text-preserving).
  const stamps = await stampForRelease(resolved, root, version);
  await writeChanges(stamps);
  for (const s of stamps) {
    const pin = d.imagePins.find((p) => p.path === s.path);
    if (pin) {
      const tags = [...new Set(pin.refs.map((r) => r.tag))].join(", ");
      changes.push({
        path: s.path,
        action: "updated",
        summary: `${pin.image} set to the release tag of ${version} (was ${tags})`,
      });
      io.warn(
        `${s.path} now points at the release tag of ${version}: make sure that image exists before you deploy it.`,
      );
      continue;
    }
    const was = d.versions
      .filter((v) => v.path === s.path && v.source !== "tag")
      .map((v) => v.value);
    const wasText = [...new Set(was)].join(", ");
    changes.push({
      path: s.path,
      action: "updated",
      summary: `version set to ${version}${wasText ? ` (was ${wasText})` : ""}`,
    });
  }

  // --- Config, README, workflows, changelog
  const configChange = await writeText(root, CONFIG_FILE, configSource, "launchset configuration");
  if (configChange) changes.push(configChange);
  const generated = [
    { path: ".launchset/README.md", content: readme, summary: "explains the folder" },
    ...workflows.map((w) => ({ path: w.path, content: w.content, summary: "launchset workflow" })),
    ...(gitlab ? [gitlab.jobs] : []),
  ];
  for (const g of generated) {
    if (!overwrite(g.path)) {
      const current = await readTextOrNull(absolute(root, g.path));
      if (current !== null && current !== g.content) {
        io.warn(
          `${g.path} already exists and differs from what init would write; it was kept (answer file.${g.path}=overwrite to replace it).`,
        );
      }
      continue;
    }
    const c = await writeText(root, g.path, g.content, g.summary);
    if (c) changes.push(c);
  }
  const writeIo = {
    warn: io.warn,
    writeText: (path: string, text: string, summary: string) =>
      writeText(root, path, text, summary),
  };
  if (gitlab) {
    const t = await writeTargetsFile(
      root,
      gitlab,
      answers[`file.${gitlab.targets.path}`] === "overwrite",
      writeIo,
    );
    changes.push(...t.changes);
    manualSteps.push(...t.manualSteps);
  }
  const changelogPath = resolved.changelog.file;
  if ((await readTextOrNull(absolute(root, changelogPath))) === null) {
    const c = await writeText(root, changelogPath, `${CHANGELOG_TITLE}\n`, "new changelog");
    if (c) changes.push(c);
  }

  // --- Retire conflicting machinery
  const retired = await applyRetirement(root, [...chosen, ...moves], { write: true });
  if (gitlab) changes.push(...(await writeTemplatesFile(root, gitlab, writeIo)));
  changes.push(...retired.changes);
  // .gitlab-ci.yml after retirement: its edits were computed on the original text.
  const gitlabRootSteps: string[] = [];
  if (gitlab) {
    const r = await writeGitLabRoot(root, gitlab, writeIo);
    gitlabRootSteps.push(...r.manualSteps);
    if (r.change) {
      const earlier = changes.find((c) => c.path === r.change?.path);
      if (earlier) earlier.summary = [earlier.summary, r.change.summary].filter(Boolean).join("; ");
      else changes.push(r.change);
    }
  }

  // --- Convert Changesets files
  if (d.changesets.preMode) io.warn(PRE_MODE_WARNING);
  changes.push(...(await writeConversion(root, conversions)));
  for (const p of conversions.filter((x) => x.placeholder && !x.exists)) {
    io.warn(PLACEHOLDER_WARNING(p));
    manualSteps.push(PLACEHOLDER_STEP(p));
  }

  // --- Agent skill
  if (answers.skill === "yes") changes.push(...(await installSkill(root)));

  // --- Pre-push hook
  if (answers.hook === "yes") {
    const hook = d.hooks.find((h) => !h.installed);
    if (hook) {
      const r = await installHook(root, hook);
      if (r.change) changes.push(r.change);
      if (r.note) manualSteps.push(r.note);
      if (hook.tool === "simple-git-hooks" && r.change)
        manualSteps.push("Run `npx simple-git-hooks` to install the updated pre-push hook.");
    }
  }

  // --- Baseline: the release workflow creates the tag after the merge (see core/baseline.ts).
  const releaseTag = renderTag(resolved.tags.release, { version });
  if (resolved.baseline !== undefined) {
    manualSteps.push(baselineStep(ctx, answers, releaseTag, version, { github: !gitlab }));
  } else if (answers.baseline === "yes") {
    io.log(`${releaseTag} already exists; no baseline needed.`);
  } else if (!ctx.tagNames.includes(releaseTag)) {
    io.warn(
      `No baseline: nothing marks ${version} as released, so launchset treats it as unreleased. If ${version} was released, set a baseline (--baseline).`,
    );
  }

  // --- Manual steps
  const buildTargets = plan.targets.map((t) => t.name);
  const retiredPaths = chosen.filter((c) => c.action !== "keep").map((c) => c.finding.item.path);
  const secret = gitlab ? "CI/CD variable" : "secret";
  const secrets = gitlab ? "CI/CD variables" : "secrets";
  if (gitlab) {
    manualSteps.push(
      ...gitlabManualSteps(resolved, buildTargets, gitlab.prefilled),
      ...gitlabRootSteps,
    );
    const ciFiles = new Set((ctx.gitlab?.files ?? []).map((f) => f.path));
    const retiredCi = [
      ...new Set(retiredPaths.filter((p) => ciFiles.has(p) || p.startsWith(".github/workflows/"))),
    ];
    if (retiredCi.length > 0) {
      const copied = plan.targets.flatMap((t) => (t.gitlab ? [`"${t.gitlab.job}"`] : []));
      manualSteps.push(
        copied.length > 0
          ? `Check what's left in ${retiredCi.join(", ")}: init copied the steps of ${copied.join(", ")} into .gitlab/launchset-targets.yml; move any other build steps you still need there too.`
          : `Move the build steps you still need from ${retiredCi.join(", ")} into .gitlab/launchset-targets.yml (the comments there name the jobs that built each image), then check what's left in those files.`,
      );
    }
  } else {
    manualSteps.push(
      `Create the launchset GitHub App for your org if it doesn't exist (${REQUIRED_APP_PERMISSIONS.map((p) => `${p.name}: ${p.access}`).join(", ")}), install it on this repo, and add the variable LAUNCHSET_APP_CLIENT_ID (the App's Client ID) and the secret LAUNCHSET_APP_PRIVATE_KEY, unless the org has them already. See "GitHub App setup" in the docs.`,
    );
    manualSteps.push(
      `Add your build and upload steps for ${buildTargets.join(", ")} to .github/workflows/launchset-release.yml (and launchset-preview.yml for previews).`,
    );
    for (const t of plan.targets) {
      const e = t.github?.electronBuilder;
      if (!e) continue;
      manualSteps.push(
        `${t.name}: the steps init copied from job "${t.github?.job}" run electron-builder (${at(e.path, e.line)}: \`${e.command}\`). In CI electron-builder publishes to GitHub Releases by itself, also on the branch pushes launchset builds releases from, and fails with "GitHub Personal Access Token is not set" without GH_TOKEN. Pass --publish never to it (launchset creates the GitHub Release), or set GH_TOKEN on purpose if electron-builder should upload the files. Nothing to do if your electron-builder config already sets publish: null.`,
      );
    }
    if (resolved.preview.enabled) {
      manualSteps.push(
        `Create the ${resolved.preview.label} label if the repo doesn't have it (adding it to a PR builds a preview): \`gh label create ${resolved.preview.label} --description "Build a launchset preview"\`.`,
      );
    }
    const retiredWorkflows = [
      ...new Set(retiredPaths.filter((p) => p.startsWith(".github/workflows/"))),
    ];
    if (retiredWorkflows.length > 0) {
      manualSteps.push(
        `Move the build steps you still need from ${retiredWorkflows.join(", ")} into launchset-release.yml, then check what's left in those files.`,
      );
    }
    if (!(await hasActionUpdater(root))) {
      manualSteps.push(DEPENDABOT_HINT);
    }
  }
  manualSteps.push(...retired.followUps);
  const guarded = guardedTargets(ctx, plan.targets, gitlab !== undefined, kept);
  if (resolved.preview.enabled && guarded.length > 0) {
    manualSteps.push(
      `Previews build ${resolved.preview.targets === "all" ? "every target" : resolved.preview.targets.length > 0 ? `only ${joinWords(resolved.preview.targets)}` : "no target yet"}: ${joinWords(guarded)} ${guarded.length === 1 ? "has" : "have"} only the "build steps missing" placeholder, which fails on purpose. Add ${guarded.length === 1 ? "it" : "them"} to preview.targets in ${CONFIG_FILE} once ${guarded.length === 1 ? "its" : "their"} build steps are in.`,
    );
  }
  const android = plan.targets.filter((t) => t.type === "android").map((t) => t.name);
  if (android.length > 0) {
    manualSteps.push(
      `Optional: to check build numbers against Google Play (${android.join(", ")}), set store.packageName and verify: ["store"] on the target and add the ${secret} LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON.`,
    );
  }
  const ios = plan.targets.filter((t) => t.type === "ios").map((t) => t.name);
  if (ios.length > 0) {
    manualSteps.push(
      `Optional: to check build numbers against App Store Connect (${ios.join(", ")}), set store.appId and verify: ["store"] on the target and add the ${secrets} LAUNCHSET_ASC_KEY_ID, LAUNCHSET_ASC_ISSUER_ID and LAUNCHSET_ASC_PRIVATE_KEY.`,
    );
  }
  if (android.length + ios.length > 0) {
    manualSteps.push(
      "init doesn't ask the stores for their build numbers. If a store already has higher ones, `launchset verify` stops the upload and says which offset to use: set it as buildNumber.offset in launchset.config.ts.",
    );
  }
  if (gitlab && resolved.preview.enabled && resolved.preview.rebuildOnPush) {
    manualSteps.push(gitlabSweepStep(resolved));
  }
  for (const m of ctx.machinery) {
    const action = m.item.actions.length > 1 ? answers[m.item.id] : "keep";
    if (action !== "keep") continue;
    if (m.item.kinds.includes("release-docs")) {
      manualSteps.push(
        `Update the release instructions in ${at(m.item.path, m.item.line)} by hand: releases now go through launchset's release PR (no npm version, git tag or changeset commands).`,
      );
    } else {
      manualSteps.push(
        `Still in place because you chose keep: ${m.item.what} (${at(m.item.path, m.item.line)}). It ${m.item.reasons.join("; it ")}.`,
      );
      io.warn(`${m.item.id} is kept: it ${m.item.reasons[0]}.`);
    }
  }
  if (d.changesets.files.length > 0) manualSteps.push(DELETE_CHANGESET_HINT);
  for (const n of d.notes) {
    if (n.manual) manualSteps.push(`${n.path ? `${at(n.path, n.line)}: ` : ""}${n.message}`);
  }
  return { changes, manualSteps };
}

/**
 * The init summary's suggestion to let Dependabot keep the workflows' actions current. init
 * doesn't write `.github/dependabot.yml` itself: it is repo-wide config the team owns (other
 * ecosystems, schedules, grouping, or Renovate instead), and it would also open PRs for
 * workflows that aren't launchset's. See design/DECISIONS.md.
 */
export const DEPENDABOT_HINT =
  'Optional: let Dependabot keep the actions in your workflows current (launchset never rewrites the workflow files it wrote). Add .github/dependabot.yml with `version: 2` and an update for `package-ecosystem: github-actions`, `directory: /`, `schedule: { interval: weekly }`. See "Keep the actions current" in the docs.';

/** Dependabot or Renovate config files: either already updates GitHub Actions refs. */
const ACTION_UPDATER_FILES = [
  ".github/dependabot.yml",
  ".github/dependabot.yaml",
  "renovate.json",
  "renovate.json5",
  ".github/renovate.json",
  ".github/renovate.json5",
  ".renovaterc",
  ".renovaterc.json",
  ".renovaterc.json5",
];

/** Whether the repo has a Dependabot or Renovate config (which may already cover actions). */
async function hasActionUpdater(root: string): Promise<boolean> {
  for (const path of ACTION_UPDATER_FILES) {
    if ((await readTextOrNull(absolute(root, path))) !== null) return true;
  }
  return false;
}

/**
 * The file with the preview build steps when init keeps the existing one (see
 * {@link KeptTargetFile}): `launchset-preview.yml` answered `keep`, or the GitLab targets file
 * not answered `overwrite`.
 */
async function keptTargetFile(
  root: string,
  ctx: DetectContext,
  answers: Answers,
): Promise<KeptTargetFile | undefined> {
  const gitlab = ciOf(answers.host ?? ctx.host.host) === "gitlab-ci";
  const path = gitlab ? GITLAB_FILES.targets : ".github/workflows/launchset-preview.yml";
  const keep = gitlab
    ? answers[`file.${path}`] !== "overwrite"
    : answers[`file.${path}`] === "keep";
  if (!keep) return undefined;
  const text = await readTextOrNull(absolute(root, path));
  return text === null ? undefined : { text };
}

/**
 * The "What's left to do" step for `baseline`: what happens after the merge, and why the tag
 * must not be created by hand (spec 11.1 step 5). Names the tag-triggered workflows a hand-made
 * tag at HEAD would start.
 */
function baselineStep(
  ctx: DetectContext,
  answers: Answers,
  tag: string,
  version: string,
  options: { github: boolean },
): string {
  const tagJobs = ctx.machinery.filter((m) => m.item.kinds.includes("tag-trigger"));
  const triggered = [...new Set(tagJobs.map((m) => m.item.path))];
  const kept = [
    ...new Set(
      tagJobs
        .filter((m) => (m.item.actions.length > 1 ? answers[m.item.id] : "keep") === "keep")
        .map((m) => m.item.path),
    ),
  ];
  const why =
    triggered.length > 0
      ? `Don't create or push ${tag} yourself: pushing a tag runs the workflows of the commit it points to, and on HEAD that would start ${triggered.join(", ")} (they still run on tags there), which would build or publish ${version} again.`
      : `Don't create or push ${tag} yourself: pushing a tag runs the tag-triggered workflows of the commit it points to.`;
  // On GitLab the tag is pushed with ci.skip; on GitHub kept tag workflows still run for it.
  const keptNote =
    options.github && kept.length > 0
      ? ` You kept ${kept.join(", ")}, which still ${kept.length === 1 ? "runs" : "run"} on tags: ${kept.length === 1 ? "it runs" : "they run"} for ${tag} too when the release workflow creates it.`
      : "";
  return `After the merge, the first release workflow run on the base branch creates ${tag} at the merge commit (baseline: "${version}" in ${CONFIG_FILE}), so ${version} counts as released without a build. ${why}${keptNote} Once ${tag} exists you can remove baseline from the config.`;
}
