/**
 * Docker tag templates (spec 6.1) and the verify tag (spec 7.4). Pure.
 */

import { DOCKER_TAG_PLACEHOLDERS, type ResolvedDockerTarget } from "./config/schema.ts";
import { LaunchsetError } from "./errors.ts";
import type { Channel, DockerPlan } from "./types.ts";
import { baseVersionOf, versionParts } from "./versions.ts";

export { DOCKER_TAG_PLACEHOLDERS };
export type DockerTagPlaceholder = (typeof DOCKER_TAG_PLACEHOLDERS)[number];

/** A valid Docker tag: up to 128 characters, `[A-Za-z0-9_.-]`, not starting with `.` or `-`. */
const DOCKER_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const PLACEHOLDER = /\{([^{}]*)\}/g;

export interface DockerTagContext {
  channel: Channel;
  /** The version of this run: release, preview (8.3) or prerelease (9.9) version. */
  version: string;
  /** True on a maintenance branch: release tags without `{version}`/`{minor}` are dropped. */
  maintenance: boolean;
  /** Prerelease id; used only on the `prerelease` channel. */
  preid?: string;
  /** PR number; used only for PR previews. */
  prNumber?: number;
  /** Branch slug; used only for branch previews (no `prNumber`) and prereleases. */
  branchSlug?: string;
  /** Full commit sha of the built commit. */
  sha?: string;
  buildNumber?: number | null;
  /** ISO 8601 creation time for the OCI `created` label (the plan's `createdAt`). */
  createdAt: string;
}

/** Placeholders used by a template, in order. */
export function templatePlaceholders(template: string): string[] {
  return Array.from(template.matchAll(PLACEHOLDER), (m) => m[1] as string);
}

/** Placeholder values for a run; a missing key means "no value in this run". */
export function dockerTagValues(
  ctx: DockerTagContext,
): Partial<Record<DockerTagPlaceholder, string>> {
  const { major, minor, patch } = versionParts(baseVersionOf(ctx.version));
  const values: Partial<Record<DockerTagPlaceholder, string>> = {
    version: ctx.version,
    major: String(major),
    minor: String(minor),
    patch: String(patch),
  };
  if (ctx.channel === "prerelease" && ctx.preid) values.preid = ctx.preid;
  if (ctx.channel === "preview" && ctx.prNumber !== undefined)
    values.prNumber = String(ctx.prNumber);
  const branchRun =
    ctx.channel === "prerelease" || (ctx.channel === "preview" && ctx.prNumber === undefined);
  if (branchRun && ctx.branchSlug) values.branchSlug = ctx.branchSlug;
  if (ctx.sha) {
    values.sha = ctx.sha;
    values.shortSha = ctx.sha.slice(0, 7);
  }
  if (ctx.buildNumber !== undefined && ctx.buildNumber !== null) {
    values.buildNumber = String(ctx.buildNumber);
  }
  return values;
}

function isKnown(name: string): name is DockerTagPlaceholder {
  return (DOCKER_TAG_PLACEHOLDERS as readonly string[]).includes(name);
}

const movesWithLine = (template: string) =>
  template.includes("{version}") || template.includes("{minor}");

/**
 * Render one template, or `null` when a placeholder has no value in this run (spec 6.1:
 * such templates are skipped). Throws on an unknown placeholder or an invalid tag.
 */
export function renderDockerTag(
  template: string,
  values: Partial<Record<DockerTagPlaceholder, string>>,
  where = "tags",
): string | null {
  let missing = false;
  const tag = template.replace(PLACEHOLDER, (match, name: string) => {
    if (!isKnown(name)) {
      throw new LaunchsetError(
        "invalid-docker-tag",
        `${where}: unknown placeholder ${match} in "${template}"`,
        { hint: `Allowed: ${DOCKER_TAG_PLACEHOLDERS.map((p) => `{${p}}`).join(", ")}.` },
      );
    }
    const value = values[name];
    if (value === undefined) missing = true;
    return value ?? "";
  });
  if (missing) return null;
  if (!DOCKER_TAG.test(tag)) {
    throw new LaunchsetError(
      "invalid-docker-tag",
      `${where}: template "${template}" renders to "${tag}", which isn't a valid Docker tag (letters, digits, _ . -, at most 128 characters, not starting with . or -)`,
    );
  }
  return tag;
}

export interface RenderedDockerTags {
  /** Tags in template order, without duplicates. */
  tags: string[];
  /** First rendered tag whose template contains `{version}` (spec 7.4), or `null`. */
  verifyTag: string | null;
}

/**
 * Apply the rules of spec 6.1 to a template list and render it. Release channel only: on
 * maintenance branches
 * templates without `{version}` and `{minor}` are dropped; while the major version is 0,
 * such templates are skipped too, except the literal `latest`; templates with a placeholder
 * that has no value in this run are skipped.
 */
export function renderDockerTags(
  templates: readonly string[],
  ctx: DockerTagContext,
  where = "tags",
): RenderedDockerTags {
  const values = dockerTagValues(ctx);
  // The maintenance and 0.x rules protect moving release tags (latest, {major}); preview
  // and prerelease tags like pr-5 or develop are never filtered by them.
  const release = ctx.channel === "release";
  const zeroMajor = release && values.major === "0";
  const tags: string[] = [];
  let verifyTag: string | null = null;
  for (const template of templates) {
    if (release && ctx.maintenance && !movesWithLine(template)) continue;
    if (zeroMajor && !movesWithLine(template) && template !== "latest") continue;
    const tag = renderDockerTag(template, values, where);
    if (tag === null) continue;
    if (verifyTag === null && template.includes("{version}")) verifyTag = tag;
    if (!tags.includes(tag)) tags.push(tag);
  }
  return { tags, verifyTag };
}

/** OCI label values (spec 6.1). `revision` is left out when the sha is unknown. */
export function ociLabels(
  ctx: Pick<DockerTagContext, "version" | "sha" | "createdAt">,
): Record<string, string> {
  const labels: Record<string, string> = { "org.opencontainers.image.version": ctx.version };
  if (ctx.sha) labels["org.opencontainers.image.revision"] = ctx.sha;
  labels["org.opencontainers.image.created"] = ctx.createdAt;
  return labels;
}

/** The template list a channel uses. */
export function tagListFor(target: Pick<ResolvedDockerTarget, "tags">, channel: Channel): string[] {
  return target.tags[channel];
}

/**
 * The Docker part of a target's plan (spec 6.1): rendered tags, `image:tag` refs for every
 * image, the verify tag and the OCI labels. Throws when no tag is left, or when the release
 * list has no rendered `{version}` tag.
 */
export function dockerPlan(target: ResolvedDockerTarget, ctx: DockerTagContext): DockerPlan {
  const where = `targets.${target.name}.tags.${ctx.channel}`;
  const { tags, verifyTag } = renderDockerTags(tagListFor(target, ctx.channel), ctx, where);
  if (tags.length === 0) {
    throw new LaunchsetError(
      "no-docker-tags",
      `${where}: no tag template produced a tag for this ${ctx.channel} run`,
      { hint: "Add a template with {version}." },
    );
  }
  if (verifyTag === null && ctx.channel === "release") {
    throw new LaunchsetError(
      "no-verify-tag",
      `${where}: no rendered tag contains {version}, so there is no verify tag`,
      { hint: 'Add "{version}" (or e.g. "v{version}") to the release tags.' },
    );
  }
  const refs = target.image.flatMap((image) => tags.map((tag) => `${image}:${tag}`));
  return {
    images: [...target.image],
    tags,
    refs,
    verifyTag: verifyTag ?? "",
    labels: ociLabels(ctx),
  };
}

/**
 * The release verify tag of a version, for stamping `kind: "image"` files in the release PR
 * (spec 6.6), where only the version is known. Throws when the first `{version}` template of
 * the release list needs another run value (`{sha}`, `{buildNumber}`).
 */
export function releaseVerifyTag(
  target: Pick<ResolvedDockerTarget, "name" | "tags">,
  version: string,
): string {
  const where = `targets.${target.name}.tags.release`;
  const template = target.tags.release.find((t) => t.includes("{version}"));
  if (template === undefined) {
    throw new LaunchsetError("no-verify-tag", `${where}: no template contains {version}`);
  }
  const { major, minor, patch } = versionParts(version);
  const values = { version, major: String(major), minor: String(minor), patch: String(patch) };
  const tag = renderDockerTag(template, values, where);
  if (tag === null) {
    throw new LaunchsetError(
      "no-verify-tag",
      `${where}: the verify tag template "${template}" uses a value that isn't known when the release PR is made, so image references can't be stamped`,
      { hint: "Put a template with only {version}, {major}, {minor} or {patch} first." },
    );
  }
  return tag;
}
