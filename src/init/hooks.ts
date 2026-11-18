/**
 * Pre-push hook (spec 11.1 step 8): add `launchset check --push` to an existing
 * simple-git-hooks, husky or lefthook setup. Never sets up a hook tool that isn't there.
 */

import { chmod, writeFile } from "node:fs/promises";
import { applyEdits, findNodeAtLocation, modify, parseTree } from "jsonc-parser";
import { isMap, parseDocument, type YAMLMap } from "yaml";
import { absolute, isDirectory, readTextOrNull } from "./fs.ts";
import { eolOf } from "./text-edit.ts";
import type { Change, DetectedHook } from "./types.ts";

export const HOOK_COMMAND = "npx @demonsters/launchset check --push";

const installed = (text: string | null | undefined) =>
  text !== null && text !== undefined && /launchset(?:@\S+)?\s+check\s+--push/.test(text);

const LEFTHOOK_FILES = ["lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".lefthook.yaml"];
const SIMPLE_GIT_HOOKS_FILES = [".simple-git-hooks.json", "simple-git-hooks.json"];

/** Hook setups in the repo root. */
export async function detectHooks(root: string): Promise<DetectedHook[]> {
  const hooks: DetectedHook[] = [];
  if (await isDirectory(absolute(root, ".husky"))) {
    const text = await readTextOrNull(absolute(root, ".husky/pre-push"));
    hooks.push({ tool: "husky", path: ".husky/pre-push", installed: installed(text) });
  }
  const pkgText = await readTextOrNull(absolute(root, "package.json"));
  const tree = pkgText ? parseTree(pkgText) : undefined;
  const sgh = tree ? findNodeAtLocation(tree, ["simple-git-hooks"]) : undefined;
  if (sgh?.type === "object") {
    const pre = findNodeAtLocation(sgh, ["pre-push"]);
    hooks.push({
      tool: "simple-git-hooks",
      path: "package.json",
      installed: typeof pre?.value === "string" && installed(pre.value),
    });
  } else {
    for (const name of SIMPLE_GIT_HOOKS_FILES) {
      const text = await readTextOrNull(absolute(root, name));
      if (text === null) continue;
      hooks.push({ tool: "simple-git-hooks", path: name, installed: installed(text) });
      break;
    }
  }
  for (const name of LEFTHOOK_FILES) {
    const text = await readTextOrNull(absolute(root, name));
    if (text === null) continue;
    hooks.push({ tool: "lefthook", path: name, installed: installed(text) });
    break;
  }
  return hooks;
}

/** Adds the hook command. Returns the change, or a note when it has to be done by hand. */
export async function installHook(
  root: string,
  hook: DetectedHook,
): Promise<{ change?: Change; note?: string }> {
  if (hook.installed) return { note: `${hook.path} already runs \`launchset check --push\`.` };
  const file = absolute(root, hook.path);
  const text = await readTextOrNull(file);
  switch (hook.tool) {
    case "husky": {
      if (text === null) {
        await writeFile(file, `${HOOK_COMMAND}\n`);
        await chmod(file, 0o755);
        return {
          change: {
            path: hook.path,
            action: "created",
            summary: `pre-push hook runs \`${HOOK_COMMAND}\``,
          },
        };
      }
      const eol = eolOf(text);
      const sep = text === "" || text.endsWith("\n") ? "" : eol;
      await writeFile(file, `${text}${sep}${HOOK_COMMAND}${eol}`);
      return {
        change: {
          path: hook.path,
          action: "updated",
          summary: `pre-push hook also runs \`${HOOK_COMMAND}\``,
        },
      };
    }
    case "simple-git-hooks": {
      if (text === null) return { note: `${hook.path} is missing.` };
      const base = hook.path === "package.json" ? ["simple-git-hooks"] : [];
      const tree = parseTree(text);
      const existing = tree ? findNodeAtLocation(tree, [...base, "pre-push"]) : undefined;
      const value =
        typeof existing?.value === "string" && existing.value.trim() !== ""
          ? `${existing.value} && ${HOOK_COMMAND}`
          : HOOK_COMMAND;
      const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? "  ";
      const out = applyEdits(
        text,
        modify(text, [...base, "pre-push"], value, {
          formattingOptions: {
            insertSpaces: !indent.includes("\t"),
            tabSize: indent.includes("\t") ? 1 : indent.length,
            eol: eolOf(text),
          },
        }),
      );
      await writeFile(file, out);
      return {
        change: {
          path: hook.path,
          action: "updated",
          summary: `simple-git-hooks pre-push runs \`${HOOK_COMMAND}\` (run \`npx simple-git-hooks\` to install it)`,
        },
      };
    }
    case "lefthook": {
      if (text === null) return { note: `${hook.path} is missing.` };
      const out = addLefthookCommand(text);
      if (out === null) {
        return {
          note: `Add \`${HOOK_COMMAND}\` to the pre-push hook in ${hook.path} by hand (its pre-push section has no commands map).`,
        };
      }
      await writeFile(file, out);
      return {
        change: {
          path: hook.path,
          action: "updated",
          summary: `lefthook pre-push runs \`${HOOK_COMMAND}\``,
        },
      };
    }
  }
}

/** Insert the command into a lefthook config; `null` when its shape isn't supported. */
export function addLefthookCommand(text: string): string | null {
  const eol = eolOf(text);
  const doc = parseDocument(text);
  if (doc.errors.length > 0 || (doc.contents !== null && !isMap(doc.contents))) return null;
  const root = doc.contents as YAMLMap | null;
  const prePush = root?.get("pre-push", true);
  if (prePush === undefined) {
    const sep = text === "" || text.endsWith("\n") ? "" : eol;
    return `${text}${sep}pre-push:${eol}  commands:${eol}    launchset:${eol}      run: ${HOOK_COMMAND}${eol}`;
  }
  if (!isMap(prePush) || prePush.flow) return null;
  const commands = prePush.get("commands", true);
  if (!isMap(commands) || commands.flow || commands.items.length === 0) return null;
  const firstKey = commands.items[0]?.key as { range?: [number, number, number] } | undefined;
  const keyStart = firstKey?.range?.[0];
  if (keyStart === undefined) return null;
  const lineStart = text.lastIndexOf("\n", keyStart - 1) + 1;
  const indent = text.slice(lineStart, keyStart);
  if (!/^[ ]+$/.test(indent)) return null;
  const inner = `${indent}${indent.length >= 4 ? indent.slice(0, indent.length / 2) : "  "}`;
  return `${text.slice(0, lineStart)}${indent}launchset:${eol}${inner}run: ${HOOK_COMMAND}${eol}${text.slice(lineStart)}`;
}
