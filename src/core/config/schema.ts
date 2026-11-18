/**
 * Config schema (spec 5). Pure: no I/O. `src/config/load.ts` loads the file and checks
 * that referenced files exist.
 *
 * The schema normalizes the input into a `ResolvedConfig`: defaults filled in, shorthand
 * forms expanded (docker `image` and `tags`, `preview.branches` strings, plist `file`),
 * and each target's `buildNumber` merged over the root one.
 */

import { z } from "zod";
import { matchBranch } from "../branches.ts";

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

const regexFileSchema = z
  .strictObject({
    path: nonEmpty,
    kind: z.literal("regex"),
    /** JavaScript regular expression source. Must match exactly once. */
    pattern: nonEmpty,
    /** Replacement with placeholders `{version}`, `{major}`, `{minor}`, `{patch}`, `{buildNumber}`. */
    replace: z.string(),
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
export type JsonFileEntry = z.output<typeof jsonFileSchema>;
export type YamlFileEntry = z.output<typeof yamlFileSchema>;
export type RegexFileEntry = z.output<typeof regexFileSchema>;
export type ImageFileEntry = z.output<typeof imageFileSchema>;

// ---------------------------------------------------------------------------
// Targets (spec 6)

const commonTargetFields = {
  /** `auto` (default): built by every release. `manual`: shipped on demand (spec 9.8). */
  release: z.enum(["auto", "manual"]).default("auto"),
  buildNumber: buildNumberOverrideSchema.optional(),
  files: z.array(fileEntrySchema).default([]),
};

const dockerTagListSchema = z.array(nonEmpty).min(1, "expected at least one tag template");

const dockerTargetSchema = z.strictObject({
  type: z.literal("docker"),
  image: z.union([nonEmpty, z.array(nonEmpty).min(1, "expected at least one image")]),
  tags: z
    .union([
      dockerTagListSchema,
      z.strictObject({
        release: dockerTagListSchema.optional(),
        preview: dockerTagListSchema.optional(),
        prerelease: dockerTagListSchema.optional(),
      }),
    ])
    .optional(),
  verify: z.array(z.literal("registry")).default([]),
  ...commonTargetFields,
});

const webTargetSchema = z.strictObject({
  type: z.literal("web"),
  verify: z.array(z.never()).default([]),
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
  z.strictObject({
    kind: z.literal("plist"),
    /** One plist (`file`) or several (`files`). */
    file: nonEmpty.optional(),
    files: z.array(nonEmpty).min(1, "expected at least one Info.plist path").optional(),
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

const previewTargetsSchema = z.union([z.literal("all"), z.array(nonEmpty)]);

const previewBranchSchema = z.union([
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
]);

const previewSchema = z.strictObject({
  label: nonEmpty.default("launchset:preview"),
  rebuildOnPush: z.boolean().default(true),
  branches: z.array(previewBranchSchema).default([]),
  targets: previewTargetsSchema.default("all"),
});

// ---------------------------------------------------------------------------
// Root

const placeholderTemplate = (required: string[]) =>
  nonEmpty.refine((value) => required.every((p) => value.includes(`{${p}}`)), {
    message: `expected a template containing ${required.map((p) => `{${p}}`).join(" and ")}`,
  });

export const configSchema = z.strictObject({
  version: z.strictObject({ file: nonEmpty.default("package.json") }).prefault({}),
  changelog: z
    .strictObject({
      file: nonEmpty.default("CHANGELOG.md"),
      /** Add PR links and authors (spec 12). */
      github: z.boolean().default(true),
    })
    .prefault({}),
  baseBranch: nonEmpty.default("main"),
  maintenanceBranches: nonEmpty.default("release/*.x"),
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
  preview: z.union([z.literal(false), previewSchema]).prefault({}),
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
export type AndroidSource = Parsed<"android">["source"];
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

export class ConfigError extends Error {
  readonly issues: ConfigIssue[];
  constructor(issues: ConfigIssue[], file?: string) {
    const where = file ? ` in ${file}` : "";
    super(
      `Invalid launchset config${where}:\n${issues.map((i) => `  - ${i.path || "(root)"}: ${i.message}`).join("\n")}`,
    );
    this.name = "ConfigError";
    this.issues = issues;
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
        issues.push({ path: `${base}.store.appId`, message: 'verify: ["store"] needs store.appId' });
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

/**
 * Validate and normalize a config object. Throws `ConfigError` listing every problem.
 */
export function resolveConfig(input: unknown, options: { file?: string } = {}): ResolvedConfig {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => ({ path: pathToString(issue.path), message: issue.message })),
      options.file,
    );
  }
  const data = parsed.data;
  const preview: ResolvedPreview =
    data.preview === false
      ? { enabled: false, label: "launchset:preview", rebuildOnPush: true, branches: [], targets: "all" }
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
