/**
 * The edits init makes to a project's GitLab CI files (design/GITLAB.md phase 5): add the
 * include of `.gitlab/launchset.yml` to an existing `.gitlab-ci.yml`, pick the stage for
 * launchset's jobs, add missing target jobs to `.gitlab/launchset-targets.yml`. Every edit is a
 * splice on the original text, so comments and formatting stay. Pure.
 */

import { isMap, isScalar, isSeq, type Node, parseDocument, type YAMLMap, type YAMLSeq } from "yaml";
import { detectEol, indentAt, lineEnd, lineStart } from "../core/text.ts";
import { targetJobName } from "../templates/gitlab-child.ts";
import { GITLAB_CUSTOM_TAGS, parseGitLabYaml } from "../templates/gitlab-yaml.ts";
import { linesOf } from "./fs.ts";
import { fullLines, SpliceSet } from "./text-edit.ts";
import { pairOf } from "./workflow-scan.ts";

function range(node: unknown): [number, number] | undefined {
  const r = (node as { range?: [number, number, number] } | null | undefined)?.range;
  return r ? [r[0], r[1]] : undefined;
}

/** True when an include value (string, map, list) already includes `local`. */
function includesLocal(value: unknown, local: string): boolean {
  const same = (path: unknown) =>
    typeof path === "string" && path.replace(/^\.?\/+/, "") === local.replace(/^\.?\/+/, "");
  const entries = isSeq(value) ? (value as YAMLSeq).items : [value];
  return entries.some((entry) => {
    if (isScalar(entry)) return same(entry.value);
    if (isMap(entry)) return same((entry as YAMLMap).get("local"));
    return false;
  });
}

/** The indentation one level down, as the file writes it (default two spaces). */
function indentUnit(text: string): string {
  for (const line of linesOf(text)) {
    const m = /^([ \t]+)\S/.exec(line.text);
    if (m && !line.text.trim().startsWith("#")) return m[1] as string;
  }
  return "  ";
}

/** Offset of the end of the line content holding `offset` (before its line ending). */
function contentEnd(text: string, offset: number): number {
  let end = lineEnd(text, offset);
  if (text[end - 1] === "\n") end--;
  if (text[end - 1] === "\r") end--;
  return end;
}

export type IncludeEdit =
  | { text: string; changed: false }
  | { text: string; changed: true; summary: string }
  | { error: string };

/**
 * Add `- local: <local>` to the top-level `include:` of a `.gitlab-ci.yml`: appended to a block
 * or flow list, a single string or map turned into a list with the least change, or a new
 * `include:` block at the end of the file. Nothing changes when it's already included.
 */
export function addLocalInclude(text: string, local: string): IncludeEdit {
  const doc = parseDocument(text, { customTags: GITLAB_CUSTOM_TAGS });
  if (doc.errors.length > 0) return { error: "it isn't valid YAML" };
  const eol = detectEol(text);
  const unit = indentUnit(text);
  const entry = `local: ${local}`;
  const edits = new SpliceSet();
  const finish = (summary: string): IncludeEdit => {
    const out = edits.apply(text);
    const check = parseDocument(out, { customTags: GITLAB_CUSTOM_TAGS });
    const pair = isMap(check.contents) ? pairOf(check.contents as YAMLMap, "include") : undefined;
    if (check.errors.length > 0 || !pair || !includesLocal(pair.value, local)) {
      return { error: "the include: key is written in a form init can't extend" };
    }
    return { text: out, changed: true, summary };
  };
  if (doc.contents !== null && !isMap(doc.contents)) {
    return { error: "it has no top-level map of keys" };
  }
  const root = doc.contents as YAMLMap | null;
  const pair = root ? pairOf(root, "include") : undefined;
  if (!pair) {
    const sep =
      text === ""
        ? ""
        : text.endsWith(`${eol}${eol}`)
          ? ""
          : text.endsWith(eol)
            ? eol
            : `${eol}${eol}`;
    edits.add({
      start: text.length,
      end: text.length,
      text: `${sep}include:${eol}${unit}- ${entry}${eol}`,
    });
    return finish(`added include: - ${entry}`);
  }
  const value = pair.value as Node | null;
  if (includesLocal(value, local)) return { text, changed: false };
  const keyStart = range(pair.key)?.[0] ?? 0;
  const base = indentAt(text, keyStart);

  if (isSeq(value)) {
    const seq = value as YAMLSeq;
    const r = range(seq);
    if (!r) return { error: "the include: list has no source position" };
    if (seq.flow) {
      const close = text.lastIndexOf("]", r[1] - 1);
      if (close < r[0]) return { error: "the include: list isn't closed" };
      const empty = text.slice(r[0] + 1, close).trim() === "";
      edits.add({ start: close, end: close, text: `${empty ? "" : ", "}{ ${entry} }` });
      return finish(`added { ${entry} } to the include: list`);
    }
    const first = seq.items[0];
    const last = seq.items.at(-1);
    const fr = range(first);
    const lr = range(last);
    if (!fr || !lr) return { error: "the include: list has no source position" };
    const indent = indentAt(text, fr[0]);
    const end = fullLines(text, lr[0], lr[1])[1];
    const newline = end > 0 && text[end - 1] !== "\n" ? eol : "";
    edits.add({ start: end, end, text: `${newline}${indent}- ${entry}${eol}` });
    return finish(`added - ${entry} to the include: list`);
  }

  if (isMap(value)) {
    const map = value as YAMLMap;
    const r = range(map);
    if (!r) return { error: "the include: map has no source position" };
    if (map.flow) {
      edits.add({ start: r[0], end: r[0], text: "[" });
      edits.add({ start: r[1], end: r[1], text: `, { ${entry} }]` });
      return finish(`made include: a list and added { ${entry} }`);
    }
    // `include:` + an indented map: the map becomes the first item of a list.
    const [start, end] = fullLines(text, r[0], r[1]);
    const lines = linesOf(text.slice(start, end)).filter(
      (l, i, all) => i < all.length - 1 || l.text !== "",
    );
    const indent = indentAt(text, r[0]);
    const firstContent = lines.findIndex(
      (l) => l.text.trim() !== "" && !l.text.trim().startsWith("#"),
    );
    lines.forEach((l, i) => {
      if (l.text.trim() === "") return;
      const at = start + l.start;
      if (i === firstContent) {
        edits.add({ start: at + indent.length, end: at + indent.length, text: "- " });
      } else if (i > firstContent) {
        edits.add({ start: at, end: at, text: "  " });
      }
    });
    const newline = end > 0 && text[end - 1] !== "\n" ? eol : "";
    edits.add({ start: end, end, text: `${newline}${indent}- ${entry}${eol}` });
    return finish(`made include: a list and added - ${entry}`);
  }

  if (isScalar(value) && typeof value.value === "string") {
    const r = range(value);
    if (!r) return { error: "the include: value has no source position" };
    const source = text.slice(r[0], r[1]);
    if (source.includes("\n")) return { error: "the include: value spans several lines" };
    const ws = /[ \t]*$/.exec(text.slice(lineStart(text, r[0]), r[0]))?.[0].length ?? 0;
    const lineEndAt = contentEnd(text, r[1]);
    edits.add({ start: r[0] - ws, end: r[1], text: `${eol}${base}${unit}- ${source}` });
    edits.add({ start: lineEndAt, end: lineEndAt, text: `${eol}${base}${unit}- ${entry}` });
    return finish(`made include: a list and added - ${entry}`);
  }

  if (value === null || (isScalar(value) && (value.value === null || value.value === undefined))) {
    // `include:` without a value.
    const at = contentEnd(text, keyStart);
    const r = range(value);
    const start =
      r && r[1] > r[0] ? r[0] - (/[ \t]*$/.exec(text.slice(0, r[0]))?.[0].length ?? 0) : at;
    edits.add({ start, end: r && r[1] > r[0] ? r[1] : at, text: `${eol}${base}${unit}- ${entry}` });
    return finish(`added - ${entry} to the empty include:`);
  }
  return { error: "the include: value is neither a list, a map nor a string" };
}

/**
 * The stage for launchset's jobs in a project with `stages:`: `test` when it's listed, else the
 * last stage that isn't `.pre` or `.post`. Undefined when there's no such stage.
 */
export function pickStage(stages: readonly string[]): string | undefined {
  if (stages.includes("test")) return "test";
  return [...stages].reverse().find((s) => s !== ".pre" && s !== ".post");
}

/** The `workflow:` block of a rendered `.gitlab-ci.yml` (to print as a recommendation). */
export function workflowBlock(content: string): string {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.startsWith("workflow:"));
  if (start === -1) return "";
  const out = [lines[start] as string];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && !/^[ \t]/.test(line)) break;
    out.push(line);
  }
  while (out.at(-1)?.trim() === "") out.pop();
  return out.join("\n");
}

/** Targets whose `.launchset-<target>` job the targets file lacks; an error when it doesn't parse. */
export function missingTargetJobs(
  text: string,
  targets: readonly string[],
): string[] | { error: string } {
  let doc: unknown;
  try {
    doc = parseGitLabYaml(text);
  } catch (error) {
    return { error: (error as Error).message.split("\n")[0] ?? "invalid YAML" };
  }
  const jobs = doc && typeof doc === "object" ? (doc as Record<string, unknown>) : {};
  return targets.filter((t) => !(targetJobName(t) in jobs));
}

/** `text` with `block` appended (separated by a line break; the block starts with its own blank line). */
export function appendBlock(text: string, block: string): string {
  const eol = detectEol(text);
  const body = block.replace(/\r?\n/g, eol).replace(/(\r?\n)+$/, "");
  const sep = text === "" || text.endsWith(eol) ? "" : eol;
  return `${text}${sep}${body}${eol}`;
}

/** Comment lines above the `.launchset-<target>:` line of a rendered target job. */
export function commentAboveJob(job: string, target: string, comment: string[]): string {
  if (comment.length === 0) return job;
  const key = `${targetJobName(target)}:`;
  const lines = job.split("\n");
  const at = lines.indexOf(key);
  if (at === -1) return job;
  lines.splice(at, 0, ...comment.map((c) => `# ${c}`));
  return lines.join("\n");
}
