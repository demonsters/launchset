/** action/README.md documents every input and output of action.yml, and its tables are generated. */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { COMMANDS } from "../../action/src/inputs.ts";
import { expectedReadme, renderReadme } from "../../scripts/build-action.ts";

const actionDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../action");
const read = (name: string) => readFile(resolve(actionDir, name), "utf8");

describe("action/README.md", () => {
  it("is in sync with action.yml (run `node scripts/build-action.ts --write-readme`)", async () => {
    expect(await read("README.md")).toBe(await expectedReadme());
  });

  it("lists every input and output of action.yml", async () => {
    const action = parse(await read("action.yml")) as {
      inputs: Record<string, unknown>;
      outputs: Record<string, unknown>;
    };
    const readme = await read("README.md");
    for (const name of [...Object.keys(action.inputs), ...Object.keys(action.outputs)]) {
      expect(readme, name).toContain(`| \`${name}\` |`);
    }
  });

  it("mentions every command, and the docs link", async () => {
    const readme = await read("README.md");
    for (const command of COMMANDS) expect(readme, command).toContain(`\`${command}\``);
    expect(readme).toContain("https://github.com/demonsters/launchset/tree/main/docs");
  });

  it("the generator escapes markdown and needs its markers", () => {
    const action = {
      inputs: { a: { description: "x | y <z>", required: true } },
      outputs: { b: { description: "one\n  two" } },
    };
    const text = renderReadme(
      "<!-- inputs:start -->\n<!-- inputs:end -->\n<!-- outputs:start -->\n<!-- outputs:end -->",
      action,
    );
    expect(text).toContain("| `a` | x \\| y &lt;z&gt; | required |");
    expect(text).toContain("| `b` | one two |");
    expect(() => renderReadme("no markers", action)).toThrow(/markers/);
  });
});

describe("action.yml", () => {
  it("declares every command of the action in the command input, and the node24 runtime", async () => {
    const action = parse(await read("action.yml")) as {
      inputs: { command: { description: string } };
      runs: { using: string; main: string };
    };
    for (const command of COMMANDS) expect(action.inputs.command.description).toContain(command);
    expect(action.runs).toEqual({ using: "node24", main: "dist/index.js" });
  });
});
