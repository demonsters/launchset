/** The I/O layer: one function per command, `(context, options) → FlowResult`. */

export { type AddData, type AddOptions, add } from "./add.ts";
export {
  type PlannedChange,
  planReleaseChanges,
  unifiedDiff,
  writePlannedChanges,
} from "./apply.ts";
export {
  type CheckData,
  type CheckOptions,
  type CheckPrInfo,
  check,
  type PushCheckData,
} from "./check.ts";
export * from "./ci/index.ts";
export * from "./context.ts";
export {
  type ExecutedAction,
  executeFinalizeActions,
  existingReleases,
  type FinalizeData,
  type FinalizeOptions,
  finalize,
} from "./finalize.ts";
export * from "./gather.ts";
export * from "./git-ops.ts";
export { type HotfixData, type HotfixOptions, hotfix, parseVersionLine } from "./hotfix.ts";
export { type MarkData, type MarkOptions, mark } from "./mark.ts";
export { outputsFor } from "./outputs.ts";
export * from "./preview.ts";
export {
  DEFAULT_SWEEP_MAX,
  type PreviewSweepData,
  type PreviewSweepOptions,
  previewSweep,
  type SweepEntry,
  type SweepOutcome,
  type SweepSkipCode,
} from "./preview-sweep.ts";
export {
  type ReleaseData,
  type ReleaseOptions,
  type ReleasePrResult,
  release,
  releasePrContent,
} from "./release.ts";
export { type ShipData, type ShipOptions, ship } from "./ship.ts";
export { flagPlan, type StampData, type StampOptions, stamp } from "./stamp.ts";
export { type StatusOptions, type StatusResultData, status } from "./status.ts";
export { type VerifyData, type VerifyOptions, verify } from "./verify.ts";
export { type VersionData, type VersionOptions, version } from "./version.ts";
