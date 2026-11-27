/**
 * Renders launchset's GitLab CI files from the template files in `templates/gitlab/` and a
 * resolved config (design/GITLAB.md, phase 4). Pure apart from reading the template files.
 *
 *   .gitlab/launchset.yml          launchset's jobs (check, release, preview), included by the
 *                                  project's .gitlab-ci.yml
 *   .gitlab/launchset-targets.yml  the user's build steps, one hidden `.launchset-<target>` job
 *                                  per target, included by the generated child pipeline
 *   .gitlab-ci.yml                 a fresh root file (workflow rules and the include), for
 *                                  projects that have none
 *
 * The child pipeline itself is generated at run time by `gitlab-child.ts`. Template syntax: see
 * `fillTemplate` in `workflows.ts`.
 */

import { posix } from "node:path";
import type {
  ResolvedConfig,
  ResolvedDockerTarget,
  ResolvedTarget,
} from "../core/config/schema.ts";
import { LaunchsetError } from "../core/errors.ts";
import {
  branchCondition,
  checkGitLabYaml,
  defaultCliSpec,
  installItems,
  labelRe2,
  maintenanceCondition,
  ruleEntry,
  shellWord,
  yamlScalar,
} from "./gitlab-yaml.ts";
import {
  androidDir,
  fillTemplate,
  flutterDir,
  iosProject,
  iosScheme,
  isNpmTarget,
  type RenderedFile,
  readTemplateFile,
  registryOf,
  unique,
} from "./workflows.ts";

export const GITLAB_FILES = {
  jobs: ".gitlab/launchset.yml",
  targets: ".gitlab/launchset-targets.yml",
  root: ".gitlab-ci.yml",
} as const;

/** The include for an existing `.gitlab-ci.yml` (init prints it when it can't add it itself). */
export const GITLAB_INCLUDE_SNIPPET = `include:\n  - local: ${GITLAB_FILES.jobs}\n`;

/** The Docker version of the docker targets' image and Docker-in-Docker service. */
export const DOCKER_VERSION = "29";
/** The tag of `cimg/android` for android targets. */
export const ANDROID_IMAGE_TAG = "2026.11-node";
/** GitLab.com's container registry; self-managed instances name theirs (`gitlabRegistry`). */
export const GITLAB_COM_REGISTRY = "registry.gitlab.com";

export interface GitLabTemplateInput {
  config: ResolvedConfig;
  /**
   * The stage of launchset's jobs (default `test`, one of GitLab's default stages). Jobs are
   * ordered by `needs`, which may point into the same stage, so one stage is enough; init picks
   * one that exists in the project's `stages:`.
   */
  stage?: string;
  /** What jobs install with npm (`LAUNCHSET_CLI`), default `launchset@<this version>`. */
  cliSpec?: string;
  /** Extra info init found per target, e.g. Dockerfile path and build context. */
  hints?: Record<string, { dockerfile?: string; context?: string; platforms?: string }>;
  /**
   * Container registry hosts of this GitLab instance (default `registry.gitlab.com`): docker
   * images there log in with the job's `CI_REGISTRY_*` credentials.
   */
  gitlabRegistries?: string[];
  /**
   * Ready `.launchset-<target>` jobs by target (with their `# ---` heading), used instead of the
   * target type's template: init copies them from the existing GitLab job a target came from.
   */
  prefill?: Record<string, string>;
}

const template = (name: string) => readTemplateFile("gitlab", name);

// ---------------------------------------------------------------------------
// Rules

/** `- if:` entries for "this branch variable is the base or a maintenance branch". */
function releaseBranchRules(config: ResolvedConfig, variable: string): string[] {
  return [
    ruleEntry(branchCondition(variable, config.baseBranch)),
    ruleEntry(maintenanceCondition(variable, config.maintenanceBranches)),
  ];
}

function prereleaseGlobs(config: ResolvedConfig): string[] {
  return unique(config.preview.branches.filter((b) => b.prerelease).map((b) => b.branch));
}

const MR = '$CI_PIPELINE_SOURCE == "merge_request_event"';
const FORK = `${MR} && $CI_MERGE_REQUEST_SOURCE_PROJECT_ID != $CI_MERGE_REQUEST_PROJECT_ID`;
const MANUAL_PREVIEW =
  '$LAUNCHSET_PREVIEW == "true" && $CI_COMMIT_BRANCH && ($CI_PIPELINE_SOURCE == "web" || $CI_PIPELINE_SOURCE == "api")';

type PreviewJob = "plan" | "trigger";

/**
 * The rules of the preview plan and trigger jobs. They share the conditions; the plan job is
 * manual in MR pipelines without the label. (The comment job is in the child pipeline: a job
 * here that `needs` the manual plan job with `when: always` would run before anyone played it.)
 */
function previewRules(config: ResolvedConfig, job: PreviewJob): string {
  const lines: string[] = ["# Never for fork MRs.", ruleEntry(FORK, ["when: never"])];
  const manual = [
    "when: manual",
    "allow_failure: true",
    "variables:",
    '  LAUNCHSET_PREVIEW_MANUAL: "true"',
  ];
  if (job !== "plan") {
    lines.push("# Merge requests (the plan job decides whether one builds).", ruleEntry(MR));
  } else if (config.preview.rebuildOnPush) {
    lines.push(
      `# MRs with the ${config.preview.label} label: on every pipeline.`,
      ruleEntry(`${MR} && $CI_MERGE_REQUEST_LABELS =~ /${labelRe2(config.preview.label)}/`),
      "# Other MRs: a manual job. Running it builds the preview without the label.",
      ruleEntry(MR, manual),
    );
  } else {
    lines.push(
      "# Every MR: a manual job (preview.rebuildOnPush is false, and GitLab has no label events).",
      ruleEntry(MR, manual),
    );
  }
  lines.push(
    "# Run pipeline (or the API) with LAUNCHSET_PREVIEW=true: a preview of any branch.",
    ruleEntry(MANUAL_PREVIEW),
  );
  const globs = unique(config.preview.branches.map((b) => b.branch));
  if (globs.length > 0) {
    lines.push(
      "# Pushes to the preview branches. Maintenance branches never auto-preview, even when a",
      "# pattern below matches them.",
      ruleEntry('$CI_PIPELINE_SOURCE != "push"', ["when: never"]),
      ruleEntry(maintenanceCondition("$CI_COMMIT_BRANCH", config.maintenanceBranches), [
        "when: never",
      ]),
      ...globs.map((glob) => ruleEntry(branchCondition("$CI_COMMIT_BRANCH", glob))),
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// .gitlab/launchset.yml

function renderJobsFile(input: GitLabTemplateInput, stage: string, cliSpec: string): string {
  const { config } = input;
  const target = "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME";
  const checkRules = [
    ...releaseBranchRules(config, target),
    ...prereleaseGlobs(config).map((glob) => ruleEntry(branchCondition(target, glob))),
  ];
  const preview = config.preview.enabled;
  const previewJobs = preview
    ? fillTemplate(
        template("launchset-preview.yml"),
        {
          stage,
          preview_mr_help: config.preview.rebuildOnPush
            ? [
                `#   - automatically, when the MR has the ${config.preview.label} label (add it, then push or`,
                "#     run a new pipeline, or let the preview sweep below start one);",
                "#   - otherwise as the manual job launchset-preview-plan: run it to build a preview.",
              ].join("\n")
            : [
                "#   - as the manual job launchset-preview-plan: run it to build a preview",
                "#     (preview.rebuildOnPush is false, so the label doesn't start it either).",
              ].join("\n"),
          preview_sweep_help: config.preview.rebuildOnPush
            ? ""
            : [
                "# preview.rebuildOnPush is false, so a labeled MR's preview is a manual job too: the",
                "# sweep refuses to run (a pipeline it started wouldn't build the preview).",
              ].join("\n"),
          preview_plan_rules: previewRules(config, "plan"),
          preview_trigger_rules: previewRules(config, "trigger"),
        },
        "launchset-preview.yml",
      )
    : "";
  return fillTemplate(
    template("launchset.yml"),
    {
      stage,
      cli_spec: yamlScalar(cliSpec),
      install: installItems(),
      release_branch_rules: releaseBranchRules(config, "$CI_COMMIT_BRANCH").join("\n"),
      check_rules: checkRules.join("\n"),
      preview_overview: preview
        ? [
            "#   launchset-preview-plan     previews (MRs, preview and prerelease branches): decides the",
            "#                              version, build number and targets; writes the child pipeline",
            "#   launchset-preview          runs it: one preview-<target> job per target (stamp -> YOUR",
            "#                              build and upload steps, to internal channels), then",
            "#                              launchset-preview-comment (one sticky MR note with the",
            "#                              result per target)",
            "#   launchset-preview-sweep    opt-in, in a pipeline schedule with LAUNCHSET_PREVIEW_SWEEP=true:",
            "#                              starts an MR pipeline for MRs that just got the preview label",
          ].join("\n")
        : "",
      preview_manual_help: preview
        ? [
            "#   - LAUNCHSET_PREVIEW=true, on any branch: builds a preview of it. LAUNCHSET_TARGET=<names>",
            "#     (comma-separated, or all) picks the targets.",
          ].join("\n")
        : "",
      preview_jobs: previewJobs,
    },
    "launchset.yml",
  );
}

// ---------------------------------------------------------------------------
// .gitlab/launchset-targets.yml

/** Credentials comments for `verify` (the CI/CD variables it reads), or "". */
function verifyComment(target: ResolvedTarget): string {
  if (target.type === "android" && target.verify.includes("store")) {
    return "# `verify` reads Google Play with LAUNCHSET_PLAY_SERVICE_ACCOUNT_JSON, a CI/CD variable\n# (the service account's JSON key).";
  }
  if (target.type === "ios" && target.verify.includes("store")) {
    return "# `verify` reads App Store Connect with the CI/CD variables LAUNCHSET_ASC_KEY_ID,\n# LAUNCHSET_ASC_ISSUER_ID and LAUNCHSET_ASC_PRIVATE_KEY (the raw contents of the .p8 key).";
  }
  return "";
}

function dockerTarget(
  target: ResolvedDockerTarget,
  input: GitLabTemplateInput,
  gitlabRegistries: Set<string>,
): string {
  const hint = input.hints?.[target.name] ?? {};
  const registries = unique(target.image.map(registryOf));
  const gitlab = registries.filter((r) => gitlabRegistries.has(r));
  const others = registries.filter((r) => !gitlabRegistries.has(r));
  const login: string[] = [];
  for (const registry of gitlab) {
    login.push(
      `- echo "$CI_REGISTRY_PASSWORD" | docker login --username "$CI_REGISTRY_USER" --password-stdin ${gitlab.length === 1 ? '"$CI_REGISTRY"' : shellWord(registry)}`,
    );
  }
  if (others.length > 0) {
    login.push(
      "# DOCKER_USERNAME and DOCKER_PASSWORD are CI/CD variables (masked) for this registry. With",
      "# several registries, give each its own pair of variables.",
    );
    for (const registry of others) {
      const host = registry === "docker.io" ? "" : ` ${shellWord(registry)}`;
      login.push(
        `- echo "$DOCKER_PASSWORD" | docker login --username "$DOCKER_USERNAME" --password-stdin${host}`,
      );
    }
  }
  const registryVariables: string[] = [];
  const [gitlabRegistry] = gitlab;
  if (target.verify.includes("registry") && gitlabRegistry !== undefined) {
    registryVariables.push(
      "# `verify` checks the GitLab registry with the job's own registry credentials.",
      "LAUNCHSET_REGISTRY_USERNAME: $CI_REGISTRY_USER",
      "LAUNCHSET_REGISTRY_PASSWORD: $CI_REGISTRY_PASSWORD",
      `LAUNCHSET_REGISTRY_HOST: ${yamlScalar(gitlabRegistry)}`,
    );
  }
  let flags = "";
  if (hint.dockerfile) flags += ` --file ${shellWord(hint.dockerfile)}`;
  if (hint.platforms) flags += ` --platform ${shellWord(hint.platforms)}`;
  return fillTemplate(
    template("targets/docker.yml"),
    {
      target: target.name,
      docker_version: DOCKER_VERSION,
      registry_variables: registryVariables.join("\n"),
      login_lines: login.join("\n"),
      platform_lines: hint.platforms
        ? [
            "# Multi-platform builds emulate the other architectures with QEMU.",
            "- docker run --privileged --rm tonistiigi/binfmt --install all",
          ].join("\n")
        : "",
      build_flags: flags,
      context: shellWord(hint.context ?? "."),
    },
    "targets/docker.yml",
  );
}

function targetJob(
  target: ResolvedTarget,
  input: GitLabTemplateInput,
  gitlabRegistries: Set<string>,
): string {
  const common = { target: target.name, verify_variables: verifyComment(target) };
  const flutter = flutterDir(target);
  if (flutter !== undefined && (target.type === "android" || target.type === "ios")) {
    const file = `targets/flutter-${target.type}.yml`;
    return fillTemplate(
      template(file),
      {
        ...common,
        android_image_tag: ANDROID_IMAGE_TAG,
        // A whole YAML item once uncommented: a folder with ": " or " #" stays one command.
        cd_flutter_dir: yamlScalar(`cd ${shellWord(flutter)}`),
        pubspec: posix.join(flutter, "pubspec.yaml"),
        package_name:
          (target.type === "android" ? target.store?.packageName : undefined) ??
          "<your.package.name>",
      },
      file,
    );
  }
  switch (target.type) {
    case "docker":
      return dockerTarget(target, input, gitlabRegistries);
    case "android":
      return fillTemplate(
        template("targets/android.yml"),
        {
          ...common,
          android_image_tag: ANDROID_IMAGE_TAG,
          cd_android_dir: yamlScalar(`cd ${shellWord(androidDir(target))}`),
          package_name: target.store?.packageName ?? "<your.package.name>",
        },
        "targets/android.yml",
      );
    case "ios": {
      const project = iosProject(target);
      return fillTemplate(
        template("targets/ios.yml"),
        { ...common, xcodeproj: project, scheme: iosScheme(project) },
        "targets/ios.yml",
      );
    }
    case "web":
      return fillTemplate(template("targets/web.yml"), common, "targets/web.yml");
    case "custom": {
      if (!isNpmTarget(target)) {
        return fillTemplate(template("targets/custom.yml"), common, "targets/custom.yml");
      }
      const variables = target.verify.includes("npm")
        ? [
            "variables:",
            "  # `verify` reads the registry with it (needed for a private package).",
            "  NODE_AUTH_TOKEN: $NPM_TOKEN",
          ].join("\n")
        : "";
      return fillTemplate(
        template("targets/custom-npm.yml"),
        { ...common, npm_variables: variables },
        "targets/custom-npm.yml",
      );
    }
  }
}

/**
 * The hidden `.launchset-<target>` job of each target, as it appears in
 * `.gitlab/launchset-targets.yml` (with its `# --- <target> ---` heading), by target name. init
 * appends the ones an existing targets file lacks.
 */
export function renderGitLabTargetJobs(input: GitLabTemplateInput): Record<string, string> {
  const registries = new Set(input.gitlabRegistries ?? [GITLAB_COM_REGISTRY]);
  const out: Record<string, string> = {};
  for (const t of Object.values(input.config.targets)) {
    out[t.name] = input.prefill?.[t.name] ?? targetJob(t, input, registries);
  }
  return out;
}

function renderTargetsFile(input: GitLabTemplateInput): string {
  const jobs = Object.values(renderGitLabTargetJobs(input));
  return fillTemplate(
    template("launchset-targets.yml"),
    { jobs: jobs.join("\n") },
    "launchset-targets.yml",
  );
}

// ---------------------------------------------------------------------------
// .gitlab-ci.yml

/** The fresh `.gitlab-ci.yml`'s note on the preview sweep schedule and the user's jobs. */
const SWEEP_NOTE = [
  "#",
  "# The preview sweep (optional, see .gitlab/launchset.yml) runs in a pipeline schedule with the",
  "# variable LAUNCHSET_PREVIEW_SWEEP=true, every few minutes. A scheduled pipeline runs every job",
  "# whose rules allow it, and a job without `rules` runs in every pipeline except MR pipelines:",
  "# scheduled ones too. To keep a job out of the sweep schedule, start its rules with",
  '#   - if: $LAUNCHSET_PREVIEW_SWEEP == "true"',
  "#     when: never",
  '# (for a job without rules, follow it with `- if: $CI_PIPELINE_SOURCE != "merge_request_event"`',
  "# to keep where it runs now).",
].join("\n");

/**
 * A fresh `.gitlab-ci.yml` for a project without one: workflow rules that switch between branch
 * and merge request pipelines, and the include of `.gitlab/launchset.yml`.
 */
export function renderGitLabCiRoot(config: ResolvedConfig): RenderedFile {
  const globs = config.preview.enabled ? unique(config.preview.branches.map((b) => b.branch)) : [];
  const always =
    globs.length === 0
      ? ""
      : [
          "# Preview and prerelease branches build every push, also while an MR from them is open",
          "# (every push to a prerelease branch is a prerelease).",
          ...globs.map((glob) =>
            ruleEntry(
              `${branchCondition("$CI_COMMIT_BRANCH", glob)} && $CI_PIPELINE_SOURCE == "push"`,
            ),
          ),
        ].join("\n");
  const file: RenderedFile = {
    path: GITLAB_FILES.root,
    content: fillTemplate(
      template("gitlab-ci.yml"),
      {
        always_branch_rules: always,
        include: GITLAB_INCLUDE_SNIPPET.trimEnd(),
        sweep_note: config.preview.enabled && config.preview.rebuildOnPush ? SWEEP_NOTE : "",
      },
      "gitlab-ci.yml",
    ),
  };
  return finish(file);
}

// ---------------------------------------------------------------------------
// Rendering

function finish(file: RenderedFile): RenderedFile {
  file.content = `${file.content.replace(/\n+$/, "")}\n`;
  checkGitLabYaml(file.path, file.content);
  return file;
}

function checkStage(stage: string): string {
  if (stage.trim() === "" || stage.trim() !== stage || /[\n\r]/.test(stage)) {
    throw new LaunchsetError("invalid-stage", `"${stage}" is not a GitLab CI stage name.`, {
      hint: "Pick a stage from the stages: list of .gitlab-ci.yml (default: test).",
    });
  }
  return yamlScalar(stage);
}

/**
 * The GitLab CI files: `.gitlab/launchset.yml`, `.gitlab/launchset-targets.yml` and a fresh
 * `.gitlab-ci.yml` (also from {@link renderGitLabCiRoot}). Every file parses as YAML.
 */
export function renderGitLabCi(input: GitLabTemplateInput): RenderedFile[] {
  const stage = checkStage(input.stage ?? "test");
  const cliSpec = input.cliSpec ?? defaultCliSpec();
  return [
    finish({ path: GITLAB_FILES.jobs, content: renderJobsFile(input, stage, cliSpec) }),
    finish({ path: GITLAB_FILES.targets, content: renderTargetsFile(input) }),
    renderGitLabCiRoot(input.config),
  ];
}
