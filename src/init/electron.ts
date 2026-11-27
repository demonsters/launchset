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
/** Chooses publishing explicitly: `--publish never`, `-p always`, `--publish=onTag`. */
const PUBLISH_FLAG = /(?:^|\s)(?:--publish|-p)(?:[\s=]|$)/;

/** Options of npm, pnpm, yarn and bun that take a value (`--filter app`, `-C dir`). */
const OPTION_WITH_VALUE = /^(?:--filter|-F|-C|--dir|--prefix|-w|--workspace|--cwd)$/;

/**
 * The script a package-manager command runs, and where to look it up: `pnpm build`,
 * `npm run build -w app`, `yarn workspace app build`, `pnpm --filter app build`. `any` is true
 * when it may run in another package (a filter or workspace option).
 */
function scriptRun(
  words: readonly string[],
): { name: string; args: string[]; any: boolean } | undefined {
  const [head, ...rest] = words;
  if (head === undefined || !/^(?:npm|pnpm|yarn|bun)$/.test(head)) return undefined;
  let any = false;
  const left: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i] as string;
    if (OPTION_WITH_VALUE.test(w)) {
      any = true;
      i++;
    } else if (
      /^--(?:filter|dir|prefix|workspace|cwd)=/.test(w) ||
      /^(?:-r|--recursive|--workspaces|-ws)$/.test(w)
    ) {
      any = true;
    } else {
      left.push(w);
    }
  }
  if (head === "yarn" && left[0] === "workspace") {
    any = true;
    left.splice(0, 2);
  }
  if (left[0] === "run" || left[0] === "run-script") left.shift();
  else if (head === "npm" || head === "bun") return undefined; // `npm install`, `bun test`
  const [name, ...args] = left;
  if (name === undefined || name.startsWith("-")) return undefined;
  return { name, args, any };
}

/**
 * The electron-builder command `script` runs, following package scripts (up to three levels),
 * when it doesn't choose publishing itself. `dir` is the directory the script runs in.
 */
function findIn(
  script: string,
  dir: string,
  packages: readonly PackageScripts[],
  depth: number,
): string | undefined {
  for (const { words, text } of simpleCommands(script)) {
    if (ELECTRON_BUILDER.test(text)) return PUBLISH_FLAG.test(text) ? undefined : text;
    const run = scriptRun(words);
    if (run === undefined || depth >= 3) continue;
    // Arguments after the script name are passed on to it (`pnpm dist --publish never`).
    if (run.args.some((a) => /^(?:--publish|-p)(?:=|$)/.test(a))) continue;
    const own = packages.find((p) => p.dir === dir);
    const candidates = run.any ? packages : own ? [own] : [];
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

/** The first step that runs electron-builder without choosing whether it publishes. */
export function electronBuilderUse(
  steps: readonly WorkflowStep[],
  packages: readonly PackageScripts[],
): ElectronBuilderUse | undefined {
  for (const step of steps) {
    if (!step.run) continue;
    const dir = posix.normalize(step.runDirectory ?? ".").replace(/\/$/, "");
    const found = findIn(step.run.value, dir, packages, 0);
    if (found !== undefined) return { step, command: found };
  }
  return undefined;
}
