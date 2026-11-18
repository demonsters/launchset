/**
 * The `launchset init` flags and `--decide` parsing: kept apart from the init machinery so the
 * CLI can define the command without loading it.
 */

import { LaunchsetError } from "../core/errors.ts";
import type { InitOptions } from "./types.ts";

/** A named `launchset init` flag and what it maps to (for mechanical CLI wiring). */
export interface InitFlag {
  /** The flag, e.g. `--baseline`. */
  flag: string;
  /** The {@link InitOptions} field it sets. */
  option: keyof InitOptions;
  type: "boolean" | "string[]";
  /** Boolean flags with a `--no-…` form. */
  negatable?: boolean;
  /** Decision the flag answers (`true` → `yes`, `false` → `no`). */
  decision?: string;
  description: string;
}

export const INIT_FLAGS: readonly InitFlag[] = [
  {
    flag: "--yes",
    option: "yes",
    type: "boolean",
    description: "Accept the default for every decision that isn't given; never prompt.",
  },
  {
    flag: "--decide",
    option: "decide",
    type: "string[]",
    description:
      "Answer a decision: --decide <id>=<value> (repeatable). See --detect --json for the ids.",
  },
  {
    flag: "--detect",
    option: "detect",
    type: "boolean",
    description: "Only detect: print what was found and the decisions, write nothing.",
  },
  { flag: "--json", option: "json", type: "boolean", description: "Print JSON." },
  {
    flag: "--convert-only",
    option: "convertOnly",
    type: "boolean",
    description:
      "Only convert .changeset/*.md files into .launchset/ (e.g. on a Changesets pre-mode branch).",
  },
  {
    flag: "--baseline",
    option: "baseline",
    type: "boolean",
    negatable: true,
    decision: "baseline",
    description:
      "Create the release tag for the canonical version at HEAD, so it counts as released.",
  },
  {
    flag: "--skill",
    option: "skill",
    type: "boolean",
    negatable: true,
    decision: "skill",
    description: "Install the launchset agent skill and the AGENTS.md section.",
  },
  {
    flag: "--hook",
    option: "hook",
    type: "boolean",
    negatable: true,
    decision: "hook",
    description:
      "Add `launchset check --push` to the existing pre-push hook (simple-git-hooks, husky, lefthook).",
  },
];

/** Parse repeated `--decide id=value` values. */
export function parseDecide(values: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of values) {
    const eq = raw.indexOf("=");
    if (eq <= 0) {
      throw new LaunchsetError("invalid-decision", `--decide ${raw}: expected <id>=<value>.`, {
        hint: "For example --decide version=1.4.0 or --decide target.ios=manual.",
      });
    }
    const id = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1).trim();
    if (out[id] !== undefined && out[id] !== value) {
      throw new LaunchsetError(
        "invalid-decision",
        `--decide ${id} is given twice with different values (${out[id]}, ${value}).`,
      );
    }
    out[id] = value;
  }
  return out;
}
