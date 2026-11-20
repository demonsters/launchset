/**
 * The files of the CLI's `--ci` mode and whether it is on: plan.json, launchset.env,
 * launchset.sh, launchset.ps1 and the GitLab child pipeline, each with the variable that renames it. Used by
 * `ci-output.ts`, which writes them, and by `run.ts`, which tells git they are launchset's own.
 */

import { resolve } from "node:path";
import { ciFromEnv, ciProfile } from "../core/hosts.ts";
import { DEFAULT_CHILD_FILE } from "../templates/gitlab-child.ts";
import type { CliIo } from "./io.ts";

/** Each `--ci` file: the variable that names it, and its default name. */
const CI_FILES = {
  plan: ["LAUNCHSET_PLAN_FILE", "plan.json"],
  dotenv: ["LAUNCHSET_DOTENV", "launchset.env"],
  shell: ["LAUNCHSET_SHELL_ENV", "launchset.sh"],
  powershell: ["LAUNCHSET_POWERSHELL_ENV", "launchset.ps1"],
  child: ["LAUNCHSET_CHILD_PIPELINE", DEFAULT_CHILD_FILE],
} as const;

type CiFile = keyof typeof CI_FILES;

/** Whether `--ci` is on: the flag, else whether the CI that runs launchset turns it on (GitLab CI). */
export function ciEnabled(io: CliIo, opts: { ci?: boolean | undefined }): boolean {
  if (opts.ci !== undefined) return opts.ci;
  const ci = ciFromEnv(io.env);
  return ci !== undefined && ciProfile(ci).ciFilesByDefault;
}

/** The name of a `--ci` file as configured (relative to the shell's folder, or absolute). */
export function ciFileName(io: CliIo, which: CiFile): string {
  const [variable, fallback] = CI_FILES[which];
  return io.env[variable]?.trim() || fallback;
}

/** The absolute path of a `--ci` file. */
export function ciFilePath(io: CliIo, which: CiFile): string {
  return resolve(io.cwd, ciFileName(io, which));
}

/** Every `--ci` file's absolute path. */
export function ciFilePaths(io: CliIo): string[] {
  return (Object.keys(CI_FILES) as CiFile[]).map((which) => ciFilePath(io, which));
}
