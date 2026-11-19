/**
 * The GitLab CI {@link CiEnvironment} adapter: `CI_*` variables. GitLab has no event payload;
 * everything comes from predefined variables and the pipeline's own variables.
 */

import { DEFAULT_SERVER_URLS } from "../../core/forge-links.ts";
import type { RunInfo } from "../../core/types.ts";
import type { CiEnvironment, Env, EventInfo, EventKind, EventPr } from "./types.ts";

function positiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Run info from `CI_PIPELINE_ID` / `CI_PIPELINE_IID`. GitLab has no attempt counter. */
export function gitlabRunInfo(env: Env): RunInfo | undefined {
  const id = positiveInt(env.CI_PIPELINE_ID);
  const number = positiveInt(env.CI_PIPELINE_IID);
  if (id === undefined && number === undefined) return undefined;
  const run: RunInfo = {};
  if (id !== undefined) run.id = id;
  if (number !== undefined) run.number = number;
  return run;
}

/** The merge request of an MR pipeline (or of a child of one), from `CI_MERGE_REQUEST_*`. */
function mergeRequest(env: Env): EventPr {
  const sourceId = env.CI_MERGE_REQUEST_SOURCE_PROJECT_ID;
  const targetId = env.CI_MERGE_REQUEST_PROJECT_ID;
  const labels = (env.CI_MERGE_REQUEST_LABELS ?? "")
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
  const pr: EventPr = { labels, fork: Boolean(sourceId && targetId && sourceId !== targetId) };
  const set = <K extends keyof EventPr>(key: K, value: EventPr[K] | "" | undefined) => {
    if (value) pr[key] = value;
  };
  set("number", positiveInt(env.CI_MERGE_REQUEST_IID));
  set("headRef", env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME);
  // The source branch's sha is only set in merged results pipelines, where CI_COMMIT_SHA is a
  // synthetic merge commit; in plain MR pipelines CI_COMMIT_SHA is the source head.
  set("headSha", env.CI_MERGE_REQUEST_SOURCE_BRANCH_SHA || env.CI_COMMIT_SHA);
  set("headRepo", env.CI_MERGE_REQUEST_SOURCE_PROJECT_PATH);
  set("baseRef", env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME);
  set("baseSha", env.CI_MERGE_REQUEST_TARGET_BRANCH_SHA);
  set("baseRepo", env.CI_MERGE_REQUEST_PROJECT_PATH);
  // The templates' manual preview job (an MR without the preview label) sets this variable.
  if (env.LAUNCHSET_PREVIEW_MANUAL === "true") pr.manual = true;
  return pr;
}

/** Inputs of a run started by hand or a tool, from pipeline variables (see the templates). */
function dispatchInputs(env: Env): Record<string, string> {
  const inputs: Record<string, string> = {};
  // `LAUNCHSET_VERSION` isn't used here: launchset exports that one itself.
  if (env.LAUNCHSET_TARGET) {
    inputs.target = env.LAUNCHSET_TARGET;
    inputs.targets = env.LAUNCHSET_TARGET;
  }
  if (env.LAUNCHSET_RELEASE_VERSION) inputs.version = env.LAUNCHSET_RELEASE_VERSION;
  if (env.LAUNCHSET_FORCE) inputs.force = env.LAUNCHSET_FORCE;
  return inputs;
}

const MANUAL_SOURCES = new Set(["web", "api", "trigger", "pipeline", "chat"]);

/** The event of the run (`CI_PIPELINE_SOURCE`), if any. */
export function gitlabEvent(env: Env): EventInfo | undefined {
  const name = env.CI_PIPELINE_SOURCE;
  if (!name) return undefined;
  const branch = env.CI_COMMIT_BRANCH;
  const tag = env.CI_COMMIT_TAG;
  const sha = env.CI_COMMIT_SHA;
  const ref = branch ? `refs/heads/${branch}` : tag ? `refs/tags/${tag}` : undefined;
  let kind: EventKind = "other";
  let pr: EventPr | undefined;
  let inputs: Record<string, string> = {};
  if (name === "merge_request_event") {
    kind = "pr";
    pr = mergeRequest(env);
  } else if (name === "parent_pipeline") {
    // A child pipeline gets the parent's variables, the merge request's among them.
    if (env.CI_MERGE_REQUEST_IID) {
      kind = "pr";
      pr = mergeRequest(env);
    } else if (branch) kind = "push";
  } else if (name === "push") {
    kind = tag ? "other" : branch ? "push" : "other";
  } else if (MANUAL_SOURCES.has(name)) {
    kind = "dispatch";
    inputs = dispatchInputs(env);
  }
  const info: EventInfo = { name, kind, inputs };
  if (pr) info.pr = pr;
  if (ref && kind !== "pr") info.ref = ref;
  if (sha && !/^0+$/.test(sha) && kind !== "pr") info.sha = sha;
  return info;
}

/** The environment from `env` (`CI_*` variables). */
export function gitlabEnvironment(env: Env): CiEnvironment {
  const ci: CiEnvironment = {
    host: "gitlab",
    inCi: env.GITLAB_CI === "true",
    serverUrl: (env.CI_SERVER_URL || DEFAULT_SERVER_URLS.gitlab).replace(/\/+$/, ""),
  };
  const set = <K extends keyof CiEnvironment>(key: K, value: CiEnvironment[K] | "" | undefined) => {
    if (value) ci[key] = value;
  };
  set("apiUrl", env.CI_API_V4_URL);
  set("repository", env.CI_PROJECT_PATH);
  set("token", env.LAUNCHSET_TOKEN || env.GITLAB_TOKEN);
  // CI_JOB_TOKEN reads merge requests, notes and releases but can't write most of them.
  set("fallbackToken", env.CI_JOB_TOKEN);
  if (env.CI_JOB_TOKEN) ci.fallbackTokenKind = "job";
  set("event", gitlabEvent(env));
  set("run", gitlabRunInfo(env));
  set(
    "ref",
    env.CI_COMMIT_BRANCH
      ? `refs/heads/${env.CI_COMMIT_BRANCH}`
      : env.CI_COMMIT_TAG
        ? `refs/tags/${env.CI_COMMIT_TAG}`
        : undefined,
  );
  set("refName", env.CI_COMMIT_REF_NAME);
  set("sha", env.CI_COMMIT_SHA);
  return ci;
}
