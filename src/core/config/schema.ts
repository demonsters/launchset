/**
 * Config schema (spec 5). Pure: no I/O. `src/config/load.ts` loads the file and checks
 * that referenced files exist.
 *
 * The schema normalizes the input into a `ResolvedConfig`: defaults filled in, shorthand
 * forms expanded (docker `image` and `tags`, `preview.branches` strings, plist `file`),
 * and each target's `buildNumber` merged over the root one.
 */

import { z } from "zod";
import { isMaintenanceBranch, matchBranch } from "../branches.ts";
import { LaunchsetError } from "../errors.ts";

export const TARGET_NAME = /^[a-z0-9][a-z0-9-]*$/;

export const DEFAULT_DOCKER_TAGS = {
  release: ["{version}", "{major}.{minor}", "{major}", "latest"],
  preview: ["{version}", "pr-{prNumber}", "{branchSlug}"],
  prerelease: ["{version}", "{branchSlug}"],
} as const;

export const DEFAULT_BOTS = ["dependabot[bot]", "renovate[bot]"];

const nonEmpty = z.string().min(1, "expected a non-empty string");

// ---------------------------------------------------------------------------
// Build numbers (spec 7)

export const BUILD_NUMBER_STRATEGIES = ["timestamp", "run-number", "semver", "eas"] as const;
const strategy = z.enum(BUILD_NUMBER_STRATEGIES);
const epoch = z.iso.datetime({ offset: true, message: "expected an ISO 8601 date-time" });
const offset = z.number().int().min(0, "expected an integer >= 0");

const buildNumberSchema = z.strictObject({
  strategy: strategy.default("timestamp"),
  epoch: epoch.default("2020-01-01T00:00:00Z"),
  offset: offset.default(0),
});

/** A target's override: every field optional, merged over the root `buildNumber`. */
const buildNumberOverrideSchema = z.strictObject({
  strategy: strategy.optional(),
  epoch: epoch.optional(),
  offset: offset.optional(),
});

export type BuildNumberConfig = z.output<typeof buildNumberSchema>;

// ---------------------------------------------------------------------------
// Extra files (spec 6.6)

const jsonFileSchema = z.strictObject({
  path: nonEmpty,
  kind: z.literal("json"),
  /** Dotted key path, e.g. `version` or `expo.version`. */
  key: nonEmpty,
});

const yamlFileSchema = z.strictObject({
  path: nonEmpty,
  kind: z.literal("yaml"),
  key: nonEmpty,
});

/** Placeholders a regex `replace` may use (spec 6.6). */
export const REGEX_REPLACE_PLACEHOLDERS = ["version", "major", "minor", "patch", "buildNumber"];

/**
 * Unknown placeholders in a regex `replace`. Other braces (JSON, code) stay literal, so only
 * identifier-like `{name}` not preceded by `$` is checked: typos like `{versoin}` fail at load.
 */
function checkReplacePlaceholders(value: string, ctx: z.RefinementCtx): void {
  for (const match of value.matchAll(/(?<!\$)\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    if (!REGEX_REPLACE_PLACEHOLDERS.includes(match[1] as string)) {
      ctx.addIssue({
        code: "custom",
        message: `unknown placeholder ${match[0]}: expected ${REGEX_REPLACE_PLACEHOLDERS.map((p) => `{${p}}`).join(", ")}`,
      });
    }
  }
}

const regexFileSchema = z
  .strictObject({
    path: nonEmpty,
    kind: z.literal("regex"),
    /** JavaScript regular expression source. Must match exactly once. */
    pattern: nonEmpty,
    /** Replacement with placeholders `{version}`, `{major}`, `{minor}`, `{patch}`, `{buildNumber}`. */
    replace: z.string().superRefine(checkReplacePlaceholders),
    /** Extra RegExp flags (`g` is not allowed; `m`, `s`, `i`, `u` are). */
    flags: z
      .string()
      .regex(/^[imsu]*$/, "expected only the RegExp flags i, m, s, u")
      .optional(),
  })
  .superRefine((entry, ctx) => {
    try {
      new RegExp(entry.pattern, entry.flags);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: ["pattern"],
        message: `expected a valid regular expression (${(error as Error).message})`,
      });
    }
  });

const imageFileSchema = z.strictObject({
  /** File path or glob, e.g. `deploy/k8s/*.yaml`. */
  path: nonEmpty,
  kind: z.literal("image"),
});

const fileEntrySchema = z.discriminatedUnion("kind", [
  jsonFileSchema,
  yamlFileSchema,
  regexFileSchema,
  imageFileSchema,
]);

export type FileEntry = z.output<typeof fileEntrySchema>;

// ---------------------------------------------------------------------------
// Targets (spec 6)

const commonTargetFields = {
  /** `auto` (default): built by every release. `manual`: shipped on demand (spec 9.8). */
  release: z.enum(["auto", "manual"]).default("auto"),
  buildNumber: buildNumberOverrideSchema.optional(),
  files: z.array(fileEntrySchema).default([]),
};

/** Placeholders a Docker tag template may use (spec 6.1). */
export const DOCKER_TAG_PLACEHOLDERS = [
  "version",
  "major",
  "minor",
  "patch",
  "preid",
  "prNumber",
  "branchSlug",
  "sha",
  "shortSha",
  "buildNumber",
] as const;

/** Checks that every `{placeholder}` in a template is one of `allowed`. */
const knownPlaceholders = (allowed: readonly string[]) => (value: string, ctx: z.RefinementCtx) => {
  for (const match of value.matchAll(/\{([^{}]*)\}/g)) {
    if (!allowed.includes(match[1] as string)) {
      ctx.addIssue({
        code: "custom",
        message: `unknown placeholder ${match[0]}: expected ${allowed.map((p) => `{${p}}`).join(", ")}`,
      });
    }
  }
};

/** OCI tag grammar. */
const DOCKER_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** Placeholders must be known, and the literal parts must fit the OCI tag grammar. */
const dockerTagTemplate = nonEmpty.superRefine((value, ctx) => {
  const allowed: readonly string[] = DOCKER_TAG_PLACEHOLDERS;
  if ([...value.matchAll(/\{([^{}]*)\}/g)].some((m) => !allowed.includes(m[1] as string))) {
    knownPlaceholders(allowed)(value, ctx);
    return;
  }
  const sample = renderSample(value);
  if (!DOCKER_TAG.test(sample)) {
    ctx.addIssue({
      code: "custom",
      message: `"${value}" can't become a valid Docker tag (it renders like "${sample}"): use only letters, digits, _ . and -, don't start with . or -, and keep it under 128 characters`,
    });
  }
});
const dockerTagListSchema = z.array(dockerTagTemplate).min(1, "expected at least one tag template");

/** An image name without tag or digest; `localhost:5000/app` has a port, not a tag. */
const imageName = nonEmpty.superRefine((value, ctx) => {
  const lastSegment = value.slice(value.lastIndexOf("/") + 1);
  if (value.includes("@") || lastSegment.includes(":")) {
    ctx.addIssue({
      code: "custom",
      message: `expected an image name without tag or digest, like "ghcr.io/org/app" (got "${value}"); set tags with "tags"`,
    });
  }
});

const dockerTargetSchema = z.strictObject({
  type: z.literal("docker"),
  image: z.union([imageName, z.array(imageName).min(1, "expected at least one image")], {
    error: 'expected an image name like "ghcr.io/org/app", or a list of image names',
  }),
  tags: z
    .union(
      [
        dockerTagListSchema,
        z.strictObject({
          release: dockerTagListSchema.optional(),
          preview: dockerTagListSchema.optional(),
          prerelease: dockerTagListSchema.optional(),
        }),
      ],
      {
        error:
          "expected a list of tag templates (the release list), or an object with release, preview and/or prerelease lists",
      },
    )
    .optional(),
  verify: z.array(z.literal("registry")).default([]),
  ...commonTargetFields,
});

const webTargetSchema = z.strictObject({
  type: z.literal("web"),
  verify: z
    .array(z.never({ error: "web targets have no verify checks: remove this entry" }))
    .default([]),
  ...commonTargetFields,
});

const androidSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("gradle"), file: nonEmpty }),
  z.strictObject({
    kind: z.literal("gradle-properties"),
    file: nonEmpty,
    versionNameKey: nonEmpty.default("VERSION_NAME"),
    versionCodeKey: nonEmpty.default("VERSION_CODE"),
  }),
  z.strictObject({ kind: z.literal("capacitor"), dir: nonEmpty }),
  z.strictObject({ kind: z.literal("expo"), file: nonEmpty.default("app.json") }),
]);

const androidTargetSchema = z.strictObject({
  type: z.literal("android"),
  source: androidSourceSchema,
  store: z.strictObject({ packageName: nonEmpty }).optional(),
  verify: z.array(z.literal("store")).default([]),
  ...commonTargetFields,
});

const xcodeTargets = z.array(nonEmpty).min(1, "expected at least one Xcode target name");

const iosSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("xcodeproj"),
    /** Path to the `.xcodeproj` directory (the stamper edits `<file>/project.pbxproj`). */
    file: nonEmpty,
    xcodeTargets: xcodeTargets.optional(),
  }),
  z
    .strictObject({
      kind: z.literal("plist"),
      /** One plist (`file`) or several (`files`). */
      file: nonEmpty.optional(),
      files: z.array(nonEmpty).min(1, "expected at least one Info.plist path").optional(),
    })
    .superRefine((source, ctx) => {
      if (source.file !== undefined && source.files !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "use either file (one Info.plist) or files (several), not both",
        });
      }
    }),
  z.strictObject({ kind: z.literal("xcconfig"), file: nonEmpty }),
  z.strictObject({
    kind: z.literal("capacitor"),
    dir: nonEmpty,
    xcodeTargets: xcodeTargets.optional(),
  }),
  z.strictObject({ kind: z.literal("expo"), file: nonEmpty.default("app.json") }),
]);

const iosTargetSchema = z.strictObject({
  type: z.literal("ios"),
  source: iosSourceSchema,
  store: z
    .strictObject({ appId: z.string().regex(/^\d+$/, "expected the numeric Apple ID of the app") })
    .optional(),
  verify: z.array(z.literal("store")).default([]),
  ...commonTargetFields,
});

const customTargetSchema = z.strictObject({
  type: z.literal("custom"),
  /** For `verify: ["npm"]` (spec 7.5). */
  npm: z.strictObject({ package: nonEmpty.default("package.json") }).optional(),
  verify: z.array(z.literal("npm")).default([]),
  ...commonTargetFields,
});

const targetSchema = z.discriminatedUnion("type", [
  dockerTargetSchema,
  webTargetSchema,
  androidTargetSchema,
  iosTargetSchema,
  customTargetSchema,
]);

export type TargetType = z.output<typeof targetSchema>["type"];

// ---------------------------------------------------------------------------
// Previews (spec 9.7, 9.9)

const previewTargetsSchema = z.union([z.literal("all"), z.array(nonEmpty)], {
  error: 'expected "all" or a list of target names',
});

const previewBranchSchema = z.union(
  [
    nonEmpty,
    z.strictObject({
      /** Branch glob, e.g. `feature/*`. */
      branch: nonEmpty,
      targets: previewTargetsSchema.optional(),
      /** Prerelease id (e.g. `alpha`): makes this a prerelease branch (spec 9.9). */
      prerelease: z
        .string()
        .regex(
          /^[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*$/,
          "expected a prerelease id like alpha, beta or rc (letters, digits and dashes, not only digits)",
        )
        .optional(),
    }),
  ],
  {
    error:
      'expected a branch glob like "develop" or "feature/*", or an object { branch, targets?, prerelease? }',
  },
);

const previewSchema = z.strictObject({
  label: nonEmpty.default("launchset:preview"),
  rebuildOnPush: z.boolean().default(true),
  branches: z.array(previewBranchSchema).default([]),
  targets: previewTargetsSchema.default("all"),
});

// ---------------------------------------------------------------------------
// Root

const placeholderTemplate = (required: string[]) =>
  nonEmpty
    .refine((value) => required.every((p) => value.includes(`{${p}}`)), {
      message: `expected a template containing ${required.map((p) => `{${p}}`).join(" and ")}`,
    })
    .superRefine(knownPlaceholders(required));

/**
 * `changelog`. `links` (PR / MR links and authors, spec 12) was called `github`; the old name
 * is still accepted and mapped onto `links`. Giving both with different values is an error.
 */
const changelogSchema = z
  .strictObject({
    file: nonEmpty.default("CHANGELOG.md"),
    /** Add PR links and authors (spec 12); default true. */
    links: z.boolean().optional().meta({ default: true }),
    /** Deprecated alias of `links`. */
    github: z
      .boolean()
      .optional()
      .meta({ deprecated: true, description: 'Deprecated: the old name of "links".' }),
  })
  .superRefine((value, ctx) => {
    if (value.links !== undefined && value.github !== undefined && value.links !== value.github) {
      ctx.addIssue({
        code: "custom",
        path: ["github"],
        message: `"github" is the old name of "links", which is set to ${value.links}: keep only "links"`,
      });
    }
  })
  .transform(({ file, links, github }) => ({ file, links: links ?? github ?? true }));

export const configSchema = z.strictObject({
  version: z.strictObject({ file: nonEmpty.default("package.json") }).prefault({}),
  changelog: changelogSchema.prefault({}),
  baseBranch: nonEmpty.default("main"),
  /** Branch pattern; its single `*` stands for `<major>.<minor>` (spec 8.2). */
  maintenanceBranches: nonEmpty
    .refine((value) => value.split("*").length === 2, {
      message:
        'expected a branch pattern with exactly one "*", which stands for <major>.<minor> (default "release/*.x")',
    })
    .default("release/*.x"),
  tags: z
    .strictObject({
      release: placeholderTemplate(["version"]).default("v{version}"),
      marker: placeholderTemplate(["target", "version"]).default("launchset/{target}@{version}"),
      partial: placeholderTemplate(["version"]).default("launchset/partial/{version}"),
    })
    .prefault({}),
  buildNumber: buildNumberSchema.prefault({}),
  check: z.strictObject({ bots: z.array(nonEmpty).default(DEFAULT_BOTS) }).prefault({}),
  /** `false` disables previews and prerelease branches (needed for the `semver` strategy). */
  preview: z
    .union([z.literal(false), previewSchema], {
      error: "expected false (to disable previews) or an object with preview settings",
    })
    .prefault({}),
  targets: z.record(z.string(), targetSchema),
});

/** What users write in `launchset.config.*` (used by `defineConfig`). */
export type LaunchsetConfig = z.input<typeof configSchema>;
type ParsedConfig = z.output<typeof configSchema>;

// ---------------------------------------------------------------------------
// Resolved shapes

export interface DockerTags {
  release: string[];
  preview: string[];
  prerelease: string[];
}

type Parsed<T extends TargetType> = Extract<z.output<typeof targetSchema>, { type: T }>;

interface ResolvedCommon {
  /** Target name (the key in `targets`). */
  name: string;
  release: "auto" | "manual";
  /** Root `buildNumber` with this target's override applied. */
  buildNumber: BuildNumberConfig;
  files: FileEntry[];
}

export type ResolvedDockerTarget = ResolvedCommon &
  Omit<Parsed<"docker">, "image" | "tags" | keyof ResolvedCommon> & {
    image: string[];
    tags: DockerTags;
  };
export type ResolvedWebTarget = ResolvedCommon &
  Omit<Parsed<"web">, keyof ResolvedCommon> & { verify: never[] };
export type ResolvedAndroidTarget = ResolvedCommon & Omit<Parsed<"android">, keyof ResolvedCommon>;
type ParsedIosSource = Parsed<"ios">["source"];
/** iOS source with plist `file`/`files` normalized to `files`. */
export type IosSource =
  | Exclude<ParsedIosSource, { kind: "plist" }>
  | { kind: "plist"; files: string[] };
export type ResolvedIosTarget = ResolvedCommon &
  Omit<Parsed<"ios">, "source" | keyof ResolvedCommon> & { source: IosSource };
export type ResolvedCustomTarget = ResolvedCommon & Omit<Parsed<"custom">, keyof ResolvedCommon>;

export type ResolvedTarget =
  | ResolvedDockerTarget
  | ResolvedWebTarget
  | ResolvedAndroidTarget
  | ResolvedIosTarget
  | ResolvedCustomTarget;

export interface PreviewBranch {
  branch: string;
  /** Overrides `preview.targets` for this branch. */
  targets?: "all" | string[];
  /** Set for prerelease branches (spec 9.9). */
  prerelease?: string;
}

export interface ResolvedPreview {
  enabled: boolean;
  label: string;
  rebuildOnPush: boolean;
  branches: PreviewBranch[];
  targets: "all" | string[];
}

export interface ResolvedConfig extends Omit<ParsedConfig, "preview" | "targets"> {
  preview: ResolvedPreview;
  /** In config order. */
  targets: Record<string, ResolvedTarget>;
}

// ---------------------------------------------------------------------------
// Resolution + cross-field validation

export interface ConfigIssue {
  /** Dotted path, e.g. `targets.android.source.file`. */
  path: string;
  message: string;
}

export class ConfigError extends LaunchsetError {
  readonly issues: ConfigIssue[];
  readonly file?: string;
  constructor(issues: ConfigIssue[], file?: string) {
    const where = file ? ` in ${file}` : "";
    super(
      "invalid-config",
      `Invalid launchset config${where}:\n${issues.map((i) => `  - ${i.path || "(root)"}: ${i.message}`).join("\n")}`,
      { hint: "See the configuration reference in the launchset docs." },
    );
    this.name = "ConfigError";
    this.issues = issues;
    if (file !== undefined) this.file = file;
  }
}

const PLAIN_VERSION_TAG = /^v?\d+\.\d+\.\d+$/;

/** Sample values used to check that preview/prerelease templates never render a plain version. */
const SAMPLE_PLACEHOLDERS: Record<string, string> = {
  version: "1.5.0-pr.1.1",
  major: "1",
  minor: "5",
  patch: "0",
  preid: "alpha",
  prNumber: "1",
  branchSlug: "feature-x",
  sha: "0123456789abcdef0123456789abcdef01234567",
  shortSha: "0123456",
  buildNumber: "100",
};

function renderSample(template: string): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => SAMPLE_PLACEHOLDERS[key] ?? match);
}

function pathToString(path: ReadonlyArray<PropertyKey>): string {
  return path.map((p) => String(p)).join(".");
}

// ---------------------------------------------------------------------------
// Readable zod issues

export const UNKNOWN_KEY_MESSAGE =
  "unknown key (check the spelling; see the configuration reference)";

const TYPE_NAMES: Record<string, string> = {
  string: "a string",
  number: "a number",
  int: "an integer",
  boolean: "true or false",
  array: "a list",
  object: "an object",
  record: "an object",
  null: "null",
  undefined: "nothing",
};

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  switch (typeof value) {
    case "string":
      return `the string ${JSON.stringify(value)}`;
    case "number":
      return `the number ${value}`;
    case "boolean":
      return String(value);
    case "object":
      return "an object";
    default:
      return typeof value;
  }
}

function formatValues(values: readonly unknown[]): string {
  const shown = values.map((v) => JSON.stringify(v));
  return shown.length === 1 ? (shown[0] as string) : `one of ${shown.join(", ")}`;
}

/** Zod's own default messages start like this; anything else was written in this file. */
const isDefaultMessage = (message: string) => /^Invalid (input|option|discriminator)/.test(message);

/** True when a union branch failed only because the value has the wrong type. */
function failedAtRoot(branch: readonly z.core.$ZodIssue[]): boolean {
  return branch.every(
    (i) => i.path.length === 0 && (i.code === "invalid_type" || i.code === "invalid_value"),
  );
}

/**
 * Turn zod issues into `ConfigIssue`s with readable messages and full paths. Parse with
 * `{ reportInput: true }`: the input tells "missing" apart from "wrong value".
 */
export function formatZodIssues(
  issues: readonly z.core.$ZodIssue[],
  base: readonly PropertyKey[] = [],
): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  for (const issue of issues) {
    const path = [...base, ...issue.path];
    const at = pathToString(path);
    const missing = issue.input === undefined;
    switch (issue.code) {
      case "unrecognized_keys":
        for (const key of issue.keys) {
          out.push({ path: pathToString([...path, key]), message: UNKNOWN_KEY_MESSAGE });
        }
        break;
      case "invalid_union": {
        if ("options" in issue && issue.discriminator && issue.options) {
          const input = issue.input as Record<string, unknown> | undefined;
          const value = input?.[issue.discriminator];
          const expected = formatValues(issue.options);
          out.push({
            path: at,
            message:
              value === undefined
                ? `required: expected ${expected}`
                : `expected ${expected}, got ${typeOf(value)}`,
          });
          break;
        }
        const progressed = issue.errors.filter((branch) => !failedAtRoot(branch));
        if (progressed.length === 1) {
          out.push(...formatZodIssues(progressed[0] as z.core.$ZodIssue[], path));
          break;
        }
        const message = isDefaultMessage(issue.message)
          ? `expected ${issue.errors
              .flat()
              .map((i) =>
                i.code === "invalid_type"
                  ? (TYPE_NAMES[i.expected] ?? i.expected)
                  : i.code === "invalid_value"
                    ? formatValues(i.values)
                    : i.message,
              )
              .join(" or ")}`
          : issue.message;
        out.push({
          path: at,
          message: missing ? `required: ${message}` : `${message}, got ${typeOf(issue.input)}`,
        });
        break;
      }
      case "invalid_type": {
        if (!isDefaultMessage(issue.message)) {
          out.push({ path: at, message: issue.message });
          break;
        }
        const expected = TYPE_NAMES[issue.expected] ?? issue.expected;
        out.push({
          path: at,
          message: missing
            ? `required: expected ${expected}`
            : `expected ${expected}, got ${typeOf(issue.input)}`,
        });
        break;
      }
      case "invalid_value": {
        if (!isDefaultMessage(issue.message)) {
          out.push({ path: at, message: issue.message });
          break;
        }
        const expected = formatValues(issue.values);
        out.push({
          path: at,
          message: missing
            ? `required: expected ${expected}`
            : `expected ${expected}, got ${typeOf(issue.input)}`,
        });
        break;
      }
      default:
        out.push({
          path: at,
          message: isDefaultMessage(issue.message)
            ? issue.message.replace(/^Invalid (input|option): /, "")
            : issue.message,
        });
    }
  }
  return out;
}

function resolveTarget(
  name: string,
  target: z.output<typeof targetSchema>,
  root: BuildNumberConfig,
): ResolvedTarget {
  const buildNumber: BuildNumberConfig = {
    strategy: target.buildNumber?.strategy ?? root.strategy,
    epoch: target.buildNumber?.epoch ?? root.epoch,
    offset: target.buildNumber?.offset ?? root.offset,
  };
  const common = { name, release: target.release, buildNumber, files: target.files };
  switch (target.type) {
    case "docker": {
      const tags: DockerTags = Array.isArray(target.tags)
        ? {
            release: target.tags,
            preview: [...DEFAULT_DOCKER_TAGS.preview],
            prerelease: [...DEFAULT_DOCKER_TAGS.prerelease],
          }
        : {
            release: target.tags?.release ?? [...DEFAULT_DOCKER_TAGS.release],
            preview: target.tags?.preview ?? [...DEFAULT_DOCKER_TAGS.preview],
            prerelease: target.tags?.prerelease ?? [...DEFAULT_DOCKER_TAGS.prerelease],
          };
      const image = Array.isArray(target.image) ? target.image : [target.image];
      return { ...target, ...common, image, tags };
    }
    case "ios": {
      const source: IosSource =
        target.source.kind === "plist"
          ? {
              kind: "plist",
              files: target.source.files ?? (target.source.file ? [target.source.file] : []),
            }
          : target.source;
      return { ...target, ...common, source };
    }
    case "web":
      return { ...target, ...common, verify: [] };
    default:
      return { ...target, ...common };
  }
}

const SEMVER_WITH_PREVIEWS =
  'the "semver" build-number strategy can\'t be used while previews are enabled (previews and the real release would compete for the same numbers). Use "timestamp", or set preview: false';

/** Cross-field rules from spec 5 that zod's per-field checks can't express. */
function semanticIssues(config: ResolvedConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const names = Object.keys(config.targets);

  if (names.length === 0) {
    issues.push({ path: "targets", message: "expected at least one target" });
  }
  for (const name of names) {
    if (!TARGET_NAME.test(name)) {
      issues.push({
        path: `targets.${name}`,
        message:
          "invalid target name: expected lowercase letters, digits and dashes, starting with a letter or digit",
      });
    }
  }
  if (names.length > 0 && !names.some((n) => config.targets[n]?.release === "auto")) {
    issues.push({
      path: "targets",
      message: 'expected at least one target with release: "auto" (otherwise no release completes)',
    });
  }

  if (config.tags.partial === config.tags.release) {
    issues.push({
      path: "tags.partial",
      message: "must differ from tags.release (a partial release must never look like a release)",
    });
  }
  if (isMaintenanceBranch(config, config.baseBranch)) {
    issues.push({
      path: "maintenanceBranches",
      message: `pattern "${config.maintenanceBranches}" matches the base branch "${config.baseBranch}"`,
    });
  }

  if (config.preview.enabled && config.buildNumber.strategy === "semver") {
    issues.push({ path: "buildNumber.strategy", message: SEMVER_WITH_PREVIEWS });
  }

  for (const target of Object.values(config.targets)) {
    const base = `targets.${target.name}`;
    if (
      config.preview.enabled &&
      target.buildNumber.strategy === "semver" &&
      config.buildNumber.strategy !== "semver"
    ) {
      issues.push({ path: `${base}.buildNumber.strategy`, message: SEMVER_WITH_PREVIEWS });
    }
    target.files.forEach((file, index) => {
      if (file.kind === "image" && target.type !== "docker") {
        issues.push({
          path: `${base}.files.${index}.kind`,
          message: 'kind "image" is only allowed in docker targets',
        });
      }
    });
    if (target.type === "docker") {
      if (!target.tags.release.some((t) => t.includes("{version}"))) {
        issues.push({
          path: `${base}.tags.release`,
          message: "expected at least one template containing {version} (used by verify)",
        });
      }
      for (const list of ["preview", "prerelease"] as const) {
        target.tags[list].forEach((template, index) => {
          if (template === "latest" || PLAIN_VERSION_TAG.test(renderSample(template))) {
            issues.push({
              path: `${base}.tags.${list}.${index}`,
              message: `"${template}" isn't allowed in ${list} tags: it would look like a release (latest or a plain X.Y.Z)`,
            });
          }
        });
      }
    }
    if (target.type === "android" && target.verify.includes("store") && !target.store) {
      issues.push({
        path: `${base}.store.packageName`,
        message: 'verify: ["store"] needs store.packageName',
      });
    }
    if (target.type === "ios") {
      if (target.verify.includes("store") && !target.store) {
        issues.push({
          path: `${base}.store.appId`,
          message: 'verify: ["store"] needs store.appId',
        });
      }
      if (target.source.kind === "plist" && target.source.files.length === 0) {
        issues.push({
          path: `${base}.source`,
          message: "expected file or files with at least one Info.plist path",
        });
      }
    }
  }

  const checkTargetRefs = (list: "all" | string[] | undefined, path: string) => {
    if (!Array.isArray(list)) return;
    list.forEach((name, index) => {
      if (!config.targets[name]) {
        issues.push({ path: `${path}.${index}`, message: `unknown target "${name}"` });
      }
    });
  };
  checkTargetRefs(config.preview.targets, "preview.targets");
  config.preview.branches.forEach((entry, index) => {
    checkTargetRefs(entry.targets, `preview.branches.${index}.targets`);
  });

  return issues;
}

/** A top-level `$schema` key (for editor support in `launchset.config.json`) is allowed. */
function withoutSchemaKey(input: unknown): unknown {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !("$schema" in input)
  ) {
    return input;
  }
  const { $schema: _schema, ...rest } = input as Record<string, unknown>;
  return rest;
}

/**
 * Validate and normalize a config object. Throws `ConfigError` listing every problem.
 */
export function resolveConfig(input: unknown, options: { file?: string } = {}): ResolvedConfig {
  const parsed = configSchema.safeParse(withoutSchemaKey(input), { reportInput: true });
  if (!parsed.success) {
    throw new ConfigError(formatZodIssues(parsed.error.issues), options.file);
  }
  const data = parsed.data;
  const preview: ResolvedPreview =
    data.preview === false
      ? {
          enabled: false,
          label: "launchset:preview",
          rebuildOnPush: true,
          branches: [],
          targets: "all",
        }
      : {
          enabled: true,
          ...data.preview,
          branches: data.preview.branches.map((b) => (typeof b === "string" ? { branch: b } : b)),
        };
  const targets: Record<string, ResolvedTarget> = {};
  for (const [name, target] of Object.entries(data.targets)) {
    targets[name] = resolveTarget(name, target, data.buildNumber);
  }
  const config: ResolvedConfig = { ...data, preview, targets };

  const issues = semanticIssues(config);
  config.preview.branches.forEach((entry, index) => {
    if (entry.prerelease && matchBranch(config.baseBranch, entry.branch)) {
      issues.push({
        path: `preview.branches.${index}.branch`,
        message: `prerelease branch pattern "${entry.branch}" matches the base branch "${config.baseBranch}"`,
      });
    }
  });
  if (issues.length > 0) throw new ConfigError(issues, options.file);
  return config;
}

/** Type helper for `launchset.config.ts`. */
export function defineConfig(config: LaunchsetConfig): LaunchsetConfig {
  return config;
}
