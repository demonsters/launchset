/** The store decision of spec 7.3, shared by Google Play and App Store Connect. */

import { type StoreCheck, VerifyError, type VerifyResult } from "./types.ts";

/**
 * A build number as dotted integers (`"12"` → `[12]`, `"1.0.3"` → `[1, 0, 3]`), with
 * trailing zero parts removed so `"12"` equals `"12.0"`. `undefined` if not numeric.
 */
export function parseBuildVersion(value: string | number): number[] | undefined {
  const text = String(value).trim();
  if (!/^\d+(\.\d+)*$/.test(text)) return undefined;
  const parts = text.split(".").map(Number);
  while (parts.length > 1 && parts[parts.length - 1] === 0) parts.pop();
  return parts;
}

/** Numeric comparison of two parsed build versions. */
export function compareBuildVersions(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The build number of a store check; throws for `null` (the `eas` strategy). */
export function requireBuildNumber(check: StoreCheck, store: string): number {
  if (check.buildNumber === null) {
    const target = check.target ? `Target "${check.target}"` : "This target";
    throw new VerifyError(
      `${target} has no build number (buildNumber.strategy is "eas", which leaves build numbers to EAS), so it can't be checked against ${store}. Remove "store" from the target's verify list; EAS's autoIncrement keeps build numbers unique.`,
    );
  }
  if (!Number.isSafeInteger(check.buildNumber) || check.buildNumber < 1) {
    throw new VerifyError(
      `Build number ${check.buildNumber} isn't a positive integer, so it can't be checked against ${store}. Check the plan passed to verify.`,
    );
  }
  return check.buildNumber;
}

/**
 * Round `minimum` up to two significant digits, so the suggestion is easy to read
 * (`83000001` → `84000000`, `57` → `57`, `1234` → `1300`).
 */
export function roundUpOffset(minimum: number): number {
  if (minimum < 100) return minimum;
  const step = 10 ** (String(minimum).length - 2);
  return Math.ceil(minimum / step) * step;
}

export interface StoreState {
  /** E.g. `Google Play (com.example.app)`. */
  store: string;
  /** E.g. `versionCode`, `build`. */
  unit: string;
  /** Every build number in the store, as the store reports it. */
  numbers: string[];
  /** True when this exact build number exists for this version (spec 7.3 step 2). */
  exact: boolean;
  /** Extra notes for the message (warnings, ignored values). */
  notes?: string[];
}

/** Apply spec 7.3 steps 2 to 4 to what the store reported. */
export function decideStore(check: StoreCheck, ours: number, state: StoreState): VerifyResult {
  const notes = state.notes?.length ? ` (${state.notes.join("; ")})` : "";
  if (state.exact) {
    return {
      alreadyPublished: true,
      message: `${state.store}: ${state.unit} ${ours} of version ${check.version} is already uploaded${notes}`,
    };
  }

  let highest: { raw: string; parsed: number[] } | undefined;
  for (const raw of state.numbers) {
    const parsed = parseBuildVersion(raw);
    if (parsed && (!highest || compareBuildVersions(parsed, highest.parsed) > 0)) {
      highest = { raw, parsed };
    }
  }
  if (!highest) {
    return {
      alreadyPublished: false,
      message: `${state.store}: no builds yet, ${state.unit} ${ours} is free${notes}`,
    };
  }

  if (compareBuildVersions(highest.parsed, [ours]) >= 0) {
    const offset = check.offset ?? 0;
    const lead = highest.parsed[0] ?? 0;
    const minimum = offset + (lead - ours) + 1;
    const suggested = roundUpOffset(minimum);
    const extra = suggested === minimum ? "" : ` (at least ${minimum})`;
    throw new VerifyError(
      `${state.store} already has ${state.unit} ${highest.raw}, which is >= this run's build number ${ours}. Uploading would fail. Raise buildNumber.offset in the launchset config from ${offset} to ${suggested}${extra} so new build numbers are higher than the store's${notes}.`,
    );
  }

  return {
    alreadyPublished: false,
    message: `${state.store}: highest ${state.unit} is ${highest.raw}, below this run's ${ours}: not published yet${notes}`,
  };
}
