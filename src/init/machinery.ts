/**
 * Existing release machinery that conflicts with launchset (spec 11.1 step 1, "Existing
 * release machinery"), with the edits each action (`remove`, `disable`) would make.
 * Read-only: `retire.ts` applies the edits.
 *
 * Rules for `disable` (it never deletes a file):
 * - triggers: remove the conflicting tag patterns / filter / trigger, or make a plain
 *   `push` skip tags; a workflow left without triggers gets `workflow_dispatch`;
 * - steps: remove the step, or only the conflicting commands of its `run` script. A command
 *   is deleted only when that's structurally safe, otherwise it's replaced by the no-op `:`
 *   plus a `# launchset: disabled — …` comment; commands in heredocs or compound lines get
 *   no disable;
 * - references to a removed step or job (`steps.<id>.…`, `needs.<job>.…`) are listed as
 *   evidence here and as manual steps after writing; they don't block `disable`.
 */

import { isMap, isScalar, isSeq, type Node, type Pair, type YAMLMap, type YAMLSeq } from "yaml";
import { escapeRegExp } from "../core/regex.ts";
import { lineOf } from "../core/text.ts";
import { joinRel, linesOf, normalizeRel } from "./fs.ts";
import { matchesFilter } from "./github-filter.ts";
import {
  type GitLabCi,
  type GitLabDockerBuild,
  type GitLabFile,
  type GitLabInclude,
  type GitLabJob,
  type GitLabLatestRef,
  type GitLabScriptItem,
  gitlabCiOf,
  gitlabDockerBuilds,
  referencesTo,
  referencingJobs,
  runsOnTags,
  tagRuleEdit,
  usersOf,
} from "./gitlab-scan.ts";
import { QUOTED_SPACE, runsFile, simpleCommands } from "./shell.ts";
import { latestFlagRange } from "./text-edit.ts";
import type { Evidence, MachineryAction, MachineryItem, MachineryKind } from "./types.ts";
import {
  type DockerBuild,
  isBlock,
  type LatestRef,
  pairOf,
  type RunCommand,
  runCommands,
  type ScalarRef,
  shellCommands,
  tagGated,
  type Workflow,
  type WorkflowJob,
  type WorkflowStep,
} from "./workflow-scan.ts";

// ---------------------------------------------------------------------------
// Edits

export type WorkflowOp =
  | { op: "remove-step"; job: WorkflowJob; step: WorkflowStep }
  | { op: "remove-commands"; job: WorkflowJob; step: WorkflowStep; commands: RunCommand[] }
  | {
      op: "neutralize-commands";
      job: WorkflowJob;
      step: WorkflowStep;
      commands: RunCommand[];
      reason: string;
    }
  | { op: "remove-run-line"; job: WorkflowJob; step: WorkflowStep; line: number }
  | { op: "remove-latest"; job: WorkflowJob; step: WorkflowStep; refs: LatestRef[] }
  /** Some (not all) patterns of `on.push.tags`. */
  | { op: "remove-tag-patterns"; patterns: ScalarRef[] }
  /** A `tags` / `tags-ignore` filter of a push that also has a branch filter. */
  | { op: "remove-filter"; pair: Pair }
  /** A whole trigger of the `on` map (`push`, `release`). */
  | { op: "remove-trigger"; pair: Pair }
  /** Make an unfiltered `push` skip tags. */
  | { op: "exclude-tags" };

/** Edits of a GitLab CI file (all computed on the text detection read). */
export type GitLabOp =
  | { op: "remove-job"; job: GitLabJob }
  /** Rename `job` to `.job` (GitLab's hidden jobs never run). */
  | { op: "hide-job"; job: GitLabJob }
  /** Comment out a script line (a plain sequence item). */
  | { op: "comment-item"; item: GitLabScriptItem; inSeq: boolean; reason: string }
  /** Replace a script line with the no-op `":"` (the script would be empty otherwise). */
  | { op: "noop-item"; item: GitLabScriptItem; inSeq: boolean; reason: string }
  /** Comment out (or neutralize) commands inside a block scalar script item. */
  | { op: "commands"; item: GitLabScriptItem; commands: RunCommand[]; reason: string }
  /** A key of a job, e.g. `release:`. */
  | { op: "remove-pair"; pair: Pair }
  /** A `-t <image>:latest` flag of a build that has other tags. */
  | { op: "remove-flag"; item: GitLabScriptItem; entry: string }
  /** The include entry of a deleted file. */
  | { op: "remove-include"; include: GitLabInclude }
  /** Entries of a sequence, e.g. a job's tag rules (`- if: $CI_COMMIT_TAG`) or `tags` in `only`. */
  | { op: "remove-seq-items"; seq: YAMLSeq; items: Node[] };

export type Edit =
  | { kind: "delete-file"; path: string }
  | { kind: "workflow"; path: string; workflow: Workflow; op: WorkflowOp }
  | { kind: "gitlab"; path: string; text: string; op: GitLabOp }
  | {
      kind: "script";
      /** The package.json. */
      path: string;
      script: string;
      /** `&&`-separated parts to drop; undefined drops the whole entry. */
      segments?: string[];
    }
  /**
   * Comment out lines (Ruby/shell `#`), e.g. fastlane version actions. A line in `noops` (a
   * shell command inside if/for or a chain) becomes the no-op `:` instead, so the structure
   * stays valid.
   */
  | {
      kind: "comment-lines";
      path: string;
      lines: number[];
      reason: string;
      noops?: { line: number; trailingOp?: string }[];
    };

export interface MachineryFinding {
  item: MachineryItem;
  edits: Partial<Record<Exclude<MachineryAction, "keep">, Edit[]>>;
}

export interface PackageScripts {
  /** package.json path. */
  path: string;
  dir: string;
  scripts: Record<string, string>;
  /** 1-based line of each script entry. */
  lines: Record<string, number>;
}

export interface MachineryInput {
  workflows: Workflow[];
  dockerBuilds: DockerBuild[];
  packages: PackageScripts[];
  /** Script files to inspect (repo-relative) with their text. */
  scriptFiles: { path: string; text: string }[];
  /** `.gitlab-ci.yml` text, if present (without its includes; see `gitlabCi`). */
  gitlab?: { path: string; text: string };
  /** The GitLab CI configuration with its local includes (wins over `gitlab`). */
  gitlabCi?: GitLabCi;
  /** Docker builds in the GitLab jobs (computed from the configuration when missing). */
  gitlabBuilds?: GitLabDockerBuild[];
  /** Fastfiles with their text. */
  fastfiles: { path: string; text: string }[];
  /** CLAUDE.md, AGENTS.md, README with their text. */
  docs: { path: string; text: string }[];
  /** Tags launchset would push, to test tag filters against (see {@link sampleTags}). */
  samples?: { tag: string; what: string }[];
}

// ---------------------------------------------------------------------------
// Patterns

// Shell commands are matched one simple command at a time (see shell.ts), at its start: a
// command that is only mentioned (a comment, a quoted argument, an echoed message) never counts.

const CHANGESET_COMMAND = /^changeset\s+(?:version|status|publish|tag|pre)\b/;
const RELEASE_TOOL_COMMAND =
  /^(?:semantic-release|release-it|standard-version|release-please|commit-and-tag-version)\b/;
/** `git` with its global options (`git -C dir`, `git -c k=v`). */
const GIT = String.raw`^git\s+(?:-[Cc]\s+\S+\s+|--[\w-]+(?:=\S*)?\s+)*`;
const TAG_COMMANDS: RegExp[] = [
  new RegExp(
    String.raw`${GIT}tag\s+(?:-[A-Za-z]*[asfmu][A-Za-z]*\b|--(?:annotate|sign|force|message)\b|[^-\s])`,
  ),
  // Pushing tags; deleting a remote tag (`--delete`, `:refs/tags/v1`) doesn't create one.
  new RegExp(
    String.raw`${GIT}push\b(?!.*\s(?:--delete|-d)\b)(?!.*\s\+?:\S)(?=.*(?:\s--tags\b|\s--follow-tags\b|refs\/tags\/|\s\+?v\$|\s\+?v\d))`,
  ),
  /^gh\s+release\s+create\b/,
];
const GIT_TAG_OFF = /\s--no-git-tag-version\b|\s--git-tag-version(?:=|\s+)false\b/;

/**
 * `npm version patch` (also `pnpm`, and yarn's `--new-version` / strategy forms): bumps the
 * version and creates its tag. `npm version` alone only prints versions.
 */
function bumpsVersion(text: string): boolean {
  const m = /^(?:npm|pnpm|yarn)\s+version\b/.exec(text);
  if (!m || GIT_TAG_OFF.test(text)) return false;
  const words = text.slice(m[0].length).trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string;
    if (/^(?:-m|--message|--preid)$/.test(w)) {
      i++;
    } else if (
      /^--(?:new-version|major|minor|patch|premajor|preminor|prepatch|prerelease)\b/.test(w)
    ) {
      return true;
    } else if (!w.startsWith("-")) {
      return true;
    }
  }
  return false;
}

const VERSION_KEYS =
  /\b(MARKETING_VERSION|CURRENT_PROJECT_VERSION|versionCode|versionName|CFBundleVersion|CFBundleShortVersionString)\b/;
/**
 * Places that only read a version key: a subscript that isn't assigned to
 * (`plistlib.load(f)["CFBundleShortVersionString"]`), `.get("versionName")`, PlistBuddy's
 * `Print`. A line whose version keys are all read like this doesn't count as a writer.
 */
const VERSION_KEY_READS = new RegExp(
  String.raw`\[\s*["']${VERSION_KEYS.source}["']\s*\](?!\s*(?:=(?!=)|\+=|\|=))|\.(?:get|getProperty|objectForKey)\(\s*["']${VERSION_KEYS.source}["']|\bPrint\s*:?\s*${VERSION_KEYS.source}`,
  "g",
);

const VERSION_WRITE_COMMANDS = [
  /^agvtool\s+(?:new-version|new-marketing-version|next-version|bump)\b/,
  /^PlistBuddy\b.*\bSet[\s\u2423]*:?[\s\u2423]*(?:CFBundleVersion|CFBundleShortVersionString)\b/,
];
/** `sed -i` / `perl -pi`: edits a file in place. */
const IN_PLACE = /^(?:sed|perl)\b.*\s(?:-[A-Za-z]*i|--in-place)/;
const FILE_WRITE =
  /\b(?:writeFile|writeFileSync|outputFile|outputFileSync|appendFile|appendFileSync)\b|\bfs\.write\b|File\.write|\.write_text\(|\.write\(|open\([^)]*["'][wa]/;
/** Lines that only print or log: what they mention isn't run. */
const LOG_CALL =
  /\b(?:console\.\w+|print|println|puts|logger\.\w+|log\.\w+|logging\.\w+|core\.(?:info|notice|warning|error|debug)|UI\.\w+)\s*[(\s"'`]/;

/** A line of a script (not shell) that writes a version key, not only reads or prints it. */
function writesVersionKey(line: string): boolean {
  const l = line.replace(VERSION_KEY_READS, "");
  const key = VERSION_KEYS.exec(l);
  if (!key || LOG_CALL.test(l)) return false;
  if (FILE_WRITE.test(l)) return true;
  // Replacing it in a text: `s.replace(/versionCode \d+/, …)`, `re.sub(…)`, `gsub`.
  if (/\.(?:replace|replaceAll|g?sub!?)\s*\(|\bre\.sub\(/.test(l)) return true;
  // Assigning it: `info["CFBundleVersion"] = n`, `versionName = …`.
  const eq = /(?<![=!<>+\-*/])=(?![=>])/.exec(l);
  if (eq && key.index < eq.index) return true;
  // Building text with it: `` `versionCode ${n}` ``, f-strings, `%s`, `.format(`.
  return (
    new RegExp(String.raw`\`[^\`]*${VERSION_KEYS.source}[^\`]*\$\{`).test(l) ||
    new RegExp(String.raw`\bf["'][^"']*${VERSION_KEYS.source}[^"']*\{`).test(l) ||
    /%[sd]|\.format\(/.test(l)
  );
}

const RELEASE_ACTIONS =
  /^(?:softprops\/action-gh-release|actions\/create-release|ncipollo\/release-action|marvinpinto\/action-automatic-releases|elgohr\/Github-Release-Action|mathieudutour\/github-tag-action|anothrNick\/github-tag-action|rickstaa\/action-create-tag)$/;
const RELEASE_TOOL_ACTIONS =
  /^(?:googleapis\/release-please-action|google-github-actions\/release-please-action|cycjimmy\/semantic-release-action|codfish\/semantic-release-action)$/;
const FASTLANE_WRITERS =
  /^\s*(?:increment_build_number|increment_version_number|increment_version_code|android_set_version_code|android_set_version_name|increment_version_name)\b|set_info_plist_value[^\n]*CFBundle(?:Short)?Version/;
const DOC_LINES = /\bnpm\s+version\b|\bgit\s+tag\b|\bchangesets?\b/i;

/** Commands that publish or deploy something (matched at the start of a simple command). */
const PUBLISH_COMMANDS: RegExp[] = [
  /^(?:npm|pnpm|yarn|bun)\s+(?:-\S+\s+)*(?:npm\s+)?publish\b/,
  /^gh\s+release\s+(?:create|upload)\b/,
  /^docker\s+(?:(?:buildx\s+)?build\b.*\s--push\b|buildx\s+bake\b.*\s--push\b|push\b|image\s+push\b|manifest\s+push\b)/,
  /^(?:podman|buildah)\s+push\b|^crane\s+(?:push|copy|cp)\b|^skopeo\s+copy\b/,
  /^kubectl\s+(?:apply|set\s+image|rollout)\b/,
  /^helm\s+(?:upgrade|install|push)\b/,
  /^(?:vercel|netlify|flyctl|fly|wrangler|firebase|eas|surge)\b.*\s(?:deploy|publish|submit)\b|^vercel\b.*\s--prod\b/,
  /^aws\s+(?:s3\s+(?:sync|cp)|ecs\s+update-service|lambda\s+update-function-code|cloudformation\s+deploy|deploy)\b/,
  /^gcloud\s+(?:app|run|functions)\s+deploy\b|^az\s+\S+.*\sdeploy\b/,
  /^fastlane\b/,
  /^(?:twine\s+upload|cargo\s+publish|gem\s+push|(?:uv|poetry|hatch|flit|pdm)\s+publish|(?:dotnet\s+)?nuget\s+push|(?:vsce|ovsx)\s+publish)\b/,
  /^goreleaser(?:\s+release\b|\s*$|\s+-)/,
  /^(?:mvn|mvnw)\b.*\sdeploy\b|^(?:gradle|gradlew)\b.*\s(?:publish|upload)\w*\b/,
  /^electron-builder\b.*\s--publish(?:\s+|=)(?:always|onTag|onTagOrDraft)\b/,
  /^(?:rsync|scp)\b.*\s[^\s:/]+:\S*/,
  /^curl\b.*\s(?:--upload-file|-T)\s/,
  /^(?:serverless|sls|cdk|pulumi|terraform|sam)\s+(?:deploy|up|apply)\b/,
  // `make deploy`, `npm run release`, `pnpm deploy:prod`, `./scripts/publish.sh`, `bash deploy.sh`.
  /^(?:make|just|task|mage)\s+(?:\S+\s+)*?(?:[\w.]*[-:_])?(?:deploy|release|publish|upload)\b/,
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:[\w.]*[-:])?(?:deploy|release|publish|upload)(?:[-:]\S*)?(?:\s|$)/,
  /^[\w.-]*(?:deploy|release|publish|upload)[\w.-]*\.(?:sh|bash|py|rb|js|mjs|cjs|ts|mts|ps1)(?:\s|$)/,
  /^(?:sh|bash|zsh|node|python3?|ruby|pwsh|tsx|bun|deno|uv)\b.*\s(?:\S*\/)?[\w.-]*(?:deploy|release|publish|upload)[\w.-]*\.(?:sh|bash|py|rb|js|mjs|cjs|ts|mts|ps1)(?:\s|$)/,
  /\s--push(?:=\S*)?(?:\s|$)/,
];
/** Flags that make a publish command a check or a help text. */
const NOT_PUBLISHING = /\s(?:--dry-run|--help|-h|--snapshot|--version)\b/;

/** The first command of `script` that publishes or deploys something, or undefined. */
export function publishCommand(script: string): string | undefined {
  return simpleCommands(script)
    .find((c) => PUBLISH_COMMANDS.some((p) => p.test(c.text)) && !NOT_PUBLISHING.test(c.text))
    ?.text.replaceAll(QUOTED_SPACE, " ");
}

const PUBLISH_ACTION =
  /deploy|gh-pages|action-gh-release|create-release|release-action|publish|upload-google-play|upload-testflight|vercel|netlify|wrangler|firebase|ssh-action/i;

const REASON: Record<MachineryKind, string> = {
  "tag-trigger":
    "fires again when launchset pushes its tags (with the App token), so its build or publish steps run a second time",
  "release-trigger":
    "fires when launchset's finalize creates the GitHub Release, so its steps run for every release",
  changesets:
    'runs Changesets, which opens its own release PR and bumps versions; launchset\'s release PR replaces it (keep it instead if it versions npm packages of their own: see "Alongside Changesets" in the docs)',
  "release-tool":
    "runs another release tool (semantic-release, release-it, standard-version or release-please), which bumps versions and creates tags or releases; launchset does that now",
  "tag-creation":
    "creates release tags or GitHub Releases, which launchset's finalize creates (it would create v{version} before finalize)",
  "docker-latest":
    "moves the Docker latest tag on branch pushes; launchset moves latest only when a release ships",
  "version-writer":
    "writes version or build numbers (MARKETING_VERSION, CURRENT_PROJECT_VERSION, versionCode, versionName), which would overwrite what launchset stamps in CI",
  "changesets-write":
    "writes Changesets files (@changesets/write); launchset reads .launchset/ instead",
  "release-docs":
    "describes the old release process (npm version, git tag, changeset); launchset releases through the release PR",
  "package-publish":
    "publishes the npm package on its own; launchset publishes it when a release ships (put npm publish in a target's build steps)",
};

/** Short reasons for `# launchset: disabled — <reason>` comments. */
const SHORT: Record<MachineryKind, string> = {
  "tag-trigger": "runs on launchset's tags",
  "release-trigger": "runs on launchset's releases",
  changesets: "Changesets is replaced by launchset",
  "release-tool": "launchset does the releases now",
  "tag-creation": "launchset's finalize creates tags and releases",
  "docker-latest": "launchset moves latest when a release ships",
  "version-writer": "launchset stamps versions and build numbers",
  "changesets-write": "launchset reads .launchset/",
  "release-docs": "launchset releases through the release PR",
  "package-publish": "launchset publishes when a release ships",
};

const KIND_ORDER: MachineryKind[] = [
  "changesets",
  "release-tool",
  "tag-creation",
  "version-writer",
];

/** The machinery kinds of one simple command's text (see shell.ts). */
function simpleCommandKinds(text: string): MachineryKind[] {
  const kinds: MachineryKind[] = [];
  if (CHANGESET_COMMAND.test(text)) kinds.push("changesets");
  if (RELEASE_TOOL_COMMAND.test(text)) kinds.push("release-tool");
  if (TAG_COMMANDS.some((t) => t.test(text)) || bumpsVersion(text)) kinds.push("tag-creation");
  if (
    VERSION_WRITE_COMMANDS.some((p) => p.test(text)) ||
    (IN_PLACE.test(text) && VERSION_KEYS.test(text))
  ) {
    kinds.push("version-writer");
  }
  return kinds;
}

/** The machinery kinds a shell command matches (only what it runs, see shell.ts). */
export function commandKinds(full: string): MachineryKind[] {
  const found = new Set(simpleCommands(full).flatMap((c) => simpleCommandKinds(c.text)));
  return KIND_ORDER.filter((k) => found.has(k));
}

/** The language of a script file, for what counts as a comment and a command. */
export function scriptLanguage(path: string | undefined, text: string): "shell" | "js" | "hash" {
  const ext = /\.([A-Za-z]+)$/.exec(path ?? "")?.[1]?.toLowerCase();
  if (ext === "sh" || ext === "bash" || ext === "zsh") return "shell";
  if (ext && /^(?:js|mjs|cjs|ts|mts|cts|jsx|tsx)$/.test(ext)) return "js";
  if (ext === "py" || ext === "rb") return "hash";
  const shebang = /^#!\S*?(?:\/env(?:\s+-\S+)*)?\s*\/?(?:\S*\/)?([\w.-]+)/.exec(text);
  const program = shebang?.[1] ?? "";
  if (/^(?:sh|bash|zsh|dash|ksh)$/.test(program)) return "shell";
  if (/^(?:node|deno|bun|tsx|ts-node)$/.test(program)) return "js";
  return "hash";
}

/** A script's lines with comments blanked (`//` and block comments, or `#`). */
function codeLines(text: string, language: "js" | "hash"): { number: number; text: string }[] {
  let block = false;
  return linesOf(text).map((l) => {
    let t = l.text;
    if (language === "hash") {
      t = l.number === 1 && t.startsWith("#!") ? "" : t.replace(/(^|\s)#.*$/, "$1");
    } else {
      let out = "";
      let i = 0;
      while (i < t.length) {
        if (block) {
          const end = t.indexOf("*/", i);
          if (end < 0) {
            i = t.length;
          } else {
            block = false;
            i = end + 2;
          }
        } else if (t.startsWith("/*", i)) {
          block = true;
          i += 2;
        } else if (t.startsWith("//", i) && (i === 0 || /[\s;,{}()]/.test(t[i - 1] as string))) {
          break;
        } else {
          out += t[i];
          i++;
        }
      }
      t = l.number === 1 && out.startsWith("#!") ? "" : out;
    }
    return { number: l.number, text: t };
  });
}

/** Tag, release-tool and Changesets commands inside a (non-shell) script's strings. */
const CODE_PATTERNS: [MachineryKind, RegExp][] = [
  ["changesets", /\bchangeset\s+(?:version|status|publish|tag|pre)\b/],
  [
    "release-tool",
    /\b(?:semantic-release|release-it|standard-version|release-please|commit-and-tag-version)\b/,
  ],
  [
    "tag-creation",
    /\bgit\s+tag\s+(?:-[A-Za-z]*[asfmu][A-Za-z]*\b|--(?:annotate|sign|force|message)\b|["'$\w])/,
  ],
  [
    "tag-creation",
    /\bgit\s+push\b[^\n]*(?:--tags|--follow-tags|refs\/tags\/|\s["']?v\$|\s["']?v\d)/,
  ],
  ["tag-creation", /\bgh\s+release\s+create\b|\bcreateRelease\b|\bcreateTag\b/],
  ["tag-creation", /\b(?:npm|pnpm)\s+version\s+(?!-)\w(?![^\n]*--no-git-tag-version)/],
];

/** What a script file does that conflicts, with the commands (shell) or lines behind it. */
export interface ScriptFileScan {
  kinds: MachineryKind[];
  /** First line with a finding (0 when none). */
  line: number;
  language: "shell" | "js" | "hash";
  /** Shell: every command, and the conflicting ones. */
  commands: RunCommand[];
  matched: RunCommand[];
  /** Lines with a finding. */
  lines: number[];
}

export function scanScriptFile(text: string, path?: string): ScriptFileScan {
  const language = scriptLanguage(path, text);
  const found = new Map<MachineryKind, number>();
  const note = (kind: MachineryKind, at: number) => {
    const was = found.get(kind);
    if (was === undefined || at < was) found.set(kind, at);
  };
  const lines = new Set<number>();
  let commands: RunCommand[] = [];
  const matched: RunCommand[] = [];
  if (language === "shell") {
    commands = shellCommands(linesOf(text));
    for (const c of commands) {
      const kinds = commandKinds(c.command);
      if (/@changesets\/write/.test(c.command)) kinds.push("changesets-write");
      if (kinds.length === 0) continue;
      matched.push(c);
      const at = c.lines[0]?.number ?? 0;
      for (const k of kinds) note(k, at);
      for (const l of c.lines) lines.add(l.number);
    }
  } else {
    const code = codeLines(text, language);
    const writes = code.some((l) => FILE_WRITE.test(l.text));
    for (const l of code) {
      if (l.text.trim() === "") continue;
      const kinds: MachineryKind[] = [];
      if (!LOG_CALL.test(l.text)) {
        for (const [kind, pattern] of CODE_PATTERNS) {
          if (pattern.test(l.text) && !kinds.includes(kind)) kinds.push(kind);
        }
      }
      if (writes && writesVersionKey(l.text)) kinds.push("version-writer");
      if (/@changesets\/write/.test(l.text)) kinds.push("changesets-write");
      for (const k of kinds) note(k, l.number);
      if (kinds.length > 0) lines.add(l.number);
    }
  }
  const order: MachineryKind[] = [...KIND_ORDER, "changesets-write"];
  const kinds = order.filter((k) => found.has(k));
  const line = kinds.length > 0 ? Math.min(...kinds.map((k) => found.get(k) as number)) : 0;
  return { kinds, line, language, commands, matched, lines: [...lines].sort((a, b) => a - b) };
}

/** The machinery kinds of a script file's content. */
export function scriptFileKinds(
  text: string,
  path?: string,
): { kinds: MachineryKind[]; line: number } {
  const { kinds, line } = scanScriptFile(text, path);
  return { kinds, line };
}

/** Tags launchset pushes, for a set of release tag formats and target names (spec 2, 9.6, 9.9). */
export function sampleTags(
  releaseFormats: string[],
  targets: string[],
): { tag: string; what: string }[] {
  const out: { tag: string; what: string }[] = [];
  const add = (tag: string, what: string) => {
    if (!out.some((o) => o.tag === tag)) out.push({ tag, what });
  };
  for (const format of new Set(["v{version}", ...releaseFormats])) {
    add(format.replace("{version}", "1.2.3"), `release tag ${format}`);
    add(format.replace("{version}", "1.2.3-alpha.0"), `prerelease tag ${format}`);
  }
  for (const target of targets.length > 0 ? targets : ["web"]) {
    add(`launchset/${target}@1.2.3`, "marker tag launchset/{target}@{version}");
  }
  add("launchset/partial/1.2.3", "partial tag launchset/partial/{version}");
  return out;
}

const DEFAULT_SAMPLES = sampleTags([], []);

// ---------------------------------------------------------------------------
// Workflows

interface Draft {
  kinds: MachineryKind[];
  path: string;
  line: number;
  what: string;
  /** `disable` edits; undefined when no minimal edit exists. */
  disable?: Edit[];
  /** `remove` edits. */
  remove: Edit[];
  effects: Partial<Record<MachineryAction, string>>;
  evidence: Evidence[];
  /** Why there's no `disable`. */
  why?: string;
  /** Overrides the default reasons of the kinds. */
  reasons?: string[];
  /** The GitLab job (for {@link MachineryItem.requires}). */
  gitlabJob?: string;
  /** GitLab jobs whose disable must come with this one's (they need this job). */
  requires?: string[];
}

function addKind(draft: Draft, kind: MachineryKind) {
  if (!draft.kinds.includes(kind)) draft.kinds.push(kind);
}

function isFlowMap(node: unknown): boolean {
  return isMap(node) && (node as YAMLMap).flow === true;
}

/** True when a workflow pushes images, publishes packages or deploys. */
export function publishesOrDeploys(workflow: Workflow, builds: DockerBuild[]): boolean {
  if (builds.some((b) => b.workflow === workflow && b.pushes)) return true;
  return workflow.jobs.some((job) =>
    job.steps.some((step) => {
      const uses = step.uses?.replace(/@.*/, "") ?? "";
      if (
        uses &&
        !/^actions\/(?:upload|download)-artifact$/.test(uses) &&
        PUBLISH_ACTION.test(uses)
      ) {
        return true;
      }
      if (uses === "docker/build-push-action" && step.with.get("push")?.value !== "false") {
        return step.with.has("push");
      }
      return step.run !== undefined && publishCommand(step.run.value) !== undefined;
    }),
  );
}

function workflowEdit(workflow: Workflow, op: WorkflowOp): Edit {
  return { kind: "workflow", path: workflow.path, workflow, op };
}

function triggerDrafts(
  workflow: Workflow,
  samples: { tag: string; what: string }[],
  publishes: boolean,
): Draft[] {
  const t = workflow.triggers;
  const drafts: Draft[] = [];
  const base = (line: number, what: string): Draft => ({
    kinds: ["tag-trigger"],
    path: workflow.path,
    line,
    what,
    remove: [{ kind: "delete-file", path: workflow.path }],
    effects: { remove: "deletes the workflow file", keep: "leaves it as is" },
    evidence: [],
  });
  const flowPush = isFlowMap(t.pair?.value) || isFlowMap(t.pushPair?.value);
  const removePush = (d: Draft, filter: Pair | undefined, label: string) => {
    if (flowPush) {
      d.why = "the trigger is written in flow style ({ ... }); edit it by hand";
      return;
    }
    if (t.hasBranchFilter && filter) {
      d.disable = [workflowEdit(workflow, { op: "remove-filter", pair: filter })];
      d.effects.disable = `removes the on.push.${label} filter (branch pushes still run it)`;
    } else if (t.pushPair) {
      d.disable = [workflowEdit(workflow, { op: "remove-trigger", pair: t.pushPair })];
      d.effects.disable =
        "removes the push trigger (workflow_dispatch replaces it when no other trigger is left)";
    }
  };

  if (t.tagsPair) {
    const conflicting = t.tagPatterns.filter((p) =>
      samples.some((s) => matchesFilter([p.value], s.tag)),
    );
    if (conflicting.length > 0) {
      const d = base(
        conflicting[0]?.line ?? 1,
        `workflow trigger on.push.tags: ${t.tagPatterns.map((p) => p.value).join(", ")}`,
      );
      d.evidence = conflicting.map((p) => ({
        path: workflow.path,
        line: p.line,
        note: `tag pattern ${p.value} matches ${samples
          .filter((s) => matchesFilter([p.value], s.tag))
          .map((s) => s.tag)
          .join(", ")}`,
      }));
      if (conflicting.length < t.tagPatterns.length && isSeq(t.tagsPair.value) && !flowPush) {
        d.disable = [workflowEdit(workflow, { op: "remove-tag-patterns", patterns: conflicting })];
        d.effects.disable = `removes ${conflicting.map((p) => p.value).join(", ")} from on.push.tags`;
      } else {
        removePush(d, t.tagsPair, "tags");
      }
      drafts.push(d);
    }
  } else if (t.tagsIgnorePair) {
    const ignore = t.tagsIgnore.map((p) => p.value);
    const firing = samples.filter((s) => !matchesFilter(ignore, s.tag));
    if (firing.length > 0) {
      const line = lineOf(
        workflow.text,
        (t.tagsIgnorePair.key as { range?: number[] }).range?.[0] ?? 0,
      );
      const d = base(line, `workflow trigger on.push.tags-ignore: ${ignore.join(", ")}`);
      d.evidence = [
        {
          path: workflow.path,
          line,
          note: `tags-ignore doesn't exclude ${firing.map((s) => s.tag).join(", ")}`,
        },
      ];
      removePush(d, t.tagsIgnorePair, "tags-ignore");
      drafts.push(d);
    }
  } else if (t.unfilteredPush && (publishes || workflow.jobs.some(tagGated))) {
    const line = lineOf(
      workflow.text,
      ((t.pushPair ?? t.pair)?.key as { range?: number[] } | undefined)?.range?.[0] ?? 0,
    );
    const d = base(line, "workflow trigger on: push (no branch or tag filter)");
    d.reasons = [
      publishes
        ? "runs on every push, including launchset's tags, and it publishes or deploys"
        : "runs on every push, including launchset's tags, and has jobs or steps that only run for tags",
    ];
    d.evidence = [
      { path: workflow.path, line, note: "push without filters runs for every pushed tag too" },
    ];
    const onValue = t.pair?.value;
    const supported =
      !isFlowMap(onValue) &&
      !isFlowMap(t.pushPair?.value) &&
      (isScalar(onValue) ||
        (isSeq(onValue) && onValue.items.every((i) => isScalar(i))) ||
        t.pushPair !== undefined);
    if (supported) {
      d.disable = [workflowEdit(workflow, { op: "exclude-tags" })];
      d.effects.disable =
        'adds branches: ["**"] and tags-ignore: ["**"] to the push trigger, so tags no longer start it';
    } else {
      d.why = "the triggers are written in flow style; edit them by hand";
    }
    drafts.push(d);
  }

  const release = t.release;
  if (
    release &&
    (release.types === null ||
      release.types.some((x) => ["published", "created", "released"].includes(x)))
  ) {
    const d = base(
      release.line,
      `workflow trigger on.release${release.types ? ` (types: ${release.types.join(", ")})` : ""}`,
    );
    d.kinds = ["release-trigger"];
    d.evidence = [
      {
        path: workflow.path,
        line: release.line,
        note: release.types ? `release types ${release.types.join(", ")}` : "every release event",
      },
    ];
    if (release.pair && !isFlowMap(t.pair?.value)) {
      d.disable = [workflowEdit(workflow, { op: "remove-trigger", pair: release.pair })];
      d.effects.disable =
        "removes the release trigger (workflow_dispatch replaces it when no other trigger is left)";
    } else {
      d.why = "the triggers are a list or flow style; edit them by hand";
    }
    drafts.push(d);
  }
  return drafts;
}

/** Lines of a run script that run one of the script files (handled by that file's item). */
function invokesScriptFile(command: string, scriptPaths: string[], wd: string): boolean {
  return scriptPaths.some((p) => runsFile(command, p, wd));
}

/**
 * Edits that take `commands` out of a step (all of them: the step goes), or `undefined`
 * when one of them can't be taken out safely.
 */
function commandEdits(
  workflow: Workflow,
  job: WorkflowJob,
  step: WorkflowStep,
  commands: RunCommand[],
  all: RunCommand[],
  reason: string,
): Edit[] | undefined {
  if (commands.length === all.length) {
    return [workflowEdit(workflow, { op: "remove-step", job, step })];
  }
  if (commands.some((c) => c.removal === null)) return undefined;
  const del = commands.filter((c) => c.removal === "delete");
  const neutral = commands.filter((c) => c.removal === "neutralize");
  const edits: Edit[] = [];
  if (del.length > 0)
    edits.push(workflowEdit(workflow, { op: "remove-commands", job, step, commands: del }));
  if (neutral.length > 0) {
    edits.push(
      workflowEdit(workflow, { op: "neutralize-commands", job, step, commands: neutral, reason }),
    );
  }
  return edits;
}

function commandEffect(edits: Edit[], step: WorkflowStep): string {
  const ops = edits.map((e) => (e.kind === "workflow" ? e.op.op : ""));
  if (ops.includes("remove-step")) return `removes ${step.label}`;
  const parts: string[] = [];
  if (ops.includes("remove-commands")) parts.push("removes the conflicting commands");
  if (ops.includes("neutralize-commands")) {
    parts.push(
      "turns the conflicting commands inside if/for/case or a chain into `:` no-ops with a `# launchset: disabled` comment",
    );
  }
  return `${parts.join(" and ")} from ${step.label}`;
}

/** Places outside `step` that use its outputs (`steps.<id>.…`). */
function stepReferences(workflow: Workflow, job: WorkflowJob, step: WorkflowStep): Evidence[] {
  if (!step.id) return [];
  const [start, end] = step.node.range ?? [0, 0];
  const [jobStart, jobEnd] = job.node.range ?? [0, workflow.text.length];
  const pattern = new RegExp(`\\bsteps\\.${escapeRegExp(step.id)}\\.`, "g");
  const found: Evidence[] = [];
  for (const m of workflow.text.matchAll(pattern)) {
    const at = m.index;
    if (at < jobStart || at >= jobEnd || (at >= start && at < end)) continue;
    found.push({
      path: workflow.path,
      line: lineOf(workflow.text, at),
      note: `uses steps.${step.id} outputs: check it once the step is gone`,
    });
  }
  return found;
}

function stepDrafts(workflow: Workflow, builds: DockerBuild[], scriptPaths: string[]): Draft[] {
  const drafts = new Map<WorkflowStep, Draft>();
  const draftFor = (job: WorkflowJob, step: WorkflowStep): Draft => {
    let d = drafts.get(step);
    if (!d) {
      d = {
        kinds: [],
        path: workflow.path,
        line: step.line,
        what: `${step.label} in job "${job.id}"`,
        disable: [],
        remove: [{ kind: "delete-file", path: workflow.path }],
        effects: { remove: "deletes the workflow file", keep: "leaves it as is" },
        evidence: [],
      };
      drafts.set(step, d);
    }
    return d;
  };
  const removeStep = (d: Draft, job: WorkflowJob, step: WorkflowStep) => {
    d.disable = [workflowEdit(workflow, { op: "remove-step", job, step })];
    d.effects.disable = `removes ${step.label} from job "${job.id}"`;
  };

  for (const job of workflow.jobs) {
    for (const step of job.steps) {
      const uses = step.uses?.replace(/@.*/, "");
      const script = step.with.get("script")?.value ?? "";
      const usesKind: MachineryKind | undefined =
        uses === "changesets/action"
          ? "changesets"
          : uses && RELEASE_TOOL_ACTIONS.test(uses)
            ? "release-tool"
            : (uses && RELEASE_ACTIONS.test(uses)) ||
                (uses === "actions/github-script" &&
                  /createRelease|createTag|refs\/tags\//.test(script))
              ? "tag-creation"
              : undefined;
      if (usesKind) {
        const d = draftFor(job, step);
        addKind(d, usesKind);
        d.evidence.push({ path: workflow.path, line: step.line, note: `uses ${uses}` });
        removeStep(d, job, step);
        continue;
      }
      if (!step.run) continue;
      const wd = step.workingDirectory ? normalizeRel(step.workingDirectory) : ".";
      const matched: RunCommand[] = [];
      const all = runCommands(step.run, workflow.text);
      const kindsFound: MachineryKind[] = [];
      for (const command of all) {
        if (invokesScriptFile(command.command, scriptPaths, wd)) continue;
        const kinds = commandKinds(command.command);
        if (kinds.length === 0) continue;
        const d = draftFor(job, step);
        for (const k of kinds) {
          addKind(d, k);
          if (!kindsFound.includes(k)) kindsFound.push(k);
        }
        d.evidence.push({
          path: workflow.path,
          line: command.lines[0]?.number ?? step.line,
          note: `runs \`${command.command.slice(0, 80)}\``,
        });
        matched.push(command);
      }
      if (matched.length > 0) {
        const d = draftFor(job, step);
        const edits = commandEdits(
          workflow,
          job,
          step,
          matched,
          all,
          SHORT[kindsFound[0] as MachineryKind],
        );
        if (edits) {
          d.disable = edits;
          d.effects.disable = commandEffect(edits, step);
        } else {
          d.disable = undefined;
          d.why =
            "a conflicting command is part of a heredoc or a compound line (if/case on one line); edit it by hand";
        }
      }
    }
  }

  // Docker latest on branch pushes.
  if (workflow.triggers.onBranchPush) {
    for (const build of builds) {
      if (!build.pushes) continue;
      const byStep = new Map<WorkflowStep, LatestRef[]>();
      for (const ref of build.latest) {
        const list = byStep.get(ref.step) ?? [];
        list.push(ref);
        byStep.set(ref.step, list);
      }
      for (const [step, refs] of byStep) {
        const d = draftFor(build.job, step);
        const hadDisable = (d.disable?.length ?? 0) > 0;
        addKind(d, "docker-latest");
        for (const ref of refs) {
          d.evidence.push({ path: workflow.path, line: ref.line, note: `pushes ${ref.entry}` });
        }
        if (hadDisable) {
          // Already removing the step (or commands); a latest edit on top would overlap.
          d.disable = undefined;
          d.why = "it both runs a release command and pushes latest; remove or edit it by hand";
          continue;
        }
        const runRefs = refs.filter((r) => r.run);
        if (runRefs.length > 0) {
          const noDisable = (why: string) => {
            d.disable = undefined;
            d.why = why;
          };
          if (runRefs.some((r) => !r.run?.removal)) {
            noDisable("the latest tag is part of a longer command that can't be edited safely");
            continue;
          }
          const all = step.run ? runCommands(step.run, workflow.text) : [];
          const commands = runRefs
            .filter((r) => r.run?.removal === "command")
            .map((r) => r.run?.command as RunCommand);
          if (commands.length > 0 && commands.length === all.length) {
            noDisable("pushing latest is all this step does; remove it or keep it");
            continue;
          }
          const commandOps =
            commands.length > 0
              ? commandEdits(workflow, build.job, step, commands, all, SHORT["docker-latest"])
              : [];
          if (commandOps === undefined) {
            noDisable(
              "the command that pushes latest can't be taken out safely (heredoc or compound line)",
            );
            continue;
          }
          d.disable = [
            ...commandOps,
            ...runRefs
              .filter((r) => r.run?.removal === "line")
              .map((r) =>
                workflowEdit(workflow, {
                  op: "remove-run-line",
                  job: build.job,
                  step,
                  line: r.run?.lineNumber as number,
                }),
              ),
          ];
        } else {
          // The only tag being latest would leave an empty tags input.
          const entries = new Map<unknown, number>();
          for (const r of refs.filter((x) => !x.flavor)) {
            entries.set(r.node, (entries.get(r.node) ?? 0) + 1);
          }
          const onlyLatest = [...entries].some(([node, count]) => {
            const value = String((node as { value?: unknown }).value ?? "");
            const total = value
              .split(/[\n,]/)
              .map((x) => x.trim())
              .filter((x) => x !== "" && !x.startsWith("#")).length;
            return total <= count;
          });
          if (onlyLatest) {
            d.disable = undefined;
            d.why =
              "latest is the only tag it pushes, so removing it would leave an empty tags input";
            continue;
          }
          d.disable = [workflowEdit(workflow, { op: "remove-latest", job: build.job, step, refs })];
        }
        d.effects.disable = `stops pushing latest from ${step.label}`;
      }
    }
  }
  for (const [step, d] of drafts) {
    d.line = Math.min(...d.evidence.map((e) => e.line ?? d.line));
    const removesStep = d.disable?.some((e) => e.kind === "workflow" && e.op.op === "remove-step");
    if (removesStep) {
      const job = workflow.jobs.find((j) => j.steps.includes(step)) as WorkflowJob;
      const refs = stepReferences(workflow, job, step);
      if (refs.length > 0) {
        d.evidence.push(...refs);
        d.effects.disable = `${d.effects.disable} (check ${refs.map((r) => `line ${r.line}`).join(", ")}: it uses the step's outputs)`;
      }
    }
  }
  return [...drafts.values()];
}

// ---------------------------------------------------------------------------
// GitLab

/** Reasons that differ on GitLab (no App token, GitLab releases). */
const GITLAB_REASON: Partial<Record<MachineryKind, string>> = {
  "tag-trigger":
    "runs again when launchset pushes its tags (with LAUNCHSET_TOKEN), so its build or publish steps run a second time",
  "tag-creation":
    "creates release tags or GitLab releases, which launchset's finalize creates (it would create v{version} before finalize)",
};
const GITLAB_RELEASE_COMMAND = /^glab\s+release\s+create\b|^release-cli\b.*\screate\b/;
const PACKAGE_PUBLISH_COMMAND =
  /^(?:npm|pnpm)\s+(?:-\S+\s+)*publish\b|^yarn\s+(?:npm\s+)?publish\b/;
/** Script lines that only print: a job left with them does nothing. */
const TRIVIAL_COMMAND = /^(?:echo|printf|true|:)(?:\s|$)/;

/** The machinery kinds of a GitLab script command ({@link commandKinds} plus GitLab's tools). */
export function gitlabCommandKinds(full: string): MachineryKind[] {
  const kinds = commandKinds(full);
  for (const { text } of simpleCommands(full)) {
    if (GITLAB_RELEASE_COMMAND.test(text) && !kinds.includes("tag-creation")) {
      kinds.push("tag-creation");
    }
    if (
      PACKAGE_PUBLISH_COMMAND.test(text) &&
      !NOT_PUBLISHING.test(text) &&
      !kinds.includes("changesets") &&
      !kinds.includes("package-publish")
    ) {
      kinds.push("package-publish");
    }
  }
  return kinds;
}

function gitlabEdit(file: { path: string; text: string }, op: GitLabOp): Edit {
  return { kind: "gitlab", path: file.path, text: file.text, op };
}

function singleLine(item: GitLabScriptItem, text: string): boolean {
  const [start, end] = item.ref.node.range ?? [0, 0];
  return !text.slice(start, end).includes("\n");
}

interface GitLabJobDraft {
  job: GitLabJob;
  draft: Draft;
  /** The disable is "remove the job" (switched to hiding it when its file would be empty). */
  removesJob: boolean;
}

function gitlabJobDraft(
  ci: GitLabCi,
  file: GitLabFile,
  job: GitLabJob,
  build: GitLabDockerBuild | undefined,
  gone: ReadonlySet<string> = new Set(),
): GitLabJobDraft | undefined {
  const kinds: MachineryKind[] = [];
  const evidence: Evidence[] = [];
  const add = (k: MachineryKind) => {
    if (!kinds.includes(k)) kinds.push(k);
  };
  const tagged = !job.hidden && runsOnTags(ci, job);
  if (tagged) {
    add("tag-trigger");
    evidence.push({
      path: file.path,
      line: job.line,
      note: `job "${job.name}" runs on tag pipelines`,
    });
  }
  const matched = new Map<GitLabScriptItem, RunCommand[]>();
  for (const script of job.scripts) {
    for (const item of script.items) {
      for (const command of item.commands) {
        const found = gitlabCommandKinds(command.command);
        if (found.length === 0) continue;
        for (const k of found) add(k);
        evidence.push({
          path: file.path,
          line: command.lines[0]?.number ?? item.ref.line,
          note: `runs \`${command.command.slice(0, 80)}\``,
        });
        matched.set(item, [...(matched.get(item) ?? []), command]);
      }
    }
  }
  const releasePair = pairOf(job.map, "release");
  if (releasePair) {
    add("tag-creation");
    evidence.push({
      path: file.path,
      line: lineOf(file.text, (releasePair.key as { range?: number[] }).range?.[0] ?? 0),
      note: "the release: keyword creates a GitLab release",
    });
  }
  const latest = build?.pushes && build.onBranch ? build.latest : [];
  if (latest.length > 0) {
    add("docker-latest");
    for (const ref of latest) {
      evidence.push({ path: file.path, line: ref.line, note: `pushes ${ref.entry}` });
    }
  }
  if (kinds.length === 0) return undefined;

  // References from jobs this run removes too (by default) don't block removing this one.
  const referencing = referencingJobs(ci, job);
  const refs = referencing.filter((r) => !gone.has(r.job)).map((r) => r.why);
  const waived = [...new Set(referencing.filter((r) => gone.has(r.job)).map((r) => r.job))];
  const removable = !job.hidden && !job.anchored && refs.length === 0;
  for (const r of referencing) evidence.push({ path: file.path, line: job.line, note: r.why });
  const label = job.hidden ? `GitLab template "${job.name}"` : `GitLab job "${job.name}"`;
  const draft: Draft = {
    kinds,
    path: file.path,
    line: Math.min(...evidence.map((e) => e.line ?? job.line)),
    what: tagged ? `GitLab job "${job.name}" (runs on tags)` : label,
    remove: [],
    effects: { keep: "leaves it as is" },
    evidence,
    reasons: kinds.map((k) => GITLAB_REASON[k] ?? REASON[k]),
    gitlabJob: job.name,
  };
  const result: GitLabJobDraft = { job, draft, removesJob: false };
  const noDisable = (why: string) => {
    draft.why = why;
    return result;
  };
  const removeJob = () => {
    draft.disable = [gitlabEdit(file, { op: "remove-job", job })];
    draft.effects.disable = `removes the job "${job.name}"`;
    if (waived.length > 0) {
      draft.requires = waived;
      draft.effects.disable += ` (together with ${waived.map((w) => `job "${w}"`).join(" and ")}, which ${waived.length === 1 ? "needs" : "need"} it: only when ${waived.length === 1 ? "that one is" : "those are"} disabled too)`;
    }
    result.removesJob = true;
    return result;
  };
  const blocker = refs[0] ?? (job.anchored ? "it has a YAML anchor others may use" : undefined);
  if (tagged) {
    // Other rules start it too (a manual trial build, branch pushes): only the tag rules go.
    const edit = tagRuleEdit(job, ci.releaseTags);
    if (edit) {
      const entries = edit.items.map((item) => {
        const value = (item as { toJSON(): unknown }).toJSON();
        return edit.key === "only"
          ? String(value)
          : `- if: ${String((value as Record<string, unknown>).if)}`;
      });
      draft.disable = [
        gitlabEdit(file, { op: "remove-seq-items", seq: edit.seq, items: edit.items }),
      ];
      draft.effects.disable = `removes its tag ${edit.items.length === 1 ? "rule" : "rules"} (${entries.join(", ")}${edit.key === "only" ? " in only:" : ""}) from job "${job.name}"; it keeps its other ${edit.others.length === 1 ? "rule" : "rules"} (${edit.others.join("; ")})`;
      return result;
    }
    if (removable) return removeJob();
    return noDisable(
      `${blocker ?? "it is a template"}, so it can't simply be removed; edit it by hand`,
    );
  }

  // Lines to comment out (plain items), commands to disable inside block scalars.
  const commented = new Set<GitLabScriptItem>();
  const inBlock = new Map<GitLabScriptItem, RunCommand[]>();
  const fully = (item: GitLabScriptItem) =>
    (matched.get(item)?.length ?? 0) === item.commands.length;
  const takeOut = (item: GitLabScriptItem, commands: RunCommand[]): string | undefined => {
    if (!isBlock(item.ref.node)) {
      if (commands.length < item.commands.length) {
        return "a conflicting command shares its script line with other commands; edit it by hand";
      }
      commented.add(item);
      return undefined;
    }
    if (commands.some((c) => c.removal === null)) {
      return "a conflicting command is part of a heredoc or a compound line (if/case on one line); edit it by hand";
    }
    const list = inBlock.get(item) ?? [];
    for (const c of commands) if (!list.includes(c)) list.push(c);
    inBlock.set(item, list);
    return undefined;
  };
  for (const [item, commands] of matched) {
    const why = takeOut(item, commands);
    if (why) return noDisable(why);
  }
  const flags: GitLabLatestRef[] = [];
  for (const ref of latest) {
    if (commented.has(ref.item)) continue;
    if (ref.removal === "command") {
      const why = takeOut(ref.item, [ref.command]);
      if (why) return noDisable(why);
    } else if (
      ref.removal === "flag" &&
      latestFlagRange(file.text, ref.item.ref.node, ref.entry) !== undefined
    ) {
      flags.push(ref);
    } else {
      return noDisable("the latest tag is part of a longer command that can't be edited safely");
    }
  }
  const script = job.scripts.find((s) => s.key === "script");
  const scriptDone =
    script !== undefined &&
    script.others === 0 &&
    script.items.every(
      (i) =>
        fully(i) ||
        commented.has(i) ||
        (releasePair !== undefined &&
          i.commands.every((c) => TRIVIAL_COMMAND.test(c.command.trim()))),
    );
  if (removable && scriptDone && (matched.size > 0 || releasePair)) return removeJob();

  const ops: GitLabOp[] = [];
  const parts: string[] = [];
  const reason = SHORT[kinds.find((k) => k !== "tag-trigger") ?? (kinds[0] as MachineryKind)];
  for (const s of job.scripts) {
    const gone = s.items.filter((i) => commented.has(i));
    if (gone.length === 0) continue;
    if (s.flow) return noDisable("the script is written in flow style ([a, b]); edit it by hand");
    const left = s.items.length - gone.length + s.others;
    gone.forEach((item, index) => {
      // A script can't be empty: the last line left becomes the no-op `:`.
      const noop = left === 0 && index === 0;
      ops.push({
        op: noop ? "noop-item" : "comment-item",
        item,
        inSeq: s.seq !== undefined,
        reason,
      });
    });
    if (s.seq === undefined && !singleLine(gone[0] as GitLabScriptItem, file.text)) {
      return noDisable("the script is one multi-line string; edit it by hand");
    }
    parts.push(
      left === 0
        ? `turns ${s.key} into the no-op ":" (# launchset: disabled — …)`
        : `comments out the conflicting ${s.key} ${gone.length === 1 ? "line" : "lines"} (# launchset: disabled — …)`,
    );
  }
  for (const [item, commands] of inBlock) ops.push({ op: "commands", item, commands, reason });
  if (inBlock.size > 0) {
    parts.push("disables the conflicting commands in its script (# launchset: disabled — …)");
  }
  for (const ref of flags) ops.push({ op: "remove-flag", item: ref.item, entry: ref.entry });
  if (flags.length > 0) parts.push("stops tagging latest");
  if (releasePair) {
    if ((job.map as { flow?: boolean }).flow) {
      return noDisable("the job is written in flow style ({ ... }); edit it by hand");
    }
    ops.push({ op: "remove-pair", pair: releasePair });
    parts.push("removes its release: keyword");
  }
  if (ops.length === 0) return noDisable("nothing in it can be taken out on its own");
  draft.disable = ops.map((op) => gitlabEdit(file, op));
  draft.effects.disable = `${parts.join(", ")} in ${job.hidden ? "template" : "job"} "${job.name}"`;
  return result;
}

function gitlabDrafts(ci: GitLabCi, builds: readonly GitLabDockerBuild[]): Draft[] {
  const draftAll = (gone: ReadonlySet<string>) => {
    const byFile = new Map<GitLabFile, GitLabJobDraft[]>();
    for (const file of ci.files) {
      const list: GitLabJobDraft[] = [];
      for (const job of file.jobs) {
        if (ci.jobs.get(job.name) !== job || usersOf(ci, job).length === 0) continue;
        const d = gitlabJobDraft(
          ci,
          file,
          job,
          builds.find((b) => b.job === job),
          gone,
        );
        if (d) list.push(d);
      }
      byFile.set(file, list);
    }
    return byFile;
  };
  // The jobs this run removes by default, to a fixed point: a job only other removed jobs need
  // can go too (site:release needs package:windows; both on tags only: both go).
  let gone = new Set<string>();
  let byFile = draftAll(gone);
  for (;;) {
    const next = new Set(
      [...byFile.values()]
        .flat()
        .filter((d) => d.removesJob)
        .map((d) => d.job.name),
    );
    if ([...next].every((name) => gone.has(name))) break;
    gone = next;
    byFile = draftAll(gone);
  }
  const drafts: Draft[] = [];
  for (const [file, list] of byFile) {
    const jobNames = new Set(file.jobs.map((j) => j.name));
    const everyKey = (test: (job: GitLabJob) => boolean) =>
      file.root.items.length > 0 &&
      file.root.items.every((pair) => {
        const job = file.jobs.find((j) => j.pair === pair);
        return job !== undefined && test(job);
      });
    const draftOf = (job: GitLabJob) => list.find((d) => d.job === job);
    // An included file can't be left empty (GitLab rejects it): jobs are hidden instead.
    if (file.includedBy && everyKey((j) => draftOf(j)?.removesJob === true)) {
      for (const d of list) {
        d.draft.disable = [gitlabEdit(file, { op: "hide-job", job: d.job })];
        d.draft.effects.disable = `hides the job "${d.job.name}" (renamed to ".${d.job.name}", GitLab's way to turn a job off; removing every job would leave ${file.path} empty, which GitLab rejects)`;
      }
    }
    // A file that is all machinery can go, with its include entry.
    const includedBy = file.includedBy;
    const usedOutside = file.jobs.some((j) =>
      referencesTo(ci, j).some((r) => {
        const other = /^job "([^"]+)"/.exec(r)?.[1];
        return other !== undefined && !jobNames.has(other);
      }),
    );
    if (includedBy && !usedOutside && everyKey((j) => draftOf(j) !== undefined)) {
      const parent = ci.files.find((f) => f.path === includedBy.path);
      for (const d of list) {
        d.draft.remove = [
          { kind: "delete-file", path: file.path },
          ...(parent
            ? [gitlabEdit(parent, { op: "remove-include", include: includedBy.include })]
            : []),
        ];
        d.draft.effects.remove = `deletes ${file.path} (everything in it conflicts) and its include in ${includedBy.path}`;
      }
    }
    drafts.push(...list.map((d) => d.draft));
  }
  return drafts;
}

// ---------------------------------------------------------------------------
// package.json scripts and script files

/** `&&`-separated parts of a script command. */
export function scriptSegments(command: string): string[] {
  return command.split(/\s*&&\s*/).filter((s) => s.trim() !== "");
}

function referencesFile(segment: string, file: string, packageDir: string): boolean {
  if (packageDir !== "." && !file.startsWith(`${packageDir}/`)) return false;
  return runsFile(segment, file, packageDir);
}

function scriptDrafts(pkg: PackageScripts, scriptPaths: string[]): Draft[] {
  const drafts: Draft[] = [];
  for (const [name, command] of Object.entries(pkg.scripts)) {
    const segments = scriptSegments(command);
    const matched: string[] = [];
    const kinds: MachineryKind[] = [];
    for (const segment of segments) {
      if (scriptPaths.some((p) => referencesFile(segment, p, pkg.dir))) continue;
      const found = commandKinds(segment);
      if (/@changesets\/write/.test(segment)) found.push("changesets-write");
      if (found.length === 0) continue;
      matched.push(segment);
      for (const k of found) if (!kinds.includes(k)) kinds.push(k);
    }
    if (matched.length === 0) continue;
    const line = pkg.lines[name] ?? 1;
    const everything = matched.length === segments.length;
    drafts.push({
      kinds,
      path: pkg.path,
      line,
      what: `script "${name}": ${command}`,
      disable: [
        everything
          ? { kind: "script", path: pkg.path, script: name }
          : { kind: "script", path: pkg.path, script: name, segments: matched },
      ],
      remove: [{ kind: "script", path: pkg.path, script: name }],
      effects: {
        disable: everything
          ? `removes the script "${name}"`
          : `removes ${matched.map((m) => `\`${m}\``).join(", ")} from the script "${name}"`,
        remove: `removes the script "${name}"`,
        keep: "leaves it as is",
      },
      evidence: [
        { path: pkg.path, line, note: `script "${name}" runs \`${matched.join(" && ")}\`` },
      ],
    });
  }
  return drafts;
}

/** Shell commands that only read, print or set up: they don't make a script more than machinery. */
const SETUP_COMMAND =
  /^(?:set|shopt|cd|pushd|popd|echo|printf|export|readonly|local|declare|typeset|exit|return|true|false|:|shift|trap|source|\.|test|\[\[?|\]\]?|unset|wait|sleep|logger|fi|done|esac|for|case|in|function|cat|grep|egrep|awk|cut|tr|head|tail|sort|uniq|wc|date|jq|yq|basename|dirname|realpath|printenv|mkdir|node\s+-p|git\s+(?:describe|rev-parse|log|fetch|config|status|diff|show|ls-remote|tag\s+(?:-l|--list|--points-at|--contains|--merged)))(?:\s|$)/;
/** A shell function definition line (`release() {`, `function release {`). */
const FUNCTION_LINE = /^\s*(?:function\s+[\w-]+(?:\s*\(\))?|[\w-]+\s*\(\))\s*\{?\s*$/;

/** True when a shell command is only setup (see {@link SETUP_COMMAND}). */
function setupOnly(command: RunCommand): boolean {
  if (command.lines.length === 1 && FUNCTION_LINE.test(command.command)) return true;
  return simpleCommands(command.command).every(
    (c) => SETUP_COMMAND.test(c.text) || (c.words.length === 1 && /[*?|]|\)$/.test(c.text)),
  );
}

/** A script file named for release machinery (`release.sh`, `sync-version.mjs`, `tag.js`). */
const MACHINERY_NAME =
  /(?:^|[-_.])(?:release|version|versions|bump|tag|tags|changeset|changesets)(?:[-_.]|$)/i;

function scriptFileDraft(
  file: { path: string; text: string },
  input: MachineryInput,
): Draft | undefined {
  const scan = scanScriptFile(file.text, file.path);
  const { kinds, line } = scan;
  if (kinds.length === 0) return undefined;
  const references: Edit[] = [];
  let unsafe = false;
  const evidence: Evidence[] = [{ path: file.path, line, note: "the script itself" }];
  for (const pkg of input.packages) {
    for (const [name, command] of Object.entries(pkg.scripts)) {
      const segments = scriptSegments(command);
      const hits = segments.filter((s) => referencesFile(s, file.path, pkg.dir));
      if (hits.length === 0) continue;
      references.push(
        hits.length === segments.length
          ? { kind: "script", path: pkg.path, script: name }
          : { kind: "script", path: pkg.path, script: name, segments: hits },
      );
      evidence.push({
        path: pkg.path,
        line: pkg.lines[name] ?? 1,
        note: `script "${name}" runs it`,
      });
    }
  }
  for (const workflow of input.workflows) {
    for (const job of workflow.jobs) {
      for (const step of job.steps) {
        if (!step.run) continue;
        const wd = step.workingDirectory ? normalizeRel(step.workingDirectory) : ".";
        const all = runCommands(step.run, workflow.text);
        const hits = all.filter((c) => invokesScriptFile(c.command, [file.path], wd));
        if (hits.length === 0) continue;
        const edits = commandEdits(
          workflow,
          job,
          step,
          hits,
          all,
          SHORT[kinds[0] as MachineryKind],
        );
        if (edits) references.push(...edits);
        else unsafe = true;
        evidence.push({
          path: workflow.path,
          line: hits[0]?.lines[0]?.number ?? step.line,
          note: `${step.label} runs it`,
        });
      }
    }
  }
  const draft: Draft = {
    kinds,
    path: file.path,
    line,
    what: `script file ${file.path}`,
    remove: [{ kind: "delete-file", path: file.path }, ...references],
    effects: {
      remove:
        references.length > 0
          ? `deletes ${file.path} and the ${references.length === 1 ? "place that runs" : "places that run"} it`
          : `deletes ${file.path}`,
      keep: "leaves it as is",
    },
    evidence,
  };
  const reason = SHORT[kinds[0] as MachineryKind];
  // Stopping the script only when release machinery is all it does: otherwise its other work
  // (a build, a deploy) would quietly stop too.
  const onlyMachinery =
    scan.language === "shell"
      ? scan.commands.every((c) => scan.matched.includes(c) || setupOnly(c))
      : MACHINERY_NAME.test(file.path.replace(/^.*\//, "").replace(/\.[^.]+$/, ""));
  if (!onlyMachinery) {
    if (scan.language === "shell" && scan.matched.every((c) => c.removal !== null)) {
      const neutral = scan.matched.filter((c) => c.removal === "neutralize");
      draft.disable = [
        {
          kind: "comment-lines",
          path: file.path,
          lines: scan.matched.flatMap((c) => c.lines.map((l) => l.number)),
          reason,
          ...(neutral.length > 0
            ? {
                noops: neutral.map((c) => ({
                  line: c.lines[0]?.number as number,
                  ...(c.trailingOp ? { trailingOp: c.trailingOp } : {}),
                })),
              }
            : {}),
        },
      ];
      draft.effects.disable = `comments out the conflicting ${scan.lines.length === 1 ? "line" : "lines"} in ${file.path} (# launchset: disabled — …); the rest of the script still runs`;
    } else {
      draft.why =
        scan.language === "shell"
          ? "a conflicting command is part of a heredoc or a compound line, and the script does more than that; edit it by hand"
          : "the script does more than release machinery, so it can't simply stop running; edit the conflicting lines by hand";
    }
  } else if (unsafe) {
    draft.why = "a workflow runs it inside a heredoc or a compound line; edit that by hand";
  } else if (references.length > 0) {
    draft.disable = references;
    draft.effects.disable = `stops running it (${evidence
      .filter((e) => e.path !== file.path)
      .map((e) => `${e.path}:${e.line}`)
      .join(", ")}); the file stays`;
  } else {
    draft.why = "nothing in package.json or the workflows runs it, so there is nothing to disable";
  }
  return draft;
}

/** A Ruby line that continues on the next one. */
const RUBY_CONTINUES = /(?:\\|,|\(|\[|\{|\+|&&|\|\|)\s*$/;
/** A Ruby line that opens a block. */
const RUBY_BLOCK = /\bdo(?:\s*\|[^|]*\|)?\s*$/;

function fastfileDraft(file: { path: string; text: string }): Draft | undefined {
  const lines = linesOf(file.text);
  const hits = lines.filter((l) => FASTLANE_WRITERS.test(l.text) && !/LAUNCHSET_/.test(l.text));
  if (hits.length === 0) return undefined;
  const safe = hits.every((l) => {
    const open = (l.text.match(/[([{]/g) ?? []).length;
    const close = (l.text.match(/[)\]}]/g) ?? []).length;
    const prev = lines
      .slice(0, l.number - 1)
      .reverse()
      .find((p) => p.text.trim() !== "" && !p.text.trim().startsWith("#"));
    return (
      open === close &&
      !RUBY_CONTINUES.test(l.text) &&
      !RUBY_BLOCK.test(l.text) &&
      !(prev && RUBY_CONTINUES.test(prev.text))
    );
  });
  const draft: Draft = {
    kinds: ["version-writer"],
    path: file.path,
    line: hits[0]?.number ?? 1,
    what: `fastlane version actions in ${file.path}`,
    remove: [],
    effects: { keep: "leaves it as is" },
    evidence: hits.map((l) => ({ path: file.path, line: l.number, note: l.text.trim() })),
  };
  if (safe) {
    draft.disable = [
      {
        kind: "comment-lines",
        path: file.path,
        lines: hits.map((l) => l.number),
        reason: SHORT["version-writer"],
      },
    ];
    draft.effects.disable = `comments out ${hits.length === 1 ? "that line" : "those lines"} (# launchset: disabled — …)`;
  } else {
    draft.why = "a call spans several lines; edit it by hand";
  }
  return draft;
}

const AGENTS_START = "<!-- launchset:start -->";
const AGENTS_END = "<!-- launchset:end -->";

function docsDraft(file: { path: string; text: string }): Draft | undefined {
  let inside = false;
  const hits: { number: number; text: string }[] = [];
  for (const line of linesOf(file.text)) {
    if (line.text.includes(AGENTS_START)) inside = true;
    if (line.text.includes(AGENTS_END)) {
      inside = false;
      continue;
    }
    if (inside) continue;
    if (DOC_LINES.test(line.text) && !/launchset/i.test(line.text)) hits.push(line);
  }
  if (hits.length === 0) return undefined;
  return {
    kinds: ["release-docs"],
    path: file.path,
    line: hits[0]?.number ?? 1,
    what: `release instructions in ${file.path}`,
    remove: [],
    effects: { keep: "left as is: update these instructions by hand" },
    evidence: hits
      .slice(0, 10)
      .map((l) => ({ path: file.path, line: l.number, note: l.text.trim() })),
    why: "prose can't be edited automatically",
  };
}

// ---------------------------------------------------------------------------

/** Every conflicting piece of machinery, numbered per file. */
export function detectMachinery(input: MachineryInput): MachineryFinding[] {
  const samples = input.samples ?? DEFAULT_SAMPLES;
  const scriptItems = input.scriptFiles
    .map((f) => scriptFileDraft(f, input))
    .filter((d): d is Draft => d !== undefined);
  const scriptPaths = scriptItems.map((d) => d.path);
  const drafts: Draft[] = [];
  for (const workflow of input.workflows) {
    const builds = input.dockerBuilds.filter((b) => b.workflow === workflow);
    drafts.push(...triggerDrafts(workflow, samples, publishesOrDeploys(workflow, builds)));
    drafts.push(...stepDrafts(workflow, builds, scriptPaths));
  }
  const gitlab = input.gitlabCi ?? (input.gitlab ? gitlabCiOf([input.gitlab]) : undefined);
  if (gitlab) {
    const builds = input.gitlabBuilds ?? gitlabDockerBuilds(gitlab, { gitTagPrefix: "v" });
    drafts.push(...gitlabDrafts(gitlab, builds));
  }
  for (const pkg of input.packages) drafts.push(...scriptDrafts(pkg, scriptPaths));
  drafts.push(...scriptItems);
  for (const f of input.fastfiles) {
    const d = fastfileDraft(f);
    if (d) drafts.push(d);
  }
  for (const f of input.docs) {
    const d = docsDraft(f);
    if (d) drafts.push(d);
  }

  const byPath = new Map<string, Draft[]>();
  for (const d of drafts) {
    const list = byPath.get(d.path) ?? [];
    list.push(d);
    byPath.set(d.path, list);
  }
  const findings: MachineryFinding[] = [];
  const idOfJob = new Map<string, string>();
  const requiresOf = new Map<MachineryItem, string[]>();
  for (const [path, list] of [...byPath].sort(([a], [b]) => a.localeCompare(b))) {
    list.sort((a, b) => a.line - b.line);
    list.forEach((d, index) => {
      const actions: MachineryAction[] = [];
      if (d.remove.length > 0) actions.push("remove");
      if (d.disable && d.disable.length > 0) actions.push("disable");
      actions.push("keep");
      const effects = { ...d.effects };
      if (!actions.includes("disable")) {
        delete effects.disable;
        if (d.why) effects.keep = `${effects.keep ?? "leaves it as is"} (no disable: ${d.why})`;
      }
      const item: MachineryItem = {
        id: `machinery.${path}#${index + 1}`,
        kinds: d.kinds,
        path,
        line: d.line,
        what: d.what,
        reasons: d.reasons ?? d.kinds.map((k) => REASON[k]),
        actions,
        effects,
        evidence: d.evidence,
      };
      const edits: MachineryFinding["edits"] = {};
      if (actions.includes("remove")) edits.remove = d.remove;
      if (d.disable && d.disable.length > 0) edits.disable = d.disable;
      if (d.gitlabJob) idOfJob.set(d.gitlabJob, item.id);
      if (d.requires) requiresOf.set(item, d.requires);
      findings.push({ item, edits });
    });
  }
  for (const [item, jobs] of requiresOf) {
    const ids = jobs.map((j) => idOfJob.get(j)).filter((id): id is string => id !== undefined);
    if (ids.length > 0) item.requires = ids;
  }
  return findings;
}

/** Script file paths referenced from package.json scripts or workflow `run` lines. */
export function referencedScriptFiles(packages: PackageScripts[], workflows: Workflow[]): string[] {
  const found = new Set<string>();
  const pattern =
    /(?:^|[\s"'=])((?:\.\/)?[\w@./-]+\.(?:mjs|cjs|js|ts|mts|cts|sh|bash|rb|py))(?=$|[\s"';&|)])/g;
  for (const pkg of packages) {
    for (const command of Object.values(pkg.scripts)) {
      for (const m of command.matchAll(pattern)) {
        const p = normalizeRel(m[1] as string);
        if (!p.startsWith("node_modules/") && !p.includes("/node_modules/"))
          found.add(joinRel(pkg.dir, p));
      }
    }
  }
  for (const workflow of workflows) {
    for (const job of workflow.jobs) {
      for (const step of job.steps) {
        if (!step.run) continue;
        const wd = step.workingDirectory ? normalizeRel(step.workingDirectory) : ".";
        for (const m of step.run.value.matchAll(pattern)) {
          const p = normalizeRel(m[1] as string);
          if (!p.includes("node_modules/")) found.add(joinRel(wd, p));
        }
      }
    }
  }
  return [...found].sort();
}
