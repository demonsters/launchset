/**
 * Publishes the built action to demonsters/launchset-action (spec 10, 15): commit the publish
 * directory, tag `v{version}` and move the major tag (`v1`). Run by launchset's own release
 * workflow (the `action` target) after `node scripts/build-action.ts --out <checkout>` wrote
 * the files into a checkout of the action repo.
 *
 *   node scripts/publish-action.ts --repo-dir <checkout> --version 1.2.3
 *       [--branch main] [--remote origin] [--no-push]
 *
 * Idempotent, so a re-run of a failed release job is safe:
 *   - `v{version}` doesn't exist: commit (even when nothing changed, so every version has a
 *     commit), tag it, move the major tag, and push all of it in one atomic push.
 *   - `v{version}` exists and holds the same files: nothing is committed. The major tag is only
 *     (re)moved when it is missing or points at an older release.
 *   - `v{version}` exists with different files: an error. A published version is never
 *     rewritten; release a new version instead.
 *
 * The major tag only moves forward: a hotfix (1.4.1 after 1.5.0) and prereleases leave `v1`
 * alone. The workflow's checkout gives the script its credentials (the App token that
 * actions/checkout stores in the checkout's git config).
 */

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import semver from "semver";

const execFileAsync = promisify(execFile);

export interface PublishActionOptions {
  /** A checkout of the action repo that already holds the files to publish. */
  repoDir: string;
  /** The launchset version, without the `v`. */
  version: string;
  /** Branch to commit to. Default: the checked out branch. */
  branch?: string;
  /** Default `origin`. */
  remote?: string;
  /** Default true. `false` commits and tags locally only. */
  push?: boolean;
  /** Progress lines. Default: ignored. */
  log?: (line: string) => void;
}

export interface PublishActionResult {
  /** `published`: a new commit and tag. `unchanged`: the tag already held these files. */
  status: "published" | "unchanged";
  tag: string;
  commit: string;
  /** The moving major tag (`v1`), or null for prereleases. */
  majorTag: string | null;
  /** True when the major tag was created or moved by this run. */
  majorMoved: boolean;
}

export const COMMITTER_NAME = "launchset[bot]";
export const COMMITTER_EMAIL = "launchset[bot]@users.noreply.github.com";

class PublishActionError extends Error {}

async function git(
  repoDir: string,
  args: string[],
  options: { allowFailure?: boolean } = {},
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoDir, ...args], {
      // The identity goes through the environment: GIT_AUTHOR_* / GIT_COMMITTER_* set by a
      // workflow would otherwise win over `-c user.name`.
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: COMMITTER_NAME,
        GIT_AUTHOR_EMAIL: COMMITTER_EMAIL,
        GIT_COMMITTER_NAME: COMMITTER_NAME,
        GIT_COMMITTER_EMAIL: COMMITTER_EMAIL,
      },
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout.trim() };
  } catch (error) {
    if (options.allowFailure) return { ok: false, stdout: "" };
    const failure = error as { stderr?: string; message: string };
    throw new PublishActionError(
      `git ${args[0]} failed in ${repoDir}: ${(failure.stderr || failure.message).trim()}`,
    );
  }
}

/** The commit a ref points at, or undefined when it doesn't exist. */
async function resolveCommit(repoDir: string, ref: string): Promise<string | undefined> {
  const result = await git(repoDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    allowFailure: true,
  });
  return result.ok ? result.stdout : undefined;
}

/** The newest stable release in the major line (excluding `version`), as `v1.2.3`. */
async function newestInLine(repoDir: string, major: number, version: string) {
  const { stdout } = await git(repoDir, ["tag", "--list", `v${major}.*`]);
  const newer = stdout
    .split("\n")
    .map((tag) => tag.trim())
    .filter((tag) => {
      const parsed = semver.valid(tag.slice(1));
      return (
        tag.startsWith("v") &&
        parsed !== null &&
        semver.prerelease(parsed) === null &&
        semver.major(parsed) === major &&
        semver.gt(parsed, version)
      );
    })
    .sort((a, b) => semver.rcompare(a.slice(1), b.slice(1)));
  return newer[0];
}

export async function publishAction(options: PublishActionOptions): Promise<PublishActionResult> {
  const log = options.log ?? (() => {});
  const repoDir = resolve(options.repoDir);
  const remote = options.remote ?? "origin";
  const push = options.push ?? true;

  const version = semver.valid(options.version);
  if (version === null || version !== options.version) {
    throw new PublishActionError(
      `"${options.version}" is not a plain version like 1.2.3 (no leading "v").`,
    );
  }
  const tag = `v${version}`;
  const major = semver.major(version);
  const stable = semver.prerelease(version) === null;

  const inside = await git(repoDir, ["rev-parse", "--is-inside-work-tree"], {
    allowFailure: true,
  });
  if (!inside.ok || inside.stdout !== "true") {
    throw new PublishActionError(`${repoDir} is not a git checkout. Check out the action repo.`);
  }

  // Tags of the remote, so a re-run in a shallow or tagless checkout still sees `v{version}`.
  const hasRemote = (await git(repoDir, ["remote"])).stdout.split("\n").includes(remote);
  if (push && !hasRemote) {
    throw new PublishActionError(`The checkout has no remote called "${remote}" to push to.`);
  }
  if (hasRemote) {
    await git(repoDir, ["fetch", "--quiet", "--force", "--tags", remote]);
  }

  const branch =
    options.branch ??
    (await git(repoDir, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true }))
      .stdout;
  if (!branch) {
    throw new PublishActionError("The checkout is on a detached HEAD: pass --branch.");
  }

  await git(repoDir, ["add", "--all"]);
  const tree = (await git(repoDir, ["write-tree"])).stdout;

  const existing = await resolveCommit(repoDir, `refs/tags/${tag}`);
  let commit: string;
  let status: PublishActionResult["status"];
  if (existing !== undefined) {
    const existingTree = (await git(repoDir, ["rev-parse", `${existing}^{tree}`])).stdout;
    if (existingTree !== tree) {
      const changed = (
        await git(repoDir, ["diff-tree", "-r", "--name-only", existingTree, tree])
      ).stdout
        .split("\n")
        .filter(Boolean);
      throw new PublishActionError(
        `${tag} already exists in the action repo with different files (${changed.slice(0, 5).join(", ")}${changed.length > 5 ? ", ..." : ""}). A published version is never rewritten: release a new version instead.`,
      );
    }
    commit = existing;
    status = "unchanged";
    log(`${tag} already exists with the same files (${commit.slice(0, 7)}): nothing to commit.`);
  } else {
    await git(repoDir, [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgsign=false",
      "commit",
      "--allow-empty",
      "--no-verify",
      "--quiet",
      "-m",
      `Release ${tag}`,
    ]);
    commit = (await git(repoDir, ["rev-parse", "HEAD"])).stdout;
    await git(repoDir, ["tag", tag, commit]);
    status = "published";
    log(`Committed ${commit.slice(0, 7)} and tagged ${tag}.`);
  }

  // The major tag moves forward only: not for prereleases, not for a hotfix of an older release.
  let majorTag: string | null = null;
  let majorMoved = false;
  if (stable) {
    const newer = await newestInLine(repoDir, major, version);
    majorTag = `v${major}`;
    if (newer) {
      log(`${majorTag} stays where it is: ${newer} is newer than ${tag}.`);
    } else if ((await resolveCommit(repoDir, `refs/tags/${majorTag}`)) === commit) {
      log(`${majorTag} already points at ${tag}.`);
    } else {
      await git(repoDir, ["tag", "--force", majorTag, commit]);
      majorMoved = true;
      log(`Moved ${majorTag} to ${tag}.`);
    }
  } else {
    log(`${tag} is a prerelease: no major tag.`);
  }

  if (push) {
    const refspecs: string[] = [];
    if (status === "published") refspecs.push(`HEAD:refs/heads/${branch}`, `refs/tags/${tag}`);
    if (majorMoved && majorTag) refspecs.push(`+refs/tags/${majorTag}:refs/tags/${majorTag}`);
    if (refspecs.length > 0) {
      // One atomic push: either the commit, its tag and the major tag all arrive, or none do.
      await git(repoDir, ["push", "--atomic", "--quiet", remote, ...refspecs]);
      log(`Pushed ${refspecs.join(" ")} to ${remote}.`);
    }
  }

  return { status, tag, commit, majorTag, majorMoved };
}

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "repo-dir": { type: "string" },
      version: { type: "string" },
      branch: { type: "string" },
      remote: { type: "string" },
      "no-push": { type: "boolean", default: false },
    },
    strict: true,
  });
  if (!values["repo-dir"] || !values.version) {
    throw new PublishActionError(
      "Usage: node scripts/publish-action.ts --repo-dir <checkout> --version <x.y.z> [--branch main] [--remote origin] [--no-push]",
    );
  }
  const result = await publishAction({
    repoDir: values["repo-dir"],
    version: values.version,
    push: !values["no-push"],
    log: (line) => console.log(line),
    ...(values.branch ? { branch: values.branch } : {}),
    ...(values.remote ? { remote: values.remote } : {}),
  });
  console.log(
    `${result.status === "published" ? "Published" : "Already published"} ${result.tag}${result.majorTag ? ` (${result.majorTag}${result.majorMoved ? " moved" : ""})` : ""}.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
