/** Helpers for running the built action bundle the way the Actions runner does. */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A Node 24 binary (the `node24` Actions runtime). `LAUNCHSET_NODE24` overrides; otherwise the
 * fnm install on this machine. `undefined` when there is none.
 */
export function findNode24(): string | undefined {
  const fromEnv = process.env.LAUNCHSET_NODE24;
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : undefined;
  if (process.version.startsWith("v24.")) return process.execPath;
  const versions = join(homedir(), ".local/share/fnm/node-versions");
  if (!existsSync(versions)) return undefined;
  const found = readdirSync(versions)
    .filter((name) => name.startsWith("v24."))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .at(-1);
  const bin = found ? join(versions, found, "installation/bin/node") : undefined;
  return bin && existsSync(bin) ? bin : undefined;
}

/** Parse a `$GITHUB_OUTPUT` / `$GITHUB_ENV` file (`name=value` and `name<<delimiter` entries). */
export function parseCommandFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line === "") continue;
    const heredoc = line.match(/^([^=<]+)<<(.+)$/);
    if (heredoc) {
      const [, name, delimiter] = heredoc as unknown as [string, string, string];
      const value: string[] = [];
      for (i++; i < lines.length && lines[i] !== delimiter; i++) value.push(lines[i] as string);
      result[name] = value.join("\n");
      continue;
    }
    const eq = line.indexOf("=");
    if (eq > 0) result[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return result;
}

export interface ActionRun {
  status: number | null;
  stdout: string;
  stderr: string;
  outputs: Record<string, string>;
  env: Record<string, string>;
  summary: string;
}

export interface RunOptions {
  node: string;
  /** Path of `index.js`. */
  bundle: string;
  /** Scratch directory for the GITHUB_* files. */
  scratch: string;
  /** Repository root (GITHUB_WORKSPACE). */
  workspace: string;
  /** Action inputs by their action.yml name (`working-directory`, `command`, …). */
  inputs: Record<string, string>;
  /** Extra environment variables (GITHUB_EVENT_NAME, GITHUB_REF, …). */
  env?: Record<string, string>;
  /** Event payload for GITHUB_EVENT_PATH. */
  event?: unknown;
}

let counter = 0;

/** Run the bundle with `INPUT_*` variables and the runner's command files. */
export function runAction(options: RunOptions): ActionRun {
  const id = ++counter;
  const file = (name: string) => join(options.scratch, `${id}-${name}`);
  const files = {
    output: file("output"),
    env: file("env"),
    summary: file("summary.md"),
    event: file("event.json"),
  };
  for (const path of [files.output, files.env, files.summary]) writeFileSync(path, "");
  writeFileSync(files.event, JSON.stringify(options.event ?? {}));
  const inputEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.inputs)) {
    inputEnv[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] = value;
  }
  const baseEnv: Record<string, string> = {};
  // Nothing from the developer's or CI's own Actions environment leaks into the run.
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("GITHUB_") || key.startsWith("INPUT_") || key.startsWith("RUNNER_"))
      continue;
    if (key === "LAUNCHSET_TOKEN" || key === "CI") continue;
    baseEnv[key] = value;
  }
  const result = spawnSync(options.node, [options.bundle], {
    cwd: options.workspace,
    encoding: "utf8",
    env: {
      ...baseEnv,
      GITHUB_ACTIONS: "true",
      GITHUB_WORKSPACE: options.workspace,
      GITHUB_OUTPUT: files.output,
      GITHUB_ENV: files.env,
      GITHUB_STEP_SUMMARY: files.summary,
      GITHUB_EVENT_PATH: files.event,
      ...inputEnv,
      ...options.env,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    outputs: parseCommandFile(readFileSync(files.output, "utf8")),
    env: parseCommandFile(readFileSync(files.env, "utf8")),
    summary: readFileSync(files.summary, "utf8"),
  };
}

/** `git` in `dir` with an isolated identity. */
export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}
