/**
 * The launchset command line (spec 11): a thin layer over src/flow and src/init. It parses
 * flags, decides whether it may ask questions, builds the flow context and prints results.
 */

import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { DOCS_URL } from "../core/links.ts";
import { BUMPS, type Bump, type Channel } from "../core/types.ts";
import {
  add,
  check,
  finalize,
  hotfix,
  mark,
  release,
  ship,
  stamp,
  status,
  verify,
  version,
} from "../flow/index.ts";
import { previewComment, previewPlan } from "../flow/preview.ts";
import { Git } from "../git/index.ts";
import { INIT_FLAGS, parseDecide } from "../init/flags.ts";
import { packageFile } from "../init/package-files.ts";
import type { InitOptions } from "../init/types.ts";
import { emitCi, finishCi } from "./ci-output.ts";
import { exitCodeFor, reportError, UsageError } from "./errors.ts";
import { type CliIo, processIo } from "./io.ts";
import { cliLogger, emit, type GlobalOpts, makeContext, readPlanInput, toJson } from "./run.ts";

/** Exit code of the command that ran (0 until a command says otherwise). */
export interface RunState {
  exitCode: number;
}

/** Exit code for wrong usage (unknown command or option, missing argument). */
const EXIT_USAGE = 2;

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(packageFile("package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function positiveInt(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) {
    throw new InvalidArgumentError("expected a positive integer.");
  }
  return Number(value);
}

const CHANNELS: readonly Channel[] = ["release", "prerelease", "preview"];

type Handler<O> = (opts: O & GlobalOpts, args: string[]) => Promise<number>;

/** Shared options; `--cwd` etc. are also accepted before the command name. */
function withGlobals(
  cmd: Command,
  options: {
    json?: boolean;
    yes?: boolean;
    github?: boolean;
    ci?: boolean;
    cwdHelp?: string;
  } = {},
): Command {
  cmd.option(
    "--cwd <dir>",
    options.cwdHelp ??
      "run in this directory (default: the nearest folder with a launchset config)",
  );
  if (options.json) cmd.option("--json", "print JSON on stdout (logs go to stderr)");
  if (options.yes) cmd.option("--yes", "never ask; accept defaults");
  if (options.ci) {
    cmd.option(
      "--ci",
      "write plan.json, launchset.env and launchset.sh (default: on when $GITLAB_CI is true)",
    );
    cmd.option("--no-ci", "don't write the CI output files");
  }
  if (options.github !== false) {
    cmd.option(
      "--token <token>",
      "token (default: $LAUNCHSET_TOKEN, then $GITHUB_TOKEN / $GITLAB_TOKEN)",
    );
    cmd.option(
      "--repo <path>",
      "repository path (owner/repo, or group/sub/project on GitLab; default: from the origin remote)",
    );
  }
  return cmd;
}

function examples(cmd: Command, ...lines: string[]): Command {
  return cmd.addHelpText("after", `\nExample:\n${lines.map((l) => `  $ ${l}`).join("\n")}\n`);
}

/** Help text on the variables a command writes in `--ci` mode. */
function ciHelp(cmd: Command, variables?: string): Command {
  const names = variables ? `\nVariables: ${variables}` : "";
  return cmd.addHelpText(
    "after",
    `\nIn --ci mode also writes plan.json, launchset.env and launchset.sh (see docs).${names}\n`,
  );
}

function missingPlan(command: string): UsageError {
  return new UsageError(
    `${command} needs the release plan`,
    "Pass --plan '<json>', --plan @plan.json or set LAUNCHSET_PLAN. Create one with: launchset plan > plan.json",
  );
}

/** The git top-level directory of `dir`, or undefined outside a repo. */
async function gitTopLevel(dir: string): Promise<string | undefined> {
  try {
    return await new Git({ cwd: dir }).topLevel();
  } catch {
    return undefined;
  }
}

function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

/**
 * The folder `init` sets up: `--cwd`, else the git top-level folder (GitHub only runs workflows
 * from the repo root), else the shell's folder. Says so when that isn't the folder it ran in.
 */
async function initRoot(io: CliIo, cwd: string | undefined): Promise<string> {
  const base = resolve(io.cwd, cwd ?? ".");
  const top = await gitTopLevel(base);
  if (top === undefined || sameDir(top, base)) return base;
  if (cwd === undefined) {
    io.stderr(
      `note: init sets up the repo root ${top} (you ran it in ${base}). Pass --cwd to set up another folder.\n`,
    );
    return top;
  }
  io.stderr(
    `warning: ${base} is a subfolder of the repo ${top}. GitHub only runs workflows from the repo root, so the workflows init writes in ${base}/.github won't run.\n`,
  );
  return base;
}

export function createProgram(io: CliIo = processIo(), state: RunState = { exitCode: 0 }): Command {
  const program = new Command("launchset");
  program
    .description("Changesets-style releases for lock-step monorepos: one version, many targets.")
    .version(packageVersion(), "-V, --version", "print the launchset version")
    .enablePositionalOptions()
    .showHelpAfterError("(run with --help for usage)")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.stdout(text),
      writeErr: (text) => io.stderr(text),
      getOutHasColors: () => false,
      getErrHasColors: () => false,
      getOutHelpWidth: () => 100,
      getErrHelpWidth: () => 100,
    });
  withGlobals(program, { json: true, yes: true });
  program.addHelpText(
    "after",
    `\nEvery command works without prompts when stdin is not a terminal. Add --json for machine-readable output.\nDocs: ${DOCS_URL}\n`,
  );

  /** Register a command whose action runs `handler`, turning failures into exit codes. */
  function command<O>(
    name: string,
    description: string,
    setup: (cmd: Command) => Command,
    handler: Handler<O>,
  ): void {
    const cmd = program.command(name).description(description);
    setup(cmd);
    cmd.action(async (...args: unknown[]) => {
      const self = args.at(-1) as Command;
      try {
        state.exitCode = await handler(self.optsWithGlobals() as O & GlobalOpts, self.args);
      } catch (error) {
        reportError(io, error);
        state.exitCode = exitCodeFor(error);
      }
    });
  }

  // init ---------------------------------------------------------------------------------
  command<{
    decide?: string[];
    detect?: boolean;
    convertOnly?: boolean;
    baseline?: boolean;
    skill?: boolean;
    hook?: boolean;
  }>(
    "init",
    "Set up a repo: detect versions and targets, write the config, workflows and README.",
    (cmd) => {
      withGlobals(cmd, {
        github: false,
        cwdHelp:
          "set up this folder (default: the git repo root; GitHub only runs workflows from the root)",
      });
      for (const flag of INIT_FLAGS) {
        if (flag.type === "string[]") {
          cmd.addOption(new Option(`${flag.flag} <id=value>`, flag.description).argParser(collect));
        } else {
          cmd.option(flag.flag, flag.description);
          if (flag.negatable) {
            cmd.option(flag.flag.replace("--", "--no-"), `do not: ${flag.description}`);
          }
        }
      }
      return examples(
        cmd,
        "launchset init --detect --json   # what would init do? writes nothing",
        "launchset init --yes --decide version=1.4.0",
      );
    },
    async (opts) => {
      const interactive = io.isTTY && !opts.yes && !opts.detect && !opts.json && !opts.convertOnly;
      const options: InitOptions = {
        cwd: await initRoot(io, opts.cwd),
        yes: Boolean(opts.yes),
        decide: parseDecide(opts.decide ?? []),
        detect: Boolean(opts.detect),
        json: Boolean(opts.json),
        convertOnly: Boolean(opts.convertOnly),
        interactive,
        output: {
          log: (line) => io.stdout(`${line}\n`),
          warn: (line) => io.stderr(`warning: ${line}\n`),
          json: (value) => io.stdout(toJson(value)),
        },
        ...(opts.baseline !== undefined ? { baseline: opts.baseline } : {}),
        ...(opts.skill !== undefined ? { skill: opts.skill } : {}),
        ...(opts.hook !== undefined ? { hook: opts.hook } : {}),
        ...(io.initPrompter ? { prompter: io.initPrompter } : {}),
        ...(io.now ? { now: io.now } : {}),
        ...(io.rng ? { rng: io.rng } : {}),
      };
      // Loaded on demand: the init machinery is big and only this command needs it.
      const { runInit } = await import("../init/index.ts");
      await runInit(options);
      return 0;
    },
  );

  // add ----------------------------------------------------------------------------------
  command<{ bump?: string; message?: string; empty?: boolean }>(
    "add",
    "Create a changeset: the bump (major, minor, patch) and a summary for the changelog.",
    (cmd) => {
      withGlobals(cmd, { json: true, yes: true, github: false });
      cmd.addOption(new Option("--bump <type>", "bump type").choices(BUMPS));
      cmd.option("-m, --message <text>", "summary for the changelog");
      cmd.option("--empty", "a change that needs no release (bump: none)");
      return examples(
        cmd,
        'launchset add --bump minor --message "Add dark mode"',
        "launchset add --empty",
        "launchset add            # asks, in a terminal",
      );
    },
    async (opts) => {
      if (opts.empty && opts.bump && opts.bump !== "none") {
        throw new UsageError(
          `--empty means bump: none, but --bump ${opts.bump} was given`,
          "Drop --empty, or use --bump none.",
        );
      }
      let bump: string | undefined = opts.empty ? "none" : opts.bump;
      let message = opts.message;
      const flagsGiven = opts.bump !== undefined || opts.message !== undefined || opts.empty;
      if (!flagsGiven) {
        if (!io.isTTY || opts.yes || opts.json) {
          throw new UsageError(
            "add needs --bump <major|minor|patch|none> and --message <text> (or --empty), because it can't ask questions here",
            io.isTTY
              ? 'Leave out --yes/--json to answer the prompts, or pass the flags: launchset add --bump patch --message "Fix the crash".'
              : 'Pass the flags, e.g.: launchset add --bump patch --message "Fix the crash".',
          );
        }
        const prompts = io.addPrompts ?? (await import("./prompts.ts")).clackAddPrompts();
        bump = await prompts.bump();
        if (bump !== "none") message = await prompts.summary();
      }
      const context = await makeContext(io, opts);
      const result = await add(context, {
        ...(bump !== undefined ? { bump: bump as Bump } : {}),
        ...(message !== undefined ? { message } : {}),
        ...(io.rng ? { rng: io.rng } : {}),
      });
      return emit(io, result, { json: opts.json });
    },
  );

  // status -------------------------------------------------------------------------------
  command<{ requireChangeset?: boolean; since?: string; fetch?: boolean }>(
    "status",
    "Show pending changesets, the next version, the last release and anything unfinished.",
    (cmd) => {
      withGlobals(cmd, { json: true, ci: true });
      cmd.option(
        "--require-changeset",
        "exit 1 unless a changeset was added or changed compared with --since",
      );
      cmd.option(
        "--since <ref>",
        "base ref for --require-changeset (default: origin/<base branch>)",
      );
      cmd.option("--no-fetch", "don't fetch tags first");
      examples(
        cmd,
        "launchset status --json",
        "launchset status --require-changeset --since origin/main",
      );
      return ciHelp(cmd);
    },
    async (opts) => {
      if (opts.since !== undefined && !opts.requireChangeset) {
        throw new UsageError(
          "--since only applies with --require-changeset",
          "Add --require-changeset, or drop --since.",
        );
      }
      const context = await makeContext(io, opts);
      const result = await status(context, {
        ...(opts.requireChangeset ? { requireChangeset: true } : {}),
        ...(opts.since ? { since: opts.since } : {}),
        fetch: opts.fetch !== false,
      });
      return emitCi(io, cliLogger(io), "status", result, context, opts);
    },
  );

  // version ------------------------------------------------------------------------------
  command<{ dryRun?: boolean; fetch?: boolean }>(
    "version",
    "Apply the pending changesets locally (what the release PR commit does).",
    (cmd) => {
      withGlobals(cmd, { json: true });
      cmd.option("--dry-run", "print the diff, write nothing");
      cmd.option("--no-fetch", "don't fetch tags first");
      return examples(cmd, "launchset version --dry-run");
    },
    async (opts) => {
      const result = await version(await makeContext(io, opts), {
        dryRun: Boolean(opts.dryRun),
        fetch: opts.fetch !== false,
      });
      return emit(io, result, { json: opts.json });
    },
  );

  // plan ---------------------------------------------------------------------------------
  command<{
    preview?: boolean;
    target?: string;
    version?: string;
    force?: boolean;
    branch?: string;
    fetch?: boolean;
    runNumber?: number;
  }>(
    "plan",
    "Print the release plan (mode, matrix, version, build number) as JSON. Writes nothing.",
    (cmd) => {
      withGlobals(cmd, { json: true, ci: true });
      cmd.option(
        "--preview",
        "plan a preview build instead (a dry run: prerelease tags are not reserved)",
      );
      cmd.option(
        "--target <names>",
        "a manual target to ship; with --preview: targets to build (comma separated, or all)",
      );
      cmd.option("--version <version>", "with --target: the released version to ship");
      cmd.option(
        "--force",
        "with --target: allow a version lower than the target's highest marker",
      );
      cmd.option("--branch <name>", "plan for this branch (default: the current branch)");
      cmd.addOption(
        new Option(
          "--run-number <n>",
          "with --preview: the workflow run number (default: $GITHUB_RUN_NUMBER)",
        ).argParser(positiveInt),
      );
      cmd.option("--no-fetch", "don't fetch tags first");
      examples(cmd, "launchset plan > plan.json", "launchset plan --preview");
      return ciHelp(
        cmd,
        "LAUNCHSET_MODE, LAUNCHSET_MATRIX, LAUNCHSET_VERSION, LAUNCHSET_BUILD_NUMBER, LAUNCHSET_CHANNEL, LAUNCHSET_RELEASE_SHA, ...",
      );
    },
    async (opts) => {
      const context = await makeContext(
        io,
        opts,
        opts.runNumber === undefined ? {} : { run: { number: opts.runNumber } },
      );
      const fetch = opts.fetch !== false;
      if (opts.preview) {
        const result = await previewPlan(context, {
          fetch,
          dryRun: true,
          ...(opts.target === undefined ? {} : { targets: [opts.target] }),
        });
        const { skip } = result.data;
        io.stdout(
          toJson(
            result.data.outcome === "skip" && skip
              ? { skipped: skip.code, reason: skip.reason }
              : result.data.plan,
          ),
        );
        io.stderr(`${result.lines.join("\n")}\n`);
        await finishCi(io, cliLogger(io), "preview-plan", result, context, {
          ...opts,
          summaryToStderr: true,
        });
        return result.ok ? 0 : 1;
      }
      const result = await release(context, {
        dryRun: true,
        fetch,
        ...(opts.target ? { target: opts.target } : {}),
        ...(opts.version ? { version: opts.version } : {}),
        ...(opts.force ? { force: true } : {}),
        ...(opts.branch ? { branch: opts.branch } : {}),
      });
      io.stdout(toJson(result.data.plan));
      const notes = result.lines.filter((l) => /^(warning|note):/.test(l));
      if (notes.length > 0) io.stderr(`${notes.join("\n")}\n`);
      await finishCi(io, cliLogger(io), "release", result, context, {
        ...opts,
        summaryToStderr: true,
      });
      return result.ok ? 0 : 1;
    },
  );

  // release ------------------------------------------------------------------------------
  command<{
    target?: string;
    version?: string;
    force?: boolean;
    branch?: string;
    fetch?: boolean;
  }>(
    "release",
    "Decide the release mode and update (or close) the release PR/MR. `plan` is the dry run.",
    (cmd) => {
      withGlobals(cmd, { json: true, ci: true });
      cmd.option("--target <name>", "a manual target to ship");
      cmd.option("--version <version>", "with --target: the released version to ship");
      cmd.option(
        "--force",
        "with --target: allow a version lower than the target's highest marker",
      );
      cmd.option("--branch <name>", "release for this branch (default: the current branch)");
      cmd.option("--no-fetch", "don't fetch tags first");
      examples(cmd, "launchset release --ci", "launchset release --target ios --version 1.5.0");
      return ciHelp(
        cmd,
        "LAUNCHSET_MODE, LAUNCHSET_MATRIX, LAUNCHSET_VERSION, LAUNCHSET_BUILD_NUMBER, LAUNCHSET_CHANNEL, LAUNCHSET_RELEASE_SHA, LAUNCHSET_TAG, LAUNCHSET_DIST_TAG, LAUNCHSET_PR_NUMBER, ...",
      );
    },
    async (opts) => {
      const context = await makeContext(io, opts);
      const result = await release(context, {
        fetch: opts.fetch !== false,
        ...(opts.target ? { target: opts.target } : {}),
        ...(opts.version ? { version: opts.version } : {}),
        ...(opts.force ? { force: true } : {}),
        ...(opts.branch ? { branch: opts.branch } : {}),
      });
      return emitCi(io, cliLogger(io), "release", result, context, opts);
    },
  );

  // preview-plan -------------------------------------------------------------------------
  command<{ target?: string; fetch?: boolean }>(
    "preview-plan",
    "Plan a preview build and reserve its prerelease tag. `plan --preview` is the dry run.",
    (cmd) => {
      withGlobals(cmd, { json: true, ci: true });
      cmd.option("--target <names>", "targets to build for a manual run (comma separated, or all)");
      cmd.option("--no-fetch", "don't fetch tags first");
      examples(cmd, "launchset preview-plan --ci", "launchset preview-plan --target web,android");
      return ciHelp(
        cmd,
        "LAUNCHSET_MATRIX, LAUNCHSET_VERSION, LAUNCHSET_BUILD_NUMBER, LAUNCHSET_CHANNEL, LAUNCHSET_PRERELEASE, LAUNCHSET_RELEASE_SHA, LAUNCHSET_TAG, LAUNCHSET_SKIPPED, ...",
      );
    },
    async (opts) => {
      const context = await makeContext(io, opts);
      // A target without a name means "not given"; previewPlan splits the comma-separated list.
      const given = opts.target !== undefined && /[^\s,]/.test(opts.target);
      const result = await previewPlan(context, {
        fetch: opts.fetch !== false,
        ...(given && opts.target !== undefined ? { targets: [opts.target] } : {}),
      });
      return emitCi(io, cliLogger(io), "preview-plan", result, context, opts);
    },
  );

  // preview-comment ----------------------------------------------------------------------
  command<{ plan?: string }>(
    "preview-comment",
    "Post the preview results (a sticky comment, or the prerelease notes).",
    (cmd) => {
      withGlobals(cmd, { json: true, ci: true });
      cmd.option(
        "--plan <json|@file>",
        "the preview plan (default: $LAUNCHSET_PLAN; empty: nothing to report)",
      );
      examples(cmd, "launchset preview-comment --plan @plan.json");
      return ciHelp(cmd, "LAUNCHSET_COMMENT_URL, LAUNCHSET_RELEASE_URL");
    },
    async (opts) => {
      // Empty when the preview was skipped: the flow reports "nothing to report".
      const plan = (await readPlanInput(io, opts.plan)) ?? "";
      const context = await makeContext(io, opts);
      const result = await previewComment(context, { plan });
      return emitCi(io, cliLogger(io), "preview-comment", result, context, opts);
    },
  );

  // stamp --------------------------------------------------------------------------------
  command<{
    target: string;
    plan?: string;
    version?: string;
    buildNumber?: number;
    channel?: Channel;
  }>(
    "stamp",
    "Write the version and build number into one target's files (never committed).",
    (cmd) => {
      withGlobals(cmd, { json: true, github: false, ci: true });
      cmd.requiredOption("--target <name>", "target name from the config");
      cmd.option("--plan <json|@file>", "the plan (default: $LAUNCHSET_PLAN)");
      cmd.option("--version <version>", "without a plan: the version to write");
      cmd.addOption(
        new Option("--build-number <n>", "without a plan: the build number").argParser(positiveInt),
      );
      cmd.addOption(
        new Option("--channel <channel>", "without a plan: release, prerelease or preview").choices(
          CHANNELS,
        ),
      );
      examples(
        cmd,
        "launchset stamp --target android --version 1.5.0 --build-number 217000000",
        "launchset stamp --target web --plan @plan.json",
        "launchset stamp --target web --plan @plan.json --ci && . ./launchset.sh",
      );
      return ciHelp(
        cmd,
        "LAUNCHSET_VERSION, LAUNCHSET_BUILD_NUMBER, LAUNCHSET_CHANNEL, LAUNCHSET_MARKETING_VERSION, LAUNCHSET_RELEASE_SHA, ...",
      );
    },
    async (opts) => {
      const byFlags =
        opts.version !== undefined || opts.buildNumber !== undefined || opts.channel !== undefined;
      if (byFlags && opts.plan !== undefined) {
        throw new UsageError(
          "--plan can't be combined with --version, --build-number or --channel",
          "Give either the plan or the values.",
        );
      }
      // Neither the plan nor --version: stamp says so (exit code 2).
      const plan = await readPlanInput(io, opts.plan, !byFlags);
      const context = await makeContext(io, opts);
      const result = await stamp(context, {
        target: opts.target,
        ...(plan !== undefined ? { plan } : {}),
        ...(opts.version !== undefined ? { version: opts.version } : {}),
        ...(opts.buildNumber !== undefined ? { buildNumber: opts.buildNumber } : {}),
        ...(opts.channel ? { channel: opts.channel } : {}),
      });
      return emitCi(io, cliLogger(io), "stamp", result, context, opts);
    },
  );

  // verify -------------------------------------------------------------------------------
  command<{ target: string; plan?: string }>(
    "verify",
    "Check the stores and registries: is this version and build number already published?",
    (cmd) => {
      withGlobals(cmd, { json: true, github: false, ci: true });
      cmd.requiredOption("--target <name>", "target name from the config");
      cmd.option("--plan <json|@file>", "the plan (default: $LAUNCHSET_PLAN)");
      examples(cmd, "launchset verify --target docker-api --plan @plan.json");
      return ciHelp(
        cmd,
        "LAUNCHSET_ALREADY_PUBLISHED, LAUNCHSET_VERSION, LAUNCHSET_BUILD_NUMBER, ...",
      );
    },
    async (opts) => {
      const plan = await readPlanInput(io, opts.plan);
      if (plan === undefined) throw missingPlan("verify");
      const context = await makeContext(io, opts);
      const result = await verify(context, { target: opts.target, plan });
      return emitCi(io, cliLogger(io), "verify", result, context, opts);
    },
  );

  // mark ---------------------------------------------------------------------------------
  command<{ target: string; plan?: string; version?: string; buildNumber?: number }>(
    "mark",
    "Create and push the marker tag for a target (for a manual target: --version).",
    (cmd) => {
      withGlobals(cmd, { json: true, ci: true });
      cmd.requiredOption("--target <name>", "target name from the config");
      cmd.option("--plan <json|@file>", "the plan (default: $LAUNCHSET_PLAN)");
      cmd.option("--version <version>", "a released version shipped by hand (manual targets)");
      cmd.addOption(
        new Option("--build-number <n>", "with --version: the build number that shipped").argParser(
          positiveInt,
        ),
      );
      examples(cmd, "launchset mark --target ios --version 1.5.0 --build-number 217000000");
      return ciHelp(cmd, "LAUNCHSET_VERSION, LAUNCHSET_RELEASE_SHA");
    },
    async (opts) => {
      // Neither the plan nor --version: mark says so (exit code 2).
      const plan = await readPlanInput(io, opts.plan, opts.version === undefined);
      const context = await makeContext(io, opts);
      const result = await mark(context, {
        target: opts.target,
        ...(plan !== undefined ? { plan } : {}),
        ...(opts.version !== undefined ? { version: opts.version } : {}),
        ...(opts.buildNumber !== undefined ? { buildNumber: opts.buildNumber } : {}),
      });
      return emitCi(io, cliLogger(io), "mark", result, context, opts);
    },
  );

  // ship ---------------------------------------------------------------------------------
  command<{ target: string; version?: string; force?: boolean; fetch?: boolean }>(
    "ship",
    "Prepare a manual target for a hand-made build of a released version, then stamp it.",
    (cmd) => {
      withGlobals(cmd, { json: true, ci: true });
      cmd.requiredOption("--target <name>", "a manual target from the config");
      cmd.option("--version <version>", "the released version (default: the latest release)");
      cmd.option("--force", "allow a version lower than the target's highest marker");
      cmd.option("--no-fetch", "don't fetch tags first");
      examples(cmd, "launchset ship --target ios --json");
      return ciHelp(
        cmd,
        "LAUNCHSET_VERSION, LAUNCHSET_BUILD_NUMBER, LAUNCHSET_CHANNEL, LAUNCHSET_MARKETING_VERSION, ...",
      );
    },
    async (opts) => {
      const context = await makeContext(io, opts);
      const result = await ship(context, {
        target: opts.target,
        fetch: opts.fetch !== false,
        ...(opts.version ? { version: opts.version } : {}),
        ...(opts.force ? { force: true } : {}),
      });
      return emitCi(io, cliLogger(io), "ship", result, context, opts);
    },
  );

  // finalize -----------------------------------------------------------------------------
  command<{ plan?: string; fetch?: boolean }>(
    "finalize",
    "Create the release tag and GitHub Release once every target is built.",
    (cmd) => {
      withGlobals(cmd, { json: true, ci: true });
      cmd.option("--plan <json|@file>", "the plan (default: $LAUNCHSET_PLAN)");
      cmd.option("--no-fetch", "don't fetch tags first");
      examples(cmd, "launchset finalize --plan @plan.json --token $GITHUB_TOKEN");
      return ciHelp(cmd, "LAUNCHSET_VERSION, LAUNCHSET_TAG, LAUNCHSET_PR_NUMBER, ...");
    },
    async (opts) => {
      const plan = await readPlanInput(io, opts.plan);
      if (plan === undefined) throw missingPlan("finalize");
      const context = await makeContext(io, opts);
      const result = await finalize(context, {
        plan,
        fetch: opts.fetch !== false,
      });
      return emitCi(io, cliLogger(io), "finalize", result, context, opts);
    },
  );

  // hotfix -------------------------------------------------------------------------------
  command<{ fetch?: boolean }>(
    "hotfix",
    "Create a maintenance branch for a released <major>.<minor> line.",
    (cmd) => {
      cmd.argument("<major.minor>", "the version line, e.g. 1.4");
      withGlobals(cmd, { json: true });
      cmd.option("--no-fetch", "don't fetch tags first");
      return examples(cmd, "launchset hotfix 1.4");
    },
    async (opts, args) => {
      const result = await hotfix(await makeContext(io, opts), {
        line: args[0] ?? "",
        fetch: opts.fetch !== false,
      });
      return emit(io, result, { json: opts.json });
    },
  );

  // check --------------------------------------------------------------------------------
  command<{ base?: string; push?: boolean; comment?: boolean; fetch?: boolean }>(
    "check",
    "Run the PR check: is there a valid changeset? (--push: the pre-push hook warning.)",
    (cmd) => {
      withGlobals(cmd, { json: true, ci: true });
      cmd.option("--base <ref>", "compare against this ref (default: the PR's base commit)");
      cmd.option("--push", "pre-push hook mode: warn when a changeset is missing, never fail");
      cmd.option("--no-comment", "don't post the sticky PR comment");
      cmd.option("--no-fetch", "don't fetch tags first (--push never fetches)");
      examples(cmd, "launchset check --base origin/main", "launchset check --push");
      return ciHelp(cmd, "LAUNCHSET_PR_NUMBER");
    },
    async (opts) => {
      const context = await makeContext(io, opts);
      const common = {
        // `--push` (a pre-push hook) stays offline unless asked; the PR check fetches.
        fetch: opts.push ? false : opts.fetch !== false,
        comment: opts.comment !== false,
        ...(opts.base ? { base: opts.base } : {}),
      };
      const result = opts.push
        ? await check(context, { ...common, push: true })
        : await check(context, common);
      return emitCi(io, cliLogger(io), "check", result, context, opts);
    },
  );

  return program;
}

/**
 * Run the CLI with `argv` (without `node` and the script) and return the exit code:
 * 0 ok, 1 failure, 2 wrong usage.
 */
export async function runCli(argv: readonly string[], io: CliIo = processIo()): Promise<number> {
  const state: RunState = { exitCode: 0 };
  const program = createProgram(io, state);
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      // Commander already printed its message (and help/version on stdout).
      return error.exitCode === 0 ? 0 : EXIT_USAGE;
    }
    reportError(io, error);
    return 1;
  }
  return state.exitCode;
}
