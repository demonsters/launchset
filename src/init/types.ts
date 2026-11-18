/**
 * Public types of `launchset init` (spec 11.1). The `--detect --json` output is
 * {@link InitDetectJson}; the docs and the adoption skill (spec 16.3) describe that shape,
 * so change it only deliberately (bump `schemaVersion` on breaking changes).
 */

import type { FoundValue } from "../platforms/types.ts";

/** Where a finding or a default comes from. `path` is repo-relative POSIX. */
export interface Evidence {
  path: string;
  /** 1-based line, when the finding is on one line. */
  line?: number;
  note: string;
}

// ---------------------------------------------------------------------------
// Detection (steps 1–3)

/** A version found in a file or a tag (step 2: "show every version found"). */
export interface FoundVersion {
  /** `root`: the root package.json; `docker-package`: a package.json next to a Dockerfile. */
  source: "root" | "docker-package" | "native" | "tag";
  /** File path, or the tag name for `source: "tag"`. */
  path: string;
  line?: number;
  /** Field, e.g. `version`, `versionName`, `MARKETING_VERSION (App, Release)`, or the tag format. */
  key: string;
  /** The value as written. */
  value: string;
  /** The value as a plain `X.Y.Z` (`1.0` → `1.0.0`); `null` when it isn't one (prereleases too). */
  plain: string | null;
  /** Set when the value is shown but not used for the canonical version (and why). */
  ignored?: string;
}

/** A git tag that looks like a version: `v1.2.3`, `1.2.3` or `name@1.2.3` (prereleases too). */
export interface FoundTag {
  tag: string;
  version: string;
  /** The tag's format as a template: `v{version}`, `{version}` or `<name>@{version}`. */
  format: string;
  prerelease: boolean;
  /** For `name@1.2.3` tags: the package name. */
  package?: string;
  /**
   * False for `name@…` tags of packages that aren't this repo's root package or a target's
   * package (other workspace packages): they're listed but never decide the version.
   */
  counted: boolean;
}

export type DetectedPlatform = "docker" | "android" | "ios" | "web";

/** A file a target stamps, with the values found in it. */
export interface DetectedFile {
  path: string;
  values: FoundValue[];
}

export interface DetectedDocker {
  /** Dockerfile path. */
  dockerfile: string;
  /** Build context directory (`.` for the repo root). */
  context: string;
  /** Image name read from an existing workflow, if any (the first of `images`). */
  image?: string;
  /** Every image name the workflow pushes (several registries). */
  images?: string[];
  /** Release tag templates read from an existing workflow, if any (e.g. `["v{version}", "latest"]`). */
  tags?: string[];
  /** `platforms` input of an existing `docker/build-push-action` step. */
  platforms?: string;
  /** A `package.json` next to the Dockerfile (not the root one): stamped with the version. */
  packageJson?: string;
  evidence: Evidence[];
}

/** A platform init can turn into a target. */
export interface DetectedTarget {
  /** Proposed target name (also used in decision ids). */
  name: string;
  type: DetectedPlatform;
  /** Directory the platform lives in (`.` for the root). */
  dir: string;
  /** `source` for android/ios targets, in config form. */
  source?: Record<string, unknown>;
  /** Files with marketing versions / build numbers (empty for docker and web). */
  files: DetectedFile[];
  /** Highest marketing version found in the files, as written. */
  marketingVersion?: string;
  /** Highest integer build number found in the files. */
  buildNumber?: number;
  /** Existing workflow steps that build this platform. */
  builtBy: Evidence[];
  /** Proposed `release` (`none`: not a target). */
  proposed: "auto" | "manual" | "none";
  /** Why `proposed` was chosen. */
  reason: string;
  /** True when `proposed` is a guess the human should confirm. */
  ask?: boolean;
  docker?: DetectedDocker;
}

export type MachineryKind =
  | "tag-trigger"
  | "release-trigger"
  | "release-tool"
  | "changesets"
  | "tag-creation"
  | "docker-latest"
  | "version-writer"
  | "changesets-write"
  | "release-docs";

export type MachineryAction = "remove" | "disable" | "keep";

/** A piece of existing release machinery that conflicts with launchset (step 1, step 4). */
export interface MachineryItem {
  /** Decision id: `machinery.<path>#<n>`, n counting items in that file from 1. */
  id: string;
  kinds: MachineryKind[];
  path: string;
  line: number;
  /** What it is, e.g. `workflow trigger on.push.tags: v*` or `step "Release" (changesets/action)`. */
  what: string;
  /** Why it conflicts, one sentence per kind. */
  reasons: string[];
  /** Allowed actions; `disable` is missing when no minimal edit exists. */
  actions: MachineryAction[];
  /** What each action changes, e.g. `{ disable: "removes the tags trigger" }`. */
  effects: Partial<Record<MachineryAction, string>>;
  evidence: Evidence[];
}

/** A deploy manifest pinning a docker target's image (offered as a `kind: "image"` entry). */
export interface ImagePin {
  path: string;
  /** Target whose image the file references. */
  target: string;
  image: string;
  refs: { line: number; tag: string }[];
}

export interface DetectedHook {
  tool: "husky" | "simple-git-hooks" | "lefthook";
  /** The file init would edit (or create, for husky). */
  path: string;
  /** True when the pre-push hook already runs `launchset check --push`. */
  installed: boolean;
}

export interface Note {
  level: "info" | "warning";
  message: string;
  /** Also listed in the manual steps after writing. */
  manual?: boolean;
  path?: string;
  line?: number;
}

export interface Detection {
  /** Absolute path of the repo (the init working directory). */
  root: string;
  git: {
    repo: boolean;
    /** HEAD commit, when there is one. */
    head?: string;
    branch?: string;
    /** `owner/repo` from the `origin` remote, when it's GitHub. */
    github?: string;
  };
  /** An existing `launchset.config.*`: init won't overwrite it. */
  existingConfig?: string;
  /** The root package.json (`version` may be missing). */
  packageJson?: { path: string; name?: string; version?: string; line?: number };
  /** Workspace package directories (from `workspaces` / `pnpm-workspace.yaml`). */
  workspaces: string[];
  versions: FoundVersion[];
  tags: FoundTag[];
  /** Proposed canonical version and why. */
  canonical: { version: string; reason: string; evidence: Evidence[] };
  targets: DetectedTarget[];
  /** Existing CI workflow files and what they build. */
  workflows: {
    path: string;
    builds: { platform: DetectedPlatform; line: number; note: string }[];
  }[];
  machinery: MachineryItem[];
  imagePins: ImagePin[];
  buildNumbers: {
    /** Highest build number found in the files, with where. */
    highest?: { value: number; path: string; line: number; key: string };
    /** The `timestamp` strategy's value now (without offset). */
    strategyNow: number;
    /** Proposed `buildNumber.offset` (0 when none is needed). */
    offset: number;
  };
  /** Files init writes that already exist (`.launchset/README.md`, `launchset-*.yml`). */
  existingFiles: string[];
  /** Changesets files to convert (step 6). */
  changesets: { files: string[]; preMode: boolean };
  hooks: DetectedHook[];
  notes: Note[];
}

// ---------------------------------------------------------------------------
// Decisions

export interface DecisionOption {
  value: string;
  label: string;
}

/**
 * A question init answers with its default unless told otherwise
 * (`--decide <id>=<value>`, a named flag, or an interactive answer).
 */
export interface Decision {
  id: string;
  question: string;
  /** Suggested values. With `freeform`, other values are accepted too. */
  options: DecisionOption[];
  /** Set when any value of this form is accepted, e.g. "a plain X.Y.Z version". */
  freeform?: string;
  default: string;
  /** What the default is based on. */
  evidence: Evidence[];
  /** True when the default is a guess or a risky choice: ask the human. */
  ask: boolean;
  /** The decision only matters when decision `id` has one of `values`. */
  onlyIf?: { id: string; values: string[] };
}

/** Output of `launchset init --detect --json`. */
export interface InitDetectJson {
  schemaVersion: 1;
  detection: Detection;
  decisions: Decision[];
}

// ---------------------------------------------------------------------------
// Running

/** Asks one decision interactively; returns the chosen value. */
export interface Prompter {
  /** `validate` returns an error message for an invalid value (for free-form answers). */
  ask(decision: Decision, validate?: (value: string) => string | undefined): Promise<string>;
  /** Shows a block of text (findings, the change list). */
  note?(message: string, title?: string): void;
}

/** Where init prints. Deep functions never print; they return lines. */
export interface InitOutput {
  log(line: string): void;
  warn(line: string): void;
  /** Prints the JSON result (only in `--json` mode). */
  json(value: unknown): void;
}

export interface InitOptions {
  cwd: string;
  /** Accept defaults for every decision not given. */
  yes: boolean;
  /** `--decide id=value` answers. */
  decide: Record<string, string>;
  /** Detection only: write nothing. */
  detect: boolean;
  json: boolean;
  /** Only convert `.changeset/*.md` (step 6). */
  convertOnly: boolean;
  /** `--baseline` / `--no-baseline`. */
  baseline?: boolean;
  /** `--skill` / `--no-skill`. */
  skill?: boolean;
  /** `--hook` / `--no-hook`. */
  hook?: boolean;
  /** Ask questions (stdin is a TTY and neither `--yes` nor `--detect` is given). */
  interactive: boolean;
  prompter?: Prompter;
  output?: InitOutput;
  /** Clock for build-number offsets (tests). */
  now?: Date;
  /** Action reference for the workflows (default `demonsters/launchset-action@v1`). */
  actionRef?: string;
}

export type ChangeAction = "created" | "updated" | "deleted" | "tagged";

/** One thing init changed. */
export interface Change {
  path: string;
  action: ChangeAction;
  summary: string;
}

export interface InitResult {
  mode: "detect" | "write" | "convert-only";
  /** Set in detect mode. */
  detect?: InitDetectJson;
  /** Final answer per decision id (write mode). */
  answers: Record<string, string>;
  changes: Change[];
  warnings: string[];
  /** Steps left for the human, in order. */
  manualSteps: string[];
  /** Human-readable report (what `output.log` printed). */
  lines: string[];
}
