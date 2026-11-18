/** Interactive prompts for `launchset add` (only used when stdin is a terminal). */

import { cancel, isCancel, select, text } from "@clack/prompts";
import { LaunchsetError } from "../core/errors.ts";
import type { Bump } from "../core/types.ts";

export interface AddPrompts {
  bump(): Promise<Bump>;
  summary(): Promise<string>;
}

function cancelled(): never {
  cancel("Cancelled.");
  throw new LaunchsetError("cancelled", "add was cancelled; no changeset was written.");
}

export function clackAddPrompts(): AddPrompts {
  return {
    async bump() {
      const value = await select<Bump>({
        message: "What kind of change is this?",
        initialValue: "patch",
        options: [
          { value: "patch", label: "patch", hint: "bug fix, small change" },
          { value: "minor", label: "minor", hint: "new feature, backwards compatible" },
          { value: "major", label: "major", hint: "breaking change" },
          { value: "none", label: "none", hint: "no release needed" },
        ],
      });
      if (isCancel(value)) cancelled();
      return value;
    },
    async summary() {
      const value = await text({
        message: "Summary (goes into the changelog)",
        placeholder: "Fix the crash when opening the settings screen",
        validate: (input) => ((input ?? "").trim() === "" ? "Write a short summary." : undefined),
      });
      if (isCancel(value)) cancelled();
      return String(value);
    },
  };
}
