/**
 * electron-builder in the steps init copies from a tag-triggered job (a custom target). In CI,
 * electron-builder publishes to GitHub Releases by itself: `onTag` on tag builds and
 * `onTagOrDraft` otherwise (app-builder-lib `PublishManager`), and with the GitHub provider that
 * includes branch pushes. So once the steps run in launchset's release workflow (a push to the
 * base branch) they fail without `GH_TOKEN` ("GitHub Personal Access Token is not set"), and with
 * it they upload to a release of their own next to launchset's. init doesn't edit the copied
 * steps: it points at the command and says to pass `--publish never` or set `GH_TOKEN` on purpose.
 */

import { posix } from "node:path";
import { normalizeRel } from "./fs.ts";
import type { PackageScripts } from "./machinery.ts";
import { simpleCommands } from "./shell.ts";
import type { WorkflowStep } from "./workflow-scan.ts";

export interface ElectronBuilderUse {
  /** The step that runs it. */
  step: WorkflowStep;
  /** The command in the step (`pnpm desktop:linux`), and the script chain to electron-builder. */
  command: string;
}

/** An `electron-builder` command (package runners are already dropped by `simpleCommands`). */
const ELECTRON_BUILDER = /^electron-builder(?:\s|$)/;
/**
 * Chooses publishing explicitly: `--publish never`, `-p always`, `--publish=onTag`, or the
 * config override `-c.publish=null`.
 */
const PUBLISH_FLAG = /(?:^|\s)(?:(?:--publish|-p)(?:[\s=]|$)|(?:-c|--config)\.publish=)/;
/** A token electron-builder publishes with: set on purpose, so it isn't "missing". */
const TOKEN_VARIABLES = ["GH_TOKEN", "GITHUB_TOKEN"];
const TOKEN_ASSIGNMENT = /(?:^|[\s;&|(])(?:export\s+)?(?:GH_TOKEN|GITHUB_TOKEN)=/m;

/** Package-manager options that take a value (`--filter app`, `-C dir`); `-w` only for npm. */
const OPTION_WITH_VALUE = /^(?:--filter|-F|-C|--dir|--prefix|--workspace|--cwd)$/;
/** npm's own commands that run a script without `run`. */
const NPM_SCRIPT_COMMANDS = new Set(["start", "test", "t", "stop", "restart"]);
/** bun's own commands (anything else after `bun` is a script or a file). */
const BUN_COMMANDS = new Set([
  "install",
  "i",
  "add",
  "a",
  "remove",
  "rm",
  "update",
  "upgrade",
  "test",
  "build",
  "x",
  "exec",
  "create",
  "init",
  "link",
  "unlink",
  "pm",
  "publish",
  "outdated",
  "patch",
  "repl",
]);

/** Where a script is looked up: the package the command runs in, the workspace root, or any. */
type Where = "here" | "root" | "any";

/**
 * The script a package-manager command runs, and where to look it up: `pnpm build`,
 * `npm run build -w app`, `npm start`, `bun dist`, `yarn workspace app build`,
 * `pnpm --filter app build`, `pnpm -w build`.
 */
function scriptRun(
  words: readonly string[],
): { name: string; args: string[]; where: Where } | undefined {
  const [head, ...rest] = words;
  if (head === undefined || !/^(?:npm|pnpm|yarn|bun)$/.test(head)) return undefined;
  let where: Where = "here";
  const left: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i] as string;
    if (head === "pnpm" && (w === "-w" || w === "--workspace-root")) {
      if (where === "here") where = "root";
    } else if (OPTION_WITH_VALUE.test(w) || (head === "npm" && w === "-w")) {
      where = "any";
      i++;
    } else if (
      /^--(?:filter|dir|prefix|workspace|cwd)=/.test(w) ||
      /^(?:-r|--recursive|--workspaces|-ws)$/.test(w)
    ) {
      where = "any";
    } else {
      left.push(w);
    }
  }
  if (head === "yarn" && left[0] === "workspace") {
    where = "any";
    left.splice(0, 2);
  }
  if (left[0] === "run" || left[0] === "run-script") left.shift();
  else if (head === "npm" && !NPM_SCRIPT_COMMANDS.has(left[0] ?? "")) return undefined;
  else if (head === "bun" && BUN_COMMANDS.has(left[0] ?? "")) return undefined;
  const [name, ...args] = left;
  if (name === undefined || name.startsWith("-")) return undefined;
  return { name, args, where };
}

/**
 * The words without an env wrapper in front: `cross-env NODE_ENV=production x`,
 * `dotenv -e .env -- x`, `env-cmd -f .env x`.
 */
function unwrap(words: readonly string[]): readonly string[] {
  let w = words;
  for (;;) {
    const head = w[0];
    if (head === "cross-env" || head === "cross-env-shell") {
      w = w.slice(1);
      while (w[0] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1);
    } else if (head === "dotenv" || head === "dotenv-cli" || head === "env-cmd") {
      const end = w.indexOf("--");
      if (end !== -1) {
        w = w.slice(end + 1);
      } else {
        w = w.slice(1);
        while (w[0]?.startsWith("-")) {
          w = w.slice(/^(?:-[efcv]|--file|--environments|--path)$/.test(w[0]) ? 2 : 1);
        }
      }
    } else {
      return w;
    }
  }
}

/**
 * The electron-builder command `script` runs, following package scripts (up to three levels),
 * when it doesn't choose publishing itself and no token is set in it. `dir` is the directory the
 * script runs in (a `cd` moves it).
 */
function findIn(
  script: string,
  start: string,
  packages: readonly PackageScripts[],
  depth: number,
): string | undefined {
  if (TOKEN_ASSIGNMENT.test(script)) return undefined;
  let dir = start;
  for (const command of simpleCommands(script)) {
    const words = unwrap(command.words);
    const text = words.join(" ");
    if (words[0] === "cd" && words[1] !== undefined) {
      dir = normalizeRel(posix.join(dir, normalizeRel(words[1])));
      continue;
    }
    if (ELECTRON_BUILDER.test(text)) return PUBLISH_FLAG.test(text) ? undefined : text;
    const run = scriptRun(words);
    if (run === undefined || depth >= 3) continue;
    // Arguments after the script name are passed on to it (`pnpm dist --publish never`).
    if (PUBLISH_FLAG.test(run.args.join(" "))) continue;
    const here = packages.find((p) => p.dir === (run.where === "root" ? "." : dir));
    const candidates = run.where === "any" ? packages : here ? [here] : [];
    for (const p of candidates) {
      const body = p.scripts[run.name];
      if (body === undefined) continue;
      const found = findIn(body, p.dir, packages, depth + 1);
      if (found !== undefined) return `${text} -> ${found}`;
    }
    // `yarn electron-builder`, `pnpm electron-builder`: the package manager runs the binary.
    if (run.name === "electron-builder" && !candidates.some((p) => p.scripts[run.name])) {
      return text;
    }
  }
  return undefined;
}

/**
 * The first step that runs electron-builder without choosing whether it publishes. `env` is
 * the job's env: a token there (or in the step's) means publishing is set up on purpose.
 */
export function electronBuilderUse(
  steps: readonly WorkflowStep[],
  packages: readonly PackageScripts[],
  env: Readonly<Record<string, string>> = {},
): ElectronBuilderUse | undefined {
  for (const step of steps) {
    if (!step.run) continue;
    if (TOKEN_VARIABLES.some((k) => k in env || k in step.env)) continue;
    const found = findIn(step.run.value, normalizeRel(step.runDirectory ?? "."), packages, 0);
    if (found !== undefined) return { step, command: found };
  }
  return undefined;
}

/**
 * Directories a step may run package scripts in besides the root and the workspaces: its
 * `working-directory` and the targets of a plain `cd <dir>`.
 */
export function stepPackageDirs(steps: readonly WorkflowStep[]): string[] {
  const dirs: string[] = [];
  for (const step of steps) {
    if (!step.run) continue;
    const base = normalizeRel(step.runDirectory ?? ".");
    dirs.push(base);
    for (const { words } of simpleCommands(step.run.value)) {
      if (words[0] === "cd" && words[1] !== undefined && !/[$*?~]/.test(words[1])) {
        dirs.push(normalizeRel(posix.join(base, normalizeRel(words[1]))));
      }
    }
  }
  return [...new Set(dirs)].filter((d) => !d.startsWith("../") && d !== "..");
}
