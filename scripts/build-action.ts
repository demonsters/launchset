/**
 * Builds the GitHub Action bundle (spec 10, 13): `action/src/index.ts` and every dependency in
 * one file, `action/dist/index.js`. Run with `node scripts/build-action.ts`.
 *
 *   node scripts/build-action.ts                 build action/dist/index.js
 *   node scripts/build-action.ts --out <dir>     also write the publish directory for
 *                                                demonsters/launchset-action: action.yml,
 *                                                dist/index.js, dist/package.json,
 *                                                dist/THIRD_PARTY_LICENSES.txt,
 *                                                README.md, LICENSE
 *   node scripts/build-action.ts --write-readme  regenerate the tables in action/README.md
 *                                                from action.yml
 */

import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild, type Plugin } from "esbuild";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const actionDir = resolve(root, "action");
export const BUNDLE = resolve(actionDir, "dist/index.js");

/**
 * Written next to `index.js`: the bundle is an ES module, and without this file Node decides by
 * looking for a package.json above the action folder. A typeless one prints
 * MODULE_TYPELESS_PACKAGE_JSON, `"type": "commonjs"` makes loading fail.
 */
export const DIST_PACKAGE_JSON = `${JSON.stringify({ type: "module" })}\n`;

/** launchset's MIT licence (the repo root `LICENSE`), published with the action too. */
export const LICENSE = resolve(root, "LICENSE");

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

/**
 * Bundle the action into `action/dist/index.js`, with `THIRD_PARTY_LICENSES.txt` (every bundled
 * package's license) next to it.
 */
export async function buildBundle(outfile: string = BUNDLE): Promise<BuildResult> {
  const result = await esbuild({
    entryPoints: [resolve(actionDir, "src/index.ts")],
    outfile,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    // Readable stack traces: no minification, source positions kept as comments off.
    minify: false,
    sourcemap: false,
    // License comments stay in the bundle, at the end. They also cover code a package vendored
    // from another one (undici's copies of ws and formdata-polyfill), which the packages'
    // license files don't.
    legalComments: "eof",
    metafile: true,
    banner: { js: BANNER },
    plugins: [jitiCjs],
    logLevel: "warning",
    // Prefer the ESM entry of a package (jsonc-parser's `main` is a UMD build that esbuild can't
    // follow: it `define`s its own relative requires).
    mainFields: ["module", "main"],
    // Every dependency is bundled: the action runs without node_modules.
    packages: "bundle",
  });
  await writeFile(resolve(dirname(outfile), "package.json"), DIST_PACKAGE_JSON);
  const packages = await bundledPackages(Object.keys(result.metafile.inputs));
  await writeFile(resolve(dirname(outfile), NOTICES), renderNotices(packages));
  const text = await readFile(outfile);
  return { bundle: outfile, bytes: text.length };
}

// ---------------------------------------------------------------------------
// Third-party licenses

/** The notices file next to the bundle. */
export const NOTICES = "THIRD_PARTY_LICENSES.txt";

/**
 * Licenses the bundle may contain. launchset is MIT, and the action is published as one file,
 * so a copyleft dependency (GPL, LGPL, MPL) would change what users of the action may do: the
 * build stops instead. An SPDX `OR` expression passes when one side is listed here.
 */
export const ALLOWED_LICENSES = [
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "Unlicense",
];

export interface BundledPackage {
  name: string;
  version: string;
  /** The SPDX expression from package.json. */
  license: string;
  /** The package's license files (LICENSE, LICENCE, COPYING, NOTICE), in name order. */
  files: { name: string; text: string }[];
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([-._].*)?$/i;

/**
 * The package directory of a file inside `node_modules`: everything up to the last
 * `node_modules/` plus the package name (two segments when scoped). Undefined for own code.
 */
export function packageDir(file: string): string | undefined {
  const parts = resolve(root, file).split(sep);
  const at = parts.lastIndexOf("node_modules");
  if (at === -1 || at + 1 >= parts.length) return undefined;
  const length = parts[at + 1]?.startsWith("@") ? 3 : 2;
  return parts.slice(0, at + length).join(sep);
}

function licenseOf(pkg: Record<string, unknown>): string {
  const { license, licenses } = pkg;
  if (typeof license === "string") return license;
  if (license && typeof license === "object" && "type" in license) return String(license.type);
  if (Array.isArray(licenses)) {
    return licenses.map((l) => (l && typeof l === "object" ? l.type : l)).join(" OR ");
  }
  return "";
}

/** Whether an SPDX expression is allowed: every `AND` part, and one side of each `OR`. */
export function licenseAllowed(expression: string): boolean {
  const clean = expression.replace(/[()]/g, " ").trim();
  if (!clean) return false;
  return clean
    .split(/\s+OR\s+/i)
    .some((option) =>
      option.split(/\s+AND\s+/i).every((id) => ALLOWED_LICENSES.includes(id.trim())),
    );
}

/** The packages the bundle's input files come from, with their licenses. */
export async function bundledPackages(inputs: string[]): Promise<BundledPackage[]> {
  const dirs = new Set(inputs.map(packageDir).filter((dir): dir is string => dir !== undefined));
  const found = new Map<string, BundledPackage>();
  const problems: string[] = [];
  for (const dir of dirs) {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const name = String(pkg.name);
    const version = String(pkg.version);
    const license = licenseOf(pkg);
    const names = (await readdir(dir)).filter((file) => LICENSE_FILE.test(file)).sort();
    const files = await Promise.all(
      names.map(async (file) => ({
        name: file,
        text: (await readFile(join(dir, file), "utf8")).trim(),
      })),
    );
    const where = relative(root, dir);
    if (!licenseAllowed(license)) {
      problems.push(`${name}@${version} (${where}): license "${license || "none"}" isn't allowed`);
    } else if (files.length === 0) {
      problems.push(`${name}@${version} (${where}): no LICENSE file to copy its notice from`);
    }
    found.set(`${name}@${version}`, { name, version, license, files });
  }
  if (problems.length > 0) {
    throw new Error(
      `The action bundle can't include these packages:\n  ${problems.join("\n  ")}\nSee ALLOWED_LICENSES in scripts/build-action.ts.`,
    );
  }
  return [...found.values()].sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
  );
}

/** `THIRD_PARTY_LICENSES.txt`: each bundled package with its license files. */
export function renderNotices(packages: BundledPackage[]): string {
  const rule = "-".repeat(78);
  const head = [
    "The launchset GitHub Action (dist/index.js) bundles the third-party packages below.",
    "Each one keeps its own license, copied here from the package. launchset itself is MIT:",
    "see LICENSE.",
  ].join("\n");
  const sections = packages.map((pkg) =>
    [
      rule,
      `${pkg.name}@${pkg.version} (${pkg.license})`,
      rule,
      ...pkg.files.map((file) =>
        pkg.files.length > 1 ? `${file.name}:\n\n${file.text}` : file.text,
      ),
    ].join("\n\n"),
  );
  return `${[head, ...sections].join("\n\n")}\n`;
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
  const files = [
    "action.yml",
    "dist/index.js",
    "dist/package.json",
    `dist/${NOTICES}`,
    "README.md",
    "LICENSE",
  ];
  await copyFile(resolve(actionDir, "action.yml"), resolve(dir, "action.yml"));
  await copyFile(bundle, resolve(dir, "dist/index.js"));
  await writeFile(resolve(dir, "dist/package.json"), DIST_PACKAGE_JSON);
  await copyFile(resolve(dirname(bundle), NOTICES), resolve(dir, "dist", NOTICES));
  await writeFile(resolve(dir, "README.md"), await expectedReadme());
  await copyFile(LICENSE, resolve(dir, "LICENSE"));
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
