/**
 * The GitLab child pipeline (design/GITLAB.md decisions 2 and 3): the `launchset-release` and
 * `launchset-preview-plan` jobs write it for their plan, and the parent's trigger job runs it.
 * It has exactly the jobs the plan needs: one `build-<target>` (or `preview-<target>`) job per
 * target in the matrix, which wraps the user's `.launchset-<target>` job from
 * `.gitlab/launchset-targets.yml` in `stamp` / `verify` / `mark`, then `launchset-finalize` for a
 * release. Nothing to build: a single `launchset-nothing-to-build` job that says why (a child
 * pipeline needs at least one job). Pure apart from reading the template files.
 */

import { LaunchsetError } from "../core/errors.ts";
import type { Plan } from "../core/types.ts";
import { packageVersion } from "../init/package-files.ts";
import {
  checkGitLabYaml,
  defaultCliSpec,
  INSTALL_LINES,
  installItems,
  parseGitLabYaml,
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

export interface ChildPipelineInput {
  /** The plan; `undefined` when there is none (a skipped preview). */
  plan: Plan | undefined;
  kind: "release" | "preview";
  /** The targets file to include, relative to the repository root. */
  targetsFile?: string;
  /** The parent job that has plan.json as an artifact (the job writing this file). */
  planJob: string;
  /**
   * The commit the pipeline runs at (`CI_COMMIT_SHA`). When the plan's release-sha differs (a
   * retry of an unfinished release, a merged results pipeline), every job checks it out first.
   */
  currentSha?: string;
  /** What jobs install with npm (`LAUNCHSET_CLI`), default `@demonsters/launchset@<this version>`. */
  cliSpec?: string;
  /** Why nothing is built (a skipped preview's reason); a default is derived from the plan. */
  reason?: string;
}

const template = (name: string) => readTemplateFile("gitlab", `child/${name}`);

/** `build-web` / `preview-web`: the names the flows look for (preview-comment, forge hints). */
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

function checkoutLines(sha: string | undefined): string[] {
  if (!sha) return [];
  return [
    "# The plan builds another commit than this pipeline's (a retry of an unfinished release, or",
    "# a merged results pipeline): check it out first.",
    item(`git checkout --quiet --detach ${sha}`),
  ];
}

function buildJob(
  input: ChildPipelineInput,
  target: string,
  cliSpec: string,
  sha: string | undefined,
): string {
  const release = input.kind === "release";
  const t = shellWord(target);
  const planArg = "--plan @plan.json --ci";
  const script = [
    item('cd "$CI_PROJECT_DIR"'),
    ...INSTALL_LINES.map(item),
    ...checkoutLines(sha),
    "# Writes the version and build number into the target's files (in this checkout only) and",
    "# sets LAUNCHSET_VERSION, LAUNCHSET_BUILD_NUMBER, LAUNCHSET_CHANNEL, ...",
    item(`launchset stamp --target ${t} ${planArg}`),
    item(". ./launchset.sh"),
  ];
  if (release) {
    script.push(
      "# Checks the store, registry or npm: is this version already published? Then your steps",
      "# are skipped and only `mark` runs (`exit` ends the job's script successfully).",
      item(`launchset verify --target ${t} ${planArg}`),
      item(". ./launchset.sh"),
      item(
        `if [ "\${LAUNCHSET_ALREADY_PUBLISHED:-}" = "true" ]; then launchset mark --target ${t} ${planArg}; exit $?; fi`,
      ),
    );
  }
  script.push(
    "# Your build and upload steps.",
    `- !reference [${yamlFlowScalar(targetJobName(target))}, script]`,
  );
  if (release) {
    script.push(
      "# Records that this target shipped (the marker tag).",
      item('cd "$CI_PROJECT_DIR"'),
      item(`launchset mark --target ${t} ${planArg}`),
    );
  }
  // Prerelease previews reserved a tag: never cancel them halfway.
  const interruptible = !release && input.plan?.channel !== "prerelease";
  return fillTemplate(
    template("build.yml"),
    {
      job: yamlScalar(childJobName(input.kind, target)),
      extends: yamlScalar(targetJobName(target)),
      plan_job: yamlScalar(input.planJob),
      interruptible: String(interruptible),
      cli_spec: yamlScalar(cliSpec),
      git_depth: sha
        ? '# Full history, so the plan\'s commit is in the clone.\nGIT_DEPTH: "0"'
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
    parts.push(
      fillTemplate(
        template("include.yml"),
        { targets_file: yamlScalar(targetsFile) },
        "child/include.yml",
      ),
    );
  }
  if (finalize) {
    parts.push(
      fillTemplate(
        template("cli.yml"),
        { cli_spec: yamlScalar(cliSpec), install: installItems() },
        "child/cli.yml",
      ),
    );
  }
  for (const target of builds) parts.push(buildJob(input, target, cliSpec, sha));
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
  if (builds.length === 0 && !finalize) {
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
