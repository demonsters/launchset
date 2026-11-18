/**
 * Builds the GitHub Action bundle (spec 10, 13): `action/src/index.ts` and every dependency in
 * one file, `action/dist/index.js`. Run with `node scripts/build-action.ts`.
 *
 *   node scripts/build-action.ts                 build action/dist/index.js
 *   node scripts/build-action.ts --out <dir>     also write the publish directory for
 *                                                demonsters/launchset-action: action.yml,
 *                                                dist/index.js, README.md, LICENSE
 *   node scripts/build-action.ts --write-readme  regenerate the tables in action/README.md
 *                                                from action.yml
 */

import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild, type Plugin } from "esbuild";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const actionDir = resolve(root, "action");
export const BUNDLE = resolve(actionDir, "dist/index.js");

export const LICENSE_TEXT = `Copyright (c) demonsters. All rights reserved.

This repository contains the compiled launchset GitHub Action. It is proprietary software of
demonsters, provided only for use in GitHub Actions workflows. No other right is granted: you
may not copy, modify, redistribute or sublicense it, in whole or in part, without written
permission from demonsters.

The bundle includes third-party open source components under their own licenses. Their notices
are in dist/index.js.LEGAL.txt.
`;

/**
 * jiti's ESM entry (`lib/jiti.mjs`) loads its Babel transform at runtime with
 * `createRequire(import.meta.url)("../dist/babel.cjs")`, a path that doesn't exist next to the
 * bundle. Its CJS entry `require`s the same files statically, so esbuild can bundle them.
 */
const jitiCjs: Plugin = {
  name: "jiti-cjs",
  setup(build) {
    build.onResolve({ filter: /^jiti$/ }, () => ({
      path: resolve(root, "node_modules/jiti/lib/jiti.cjs"),
    }));
  },
};

/**
 * Bundled CommonJS code (jiti, and anything else) calls `require`, `__filename` and
 * `__dirname`, which don't exist in an ES module.
 */
const BANNER = [
  'import { createRequire as __launchsetCreateRequire } from "node:module";',
  'import { fileURLToPath as __launchsetFileURLToPath } from "node:url";',
  'import { dirname as __launchsetDirname } from "node:path";',
  "const require = __launchsetCreateRequire(import.meta.url);",
  "const __filename = __launchsetFileURLToPath(import.meta.url);",
  "const __dirname = __launchsetDirname(__filename);",
].join("\n");

export interface BuildResult {
  bundle: string;
  bytes: number;
}

/** Bundle the action into `action/dist/index.js` (+ `index.js.LEGAL.txt` next to it). */
export async function buildBundle(outfile: string = BUNDLE): Promise<BuildResult> {
  await esbuild({
    entryPoints: [resolve(actionDir, "src/index.ts")],
    outfile,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    // Readable stack traces: no minification, source positions kept as comments off.
    minify: false,
    sourcemap: false,
    legalComments: "external",
    banner: { js: BANNER },
    plugins: [jitiCjs],
    logLevel: "warning",
    // Prefer the ESM entry of a package (jsonc-parser's `main` is a UMD build that esbuild can't
    // follow: it `define`s its own relative requires).
    mainFields: ["module", "main"],
    // Every dependency is bundled: the action runs without node_modules.
    packages: "bundle",
  });
  const text = await readFile(outfile);
  return { bundle: outfile, bytes: text.length };
}

// ---------------------------------------------------------------------------
// README tables, generated from action.yml

interface ActionYml {
  inputs: Record<string, { description: string; required?: boolean; default?: string }>;
  outputs: Record<string, { description: string }>;
}

async function readActionYml(): Promise<ActionYml> {
  return parse(await readFile(resolve(actionDir, "action.yml"), "utf8")) as ActionYml;
}

function cell(text: string): string {
  // `<preid>` and friends would be read as HTML tags by GitHub's markdown.
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replaceAll("|", "\\|")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Markdown tables of the inputs and outputs of action.yml. */
export function renderTables(action: ActionYml): { inputs: string; outputs: string } {
  const inputs = [
    "| Input | Description | Default |",
    "| --- | --- | --- |",
    ...Object.entries(action.inputs).map(([name, input]) => {
      const fallback = input.required
        ? "required"
        : input.default !== undefined && input.default !== ""
          ? `\`${input.default}\``
          : "";
      return `| \`${name}\` | ${cell(input.description)} | ${fallback} |`;
    }),
  ].join("\n");
  const outputs = [
    "| Output | Description |",
    "| --- | --- |",
    ...Object.entries(action.outputs).map(
      ([name, output]) => `| \`${name}\` | ${cell(output.description)} |`,
    ),
  ].join("\n");
  return { inputs, outputs };
}

const MARKERS = {
  inputs: ["<!-- inputs:start -->", "<!-- inputs:end -->"],
  outputs: ["<!-- outputs:start -->", "<!-- outputs:end -->"],
} as const;

/** The README with the generated sections (between the marker comments) replaced. */
export function renderReadme(template: string, action: ActionYml): string {
  const tables = renderTables(action);
  let out = template;
  for (const key of ["inputs", "outputs"] as const) {
    const [start, end] = MARKERS[key];
    const from = out.indexOf(start);
    const to = out.indexOf(end);
    if (from === -1 || to === -1 || to < from) {
      throw new Error(`action/README.md needs the markers ${start} and ${end}`);
    }
    out = `${out.slice(0, from + start.length)}\n\n${tables[key]}\n\n${out.slice(to)}`;
  }
  return out;
}

/** What `action/README.md` should contain. */
export async function expectedReadme(): Promise<string> {
  const template = await readFile(resolve(actionDir, "README.md"), "utf8");
  return renderReadme(template, await readActionYml());
}

// ---------------------------------------------------------------------------
// Publish directory

/** The tree published to demonsters/launchset-action (spec 10, 15). */
export async function writePublishDir(out: string, bundle: string = BUNDLE): Promise<string[]> {
  const dir = resolve(out);
  await rm(resolve(dir, "dist"), { recursive: true, force: true });
  await mkdir(resolve(dir, "dist"), { recursive: true });
  const files = ["action.yml", "dist/index.js", "dist/index.js.LEGAL.txt", "README.md", "LICENSE"];
  await copyFile(resolve(actionDir, "action.yml"), resolve(dir, "action.yml"));
  await copyFile(bundle, resolve(dir, "dist/index.js"));
  await copyFile(`${bundle}.LEGAL.txt`, resolve(dir, "dist/index.js.LEGAL.txt"));
  await writeFile(resolve(dir, "README.md"), await expectedReadme());
  await writeFile(resolve(dir, "LICENSE"), LICENSE_TEXT);
  return files;
}

async function main(argv: string[]): Promise<void> {
  const outIndex = argv.indexOf("--out");
  const out = outIndex === -1 ? undefined : argv[outIndex + 1];
  if (outIndex !== -1 && (!out || out.startsWith("--"))) {
    throw new Error("--out needs a directory");
  }
  if (argv.includes("--write-readme")) {
    await writeFile(resolve(actionDir, "README.md"), await expectedReadme());
    console.log(`updated ${resolve(actionDir, "README.md")}`);
  }
  const { bundle, bytes } = await buildBundle();
  console.log(`wrote ${bundle} (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
  if (out) {
    const files = await writePublishDir(out);
    console.log(`wrote ${files.join(", ")} to ${resolve(out)}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
