/**
 * Small helpers for the GitLab CI files launchset writes (`gitlab.ts`, `gitlab-child.ts`):
 * parsing GitLab YAML (with its `!reference` tag), quoting YAML and shell values, turning branch
 * globs and labels into RE2 patterns for `rules: if:`, and the CLI install lines. Pure.
 */

import { isDeepStrictEqual } from "node:util";
import { type ParseOptions, parse as parseYaml, type SchemaOptions, YAMLSeq } from "yaml";
import { LaunchsetError } from "../core/errors.ts";
import { packageVersion } from "../init/package-files.ts";

// ---------------------------------------------------------------------------
// Parsing

/** A GitLab `!reference [job, key, ...]` tag, as parsed by {@link parseGitLabYaml}. */
export class GitLabReference {
  readonly path: unknown[];
  constructor(path: unknown[]) {
    this.path = path;
  }
}

const REFERENCE_TAG = {
  tag: "!reference",
  collection: "seq" as const,
  resolve: (value: unknown) =>
    new GitLabReference(value instanceof YAMLSeq ? (value.toJSON() as unknown[]) : []),
};

/** The custom tags of GitLab CI YAML (`!reference`), for parsing it with `yaml` directly. */
export const GITLAB_CUSTOM_TAGS = [REFERENCE_TAG];

const GITLAB_YAML: ParseOptions & SchemaOptions = { strict: true, customTags: GITLAB_CUSTOM_TAGS };

/** Parse GitLab CI YAML; `!reference` sequences become {@link GitLabReference}s. Throws on errors. */
export function parseGitLabYaml(text: string): unknown {
  return parseYaml(text, GITLAB_YAML);
}

/** Throws a LaunchsetError when a rendered GitLab file doesn't parse. */
export function checkGitLabYaml(path: string, content: string): void {
  try {
    parseGitLabYaml(content);
  } catch (error) {
    throw new LaunchsetError(
      "template-invalid-yaml",
      `The generated ${path} is not valid YAML: ${(error as Error).message}`,
      {
        hint: "A value from launchset.config (a branch pattern, label or target name) may contain characters YAML can't take in this position.",
        cause: error,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Quoting

const parsesTo = (text: string, expected: unknown): boolean => {
  try {
    return isDeepStrictEqual(parseYaml(text), expected);
  } catch {
    return false;
  }
};

/** A YAML block-context scalar: plain when it reads back unchanged, else double-quoted (JSON). */
export function yamlScalar(value: string): string {
  if (value !== "" && value.trim() === value && !value.includes("\n")) {
    if (parsesTo(`k: ${value}`, { k: value })) return value;
  }
  return JSON.stringify(value);
}

/** A YAML scalar inside a flow sequence (`[a, b]`): plain when safe, else double-quoted. */
export function yamlFlowScalar(value: string): string {
  if (/^[A-Za-z0-9._/-]+$/.test(value) && parsesTo(`[${value}]`, [value])) return value;
  return JSON.stringify(value);
}

/** One POSIX shell word: as is when it has no special characters, else single-quoted. */
export function shellWord(value: string): string {
  if (/^[A-Za-z0-9._/@%+=:,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// RE2 patterns for `rules: if:`

/**
 * Escape text for a GitLab `=~ /.../` pattern (RE2): regex metacharacters, the `/` that ends the
 * pattern, and `@` (GitLab reads it as the start of a ref's project path; its docs say to write
 * `\x40`).
 */
export function re2Escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&").replaceAll("@", "\\x40");
}

const EXTGLOB = /^[@!+*?]\(/;

/** The body of {@link branchGlobRe2} without anchors, or `undefined` when RE2 can't say it. */
function globBody(glob: string): string | undefined {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const char = glob[i] as string;
    const rest = glob.slice(i);
    if (EXTGLOB.test(rest)) return undefined;
    if (char === "\\" && i + 1 < glob.length) {
      out += re2Escape(glob[i + 1] as string);
      i += 2;
    } else if (rest === "/**") {
      out += "(?:\\/.*)?";
      i += 3;
    } else if (rest.startsWith("**/")) {
      out += "(?:.*\\/)?";
      i += 3;
    } else if (rest.startsWith("**")) {
      out += ".*";
      i += 2;
    } else if (char === "*") {
      out += "[^\\/]*";
      i += 1;
    } else if (char === "?") {
      out += "[^\\/]";
      i += 1;
    } else if (char === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end === -1) {
        out += re2Escape(char);
        i += 1;
        continue;
      }
      let inner = glob.slice(i + 1, end);
      const negate = inner.startsWith("!") || inner.startsWith("^");
      if (negate) inner = inner.slice(1);
      out += `[${negate ? "^" : ""}${inner.replace(/[\\/[\]]/g, "\\$&")}]`;
      i = end + 1;
    } else if (char === "{") {
      const end = glob.indexOf("}", i);
      const inner = end === -1 ? "" : glob.slice(i + 1, end);
      if (end === -1 || inner.includes("{")) {
        out += re2Escape(char);
        i += 1;
        continue;
      }
      const alternatives = inner.split(",").map(globBody);
      if (alternatives.some((alt) => alt === undefined)) return undefined;
      out += `(?:${alternatives.join("|")})`;
      i = end + 1;
    } else {
      out += re2Escape(char);
      i += 1;
    }
  }
  return out;
}

/**
 * An RE2 pattern (between the `/`s) for a branch glob as launchset matches it (picomatch: `*` and
 * `?` stay within one `/` segment, `**` crosses them, `{a,b}` and `[abc]` work). Extglobs
 * (`!(x)`, `+(x)`, ...) have no RE2 form: they become their literal prefix followed by anything,
 * a superset that is safe here because launchset itself decides precisely and skips a branch
 * that doesn't match.
 */
export function branchGlobRe2(glob: string): string {
  const body = globBody(glob);
  if (body !== undefined) return `^${body}$`;
  const wildcard = glob.search(/[*?[{\\]|[@!+]\(/);
  const prefix = glob.slice(0, wildcard === -1 ? glob.length : wildcard);
  return `^${re2Escape(prefix)}.*$`;
}

/** The RE2 pattern for `maintenanceBranches` (its `*` stands for `<major>.<minor>`). */
export function maintenanceRe2(pattern: string): string {
  const [before = "", after = ""] = pattern.split("*");
  return `^${re2Escape(before)}(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)${re2Escape(after)}$`;
}

/** The RE2 pattern for one label in `CI_MERGE_REQUEST_LABELS` (comma-separated names). */
export function labelRe2(label: string): string {
  return `(^|,)${re2Escape(label)}(,|$)`;
}

const PLAIN_BRANCH = /^[A-Za-z0-9._/-]+$/;

/**
 * A `rules: if:` expression: `variable` equals the branch, or matches the branch glob. A glob
 * without wildcards is a string comparison (`$CI_COMMIT_BRANCH == "main"`).
 */
export function branchCondition(variable: string, glob: string): string {
  if (PLAIN_BRANCH.test(glob)) return `${variable} == "${glob}"`;
  return `${variable} =~ /${branchGlobRe2(glob)}/`;
}

/** `variable` is a maintenance branch. */
export function maintenanceCondition(variable: string, pattern: string): string {
  return `${variable} =~ /${maintenanceRe2(pattern)}/`;
}

/** A `- if: <expression>` rules entry (with optional extra keys, already rendered). */
export function ruleEntry(expression: string, extra: string[] = []): string {
  return [`- if: ${yamlScalar(expression)}`, ...extra.map((line) => `  ${line}`)].join("\n");
}

// ---------------------------------------------------------------------------
// Installing the CLI in a job

/** The npm package of the CLI. */
export const CLI_PACKAGE = "@demonsters/launchset";

/** `@demonsters/launchset@<this version>`: what a job installs unless LAUNCHSET_CLI says else. */
export function defaultCliSpec(): string {
  const version = packageVersion();
  return version === "unknown" ? CLI_PACKAGE : `${CLI_PACKAGE}@${version}`;
}

/**
 * The script lines that install the CLI (`$LAUNCHSET_CLI`) unless `launchset` is already on the
 * PATH. The package is private: with `NPM_TOKEN` set, npm gets it as the registry token first.
 * POSIX sh; each line is one command, so a failure fails the job.
 */
export const INSTALL_LINES = [
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion, not a JS template.
  'if [ -n "${NPM_TOKEN:-}" ] && ! command -v launchset >/dev/null 2>&1; then npm config set "//registry.npmjs.org/:_authToken" "$NPM_TOKEN"; fi',
  'command -v launchset >/dev/null 2>&1 || npm install --global --no-fund --no-audit --loglevel=error "$LAUNCHSET_CLI"',
  "launchset --version",
];

/** {@link INSTALL_LINES} as YAML sequence items. */
export function installItems(): string {
  return INSTALL_LINES.map((line) => `- ${yamlScalar(line)}`).join("\n");
}
