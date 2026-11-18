/** Helpers shared by the commands: the config root, the flow context, plan input, output. */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CONFIG_FILE_NAMES } from "../config/load.ts";
import { LaunchsetError } from "../core/errors.ts";
import {
  type ContextOptions,
  createContext,
  type FlowContext,
  type FlowResult,
  type Logger,
} from "../flow/index.ts";
import { UsageError } from "./errors.ts";
import type { CliIo } from "./io.ts";

/** Options every command understands (also accepted before the command name). */
export interface GlobalOpts {
  cwd?: string;
  json?: boolean;
  token?: string;
  repo?: string;
  yes?: boolean;
}

/** The directory with the launchset config: `--cwd`, else the nearest parent that has one. */
export function resolveRoot(io: CliIo, opts: GlobalOpts): string {
  if (opts.cwd) return resolve(io.cwd, opts.cwd);
  let dir = resolve(io.cwd);
  for (;;) {
    if (CONFIG_FILE_NAMES.some((name) => existsSync(join(dir, name)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(io.cwd);
    dir = parent;
  }
}

/** Progress and warnings go to stderr, so stdout only carries results. */
export function cliLogger(io: CliIo): Logger {
  const debug = Boolean(io.env.LAUNCHSET_DEBUG);
  return {
    info: (message) => io.stderr(`${message}\n`),
    warn: (message) => io.stderr(`warning: ${message}\n`),
    debug: (message) => {
      if (debug) io.stderr(`debug: ${message}\n`);
    },
  };
}

const REPO = /^[^/\s]+\/[^/\s]+$/;

export async function makeContext(
  io: CliIo,
  opts: GlobalOpts,
  extra: Pick<ContextOptions, "run"> = {},
): Promise<FlowContext> {
  if (opts.repo !== undefined && !REPO.test(opts.repo)) {
    throw new UsageError(
      `--repo ${opts.repo} is not owner/repo`,
      "Pass the repository as --repo demonsters/my-app.",
    );
  }
  return createContext({
    cwd: resolveRoot(io, opts),
    env: io.env,
    log: cliLogger(io),
    ...(opts.token ? { token: opts.token } : {}),
    ...(opts.repo ? { repository: opts.repo } : {}),
    ...(io.now ? { now: io.now } : {}),
    ...extra,
  });
}

/**
 * The plan JSON text: `--plan '<json>'`, `--plan @file.json`, else `LAUNCHSET_PLAN` (unless
 * `useEnv` is false, e.g. explicit `--version` flags were given).
 */
export async function readPlanInput(
  io: CliIo,
  value: string | undefined,
  useEnv = true,
): Promise<string | undefined> {
  const raw = value ?? (useEnv ? io.env.LAUNCHSET_PLAN : undefined);
  if (raw === undefined || raw.trim() === "") return undefined;
  if (!raw.startsWith("@")) return raw;
  const file = resolve(io.cwd, raw.slice(1));
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    throw new LaunchsetError("plan-file-unreadable", `can't read the plan file ${file}`, {
      cause: error,
      hint: "Pass --plan @path/to/plan.json, or the JSON itself.",
    });
  }
}

export function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Print a flow result and return the exit code: lines on stdout, or with `--json` only JSON
 * on stdout (the report goes to stderr when the command failed). `ok: false` exits 1.
 */
export function emit(
  io: CliIo,
  result: FlowResult,
  opts: { json?: boolean | undefined } = {},
): number {
  const text = result.lines.length > 0 ? `${result.lines.join("\n")}\n` : "";
  if (opts.json) {
    let data = result.data;
    if (result.env && data !== null && typeof data === "object" && !Array.isArray(data)) {
      data = { ...data, env: result.env };
    }
    io.stdout(toJson(data));
    if (!result.ok && text) io.stderr(text);
  } else if (text) {
    io.stdout(text);
  }
  return result.ok ? 0 : 1;
}
