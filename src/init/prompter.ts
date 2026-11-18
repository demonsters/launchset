/** Interactive prompts for `launchset init` in a TTY (spec 11), built on @clack/prompts. */

import { isCancel, log, note, select, text } from "@clack/prompts";
import { LaunchsetError } from "../core/errors.ts";
import type { Decision, Prompter } from "./types.ts";

const OTHER = "\u0000other";

function cancelled(): never {
  throw new LaunchsetError("cancelled", "init was cancelled; nothing was written.");
}

/** A {@link Prompter} that asks in the terminal. */
export function clackPrompter(): Prompter {
  return {
    async ask(decision: Decision, validate?: (value: string) => string | undefined) {
      if (decision.evidence.length > 0) {
        log.info(
          decision.evidence
            .slice(0, 5)
            .map((e) => `${e.path}${e.line ? `:${e.line}` : ""}: ${e.note}`)
            .join("\n"),
        );
      }
      const options = decision.options.map((o) => ({ value: o.value, label: o.label }));
      if (decision.freeform)
        options.push({ value: OTHER, label: `Something else (${decision.freeform})` });
      let value: string | symbol = decision.default;
      if (options.length > 1 || !decision.freeform) {
        value = await select({
          message: decision.question,
          options,
          initialValue: decision.options.some((o) => o.value === decision.default)
            ? decision.default
            : options[0]?.value,
        });
        if (isCancel(value)) cancelled();
      }
      if (value === OTHER || (decision.freeform && options.length <= 1)) {
        value = await text({
          message: decision.question,
          initialValue: decision.default,
          validate: (input) => (validate ? validate(input ?? "") : undefined),
        });
        if (isCancel(value)) cancelled();
      }
      return String(value);
    },
    note(message: string, title?: string) {
      note(message, title);
    },
  };
}
