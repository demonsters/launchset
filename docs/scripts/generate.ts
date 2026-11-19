/**
 * Fills the generated blocks in the docs pages from the code, so the docs can't drift:
 *
 *   config-options    the configuration reference (JSON Schema of the zod config schema)
 *   cli-commands      the CLI reference (the real `--help` output of every command)
 *   action-inputs     the action's inputs   (action/action.yml)
 *   action-outputs    the action's outputs  (action/action.yml)
 *   app-permissions   the GitHub App permissions (src/forge/github/permissions.ts)
 *
 * A page marks a block like this and the script rewrites what is between the markers:
 *
 *   <!-- generated:config-options:start -->
 *   <!-- generated:config-options:end -->
 *
 * Run with Node 26 (it runs TypeScript directly): `node scripts/generate.ts` writes, and
 * `node scripts/generate.ts --check` fails when a page is out of date (the docs build runs the
 * writing form first). Options without a hand-written description (scripts/descriptions.ts), and
 * descriptions of options that no longer exist, fail the run: that is how a config change shows
 * up here.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { runCli } from "../../src/cli/program.ts";
import { configJsonSchema } from "../../src/core/config/json-schema.ts";
import { REQUIRED_APP_PERMISSIONS } from "../../src/forge/github/permissions.ts";
import { CLI_INTROS, COMMON_FLAGS_NOTE } from "./cli-intros.ts";
import { CONFIG_DESCRIPTIONS } from "./descriptions.ts";

const docsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(docsRoot, "..");
const pagesDir = join(docsRoot, "src/content/docs");

// JSON Schema fragments are walked loosely.
// biome-ignore lint/suspicious/noExplicitAny: a JSON Schema has no fixed shape
type Json = Record<string, any>;

// ---------------------------------------------------------------------------
// Markdown helpers

/** A table cell: no pipes or newlines. */
function cell(text: string): string {
  return text
    .replace(/\|/g, "\\|")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

function table(head: string[], rows: string[][]): string {
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}

function code(text: string): string {
  return `\`${text.replace(/`/g, "\\`")}\``;
}

// ---------------------------------------------------------------------------
// Configuration reference

interface Row {
  /** Description key, e.g. `targets[docker].image`. */
  key: string;
  /** The `kind` of the union variant the option belongs to, e.g. `gradle`. */
  when?: string;
  /** Path as the user writes it, e.g. `targets.<name>.image`. */
  display: string;
  type: string;
  required: boolean;
  default: string;
}

/** A readable type for a (sub)schema, e.g. `"a" | "b"` or `(string | object)[]`. */
function typeOf(schema: Json): string {
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.not !== undefined) return "never";
  if (schema.enum) return schema.enum.map((v: unknown) => JSON.stringify(v)).join(" | ");
  const variants: Json[] | undefined = schema.anyOf ?? schema.oneOf;
  if (variants) return [...new Set(variants.map(typeOf))].join(" | ");
  switch (schema.type) {
    case "array": {
      const item = typeOf(schema.items ?? {});
      return item.includes(" | ") ? `(${item})[]` : `${item}[]`;
    }
    case undefined:
      return "any";
    default:
      return String(schema.type);
  }
}

function defaultOf(schema: Json): string {
  if (!("default" in schema)) return "";
  const value = schema.default;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return Object.keys(value).length === 0 ? "" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
  return JSON.stringify(value);
}

interface Section {
  title: string;
  /** Hand-written intro key into CONFIG_DESCRIPTIONS (`#title`). */
  intro?: string;
  rows: Row[];
}

const TARGET_COMMON = ["release", "buildNumber", "files"];

/** The `kind` constant of a union variant (`source.kind`, `files[].kind`), if it has one. */
function kindOf(variant: Json): string | undefined {
  const kind = variant.properties?.kind?.const;
  return typeof kind === "string" ? kind : undefined;
}

function flattenObject(
  schema: Json,
  keyBase: string,
  displayBase: string,
  out: Row[],
  skip: (name: string) => boolean = () => false,
  when?: string,
): void {
  const required = new Set<string>(schema.required ?? []);
  for (const [name, prop] of Object.entries<Json>(schema.properties ?? {})) {
    if (skip(name)) continue;
    const key = keyBase ? `${keyBase}.${name}` : name;
    const display = displayBase ? `${displayBase}.${name}` : name;
    out.push({
      key,
      display,
      type: typeOf(prop),
      required: required.has(name),
      default: defaultOf(prop),
      ...(when !== undefined ? { when } : {}),
    });
    descend(prop, key, display, out, when);
  }
}

/** Rows for what lies below a property: objects, arrays of objects and object unions. */
function descend(prop: Json, key: string, display: string, out: Row[], when?: string): void {
  if (prop.type === "object" && prop.properties) {
    flattenObject(prop, key, display, out, undefined, when);
    return;
  }
  const variantsOf = (schema: Json): Json[] => schema.anyOf ?? schema.oneOf ?? [schema];
  const below = (schema: Json, keyBase: string, displayBase: string) => {
    for (const variant of variantsOf(schema)) {
      if (variant.type !== "object" || !variant.properties) continue;
      const kind = kindOf(variant);
      flattenObject(
        variant,
        kind ? `${keyBase}[${kind}]` : keyBase,
        displayBase,
        out,
        // The discriminator is shown as "kind ..." next to the option, not as a row of its own.
        (name) => kind !== undefined && name === "kind",
        kind ?? when,
      );
    }
  };
  if (prop.type === "array" && prop.items) {
    below(prop.items, `${key}[]`, `${display}[]`);
    return;
  }
  if (prop.anyOf ?? prop.oneOf) below(prop, key, display);
}

function configSections(schema: Json): Section[] {
  const props = schema.properties as Record<string, Json> & { preview: Json; targets: Json };
  const sections: Section[] = [];

  const topLevel: Row[] = [];
  for (const [name, prop] of Object.entries(props)) {
    if (name === "targets" || name === "preview") continue;
    topLevel.push({
      key: name,
      display: name,
      type: typeOf(prop),
      required: false,
      default: defaultOf(prop),
    });
    descend(prop, name, name, topLevel);
  }
  sections.push({ title: "Top-level options", rows: topLevel });

  // preview: `false | object`
  const preview: Row[] = [
    {
      key: "preview",
      display: "preview",
      type: typeOf(props.preview),
      required: false,
      default: "{}",
    },
  ];
  descend(props.preview, "preview", "preview", preview);
  sections.push({ title: "Previews", rows: preview });

  // targets: a record of oneOf(type)
  const variants: Json[] = props.targets.additionalProperties.oneOf;
  const targetsRow: Row = {
    key: "targets",
    display: "targets",
    type: "object",
    required: true,
    default: "",
  };
  sections.push({ title: "Targets", rows: [targetsRow] });
  const common: Row[] = [];
  const first = variants[0] as Json;
  for (const name of TARGET_COMMON) {
    const prop = first.properties[name];
    common.push({
      key: `targets[*].${name}`,
      display: `targets.<name>.${name}`,
      type: typeOf(prop),
      required: false,
      default: defaultOf(prop),
    });
    if (name === "buildNumber") {
      flattenObject(prop, "targets[*].buildNumber", "targets.<name>.buildNumber", common);
    }
    if (name === "files") {
      descend(prop, "targets[*].files", "targets.<name>.files", common);
    }
  }
  sections.push({ title: "Options of every target", rows: common });
  for (const variant of variants) {
    const type = variant.properties.type.const as string;
    const rows: Row[] = [
      {
        key: `targets[${type}].type`,
        display: "targets.<name>.type",
        type: JSON.stringify(type),
        required: true,
        default: "",
      },
    ];
    flattenObject(
      variant,
      `targets[${type}]`,
      "targets.<name>",
      rows,
      (name) => name === "type" || TARGET_COMMON.includes(name),
    );
    sections.push({ title: `Targets of type "${type}"`, rows });
  }
  return sections;
}

function renderConfigOptions(): { markdown: string; usedKeys: Set<string> } {
  const schema = configJsonSchema() as Json;
  const sections = configSections(schema);
  const used = new Set<string>();
  const missing: string[] = [];
  const blocks: string[] = [];
  for (const section of sections) {
    const rows = section.rows.map((row) => {
      used.add(row.key);
      const description = CONFIG_DESCRIPTIONS[row.key];
      if (description === undefined) missing.push(row.key);
      const required = row.required ? "required" : "";
      return [
        code(row.display) + (row.when ? ` <br>*kind ${row.when}*` : ""),
        code(row.type),
        row.default === "" ? (required ? "required" : "") : code(row.default),
        description ?? "",
      ];
    });
    const intro = CONFIG_DESCRIPTIONS[`#${section.title}`];
    if (intro) used.add(`#${section.title}`);
    blocks.push(
      `### ${section.title}`,
      ...(intro ? [intro] : []),
      table(["Option", "Type", "Default", "What it does"], rows),
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `docs/scripts/descriptions.ts has no description for these config options:\n  ${missing.join("\n  ")}\nAdd them, so the configuration reference stays complete.`,
    );
  }
  return { markdown: blocks.join("\n\n"), usedKeys: used };
}

// ---------------------------------------------------------------------------
// CLI reference

async function helpText(args: string[]): Promise<string> {
  let out = "";
  let err = "";
  const code = await runCli([...args, "--help"], {
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      err += t;
    },
    env: {},
    isTTY: false,
    cwd: repoRoot,
  });
  if (code !== 0 || out.trim() === "") {
    throw new Error(`launchset ${args.join(" ")} --help failed (exit ${code}): ${err}`);
  }
  return out.trimEnd();
}

async function renderCliCommands(): Promise<string> {
  const top = await helpText([]);
  // Command names from the top-level help ("Commands:" section).
  const names = [...top.matchAll(/^ {2}([a-z]+)(?: \[options\])?(?: <[^>]+>)?\s{2,}\S/gm)]
    .map((m) => m[1] as string)
    .filter((n) => n !== "help");
  const missing = names.filter((n) => CLI_INTROS[n] === undefined);
  const stale = Object.keys(CLI_INTROS).filter((n) => !names.includes(n));
  if (missing.length > 0 || stale.length > 0) {
    throw new Error(
      `docs/scripts/cli-intros.ts is out of step with the CLI. Missing: ${missing.join(", ") || "none"}. No longer a command: ${stale.join(", ") || "none"}.`,
    );
  }
  const blocks: string[] = [
    "### Help of the main command",
    ["```text", top, "```"].join("\n"),
    COMMON_FLAGS_NOTE,
  ];
  for (const name of names) {
    blocks.push(
      `### launchset ${name}`,
      CLI_INTROS[name] as string,
      ["```text", await helpText([name]), "```"].join("\n"),
    );
  }
  return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// Action inputs and outputs

async function actionYml(): Promise<Json> {
  return parseYaml(await readFile(join(repoRoot, "action/action.yml"), "utf8")) as Json;
}

function renderActionInputs(action: Json): string {
  const rows = Object.entries<Json>(action.inputs).map(([name, input]) => [
    code(name),
    String(input.description).replace(/\s+/g, " ").trim(),
    input.required ? "required" : input.default === "" ? "" : code(String(input.default)),
  ]);
  return table(["Input", "What it does", "Default"], rows);
}

function renderActionOutputs(action: Json): string {
  const rows = Object.entries<Json>(action.outputs).map(([name, output]) => [
    code(name),
    String(output.description).replace(/\s+/g, " ").trim(),
  ]);
  return table(["Output", "What it does"], rows);
}

// ---------------------------------------------------------------------------
// GitHub App permissions

function renderPermissions(): string {
  return table(
    ["Repository permission", "Access", "Why launchset needs it"],
    REQUIRED_APP_PERMISSIONS.map((p) => [p.name, p.access, p.why]),
  );
}

// ---------------------------------------------------------------------------
// Rewriting the pages

const MARKER = /<!-- generated:([a-z-]+):start -->\n[\s\S]*?<!-- generated:\1:end -->/g;

async function walk(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else if (/\.mdx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const action = await actionYml();
  const config = renderConfigOptions();
  const blocks: Record<string, string> = {
    "config-options": config.markdown,
    "cli-commands": await renderCliCommands(),
    "action-inputs": renderActionInputs(action),
    "action-outputs": renderActionOutputs(action),
    "app-permissions": renderPermissions(),
  };

  const stale = Object.keys(CONFIG_DESCRIPTIONS).filter((k) => !config.usedKeys.has(k));
  if (stale.length > 0) {
    throw new Error(
      `docs/scripts/descriptions.ts describes config options that no longer exist:\n  ${stale.join("\n  ")}`,
    );
  }

  const seen = new Set<string>();
  const outdated: string[] = [];
  for (const file of await walk(pagesDir)) {
    const before = await readFile(file, "utf8");
    const after = before.replace(MARKER, (_match, name: string) => {
      const body = blocks[name];
      if (body === undefined)
        throw new Error(`${relative(docsRoot, file)}: unknown block "${name}"`);
      seen.add(name);
      return `<!-- generated:${name}:start -->\n${body}\n<!-- generated:${name}:end -->`;
    });
    if (after !== before) {
      if (check) outdated.push(relative(docsRoot, file));
      else await writeFile(file, after);
    }
  }
  const unused = Object.keys(blocks).filter((name) => !seen.has(name));
  if (unused.length > 0) {
    throw new Error(`No page has the generated block(s): ${unused.join(", ")}`);
  }
  if (outdated.length > 0) {
    throw new Error(
      `Generated docs are out of date: ${outdated.join(", ")}. Run \`pnpm --filter docs generate\` and commit the result.`,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
