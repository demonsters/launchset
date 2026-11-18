/**
 * Changeset files (spec 4): parse, serialize, name, and convert from Changesets. Pure.
 */

import { isMap, isScalar, LineCounter, type Node, parseDocument, stringify } from "yaml";
import { LaunchsetError } from "./errors.ts";
import { BUMPS, type Bump, type Changeset } from "./types.ts";

/** Folder that holds changesets, relative to the launchset root. */
export const CHANGESET_DIR = ".launchset";

const KNOWN_KEYS = new Set(["bump", "source", "pr"]);

const FORMAT_HINT = [
  "A changeset looks like this:",
  "",
  "---",
  "bump: minor",
  "---",
  "",
  "Add offline mode to the mobile app.",
].join("\n");

/** A changeset file that can't be read. `line` is 1-based. */
export class ChangesetError extends LaunchsetError {
  readonly file: string;
  readonly line: number;
  readonly reason: string;

  constructor(file: string, line: number, reason: string, hint: string = FORMAT_HINT) {
    super("invalid-changeset", `${file}:${line}: ${reason}`, { hint });
    this.name = "ChangesetError";
    this.file = file;
    this.line = line;
    this.reason = reason;
  }
}

export interface ParsedChangeset {
  changeset: Changeset;
  /** Non-fatal problems, e.g. unknown frontmatter keys (`file:line: ...`). */
  warnings: string[];
}

interface Frontmatter {
  /** Frontmatter text between the `---` lines, LF line endings. */
  yaml: string;
  /** 1-based file line of the first frontmatter line. */
  firstLine: number;
  /** Body after the closing `---`, LF line endings. */
  body: string;
  /** 1-based file line where the body starts. */
  bodyLine: number;
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function splitFrontmatter(text: string, file: string): Frontmatter {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") {
    throw new ChangesetError(
      file,
      1,
      'missing frontmatter: a changeset must start with a "---" line, then "bump: <major|minor|patch|none>", then "---"',
    );
  }
  const close = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (close === -1) {
    throw new ChangesetError(
      file,
      1,
      'frontmatter is not closed: expected a "---" line after the frontmatter',
    );
  }
  return {
    yaml: lines.slice(1, close).join("\n"),
    firstLine: 2,
    body: lines.slice(close + 1).join("\n"),
    bodyLine: close + 2,
  };
}

/** Body with surrounding blank lines removed. */
function trimBody(body: string): string {
  return body.replace(/^(?:[ \t]*\n)+/, "").trimEnd();
}

interface FrontmatterEntry {
  key: string;
  value: unknown;
  /** 1-based file line of the key. */
  line: number;
  /** 1-based file line of the value. */
  valueLine: number;
}

/** Parse frontmatter YAML into entries with file line numbers. */
function readFrontmatter(fm: Frontmatter, file: string): FrontmatterEntry[] {
  const lineCounter = new LineCounter();
  const doc = parseDocument(fm.yaml, { lineCounter, prettyErrors: false, uniqueKeys: true });
  const lineAt = (offset: number) => lineCounter.linePos(offset).line + fm.firstLine - 1;
  const firstError = doc.errors[0];
  if (firstError) {
    throw new ChangesetError(
      file,
      lineAt(firstError.pos[0]),
      `invalid frontmatter: ${firstError.message.split("\n")[0]}`,
    );
  }
  if (doc.contents === null) return [];
  if (!isMap(doc.contents)) {
    const range = (doc.contents as Node).range;
    throw new ChangesetError(
      file,
      range ? lineAt(range[0]) : fm.firstLine,
      'invalid frontmatter: expected "key: value" lines, like "bump: minor"',
    );
  }
  let values: Record<string, unknown>;
  try {
    values = doc.toJS({ maxAliasCount: 100 }) as Record<string, unknown>;
  } catch (error) {
    throw new ChangesetError(
      file,
      fm.firstLine,
      `invalid frontmatter: ${(error as Error).message}`,
    );
  }
  return doc.contents.items.map((pair) => {
    const keyNode = pair.key as Node | null;
    const valueNode = pair.value as Node | null;
    const key = isScalar(keyNode) ? String(keyNode.value) : String(keyNode);
    const line = keyNode?.range ? lineAt(keyNode.range[0]) : fm.firstLine;
    const valueLine = valueNode?.range ? lineAt(valueNode.range[0]) : line;
    return { key, value: values[key] ?? null, line, valueLine };
  });
}

function isBump(value: unknown): value is Bump {
  return typeof value === "string" && (BUMPS as readonly string[]).includes(value);
}

function describe(value: unknown): string {
  return value === null || value === undefined ? "nothing" : JSON.stringify(value);
}

/**
 * Parse a changeset file (spec 4.1). `path` is the repo-relative POSIX path; it is used
 * in error messages and stored on the changeset. Throws `ChangesetError` (file + line) for
 * missing or invalid frontmatter, an invalid `bump`, `source` or `pr`, or an empty summary.
 */
export function parseChangeset(text: string, path: string): ParsedChangeset {
  const fm = splitFrontmatter(text, path);
  const entries = readFrontmatter(fm, path);
  const warnings: string[] = [];
  const extra: Record<string, unknown> = {};
  let bump: Bump | undefined;
  let source: "bot" | undefined;
  let pr: number | undefined;

  for (const entry of entries) {
    switch (entry.key) {
      case "bump":
        if (!isBump(entry.value)) {
          throw new ChangesetError(
            path,
            entry.valueLine,
            `invalid bump ${describe(entry.value)}: expected major, minor, patch or none`,
          );
        }
        bump = entry.value;
        break;
      case "source":
        if (entry.value !== "bot") {
          throw new ChangesetError(
            path,
            entry.valueLine,
            `invalid source ${describe(entry.value)}: the only allowed value is "bot" (set on generated bot changesets); remove the line otherwise`,
          );
        }
        source = "bot";
        break;
      case "pr":
        if (
          typeof entry.value !== "number" ||
          !Number.isSafeInteger(entry.value) ||
          entry.value < 1
        ) {
          throw new ChangesetError(
            path,
            entry.valueLine,
            `invalid pr ${describe(entry.value)}: expected a pull request number like 123`,
          );
        }
        pr = entry.value;
        break;
      default:
        warnings.push(
          `${path}:${entry.line}: unknown frontmatter key "${entry.key}" (kept, but launchset ignores it)`,
        );
        extra[entry.key] = entry.value;
    }
  }

  if (bump === undefined) {
    throw new ChangesetError(
      path,
      1,
      'missing "bump" in the frontmatter: add a line "bump: <major|minor|patch|none>"',
    );
  }
  const summary = trimBody(fm.body);
  if (summary === "" && bump !== "none") {
    throw new ChangesetError(
      path,
      fm.bodyLine,
      "the summary is empty: write the changelog entry below the frontmatter (or use bump: none for a change that needs no release)",
    );
  }

  const changeset: Changeset = { name: basename(path), path, bump, summary, extra };
  if (source) changeset.source = source;
  if (pr !== undefined) changeset.pr = pr;
  return { changeset, warnings };
}

/**
 * Write a changeset file. `parseChangeset(serializeChangeset(c), c.path)` gives back `c`;
 * unknown keys from `extra` are kept after the known ones.
 */
export function serializeChangeset(
  changeset: Pick<Changeset, "bump" | "summary" | "source" | "pr" | "extra">,
): string {
  const data: Record<string, unknown> = { bump: changeset.bump };
  if (changeset.source) data.source = changeset.source;
  if (changeset.pr !== undefined) data.pr = changeset.pr;
  for (const [key, value] of Object.entries(changeset.extra ?? {})) {
    if (!KNOWN_KEYS.has(key)) data[key] = value;
  }
  const frontmatter = `---\n${stringify(data, { lineWidth: 0 })}---\n`;
  const summary = trimBody(changeset.summary.replace(/\r\n/g, "\n"));
  return summary === "" ? frontmatter : `${frontmatter}\n${summary}\n`;
}

/**
 * True for a changeset path: a `.md` file directly in `.launchset/` (relative to `dir`'s
 * parent, i.e. the launchset root), other than `README.md`.
 */
export function isChangesetPath(path: string, dir: string = CHANGESET_DIR): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  const prefix = `${dir.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")}/`;
  if (!normalized.startsWith(prefix)) return false;
  const name = normalized.slice(prefix.length);
  return (
    name.length > ".md".length &&
    name.endsWith(".md") &&
    !name.includes("/") &&
    name.toLowerCase() !== "readme.md"
  );
}

// ---------------------------------------------------------------------------
// Names

const ADJECTIVES = (
  "brave calm clever cool cozy curly dull eager early empty fair fancy fast fluffy fresh " +
  "friendly funny gentle giant good grumpy happy heavy honest hot huge kind late lazy " +
  "light little long loud lucky mighty modern neat new nice odd old orange polite proud " +
  "purple quick quiet rare red rich rotten rude shaggy shiny short shy silent silly slimy " +
  "slow small smart smooth soft spicy strong sweet tall tame thick tidy tiny tough wet " +
  "wicked wild wise witty young yellow"
).split(" ");

const NOUNS = (
  "apples ants bags bananas bats beans bears beds bees birds boats books boxes bugs buses " +
  "camels cars cats chairs cobras cows crabs cups deer dodos dogs donkeys doors dots " +
  "ducks eagles eels eggs elephants falcons files fish flies foxes frogs geckos geese " +
  "ghosts goats grapes hats hornets horses items jars jokes keys kids kings kiwis lamps " +
  "lemons lions lizards llamas maps mice moles monkeys moons moose news olives otters " +
  "owls pandas parrots pens pigs planes plants poets ravens rings rivers rockets seals " +
  "sheep ships shoes snails socks spiders squids stars swans tables teams tigers toes " +
  "toys trains trees turtles walls waves wolves worms yaks zebras"
).split(" ");

const VERBS = (
  "act add agree allow appear arrive ask bake beam beg behave bow breathe build burn buy " +
  "call camp care carry change cheat check cheer chew clap clean compare complain cough " +
  "count cover crash cross cry dance decide deliver destroy divide double draw dream " +
  "dress drive drop eat enjoy exist explain fail fetch fix float fly fold follow glow " +
  "grin grow guess hammer hang happen heal help hide hope hug hunt invent itch jam joke " +
  "judge juggle jump kick kiss kneel knock know laugh lay learn lick lie listen live love " +
  "march marry matter melt mix move nail nod notice obey occur own pay peel perform play " +
  "poke pretend promise pull punch push raise relate relax remain repeat reply rest " +
  "return rhyme roll run rush sail say scream search see sell serve shake share shave " +
  "shine shop shout sing sink sit sleep slide smash smell smile sneeze sniff sparkle " +
  "speak stare study swim talk taste teach tease tell thank think tickle travel try turn " +
  "type unite visit wait walk wander warn wash watch wave whisper win wink wonder work " +
  "worry yell"
).split(" ");

/** Random number generator returning a float in [0, 1), like `Math.random`. */
export type Rng = () => number;

function pick<T>(list: readonly T[], rng: Rng): T {
  const index = Math.min(list.length - 1, Math.floor(rng() * list.length));
  return list[index] as T;
}

/**
 * A new changeset file name like `brave-lions-sing.md` (spec 4.1) that isn't in
 * `existing` (file names, with `.md`). `rng` is required to keep the core free of hidden
 * randomness: callers pass `Math.random`, tests a deterministic function.
 */
export function generateChangesetName(existing: ReadonlySet<string>, rng: Rng): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const name = `${pick(ADJECTIVES, rng)}-${pick(NOUNS, rng)}-${pick(VERBS, rng)}.md`;
    if (!existing.has(name)) return name;
  }
  // Practically unreachable (over two million combinations), but never loop forever.
  const base = `${pick(ADJECTIVES, rng)}-${pick(NOUNS, rng)}-${pick(VERBS, rng)}`;
  for (let n = 2; ; n++) {
    const name = `${base}-${n}.md`;
    if (!existing.has(name)) return name;
  }
}

// ---------------------------------------------------------------------------
// Migration from Changesets (spec 4.2)

export interface ConvertedChangeset {
  /** The launchset changeset; `path` is `.launchset/<same file name>`. */
  changeset: Changeset;
  /** The package bumps found in the Changesets frontmatter (`none` included). */
  packages: Record<string, Bump>;
  /**
   * True when the bump releases something but the Changesets file has no summary
   * (Changesets allows that, launchset doesn't). The changeset keeps its bump and an empty
   * summary; `init` must tell the user to write one, because `parseChangeset` rejects the
   * converted file until then.
   */
  needsSummary: boolean;
  /** Non-fatal problems (`file:line: ...`), e.g. the missing summary. */
  warnings: string[];
}

/**
 * Convert a Changesets file (`.changeset/*.md`, spec 4.2): every `"pkg": minor` line
 * (`major`, `minor`, `patch` or `none`) becomes one `bump`, the highest found; empty
 * frontmatter becomes `none`. The summary is kept. An empty summary with a releasing bump
 * is a warning and sets `needsSummary` (see there). Throws `ChangesetError` (file + line)
 * on anything that isn't a Changesets file.
 */
export function convertChangesetsFile(text: string, path: string): ConvertedChangeset {
  const fm = splitFrontmatter(text, path);
  const entries = readFrontmatter(fm, path);
  const packages: Record<string, Bump> = {};
  let bump: Bump = "none";
  for (const entry of entries) {
    const value = entry.value;
    if (!isBump(value)) {
      throw new ChangesetError(
        path,
        entry.valueLine,
        `invalid Changesets bump ${describe(value)} for "${entry.key}": expected major, minor, patch or none`,
        'A Changesets file has lines like "my-package": minor in its frontmatter.',
      );
    }
    packages[entry.key] = value;
    if (BUMPS.indexOf(value) > BUMPS.indexOf(bump)) bump = value;
  }
  const summary = trimBody(fm.body);
  const needsSummary = summary === "" && bump !== "none";
  const warnings = needsSummary
    ? [
        `${path}:${fm.bodyLine}: the summary is empty; launchset needs one for a ${bump} changeset, so write it in the converted file`,
      ]
    : [];
  const name = basename(path);
  return {
    changeset: { name, path: `${CHANGESET_DIR}/${name}`, bump, summary, extra: {} },
    packages,
    needsSummary,
    warnings,
  };
}
