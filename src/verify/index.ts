/**
 * `launchset verify` (spec 7.3 to 7.5): runs every entry of a target's `verify` list.
 *
 * Several entries: every check must succeed (the first error is thrown), and the
 * target is already published only if every check says so. If they disagree, it's not
 * published: the upload steps run again and the store or registry rejects a duplicate
 * where it matters.
 */

import type { ResolvedTarget } from "../core/config/schema.ts";
import type { TargetPlan } from "../core/types.ts";
import { verifyNpm } from "./npm.ts";
import { verifyRegistry } from "./registry.ts";
import { type VerifyContext, VerifyError, type VerifyResult } from "./types.ts";

// The store checks (appstore.ts, play.ts) load jose; runCheck imports them on demand.
export type { AppStoreCheck } from "./appstore.ts";
export { type NpmCheck, packageUrl, parseNpmrc, readPackageInfo, verifyNpm } from "./npm.ts";
export type { PlayCheck } from "./play.ts";
export {
  findCredentials,
  parseChallenge,
  parseImageName,
  type RegistryCheck,
  verifyRegistry,
} from "./registry.ts";
export { compareBuildVersions, parseBuildVersion, roundUpOffset } from "./store.ts";
export { type StoreCheck, type VerifyContext, VerifyError, type VerifyResult } from "./types.ts";

export interface VerifyRun {
  /** The version of this run. */
  version: string;
  target: TargetPlan;
}

/** Run one `verify` entry of a target. */
async function runCheck(
  kind: string,
  target: ResolvedTarget,
  run: VerifyRun,
  ctx: VerifyContext,
): Promise<VerifyResult> {
  const store = {
    version: run.target.marketingVersion,
    buildNumber: run.target.buildNumber,
    offset: target.buildNumber.offset,
    target: target.name,
  };
  if (kind === "store" && target.type === "android") {
    if (!target.store) throw missingConfig(target.name, "store.packageName");
    const { verifyPlay } = await import("./play.ts");
    return verifyPlay({ ...store, packageName: target.store.packageName }, ctx);
  }
  if (kind === "store" && target.type === "ios") {
    if (!target.store) throw missingConfig(target.name, "store.appId");
    const { verifyAppStore } = await import("./appstore.ts");
    return verifyAppStore({ ...store, appId: target.store.appId }, ctx);
  }
  if (kind === "registry" && target.type === "docker") {
    const docker = run.target.docker;
    if (!docker?.verifyTag) {
      throw new VerifyError(
        `The plan has no docker verify tag for target "${target.name}". Pass the plan output of the launchset job to verify.`,
      );
    }
    const images = docker.images.length > 0 ? docker.images : target.image;
    return verifyRegistry({ images, tag: docker.verifyTag }, ctx);
  }
  if (kind === "npm" && target.type === "custom") {
    return verifyNpm(
      { packageFile: target.npm?.package ?? "package.json", version: run.version },
      ctx,
    );
  }
  throw new VerifyError(
    `verify: "${kind}" isn't supported for ${target.type} target "${target.name}". Use "store" for android/ios, "registry" for docker, "npm" for custom targets.`,
  );
}

function missingConfig(target: string, key: string): VerifyError {
  return new VerifyError(
    `Target "${target}" has verify: ["store"] but no ${key}. Add ${key} to the target in the launchset config.`,
  );
}

/** Run every `verify` entry of `target` for this run (spec 7.3 to 7.5). */
export async function verifyTarget(
  target: ResolvedTarget,
  run: VerifyRun,
  ctx: VerifyContext,
): Promise<VerifyResult> {
  const kinds = [...new Set<string>(target.verify)];
  if (kinds.length === 0) return { alreadyPublished: false, message: "no verification configured" };

  const results: VerifyResult[] = [];
  for (const kind of kinds) {
    results.push(await runCheck(kind, target, run, ctx));
  }
  if (results.length === 1 && results[0]) return results[0];

  const alreadyPublished = results.every((r) => r.alreadyPublished);
  const summary = alreadyPublished
    ? "already published (every check agrees)"
    : results.some((r) => r.alreadyPublished)
      ? "not published (only some checks found it)"
      : "not published";
  return {
    alreadyPublished,
    message: `${summary}: ${results.map((r, i) => `${kinds[i]}: ${r.message}`).join("; ")}`,
  };
}
