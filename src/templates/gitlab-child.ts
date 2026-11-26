/**
 * The GitLab child pipeline (design/GITLAB.md decisions 2 and 3): the `launchset-release` and
 * `launchset-preview-plan` jobs write it for their plan, and the parent's trigger job runs it.
 * It has exactly the jobs the plan needs: one `build-<target>` (or `preview-<target>`) job per
 * target in the matrix, which wraps the user's `.launchset-<target>` job from
 * `.gitlab/launchset-targets.yml` in `stamp` / `verify` / `mark`, then `launchset-finalize` for a
 * release or `launchset-preview-comment` for a preview. Nothing to build: a single
 * `launchset-nothing-to-build` job that says why (a child pipeline needs at least one job). Pure
 * apart from reading the template files.
 */

import type { GitLabShell } from "../core/config/schema.ts";
import { LaunchsetError } from "../core/errors.ts";
import type { Plan } from "../core/types.ts";
import { packageVersion } from "../init/package-files.ts";
import {
  checkGitLabYaml,
  defaultCliSpec,
  INSTALL_LINES,
  installItems,
  POWERSHELL_INSTALL_LINES,
  parseGitLabYaml,
  psChecked,
  psQuote,
  psWord,
  shellWord,
  yamlFlowScalar,
  yamlScalar,
} from "./gitlab-yaml.ts";
import { fillTemplate, readTemplateFile } from "./workflows.ts";

/** Where the user's build steps live (relative to the repository root). */
export const DEFAULT_TARGETS_FILE = ".gitlab/launchset-targets.yml";
/** The child pipeline file the plan jobs write (`LAUNCHSET_CHILD_PIPELINE`). */
export const DEFAULT_CHILD_FILE = "launchset-child.yml";
/** The plan jobs of `.gitlab/launchset.yml`. */
export const PLAN_JOBS = {
  release: "launchset-release",
  preview: "launchset-preview-plan",
} as const;

/** What the child pipeline needs to know about one target (from the config and targets file). */
export interface ChildTarget {
  /** The runner's shell (`gitlab.shell`), default `sh`. */
  shell?: GitLabShell;
  /** Targets whose jobs this one waits for, with their artifacts (`after`). */
  after?: readonly string[];
  /**
   * The user's `.launchset-<target>` job (with its `extends` and the included files' `default`)
   * sets `interruptible: false`: preview jobs keep it. Release jobs are never interruptible.
   */
  notInterruptible?: boolean;
}

export interface ChildPipelineInput {
  /** The plan; `undefined` when there is none (a skipped preview). */
  plan: Plan | undefined;
  kind: "release" | "preview";
  /** The targets file to include, relative to the repository root. */
  targetsFile?: string;
  /** Extra local files to include before the targets file (`gitlab.include`). */
  includes?: readonly string[];
  /** Per target: shell, `after`, interruptible (default: sh, none, interruptible previews). */
  targets?: Readonly<Record<string, ChildTarget>>;
  /** The parent job that has plan.json as an artifact (the job writing this file). */
  planJob: string;
  /**
   * The commit the pipeline runs at (`CI_COMMIT_SHA`). When the plan's release-sha differs (a
   * retry of an unfinished release, a merged results pipeline), every job checks it out first.
   */
  currentSha?: string;
  /** What jobs install with npm (`LAUNCHSET_CLI`), default `launchset@<this version>`. */
  cliSpec?: string;
  /** Why nothing is built (a skipped preview's reason); a default is derived from the plan. */
  reason?: string;
}

const template = (name: string) => readTemplateFile("gitlab", `child/${name}`);

/**
 * `build-web` / `preview-web`. preview-comment finds a target's job by this name
 * (`findTargetJob`); `forgeHints("gitlab").previewJobName` names it in hints.
 */
export function childJobName(kind: ChildPipelineInput["kind"], target: string): string {
  return `${kind === "release" ? "build" : "preview"}-${target}`;
}

/** The hidden job of a target in the targets file. */
export function targetJobName(target: string): string {
  return `.launchset-${target}`;
}

/** A sequence item of one script line. */
const item = (line: string) => `- ${yamlScalar(line)}`;

function nothingReason(input: ChildPipelineInput): string {
  if (input.reason?.trim()) return input.reason.trim();
  const plan = input.plan;
  if (!plan) return "There is no plan: nothing to build.";
  switch (plan.mode) {
    case "release-pr":
      return `The release MR for ${plan.releasePr?.version ?? plan.version} is up to date. Nothing is built until it is merged.`;
    case "none":
      return "Nothing to release: no changesets are pending and no release is unfinished.";
    case "preview":
      return "The preview plan has no targets to build.";
    default:
      return `The ${plan.mode} plan has no targets to build.`;
  }
}

function describe(input: ChildPipelineInput): string {
  const plan = input.plan;
  if (!plan || plan.matrix.length === 0 || plan.mode === "release-pr" || plan.mode === "none") {
    return plan ? `a ${plan.mode} plan: nothing to build` : "a skipped preview: nothing to build";
  }
  const targets = plan.matrix.join(", ");
  if (plan.mode === "ship") return `shipping ${plan.version} (${targets})`;
  if (plan.mode === "preview") return `the ${plan.channel} ${plan.version} (${targets})`;
  return `the release of ${plan.version} (${targets})`;
}

/** The plan's commit, when the jobs must check it out first (it isn't the pipeline's commit). */
function checkoutSha(input: ChildPipelineInput): string | undefined {
  const sha = input.plan?.releaseSha;
  if (!sha || !input.currentSha || sha === input.currentSha) return undefined;
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) {
    throw new LaunchsetError("invalid-plan", `the plan's release-sha "${sha}" is not a commit`, {
      hint: "Pass the plan that launchset release or launchset preview-plan wrote.",
    });
  }
  return sha;
}

/** launchset's lines of a build job, in the runner's shell. */
interface ShellLines {
  cd: string;
  install: readonly string[];
  /** A launchset (or git) command that fails the job when it fails. */
  run(command: string): string;
  /** Load the variables the last `--ci` command wrote. */
  load: string;
  /** `--plan @plan.json --ci`. */
  planArgs: string;
  word(value: string): string;
  /** Already published: run `mark`, then end the job with its exit code. */
  alreadyPublished(mark: string): string;
}

const SH_LINES: ShellLines = {
  cd: 'cd "$CI_PROJECT_DIR"',
  install: INSTALL_LINES,
  run: (command) => command,
  load: ". ./launchset.sh",
  planArgs: "--plan @plan.json --ci",
  word: shellWord,
  alreadyPublished: (mark) =>
    `if [ "\${LAUNCHSET_ALREADY_PUBLISHED:-}" = "true" ]; then ${mark}; exit $?; fi`,
};

/**
 * PowerShell: `$env:` variables, `'@plan.json'` quoted (a bare `@plan` is splatting), the
 * launchset.ps1 variables file, and `$LASTEXITCODE` checked after every native command.
 */
const POWERSHELL_LINES: ShellLines = {
  cd: "Set-Location -LiteralPath $env:CI_PROJECT_DIR",
  install: POWERSHELL_INSTALL_LINES,
  run: psChecked,
  load: ". ./launchset.ps1",
  planArgs: `--plan ${psQuote("@plan.json")} --ci`,
  word: psWord,
  alreadyPublished: (mark) =>
    `if ($env:LAUNCHSET_ALREADY_PUBLISHED -eq 'true') { ${mark}; exit $LASTEXITCODE }`,
};

function shellLines(shell: GitLabShell | undefined): ShellLines {
  return shell === "powershell" ? POWERSHELL_LINES : SH_LINES;
}

function checkoutLines(sha: string | undefined, lines: ShellLines = SH_LINES): string[] {
  if (!sha) return [];
  return [
    "# The plan builds another commit than this pipeline's (a retry of an unfinished release, or",
    "# a merged results pipeline): check it out first.",
    item(lines.run(`git checkout --quiet --detach ${sha}`)),
  ];
}

/** `needs` entries for the targets this one comes after (`after`), with their artifacts. */
function afterNeeds(
  input: ChildPipelineInput,
  target: string,
  builds: readonly string[],
): string[] {
  const after = input.targets?.[target]?.after ?? [];
  if (after.length === 0) return [];
  const lines = [
    `# after: ${after.join(", ")}. Optional: a retry that doesn't build one of them still starts, but`,
    "# then its artifacts (from an earlier pipeline) aren't here.",
  ];
  for (const other of after) {
    if (!builds.includes(other)) {
      lines.push(`# (${other} isn't built in this pipeline.)`);
      continue;
    }
    lines.push(
      `- job: ${yamlScalar(childJobName(input.kind, other))}`,
      "  artifacts: true",
      "  optional: true",
    );
  }
  return lines;
}

function buildJob(
  input: ChildPipelineInput,
  target: string,
  cliSpec: string,
  sha: string | undefined,
  builds: readonly string[],
): string {
  const release = input.kind === "release";
  const options = input.targets?.[target] ?? {};
  const sh = shellLines(options.shell);
  const t = sh.word(target);
  const command = (name: string) => `launchset ${name} --target ${t} ${sh.planArgs}`;
  const script = [
    item(sh.cd),
    ...sh.install.map(item),
    ...checkoutLines(sha, sh),
    "# Writes the version and build number into the target's files (in this checkout only) and",
    "# sets LAUNCHSET_VERSION, LAUNCHSET_BUILD_NUMBER, LAUNCHSET_CHANNEL, ...",
    item(sh.run(command("stamp"))),
    item(sh.load),
  ];
  if (release) {
    script.push(
      "# Checks the store, registry or npm: is this version already published? Then your steps",
      "# are skipped and only `mark` runs (`exit` ends the job's script with mark's exit code).",
      item(sh.run(command("verify"))),
      item(sh.load),
      item(sh.alreadyPublished(command("mark"))),
    );
  }
  script.push(
    "# Your build and upload steps.",
    `- !reference [${yamlFlowScalar(targetJobName(target))}, script]`,
  );
  if (release) {
    script.push(
      "# Records that this target shipped (the marker tag).",
      item(sh.cd),
      item(sh.run(command("mark"))),
    );
  }
  // Releases and prerelease previews (they reserved a tag) are never cancelled halfway; other
  // previews are, unless the user's job says interruptible: false (a runner a cancel breaks).
  const interruptible =
    !release && input.plan?.channel !== "prerelease" && options.notInterruptible !== true;
  return fillTemplate(
    template("build.yml"),
    {
      job: yamlScalar(childJobName(input.kind, target)),
      extends: yamlScalar(targetJobName(target)),
      plan_job: yamlScalar(input.planJob),
      after_needs: afterNeeds(input, target, builds).join("\n"),
      interruptible: String(interruptible),
      cli_spec: yamlScalar(cliSpec),
      git_depth: sha
        ? '# Full history, so the plan\'s commit is in the clone.\nGIT_DEPTH: "0"'
        : "",
      shell_note:
        options.shell === "powershell"
          ? "# PowerShell (gitlab.shell): every native command checks $LASTEXITCODE, so a failure fails the job."
          : "",
      script: script.join("\n"),
    },
    "child/build.yml",
  );
}

/**
 * The child pipeline YAML for a plan (see the file comment). Parses as YAML, with `!reference`
 * kept as a tag.
 */
export function renderChildPipeline(input: ChildPipelineInput): string {
  const plan = input.plan;
  const cliSpec = input.cliSpec?.trim() || defaultCliSpec();
  const targetsFile = input.targetsFile ?? DEFAULT_TARGETS_FILE;
  const builds = plan && plan.mode !== "release-pr" && plan.mode !== "none" ? [...plan.matrix] : [];
  const finalize =
    input.kind === "release" &&
    plan !== undefined &&
    (plan.mode === "publish" || plan.mode === "ship");
  // The preview's note (or prerelease release) comes from the child: it only exists once the
  // plan job ran, also when that job is a manual one someone played later.
  const comment = input.kind === "preview" && plan !== undefined;
  const sha = builds.length > 0 || finalize ? checkoutSha(input) : undefined;

  const parts = [
    fillTemplate(
      template("header.yml"),
      {
        version: packageVersion(),
        what: describe(input),
        plan_job: input.planJob,
        targets_file: targetsFile,
      },
      "child/header.yml",
    ),
  ];
  if (builds.length > 0) {
    const includes = (input.includes ?? []).filter((path) => path !== targetsFile);
    parts.push(
      fillTemplate(
        template("include.yml"),
        {
          templates: includes.length
            ? [
                "# Templates your .launchset-<target> jobs extend (gitlab.include in launchset.config).",
                ...includes.map((path) => `- local: ${yamlScalar(path)}`),
              ].join("\n")
            : "",
          targets_file: yamlScalar(targetsFile),
        },
        "child/include.yml",
      ),
    );
  }
  if (finalize || comment) {
    parts.push(
      fillTemplate(
        template("cli.yml"),
        { cli_spec: yamlScalar(cliSpec), install: installItems() },
        "child/cli.yml",
      ),
    );
  }
  for (const target of builds) parts.push(buildJob(input, target, cliSpec, sha, builds));
  if (finalize) {
    parts.push(
      fillTemplate(
        template("finalize.yml"),
        {
          plan_job: yamlScalar(input.planJob),
          build_needs: builds
            .map((t) => `- job: ${yamlScalar(childJobName("release", t))}\n  artifacts: false`)
            .join("\n"),
          checkout: checkoutLines(sha).join("\n"),
        },
        "child/finalize.yml",
      ),
    );
  }
  if (comment) {
    parts.push(
      fillTemplate(
        template("comment.yml"),
        {
          plan_job: yamlScalar(input.planJob),
          build_needs: builds
            .map((t) => `- job: ${yamlScalar(childJobName("preview", t))}\n  artifacts: false`)
            .join("\n"),
          // Like the preview jobs: a newer push replaces the preview, a prerelease's release is
          // always written.
          interruptible: String(plan.channel !== "prerelease"),
        },
        "child/comment.yml",
      ),
    );
  }
  if (builds.length === 0 && !finalize && !comment) {
    parts.push(
      fillTemplate(
        template("nothing.yml"),
        { echo: yamlScalar(`echo ${shellWord(nothingReason(input))}`) },
        "child/nothing.yml",
      ),
    );
  }
  const content = `${parts.join("\n").replace(/\n+$/, "")}\n`;
  checkGitLabYaml(DEFAULT_CHILD_FILE, content);
  return content;
}

// ---------------------------------------------------------------------------
// The targets file

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Check the targets file before the child pipeline is written: it must exist and define a
 * `.launchset-<target>` job with a `script` (or an `extends`) for every target in `matrix`.
 * GitLab would otherwise fail to create the child pipeline with a less helpful message. Returns
 * warnings for what can't be checked here (a job that may come from the file's own `include`).
 */
export function checkTargetsFile(
  text: string | undefined,
  matrix: readonly string[],
  path = DEFAULT_TARGETS_FILE,
): string[] {
  if (matrix.length === 0) return [];
  const hint = `It holds one hidden job per target with your build steps (launchset init writes it): .launchset-<target> with a script. See the header of ${path}.`;
  if (text === undefined) {
    throw new LaunchsetError(
      "gitlab-targets-missing",
      `${path} doesn't exist, so the child pipeline can't build ${matrix.join(", ")}.`,
      { hint },
    );
  }
  let doc: unknown;
  try {
    doc = parseGitLabYaml(text);
  } catch (error) {
    throw new LaunchsetError(
      "gitlab-targets-invalid",
      `${path} is not valid YAML: ${(error as Error).message}`,
      { hint, cause: error },
    );
  }
  const jobs = isRecord(doc) ? doc : {};
  const hasInclude = "include" in jobs;
  const warnings: string[] = [];
  const missing: string[] = [];
  for (const target of matrix) {
    const name = targetJobName(target);
    const job = jobs[name];
    if (job === undefined) {
      if (hasInclude) {
        warnings.push(
          `${path} doesn't define ${name} itself; it has to come from one of its includes.`,
        );
      } else {
        missing.push(`${name} (target ${target})`);
      }
      continue;
    }
    if (!isRecord(job) || (job.script === undefined && job.extends === undefined)) {
      missing.push(`${name} (target ${target}) with a script`);
    }
  }
  if (missing.length > 0) {
    throw new LaunchsetError(
      "gitlab-targets-missing",
      `${path} has no job ${missing.join(", ")}, so the child pipeline can't build it.`,
      { hint },
    );
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// The included template files and what the target jobs inherit

/** Top-level keys an included template file may have, besides hidden jobs. */
const TEMPLATE_FILE_KEYS = new Set(["variables", "default"]);

const includeHint = (path: string) =>
  `${path} is in gitlab.include of launchset.config: the child pipeline includes it so the .launchset-<target> jobs can extend its templates. It may only hold hidden jobs (names starting with .), variables and default.`;

/**
 * Check one `gitlab.include` file: it must exist, parse, and hold only hidden jobs,
 * `variables` and `default`. A visible job there would run in every child pipeline, and a
 * `workflow`, `stages` or nested `include` would change the child pipeline itself. Returns the
 * parsed file.
 */
export function checkTemplateFile(path: string, text: string | undefined): Record<string, unknown> {
  if (text === undefined) {
    throw new LaunchsetError(
      "gitlab-include-missing",
      `${path} doesn't exist, so the child pipeline can't include it.`,
      { hint: `${includeHint(path)} Create it, or remove it from gitlab.include.` },
    );
  }
  let doc: unknown;
  try {
    doc = parseGitLabYaml(text);
  } catch (error) {
    throw new LaunchsetError(
      "gitlab-include-invalid",
      `${path} is not valid YAML: ${(error as Error).message}`,
      { hint: includeHint(path), cause: error },
    );
  }
  if (doc === null || doc === undefined) return {};
  if (!isRecord(doc)) {
    throw new LaunchsetError("gitlab-include-invalid", `${path} is not a map of jobs.`, {
      hint: includeHint(path),
    });
  }
  const unsafe = Object.keys(doc).filter(
    (key) => !key.startsWith(".") && !TEMPLATE_FILE_KEYS.has(key),
  );
  if (unsafe.length > 0) {
    const nested = unsafe.includes("include")
      ? " For an include of its own, list that file in gitlab.include instead."
      : "";
    throw new LaunchsetError(
      "gitlab-include-unsafe",
      `${path} has ${unsafe.map((k) => `"${k}"`).join(", ")}, which the child pipeline can't include: a visible job would run in every child pipeline, and workflow, stages or include would change the child pipeline itself.`,
      {
        hint: `Move ${unsafe.length === 1 ? "it" : "them"} to .gitlab-ci.yml, or hide a template by starting its name with a dot.${nested} ${includeHint(path)}`,
      },
    );
  }
  return doc;
}

const names = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string")
      : [];

/**
 * Where `key` of a job comes from, following `extends` like GitLab (the job's own value, else
 * the last template in `extends` that has it, depth first). Undefined when nothing sets it.
 */
function inherited(
  jobs: Record<string, unknown>,
  name: string,
  key: string,
  seen = new Set<string>(),
): { job: string; value: unknown } | undefined {
  if (seen.has(name)) return undefined;
  seen.add(name);
  const job = jobs[name];
  if (!isRecord(job)) return undefined;
  if (job[key] !== undefined) return { job: name, value: job[key] };
  for (const parent of [...names(job.extends)].reverse()) {
    const found = inherited(jobs, parent, key, seen);
    if (found) return found;
  }
  return undefined;
}

/** Keys the child pipeline sets or decides itself, and why the user's value is a problem. */
const CHILD_DECIDES: Record<string, (job: string, target: string) => string> = {
  needs: (job, target) =>
    `${job} replaces it with its own needs (the plan job), so it doesn't wait for those jobs or get their artifacts. To build ${target} after other targets, list them in "after" of the target in launchset.config`,
  rules: (job) =>
    `the child pipeline decides when ${job} runs: a rule that keeps it out leaves the target unbuilt (and a child pipeline whose jobs are all ruled out fails to start). Remove it`,
  when: (job) =>
    `the child pipeline decides when ${job} runs (a manual or delayed job holds up the release). Remove it`,
  only: (job) => `the child pipeline decides when ${job} runs. Remove it`,
  except: (job) => `the child pipeline decides when ${job} runs. Remove it`,
  stage: (job) =>
    `${job} runs in stage test (a child pipeline has GitLab's default stages), so it is ignored. Remove it`,
};

export interface TargetJobsInput {
  /** The targets file's text (undefined when it doesn't exist). */
  targetsText: string | undefined;
  targetsPath?: string;
  /** The `gitlab.include` files with their text (undefined when missing). */
  includes?: readonly { path: string; text: string | undefined }[];
  /** The targets the child pipeline builds. */
  matrix: readonly string[];
  kind: ChildPipelineInput["kind"];
}

/**
 * Check the targets file and the `gitlab.include` files before the child pipeline is written
 * (throws on a missing or unsafe file, like {@link checkTargetsFile}), and read what the
 * `.launchset-<target>` jobs inherit. Warnings: keys the child pipeline overrides or decides
 * (`needs`, `rules`, `when`, `only`, `except`, `stage`) set on a target's job or a template it
 * extends.
 */
export function inspectTargetJobs(input: TargetJobsInput): {
  warnings: string[];
  /** Targets whose job ends up `interruptible: false`. */
  notInterruptible: Set<string>;
} {
  const path = input.targetsPath ?? DEFAULT_TARGETS_FILE;
  const warnings = checkTargetsFile(input.targetsText, input.matrix, path);
  const notInterruptible = new Set<string>();
  if (input.matrix.length === 0) return { warnings, notInterruptible };
  const jobs: Record<string, unknown> = {};
  let defaults: Record<string, unknown> = {};
  for (const file of input.includes ?? []) {
    const doc = checkTemplateFile(file.path, file.text);
    Object.assign(jobs, doc);
    if (isRecord(doc.default)) defaults = { ...defaults, ...doc.default };
  }
  const targets = parseGitLabYaml(input.targetsText ?? "");
  if (isRecord(targets)) {
    Object.assign(jobs, targets);
    if (isRecord(targets.default)) defaults = { ...defaults, ...targets.default };
  }
  for (const target of input.matrix) {
    const name = targetJobName(target);
    const job = childJobName(input.kind, target);
    for (const [key, why] of Object.entries(CHILD_DECIDES)) {
      const found = inherited(jobs, name, key);
      if (!found) continue;
      const where = found.job === name ? name : `${found.job}, which ${name} extends,`;
      warnings.push(`${where} sets ${key}: ${why(job, target)}.`);
    }
    const interruptible = inherited(jobs, name, "interruptible")?.value ?? defaults.interruptible;
    if (interruptible === false) notInterruptible.add(target);
  }
  return { warnings, notInterruptible };
}
