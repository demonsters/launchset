/**
 * Applies the chosen action for each piece of conflicting machinery (spec 11.1 step 4):
 * `remove` deletes the workflow or script, `disable` removes or neutralizes only the
 * conflicting trigger, step, command or script part with a minimal splice (it never deletes
 * a file), `keep` does nothing. Every other byte of an edited file stays identical.
 */

import { rm, writeFile } from "node:fs/promises";
import { findNodeAtLocation, type Node as JsonNode, parseTree } from "jsonc-parser";
import { isMap, isScalar, isSeq, type Pair, type Scalar, type YAMLMap, type YAMLSeq } from "yaml";
import { escapeRegExp } from "../core/regex.ts";
import { detectEol, indentAt, lineEnd, lineOf, lineStart } from "../core/text.ts";
import { absolute, linesOf, readTextOrNull } from "./fs.ts";
import type { Edit, GitLabOp, MachineryFinding, ScriptCaller } from "./machinery.ts";
import { runsScript, topLevelCommands } from "./shell.ts";
import {
  itemLines,
  latestFlagRange,
  pairLines,
  removeListEntry,
  removeSeqItem,
  SpliceSet,
} from "./text-edit.ts";
import type { Change, MachineryAction } from "./types.ts";
import {
  isBlock,
  type RunCommand,
  runCommands,
  type ScalarRef,
  type Workflow,
  type WorkflowJob,
  type WorkflowStep,
} from "./workflow-scan.ts";

type WorkflowEdit = Extract<Edit, { kind: "workflow" }>;
type GitLabEdit = Extract<Edit, { kind: "gitlab" }>;
type Op = WorkflowEdit["op"];

interface WorkflowResult {
  text: string;
  notes: string[];
  /** Things to check by hand (references to removed steps or jobs). */
  followUps: string[];
}

/** Line number → [start, end of content, end including the newline]. */
function lineOffsets(text: string): Map<number, [number, number, number]> {
  const map = new Map<number, [number, number, number]>();
  const lines = linesOf(text);
  lines.forEach((l, i) => {
    const next = lines[i + 1];
    map.set(l.number, [l.start, l.start + l.text.length, next ? next.start : text.length]);
  });
  return map;
}

function keyStart(pair: Pair): number {
  return (pair.key as { range?: [number, number, number] }).range?.[0] ?? 0;
}

const NO_TAGS = (indent: string, eol: string) =>
  `${indent}branches: ["**"]${eol}${indent}tags-ignore: ["**"]${eol}`;

/** Apply the workflow ops of one file (all computed on the original text). */
export function retireWorkflow(workflow: Workflow, ops: Op[]): WorkflowResult {
  const text = workflow.text;
  const eol = detectEol(text);
  const edits = new SpliceSet();
  const notes: string[] = [];
  const followUps: string[] = [];
  const refChecks: { pattern: RegExp; message: (line: number) => string }[] = [];
  const offsets = lineOffsets(text);
  const removeLineNumbers = (numbers: number[]) => {
    for (const n of numbers) {
      const r = offsets.get(n);
      if (r) edits.remove(r[0], r[2]);
    }
  };
  const replaceLine = (n: number, content: string) => {
    const r = offsets.get(n);
    if (r) edits.add({ start: r[0], end: r[1], text: content });
  };

  const removedSteps = new Set<WorkflowStep>();
  const commandRemovals = new Map<WorkflowStep, RunCommand[]>();
  const neutralized = new Map<WorkflowStep, { commands: RunCommand[]; reason: string }>();
  const lineRemovals = new Map<WorkflowStep, number[]>();
  const latest = new Map<WorkflowStep, Extract<Op, { op: "remove-latest" }>>();
  const patterns: ScalarRef[] = [];
  const filters: Pair[] = [];
  const triggers: Pair[] = [];
  let excludeTags = false;
  for (const op of ops) {
    switch (op.op) {
      case "remove-step":
        removedSteps.add(op.step);
        break;
      case "remove-commands":
        commandRemovals.set(op.step, [...(commandRemovals.get(op.step) ?? []), ...op.commands]);
        break;
      case "neutralize-commands": {
        const entry = neutralized.get(op.step) ?? { commands: [], reason: op.reason };
        entry.commands.push(...op.commands);
        neutralized.set(op.step, entry);
        break;
      }
      case "remove-run-line":
        lineRemovals.set(op.step, [...(lineRemovals.get(op.step) ?? []), op.line]);
        break;
      case "remove-latest":
        latest.set(op.step, op);
        break;
      case "remove-tag-patterns":
        patterns.push(...op.patterns);
        break;
      case "remove-filter":
        filters.push(op.pair);
        break;
      case "remove-trigger":
        if (!triggers.includes(op.pair)) triggers.push(op.pair);
        break;
      case "exclude-tags":
        excludeTags = true;
        break;
    }
  }

  // A step whose every command goes is removed as a whole.
  for (const [step, commands] of commandRemovals) {
    if (!step.run) continue;
    const gone = new Set(commands.map((c) => c.lines[0]?.number));
    for (const c of neutralized.get(step)?.commands ?? []) gone.add(c.lines[0]?.number);
    if (runCommands(step.run, text).every((c) => gone.has(c.lines[0]?.number)))
      removedSteps.add(step);
  }

  const removedJobs = new Set<WorkflowJob>(
    workflow.jobs.filter((j) => j.steps.length > 0 && j.steps.every((s) => removedSteps.has(s))),
  );

  // Disable never deletes a workflow: when every job conflicts, the jobs stay and the
  // triggers become workflow_dispatch.
  if (removedJobs.size > 0 && removedJobs.size === workflow.jobs.length) {
    const on = workflow.triggers.pair;
    if (on) {
      const [s, e] = pairLines(text, on);
      const indent = indentAt(text, keyStart(on));
      edits.add({
        start: s,
        end: e,
        text: `${indent}on:${eol}${indent}  workflow_dispatch:${eol}`,
      });
      notes.push(
        "every job in it conflicts, so its triggers became workflow_dispatch (it only runs when started by hand)",
      );
      followUps.push(
        `${workflow.path} now only runs when started by hand: move the steps you still need into launchset-release.yml, then delete it.`,
      );
    }
    return { text: edits.apply(text), notes, followUps };
  }

  for (const job of removedJobs) {
    const [s, e] = pairLines(text, job.pair);
    edits.remove(s, e);
    notes.push(`removed job "${job.id}" (all its steps conflicted)`);
    refChecks.push({
      pattern: new RegExp(`\\bneeds\\.${escapeRegExp(job.id)}\\.`, "g"),
      message: (line) =>
        `Check ${workflow.path}:${line}: it uses needs.${job.id}, but init removed the job "${job.id}".`,
    });
  }
  for (const job of workflow.jobs) {
    if (removedJobs.has(job) || !job.needsPair) continue;
    const gone = job.needs.filter((n) => [...removedJobs].some((r) => r.id === n.value));
    if (gone.length === 0) continue;
    if (gone.length === job.needs.length || !isSeq(job.needsPair.value)) {
      const [s, e] = pairLines(text, job.needsPair);
      edits.remove(s, e);
    } else {
      for (const n of gone) removeSeqItem(text, job.needsPair.value as YAMLSeq, n.node, edits);
    }
    notes.push(`job "${job.id}" no longer needs ${gone.map((g) => `"${g.value}"`).join(", ")}`);
  }

  for (const job of workflow.jobs) {
    if (removedJobs.has(job) || !job.stepsSeq) continue;
    for (const step of job.steps) {
      if (!removedSteps.has(step)) continue;
      removeSeqItem(text, job.stepsSeq, step.node, edits);
      if (!step.id) continue;
      const id = step.id;
      refChecks.push({
        pattern: new RegExp(`\\bsteps\\.${escapeRegExp(id)}\\.`, "g"),
        message: (line) =>
          `Check ${workflow.path}:${line}: it uses steps.${id}, but init removed that step.`,
      });
    }
  }

  const live = (step: WorkflowStep) =>
    !removedSteps.has(step) &&
    !workflow.jobs.some((j) => removedJobs.has(j) && j.steps.includes(step));
  for (const [step, commands] of commandRemovals) {
    if (live(step)) removeLineNumbers(commands.flatMap((c) => c.lines.map((l) => l.number)));
  }
  for (const [step, { commands, reason }] of neutralized) {
    if (!live(step)) continue;
    // PowerShell has no `:`; `$null` is its no-op statement.
    const noop = step.shell === "powershell" ? "$null" : ":";
    for (const c of commands) {
      c.lines.forEach((l, i) => {
        const indent = /^[ \t]*/.exec(l.text)?.[0] ?? "";
        const trimmed = l.text.trim();
        replaceLine(
          l.number,
          i === 0
            ? `${indent}${noop}${c.trailingOp ? ` ${c.trailingOp}` : ""} # launchset: disabled — ${reason}: ${trimmed}`
            : `${indent}# ${trimmed}`,
        );
      });
    }
  }
  for (const [step, lines] of lineRemovals) {
    if (live(step)) removeLineNumbers(lines);
  }
  for (const [step, op] of latest) {
    if (!live(step)) continue;
    for (const ref of op.refs) {
      const [start, end] = ref.node.range ?? [0, 0];
      if (ref.flavor) {
        const index = text.indexOf("latest=true", start);
        if (index === -1 || index >= end)
          throw new Error(`internal: latest=true not found in ${workflow.path}`);
        edits.add({ start: index, end: index + "latest=true".length, text: "latest=false" });
        continue;
      }
      if (isBlock(ref.node)) {
        const line = linesOf(text).find(
          (l) => l.start > start && l.start < end && l.text.trim() === ref.entry,
        );
        if (line) {
          removeLineNumbers([line.number]);
          continue;
        }
      }
      if (!removeListEntry(text, ref.node, ref.entry, edits)) {
        throw new Error(`internal: can't find ${ref.entry} in ${workflow.path}`);
      }
    }
  }

  // Triggers
  const t = workflow.triggers;
  const tagsValue = t.tagsPair?.value;
  if (patterns.length > 0 && isSeq(tagsValue)) {
    for (const p of patterns) removeSeqItem(text, tagsValue as YAMLSeq, p.node, edits);
  }
  for (const pair of filters) {
    const [s, e] = pairLines(text, pair);
    edits.remove(s, e);
  }
  if (triggers.length > 0 && t.map) {
    const remaining = t.map.items.filter((i) => !triggers.includes(i as Pair)).length;
    triggers.forEach((pair, index) => {
      const [s, e] = pairLines(text, pair);
      if (remaining === 0 && index === 0) {
        edits.add({
          start: s,
          end: e,
          text: `${indentAt(text, keyStart(pair))}workflow_dispatch:${eol}`,
        });
      } else {
        edits.remove(s, e);
      }
    });
  }
  if (excludeTags && t.pair) {
    const on = t.pair;
    const base = indentAt(text, keyStart(on));
    const value = on.value;
    if (isScalar(value) || isSeq(value)) {
      const names = (isSeq(value) ? value.items : [value]).map((i) =>
        String((i as { value?: unknown }).value),
      );
      const body = names
        .map((n) =>
          n === "push"
            ? `${base}  push:${eol}${NO_TAGS(`${base}    `, eol)}`
            : `${base}  ${n}:${eol}`,
        )
        .join("");
      const [s, e] = pairLines(text, on);
      edits.add({ start: s, end: e, text: `${base}on:${eol}${body}` });
    } else if (t.pushPair) {
      const push = t.pushPair;
      const indent = indentAt(text, keyStart(push));
      if (isMap(push.value) && (push.value as YAMLMap).items.length > 0) {
        const first = (push.value as YAMLMap).items[0] as Pair;
        const at = lineEnd(text, keyStart(push));
        edits.add({ start: at, end: at, text: NO_TAGS(indentAt(text, keyStart(first)), eol) });
      } else {
        const [s, e] = pairLines(text, push);
        edits.add({ start: s, end: e, text: `${indent}push:${eol}${NO_TAGS(`${indent}  `, eol)}` });
      }
    }
  }
  // References left to removed steps and jobs, with their lines in the edited file.
  const out = edits.apply(text);
  for (const check of refChecks) {
    for (const m of out.matchAll(check.pattern))
      followUps.push(check.message(lineOf(out, m.index)));
  }
  return { text: out, notes, followUps };
}

/** `# launchset: disabled — <reason>: <line>` for the first line, `# <line>` for the others. */
function commentedLines(lines: { text: string }[], reason: string, indent?: string): string[] {
  return lines.map((l, i) => {
    const own = indent ?? /^[ \t]*/.exec(l.text)?.[0] ?? "";
    const trimmed = l.text.trim();
    return i === 0 ? `${own}# launchset: disabled — ${reason}: ${trimmed}` : `${own}# ${trimmed}`;
  });
}

/** The start of the comment lines right above `start` (same indentation, no blank line). */
export function commentsAbove(text: string, start: number): number {
  const indent = indentAt(text, start);
  let at = start;
  while (at > 0) {
    const prev = lineStart(text, at - 1);
    const line = text.slice(prev, at).replace(/\r?\n$/, "");
    if (!line.startsWith(`${indent}#`) || /^[ \t]/.test(line.slice(indent.length))) break;
    at = prev;
  }
  return at;
}

/**
 * Apply GitLab CI edits to one file (all computed on its original text): remove or hide jobs,
 * comment out script lines (or turn the last one into `":"`), disable commands inside block
 * scalars, drop `release:` keys, `-t …:latest` flags and include entries.
 */
export function retireGitLab(text: string, ops: GitLabOp[]): string {
  const edits = new SpliceSet();
  const offsets = lineOffsets(text);
  const replaceLines = (numbers: number[], content: string[]) => {
    numbers.forEach((n, i) => {
      const r = offsets.get(n);
      if (r) edits.add({ start: r[0], end: r[1], text: content[i] ?? "" });
    });
  };
  const itemLineNumbers = (node: Scalar): number[] => {
    const [s, e] = itemLines(text, node);
    const first = lineOf(text, s);
    const last = lineOf(text, Math.max(s, e - 1));
    return Array.from({ length: last - first + 1 }, (_, i) => first + i);
  };
  for (const op of ops) {
    switch (op.op) {
      case "remove-job": {
        const [s, e] = pairLines(text, op.job.pair);
        let from = commentsAbove(text, s);
        let to = e;
        // The last job: its blank line before goes too, so the file doesn't end in one.
        if (e === text.length && /\r?\n\r?\n$/.test(text.slice(0, from))) {
          from = text.slice(0, from).replace(/\r?\n$/, "").length;
        } else if (/(^|\n)[ \t]*\r?\n$/.test(text.slice(0, from))) {
          // A blank line on both sides: one of them goes, so no double blank line is left.
          const blank = /^[ \t]*\r?\n/.exec(text.slice(e));
          if (blank) to = e + blank[0].length;
        }
        edits.remove(from, to);
        break;
      }
      case "hide-job": {
        const key = op.job.pair.key as Scalar;
        const [start, end] = key.range ?? [0, 0];
        edits.add({
          start,
          end: key.type === "PLAIN" ? start : end,
          text: key.type === "PLAIN" ? "." : JSON.stringify(`.${op.job.name}`),
        });
        break;
      }
      case "comment-item":
      case "noop-item": {
        const node = op.item.ref.node;
        if (!op.inSeq) {
          // `script: <string>`: the value becomes the no-op.
          const [start, end] = node.range ?? [0, 0];
          edits.add({
            start,
            end,
            text: `":" # launchset: disabled — ${op.reason}: ${text.slice(start, end).trim()}`,
          });
          break;
        }
        const numbers = itemLineNumbers(node);
        const lines = numbers.map((n) => ({ text: linesOf(text)[n - 1]?.text ?? "" }));
        const indent = /^[ \t]*/.exec(lines[0]?.text ?? "")?.[0] ?? "";
        if (op.op === "comment-item") {
          replaceLines(numbers, commentedLines(lines, op.reason));
        } else {
          const [first, ...rest] = lines.map((l) => l.text.trim());
          replaceLines(numbers, [
            `${indent}- ${op.noop === undefined ? '":"' : `'${op.noop}'`} # launchset: disabled — ${op.reason}: ${(first ?? "").replace(/^-\s*/, "")}`,
            ...rest.map((r) => `${indent}  # ${r}`),
          ]);
        }
        break;
      }
      case "commands": {
        for (const c of op.commands) {
          if (c.removal === "neutralize") {
            c.lines.forEach((l, i) => {
              const indent = /^[ \t]*/.exec(l.text)?.[0] ?? "";
              const trimmed = l.text.trim();
              replaceLines(
                [l.number],
                [
                  i === 0
                    ? `${indent}${op.noop ?? ":"}${c.trailingOp ? ` ${c.trailingOp}` : ""} # launchset: disabled — ${op.reason}: ${trimmed}`
                    : `${indent}# ${trimmed}`,
                ],
              );
            });
          } else {
            replaceLines(
              c.lines.map((l) => l.number),
              commentedLines(c.lines, op.reason),
            );
          }
        }
        break;
      }
      case "remove-pair": {
        const [s, e] = pairLines(text, op.pair);
        edits.remove(s, e);
        break;
      }
      case "remove-flag": {
        const range = latestFlagRange(text, op.item.ref.node, op.entry);
        if (!range) throw new Error(`internal: can't find ${op.entry} in the script`);
        edits.remove(range[0], range[1]);
        break;
      }
      case "remove-seq-items": {
        for (const item of op.items) removeSeqItem(text, op.seq, item, edits);
        break;
      }
      case "remove-include": {
        const { include } = op;
        if (include.seq && include.seq.items.length > 1) {
          removeSeqItem(text, include.seq, include.node, edits);
        } else {
          const [s, e] = pairLines(text, include.pair);
          edits.remove(s, e);
        }
        break;
      }
    }
  }
  return edits.apply(text);
}

/**
 * Remove top-level commands (see `topLevelCommands`) from a script command. The commands left
 * are joined with `;` where a `;` stood anywhere between them (the later one ran regardless), and
 * with `&&` otherwise. Callers only drop commands joined with `&&` or `;` (see `droppable`).
 */
export function removeSegments(command: string, segments: string[]): string | null {
  const { parts, ops } = topLevelCommands(command);
  let out = "";
  let prev: number | undefined;
  parts.forEach((part, i) => {
    if (part === "" || segments.includes(part)) return;
    if (prev !== undefined) out += ops.slice(prev, i).includes(";") ? "; " : " && ";
    out += part;
    prev = i;
  });
  return out.trim() === "" ? null : out;
}

/** Splice a property out of a JSON object, with its separating comma (nothing else moves). */
export function removeJsonProperty(text: string, prop: JsonNode): string {
  const siblings = prop.parent?.children ?? [prop];
  const index = siblings.indexOf(prop);
  const start = prop.offset;
  const end = prop.offset + prop.length;
  let from = start;
  let to = end;
  const next = siblings[index + 1];
  const prev = siblings[index - 1];
  if (next) {
    to = next.offset;
  } else if (prev) {
    from = prev.offset + prev.length;
  } else {
    const ls = lineStart(text, start);
    const le = lineEnd(text, end);
    if (text.slice(ls, start).trim() === "" && text.slice(end, le).trim() === "") {
      from = ls;
      to = le;
    }
  }
  return text.slice(0, from) + text.slice(to);
}

/** Apply script edits to a package.json text with minimal splices. */
export function editScripts(
  text: string,
  edits: { script: string; segments?: string[] }[],
  path: string,
): string {
  let out = text;
  const byScript = new Map<string, { whole: boolean; segments: string[] }>();
  for (const e of edits) {
    const entry = byScript.get(e.script) ?? { whole: false, segments: [] };
    if (e.segments === undefined) entry.whole = true;
    else entry.segments.push(...e.segments);
    byScript.set(e.script, entry);
  }
  for (const [script, { whole, segments }] of byScript) {
    const tree = parseTree(out);
    const node = tree ? findNodeAtLocation(tree, ["scripts", script]) : undefined;
    if (!node || typeof node.value !== "string" || !node.parent) {
      throw new Error(`internal: script "${script}" not found in ${path}`);
    }
    const next = whole ? null : removeSegments(node.value, segments);
    out =
      next === null
        ? removeJsonProperty(out, node.parent)
        : out.slice(0, node.offset) + JSON.stringify(next) + out.slice(node.offset + node.length);
  }
  return out;
}

/**
 * Comment lines out (`#` languages), keeping their indentation. A line in `noops` becomes the
 * shell no-op `:` (with its trailing `&&` / `||` / `|`) followed by the comment.
 */
export function commentLines(
  text: string,
  numbers: number[],
  reason: string,
  noops: { line: number; trailingOp?: string }[] = [],
): string {
  const set = new SpliceSet();
  for (const line of linesOf(text)) {
    if (!numbers.includes(line.number)) continue;
    const indent = /^[ \t]*/.exec(line.text)?.[0] ?? "";
    const noop = noops.find((n) => n.line === line.number);
    const prefix = noop ? `:${noop.trailingOp ? ` ${noop.trailingOp}` : ""} ` : "";
    set.add({
      start: line.start,
      end: line.start + line.text.length,
      text: `${indent}${prefix}# launchset: disabled — ${reason}: ${line.text.trim()}`,
    });
  }
  return set.apply(text);
}

export interface ChosenAction {
  finding: MachineryFinding;
  action: MachineryAction;
}

export interface RetirementResult {
  changes: Change[];
  /** Things to check by hand afterwards. */
  followUps: string[];
}

/**
 * Apply the chosen actions. Returns one change per file touched; `write: false` computes
 * them without touching the disk.
 */
export async function applyRetirement(
  root: string,
  chosen: ChosenAction[],
  options: { write: boolean } = { write: true },
): Promise<RetirementResult> {
  const edits: Edit[] = [];
  const summaries = new Map<string, string[]>();
  for (const { finding, action } of chosen) {
    if (action === "keep") continue;
    const list = finding.edits[action];
    if (!list) throw new Error(`internal: ${finding.item.id} has no "${action}" edits`);
    edits.push(...list);
    for (const e of list) {
      const s = summaries.get(e.path) ?? [];
      const effect = finding.item.effects[action];
      const line =
        e.path === finding.item.path
          ? `${action}d ${finding.item.what}${effect ? ` (${effect})` : ""}`
          : `stopped running ${finding.item.path} (${finding.item.id})`;
      if (!s.includes(line)) s.push(line);
      summaries.set(e.path, s);
    }
  }
  const paths = [...new Set(edits.map((e) => e.path))];
  const changes: Change[] = [];
  const followUps: string[] = [];
  /** Each edited file's text after the edits (`null`: deleted). */
  const finalTexts = new Map<string, string | null>();
  for (const path of paths) {
    const forPath = edits.filter((e) => e.path === path);
    const summary = summaries.get(path) ?? [];
    const file = absolute(root, path);
    if (forPath.some((e) => e.kind === "delete-file")) {
      finalTexts.set(path, null);
      if (options.write) await rm(file, { force: true });
      changes.push({ path, action: "deleted", summary: summary.join("; ") || "deleted" });
      continue;
    }
    const original = await readTextOrNull(file);
    if (original === null) throw new Error(`internal: ${path} disappeared during init`);
    let text = original;
    const notes: string[] = [];
    const workflowOps = forPath.filter((e): e is WorkflowEdit => e.kind === "workflow");
    if (workflowOps.length > 0) {
      const result = retireWorkflow(
        workflowOps[0]?.workflow as Workflow,
        workflowOps.map((e) => e.op),
      );
      text = result.text;
      notes.push(...result.notes);
      followUps.push(...result.followUps);
    }
    const gitlab = forPath.filter((e): e is GitLabEdit => e.kind === "gitlab");
    if (gitlab.length > 0) {
      if (gitlab[0]?.text !== text) throw new Error(`internal: ${path} changed during init`);
      text = retireGitLab(
        text,
        gitlab.map((e) => e.op),
      );
    }
    for (const e of forPath) {
      if (e.kind === "comment-lines") text = commentLines(text, e.lines, e.reason, e.noops);
    }
    const scripts = forPath.filter((e) => e.kind === "script");
    if (scripts.length > 0) text = editScripts(text, scripts, path);

    finalTexts.set(path, text);
    if (text !== original) {
      if (options.write) await writeFile(file, text);
      changes.push({ path, action: "updated", summary: [...summary, ...notes].join("; ") });
    }
  }
  followUps.push(...(await callerFollowUps(root, edits, finalTexts)));
  return { changes, followUps };
}

/**
 * Follow-ups for the places that still run a removed `package.json` script by name after the
 * edits (`npm run release` in a workflow, another script), since that call now fails.
 */
async function callerFollowUps(
  root: string,
  edits: Edit[],
  finalTexts: Map<string, string | null>,
): Promise<string[]> {
  const textOf = async (path: string) =>
    finalTexts.has(path)
      ? (finalTexts.get(path) ?? null)
      : await readTextOrNull(absolute(root, path));
  const out: string[] = [];
  for (const e of edits) {
    if (e.kind !== "script" || !e.callers) continue;
    const pkg = await textOf(e.path);
    const tree = pkg === null ? undefined : parseTree(pkg);
    if (tree && typeof findNodeAtLocation(tree, ["scripts", e.script])?.value === "string")
      continue;
    for (const caller of e.callers) {
      if (!(await stillCalls(caller, e.script, textOf))) continue;
      const line = `${caller.path}:${caller.line}: ${caller.what} runs the script "${e.script}", which init removed from ${e.path}. Remove that call, or point it at what should run now.`;
      if (!out.includes(line)) out.push(line);
    }
  }
  return out;
}

async function stillCalls(
  caller: ScriptCaller,
  script: string,
  textOf: (path: string) => Promise<string | null>,
): Promise<boolean> {
  const text = await textOf(caller.path);
  if (text === null) return false;
  if (caller.check.kind === "line") {
    const wanted = caller.check.text;
    return linesOf(text).some((l) => l.text.includes(wanted));
  }
  const tree = parseTree(text);
  const value = tree
    ? findNodeAtLocation(tree, ["scripts", caller.check.script])?.value
    : undefined;
  return typeof value === "string" && runsScript(value, script);
}
