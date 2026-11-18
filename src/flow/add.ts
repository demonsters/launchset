/**
 * `launchset add` / `command: add` (spec 11, 10): write a changeset file. Interactive
 * prompting is the CLI's job; this takes the values.
 */

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CHANGESET_DIR,
  generateChangesetName,
  parseChangeset,
  type Rng,
  serializeChangeset,
} from "../core/changesets.ts";
import { LaunchsetError } from "../core/errors.ts";
import { BUMPS, type Bump } from "../core/types.ts";
import type { FlowContext, FlowResult } from "./context.ts";

export interface AddOptions {
  /** Required unless `empty`. */
  bump?: Bump | string;
  /** The changelog entry; required unless the bump is `none`. */
  message?: string;
  /** `--empty`: `bump: none` (a change that needs no release). */
  empty?: boolean;
  /** Random source for the file name; default `Math.random`. */
  rng?: Rng;
}

export interface AddData {
  /** Path relative to the config root, e.g. `.launchset/brave-lions-sing.md`. */
  path: string;
  absolute: string;
  bump: Bump;
  summary: string;
}

function isBump(value: string): value is Bump {
  return (BUMPS as readonly string[]).includes(value);
}

/** `launchset add` (spec 11). */
export async function add(context: FlowContext, options: AddOptions): Promise<FlowResult<AddData>> {
  const raw = options.empty ? "none" : options.bump?.trim().toLowerCase();
  if (!raw || !isBump(raw)) {
    throw new LaunchsetError(
      "invalid-bump",
      raw ? `"${options.bump}" is not a bump type` : "add needs a bump type",
      {
        hint: "Give the bump: major, minor, patch or none, or empty for none (CLI: --bump / --empty; action: bump input).",
      },
    );
  }
  const bump: Bump = raw;
  const summary = (options.message ?? "").replace(/\r\n/g, "\n").trim();
  if (summary === "" && bump !== "none") {
    throw new LaunchsetError("empty-summary", `a ${bump} changeset needs a summary`, {
      hint: "Give a message with what changed, for the changelog (CLI: --message; action: message input), or use an empty changeset for a change that needs no release (CLI: --empty).",
    });
  }
  const dir = join(context.cwd, CHANGESET_DIR);
  await mkdir(dir, { recursive: true });
  const existing = new Set(await readdir(dir));
  const name = generateChangesetName(existing, options.rng ?? Math.random);
  const text = serializeChangeset({ bump, summary, extra: {} });
  const path = `${CHANGESET_DIR}/${name}`;
  // Round-trip check: never write a file launchset itself can't read.
  parseChangeset(text, path);
  const absolute = join(dir, name);
  await writeFile(absolute, text, { flag: "wx" });
  return {
    ok: true,
    outputs: {},
    summary: `## launchset: add\n\nCreated \`${path}\` (${bump}).\n`,
    lines: [path],
    data: { path, absolute, bump, summary },
  };
}
