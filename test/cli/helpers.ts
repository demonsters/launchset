/** CLI test helpers: in-process `runCli` against temp repos, with collected output. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CliIo } from "../../src/cli/io.ts";
import { runCli } from "../../src/cli/program.ts";
import { repoWithRemote, type TestRepo } from "../git/helpers.ts";

export const NOW = new Date("2026-11-18T12:00:00Z");

export const CONFIG = {
  targets: {
    "docker-api": { type: "docker", image: "ghcr.io/acme/api" },
    web: { type: "web" },
    ios: {
      type: "ios",
      source: { kind: "xcconfig", file: "ios/Version.xcconfig" },
      release: "manual",
    },
  },
};

export const pkg = (version: string) =>
  `${JSON.stringify({ name: "app", private: true, version }, null, 2)}\n`;

export const xcconfig = (version: string, build = 12) =>
  `MARKETING_VERSION = ${version}\nCURRENT_PROJECT_VERSION = ${build}\n`;

export interface Fixture {
  repo: TestRepo;
  remote: string;
  dir: string;
}

/** A pushed repo at `version` with a config, a docker target, a web target and a manual iOS target. */
export function fixtureRepo(version = "1.4.0", options: { released?: boolean } = {}): Fixture {
  const { repo, remote } = repoWithRemote();
  repo.commit(`Set up ${version}`, {
    "launchset.config.json": `${JSON.stringify(CONFIG, null, 2)}\n`,
    ".launchset/README.md": "# Changesets\n",
    "CHANGELOG.md": `# Changelog\n\n## ${version} (2026-01-01)\n\n### Patch changes\n- First release.\n`,
    "package.json": pkg(version),
    "ios/Version.xcconfig": xcconfig(version),
  });
  repo.git("push", "--quiet", "origin", "main");
  if (options.released ?? true) {
    repo.git("tag", `v${version}`);
    repo.git("push", "--quiet", "origin", `v${version}`);
  }
  return { repo, remote, dir: repo.dir };
}

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Shell working directory. Default: the repo dir, or the process cwd. */
  cwd?: string;
  env?: Record<string, string | undefined>;
  isTTY?: boolean;
  io?: Partial<CliIo>;
}

/** Run the CLI in-process. The environment is empty unless given (no token, no `NO_COLOR` surprises). */
export async function cli(argv: string[], options: RunOptions = {}): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    // Prompts and colors are off unless a test asks: NO_COLOR keeps error output plain in TTY runs.
    env: options.env ?? { NO_COLOR: "1" },
    isTTY: options.isTTY ?? false,
    cwd: options.cwd ?? process.cwd(),
    now: NOW,
    ...options.io,
  };
  const code = await runCli(argv, io);
  return { code, stdout, stderr };
}

export function readJson(dir: string, path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, path), "utf8")) as Record<string, unknown>;
}
