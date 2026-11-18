/** Small helpers for building `FlowResult`s. */

import { LaunchsetError } from "../core/errors.ts";
import { parsePlan } from "../core/outputs.ts";
import type { Plan } from "../core/types.ts";

/** Append `> [!KIND]` alert blocks to a rendered job summary. */
export function appendAlerts(
  summary: string,
  kind: "WARNING" | "NOTE" | "CAUTION",
  texts: readonly string[],
): string {
  if (texts.length === 0) return summary;
  const blocks = texts.map(
    (text) =>
      `> [!${kind}]\n${text
        .trimEnd()
        .split("\n")
        .map((l) => (l === "" ? ">" : `> ${l}`))
        .join("\n")}`,
  );
  return `${summary.trimEnd()}\n\n${blocks.join("\n\n")}\n`;
}

/** Append paragraphs to a rendered job summary. */
export function appendParagraphs(summary: string, paragraphs: readonly string[]): string {
  const extra = paragraphs.filter((p) => p.trim() !== "");
  if (extra.length === 0) return summary;
  return `${summary.trimEnd()}\n\n${extra.map((p) => p.trimEnd()).join("\n\n")}\n`;
}

/** Strip markdown emphasis and code backticks for terminal lines. */
export function plain(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]*)`/g, "$1");
}

/** Terminal lines for warnings and notices. */
export function noteLines(warnings: readonly string[], notices: readonly string[]): string[] {
  return [
    ...warnings.map((w) => `warning: ${plain(w)}`),
    ...notices.map((n) => `note: ${plain(n)}`),
  ];
}

/** A plan from the `plan` input (JSON text) or an already parsed plan (validated again). */
export function resolvePlan(plan: string | Plan | undefined): Plan {
  if (plan === undefined) return parsePlan(undefined);
  return parsePlan(typeof plan === "string" ? plan : JSON.stringify(plan));
}

/** A release-channel plan (`publish` or `ship`), or a clear error. */
export function requireReleasePlan(plan: Plan, command: string): Plan {
  if (plan.channel === "release" && (plan.mode === "publish" || plan.mode === "ship")) return plan;
  throw new LaunchsetError(
    "invalid-plan",
    `${command} needs a publish or ship plan, but this plan is mode "${plan.mode}" (channel ${plan.channel})`,
    {
      hint:
        plan.mode === "preview"
          ? "Preview builds have no markers or releases (spec 9.7)."
          : `Run ${command} only when the release job's mode output is publish or ship.`,
    },
  );
}
