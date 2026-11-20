/**
 * `command: mark` (spec 9.3, 9.8): create and push the marker tag `launchset/<target>@<version>`
 * at the release commit. With `--version` (a manual target shipped by hand) the marker goes on
 * the commit of `v{version}` and the GitHub Release's "Manual targets" list is updated.
 */

import { LaunchsetError } from "../core/errors.ts";
import { planFinalize } from "../core/finalize.ts";
import { forgeWords } from "../core/forge-links.ts";
import { DEFAULT_HOST } from "../core/hosts.ts";
import { planTarget } from "../core/outputs.ts";
import { normalizeVersionInput, renderSummary, unknownTarget } from "../core/plan-common.ts";
import { buildShipPlan } from "../core/release.ts";
import { isReleased, markerTag, releaseTag } from "../core/tags.ts";
import type { Plan } from "../core/types.ts";
import { type FlowContext, type FlowResult, requireForge } from "./context.ts";
import { type ExecutedAction, executeFinalizeActions, existingReleases } from "./finalize.ts";
import { changelogFilePath, readTagSnapshot, syncTags, tryResolveBranch } from "./gather.ts";
import { checkHeadAtPlan, ensureTag, type TagResult } from "./git-ops.ts";
import { plain, requireReleasePlan, resolvePlan } from "./result.ts";

export interface MarkOptions {
  target: string;
  /** The plan of this run (CI). */
  plan?: string | Plan;
  /** A released version shipped by hand (`launchset mark --version`, spec 9.8). */
  version?: string;
  /** With `version`: the build number that shipped (from `launchset ship --json`). */
  buildNumber?: number | null;
  /** `git fetch --tags` first (when a remote exists). Default true. */
  fetch?: boolean;
}

export interface MarkData {
  target: string;
  version: string;
  marker: string;
  sha: string;
  result: TagResult;
  /** Release updates for a manual target marked with `--version`. */
  releaseUpdates: ExecutedAction[];
}

/** `command: mark`. Idempotent: an existing marker on the same commit is fine. */
export async function mark(
  context: FlowContext,
  options: MarkOptions,
): Promise<FlowResult<MarkData>> {
  const { config } = context;
  const target = config.targets[options.target];
  if (!target) throw unknownTarget(config, options.target);
  if (options.plan === undefined && !options.version) {
    throw new LaunchsetError(
      "missing-plan",
      "mark needs a plan or a version (CLI: --plan / --version; action: plan / version inputs)",
      {
        hint: "In workflows pass the launchset job's plan output; by hand pass the version you shipped.",
      },
    );
  }
  await syncTags(context, options.fetch ?? true);

  let version: string;
  let sha: string;
  let marker: string;
  let byHand = false;
  let checkout: string | undefined;
  if (options.plan !== undefined) {
    const plan = requireReleasePlan(resolvePlan(options.plan), "mark");
    const targetPlan = planTarget(plan, options.target);
    checkout = await checkHeadAtPlan(context, plan, "mark");
    if (options.version && normalizeVersionInput(options.version) !== plan.version) {
      throw new LaunchsetError(
        "version-mismatch",
        `the version ${options.version} doesn't match the plan's version ${plan.version}`,
        {
          hint: "Pass either the plan or the version, not both (CLI: --plan / --version; action: plan / version inputs).",
        },
      );
    }
    version = plan.version;
    sha = plan.releaseSha;
    marker = targetPlan.marker ?? markerTag(config.tags, options.target, version);
  } else {
    version = normalizeVersionInput(options.version ?? ""); // checked above: there is one
    const tags = await readTagSnapshot(context);
    const tag = releaseTag(config.tags, version);
    const tagSha = tags.shas.get(tag);
    if (!isReleased(tags.index, version) || !tagSha) {
      throw new LaunchsetError(
        "not-released",
        `${version} isn't released (there is no ${tag} tag), so ${options.target} can't be marked as shipped for it`,
        {
          hint: "Only released versions are shipped by hand. Fetch the tags if it was released elsewhere.",
        },
      );
    }
    sha = tagSha;
    marker = markerTag(config.tags, options.target, version);
    byHand = true;
  }

  const result = await ensureTag(context, marker, sha);
  const releaseUpdates: ExecutedAction[] = [];
  let releaseNote = "";
  if (byHand && target.release === "manual") {
    const { releaseName } = forgeWords(context.host);
    const forge = requireForge(context, `Updating the ${releaseName} of a hand-shipped target`);
    const tags = await readTagSnapshot(context);
    const tag = releaseTag(config.tags, version);
    // The plan `ship` would have made, with the build number that shipped.
    const plan = buildShipPlan(
      {
        config,
        branch: (await tryResolveBranch(context)) ?? config.baseBranch,
        tags,
        now: context.now,
        ...(context.run ? { run: context.run } : {}),
        ...(context.repository ? { repository: context.repository } : {}),
        ...(context.host !== DEFAULT_HOST ? { host: context.host } : {}),
      },
      target.name,
      version,
      { buildNumber: options.buildNumber ?? null },
    );
    const changelogPath = await changelogFilePath(context);
    const finalized = planFinalize({
      config,
      plan,
      tags,
      changelog: (await context.git.showFile(sha, changelogPath)) ?? null,
      releases: await existingReleases(forge, [tag]),
      now: context.now,
      host: context.host,
    });
    const { executed } = await executeFinalizeActions(context, forge, finalized.actions);
    releaseUpdates.push(...executed);
    releaseNote =
      executed.length > 0
        ? `Updated the ${tag} ${releaseName}: ${target.name} is listed as shipped.`
        : `The ${tag} ${releaseName} already lists ${target.name} as shipped.`;
  }

  const verb = result === "created" ? "created" : "already exists";
  return {
    ok: true,
    outputs: { version, "release-sha": sha },
    summary: renderSummary({
      title: `launchset: mark ${options.target}`,
      paragraphs: [`Marker \`${marker}\` ${verb} at \`${sha.slice(0, 7)}\`.`, releaseNote],
      warnings: checkout ? [checkout] : [],
    }),
    lines: [
      ...(checkout ? [`warning: ${checkout}`] : []),
      `${marker} ${verb} at ${sha.slice(0, 7)}`,
      ...releaseUpdates.map(
        (u) =>
          `  updated ${plain(u.action.kind === "update-release" || u.action.kind === "create-release" ? u.action.name : "")}: ${u.result}`,
      ),
    ],
    data: { target: options.target, version, marker, sha, result, releaseUpdates },
  };
}
