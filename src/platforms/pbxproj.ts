/**
 * `project.pbxproj` stamper (spec 6, 6.4 `xcodeproj`).
 *
 * The file is an old-style (NeXT) property list. We parse it only far enough to walk the
 * object graph (`PBXNativeTarget` -> `buildConfigurationList` -> `XCBuildConfiguration`) and to
 * know the exact character range of each `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` value
 * that belongs to a selected target. Edits splice only those ranges: quotes, tabs, comments and
 * line endings stay as they are.
 *
 * Rules:
 * - Default selection: every native target that sets either value in one of its configurations
 *   (app, extensions, widgets). Test targets without the settings are skipped. With
 *   `targets`, exactly those targets.
 * - The `PBXProject`-level configuration list and unselected targets are never touched.
 * - A selected target must set every value that is being written, in every configuration.
 * - Values that are build-setting references (`$(...)`) are never overwritten.
 * - Configurations shared between targets are stamped once.
 */

import { assertBuildNumber, assertIosMarketing, isBuildSettingReference } from "./ios-version.ts";
import {
  applySplices,
  type FoundValue,
  lineOf,
  type Splice,
  StampError,
  type TextStamper,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Old-style plist parser (positions only matter for string values)
// ---------------------------------------------------------------------------

interface PString {
  kind: "string";
  /** Decoded value (without quotes, escapes resolved). */
  value: string;
  /** Range of the raw token in the text, including quotes. */
  start: number;
  end: number;
  quoted: boolean;
}

interface PEntry {
  key: string;
  value: PNode;
}

interface PDict {
  kind: "dict";
  entries: PEntry[];
}

interface PArray {
  kind: "array";
  items: PNode[];
}

type PNode = PString | PDict | PArray;

const STRING_STOP = new Set([" ", "\t", "\r", "\n", "{", "}", "(", ")", "=", ";", ",", '"']);

class PlistParser {
  private pos = 0;
  private readonly text: string;
  private readonly file: string;

  constructor(text: string, file: string) {
    this.text = text;
    this.file = file;
    if (text.charCodeAt(0) === 0xfeff) this.pos = 1;
  }

  parseRoot(): PDict {
    this.skipTrivia();
    const root = this.parseValue();
    this.skipTrivia();
    if (this.pos < this.text.length) this.fail("unexpected content after the top-level dictionary");
    if (root.kind !== "dict") this.fail("the top level must be a dictionary `{ ... }`");
    return root;
  }

  private fail(message: string): never {
    throw new StampError(
      this.file,
      `can't parse as an Xcode project file (line ${lineOf(this.text, this.pos)}): ${message}`,
    );
  }

  private skipTrivia(): void {
    const t = this.text;
    for (;;) {
      const c = t[this.pos];
      if (c === " " || c === "\t" || c === "\r" || c === "\n") {
        this.pos++;
      } else if (c === "/" && t[this.pos + 1] === "*") {
        const close = t.indexOf("*/", this.pos + 2);
        if (close < 0) this.fail("unterminated /* comment");
        this.pos = close + 2;
      } else if (c === "/" && t[this.pos + 1] === "/") {
        const nl = t.indexOf("\n", this.pos);
        this.pos = nl < 0 ? t.length : nl + 1;
      } else {
        return;
      }
    }
  }

  private parseValue(): PNode {
    const c = this.text[this.pos];
    if (c === "{") return this.parseDict();
    if (c === "(") return this.parseArray();
    if (c === '"') return this.parseQuoted();
    return this.parseUnquoted();
  }

  private parseDict(): PDict {
    this.pos++; // {
    const entries: PEntry[] = [];
    for (;;) {
      this.skipTrivia();
      const c = this.text[this.pos];
      if (c === undefined) this.fail("unterminated dictionary, expected `}`");
      if (c === "}") {
        this.pos++;
        return { kind: "dict", entries };
      }
      const key = c === '"' ? this.parseQuoted() : this.parseUnquoted();
      this.skipTrivia();
      if (this.text[this.pos] !== "=") this.fail(`expected "=" after key "${key.value}"`);
      this.pos++;
      this.skipTrivia();
      const value = this.parseValue();
      this.skipTrivia();
      if (this.text[this.pos] !== ";") this.fail(`expected ";" after the value of "${key.value}"`);
      this.pos++;
      entries.push({ key: key.value, value });
    }
  }

  private parseArray(): PArray {
    this.pos++; // (
    const items: PNode[] = [];
    for (;;) {
      this.skipTrivia();
      const c = this.text[this.pos];
      if (c === undefined) this.fail("unterminated array, expected `)`");
      if (c === ")") {
        this.pos++;
        return { kind: "array", items };
      }
      items.push(this.parseValue());
      this.skipTrivia();
      if (this.text[this.pos] === ",") this.pos++;
      else if (this.text[this.pos] !== ")") this.fail('expected "," or ")" in array');
    }
  }

  private parseQuoted(): PString {
    const start = this.pos;
    this.pos++; // opening quote
    let value = "";
    for (;;) {
      const c = this.text[this.pos];
      if (c === undefined) {
        this.pos = start;
        this.fail("unterminated quoted string");
      }
      if (c === '"') {
        this.pos++;
        return { kind: "string", value, start, end: this.pos, quoted: true };
      }
      if (c === "\\") {
        const n = this.text[this.pos + 1];
        if (n === undefined) {
          this.pos = start;
          this.fail("unterminated quoted string");
        }
        value += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "\r" : n;
        this.pos += 2;
      } else {
        value += c;
        this.pos++;
      }
    }
  }

  private parseUnquoted(): PString {
    const t = this.text;
    const start = this.pos;
    while (this.pos < t.length) {
      const c = t[this.pos] as string;
      // `//` and `/*` only start comments in trivia, never inside a token (`path = a//b.swift;`).
      if (STRING_STOP.has(c)) break;
      this.pos++;
    }
    if (this.pos === start) {
      this.fail(`unexpected character ${JSON.stringify(t[this.pos] ?? "end of file")}`);
    }
    return {
      kind: "string",
      value: t.slice(start, this.pos),
      start,
      end: this.pos,
      quoted: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Object graph
// ---------------------------------------------------------------------------

type Field = "marketing" | "build";

const FIELD_KEY = { marketing: "MARKETING_VERSION", build: "CURRENT_PROJECT_VERSION" } as const;

interface Setting {
  node: PString;
}

/** Something about a setting we can't stamp. Raised only when that field is actually used. */
interface Problem {
  conditional: boolean;
  message: string;
}

interface ConfigInfo {
  id: string;
  name: string;
  marketing?: Setting;
  build?: Setting;
  problems: Partial<Record<Field, Problem>>;
}

interface TargetInfo {
  id: string;
  name: string;
  productType?: string;
  configs: ConfigInfo[];
}

interface Model {
  /** Native targets in project order. */
  targets: TargetInfo[];
  /** Configurations of the `PBXProject` itself (inherited by every target that doesn't override). */
  projectConfigs: ConfigInfo[];
}

function dictGet(dict: PDict, key: string): PNode | undefined {
  return dict.entries.find((e) => e.key === key)?.value;
}

function dictString(dict: PDict, key: string): string | undefined {
  const v = dictGet(dict, key);
  return v?.kind === "string" ? v.value : undefined;
}

function loadModel(text: string, file: string): Model {
  const root = new PlistParser(text, file).parseRoot();
  const objectsNode = dictGet(root, "objects");
  if (objectsNode?.kind !== "dict") {
    throw new StampError(
      file,
      "not an Xcode project file: no top-level `objects` dictionary. Point the source at the project.pbxproj inside the .xcodeproj folder.",
    );
  }

  const objects = new Map<string, PDict>();
  for (const e of objectsNode.entries) {
    if (e.value.kind === "dict") objects.set(e.key, e.value);
  }

  const lookup = (id: string, expectedIsa: string, what: string): PDict => {
    const obj = objects.get(id);
    if (!obj) throw new StampError(file, `${what} references object ${id}, which doesn't exist`);
    const isa = dictString(obj, "isa");
    if (isa !== expectedIsa) {
      throw new StampError(
        file,
        `${what} references object ${id}, expected ${expectedIsa}, got ${isa}`,
      );
    }
    return obj;
  };

  const readConfig = (id: string, what: string): ConfigInfo => {
    const config = lookup(id, "XCBuildConfiguration", what);
    const name = dictString(config, "name") ?? id;
    const settings = dictGet(config, "buildSettings");
    if (settings?.kind !== "dict") {
      throw new StampError(file, `${what}, configuration "${name}": no buildSettings dictionary`);
    }
    const info: ConfigInfo = { id, name, problems: {} };
    for (const field of ["marketing", "build"] as const) {
      const key = FIELD_KEY[field];
      const conditional = settings.entries.find((e) => e.key.startsWith(`${key}[`));
      if (conditional) {
        info.problems[field] = {
          conditional: true,
          message: `${conditional.key} is a conditional setting. It overrides ${key} for matching builds, so those builds would ship a different value than the one launchset writes. Remove it, or manage ${key} by hand and don't stamp it with launchset.`,
        };
      }
      const matches = settings.entries.filter((e) => e.key === key);
      const match = matches[0];
      if (matches.length > 1) {
        info.problems[field] = {
          conditional: false,
          message: `${key} is set ${matches.length} times, can't tell which to change`,
        };
      } else if (match && match.value.kind !== "string") {
        info.problems[field] = {
          conditional: false,
          message: `${key} isn't a plain value (it is a ${match.value.kind})`,
        };
      } else if (match?.value.kind === "string") {
        info[field] = { node: match.value };
      }
    }
    return info;
  };

  const readConfigList = (listId: string, what: string): ConfigInfo[] => {
    const list = lookup(listId, "XCConfigurationList", what);
    const configIds = dictGet(list, "buildConfigurations");
    if (configIds?.kind !== "array") {
      throw new StampError(file, `${what}: its configuration list has no buildConfigurations`);
    }
    return configIds.items.map((item) => {
      if (item.kind !== "string") {
        throw new StampError(file, `${what}: unexpected value in buildConfigurations`);
      }
      return readConfig(item.value, what);
    });
  };

  const readTarget = (id: string, obj: PDict): TargetInfo => {
    const name = dictString(obj, "name") ?? id;
    const what = `target "${name}"`;
    const listId = dictString(obj, "buildConfigurationList");
    if (!listId) throw new StampError(file, `${what} has no buildConfigurationList`);
    const info: TargetInfo = { id, name, configs: readConfigList(listId, what) };
    const productType = dictString(obj, "productType");
    if (productType !== undefined) info.productType = productType;
    return info;
  };

  const native = new Map<string, TargetInfo>();
  for (const [id, obj] of objects) {
    if (dictString(obj, "isa") === "PBXNativeTarget") native.set(id, readTarget(id, obj));
  }

  // Report targets in project order (the order Xcode shows them), then any others.
  const ordered: TargetInfo[] = [];
  const rootObject = dictString(root, "rootObject");
  const project = rootObject ? objects.get(rootObject) : undefined;
  const projectTargets = project ? dictGet(project, "targets") : undefined;
  if (projectTargets?.kind === "array") {
    for (const item of projectTargets.items) {
      const t = item.kind === "string" ? native.get(item.value) : undefined;
      if (t && !ordered.includes(t)) ordered.push(t);
    }
  }
  for (const t of native.values()) if (!ordered.includes(t)) ordered.push(t);

  const projectListId = project ? dictString(project, "buildConfigurationList") : undefined;
  const projectConfigs = projectListId
    ? readConfigList(projectListId, "the project-level configuration list")
    : [];
  return { targets: ordered, projectConfigs };
}

function configSetsAnything(c: ConfigInfo): boolean {
  return Boolean(c.marketing || c.build || c.problems.marketing || c.problems.build);
}

/** True when the target itself sets MARKETING_VERSION or CURRENT_PROJECT_VERSION. */
function hasVersionSettings(target: TargetInfo): boolean {
  return target.configs.some(configSetsAnything);
}

const TEST_PRODUCT_TYPES = new Set([
  "com.apple.product-type.bundle.unit-test",
  "com.apple.product-type.bundle.ui-testing",
]);

/**
 * A target that sets neither value but inherits one from the project-level configuration of the
 * same name. Test bundles don't count (they never ship).
 */
function inheritsVersionSettings(target: TargetInfo, model: Model): boolean {
  if (target.productType !== undefined && TEST_PRODUCT_TYPES.has(target.productType)) return false;
  return target.configs.some((c) =>
    model.projectConfigs.some((p) => p.name === c.name && configSetsAnything(p)),
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface NativeTargetSummary {
  name: string;
  productType?: string;
  /**
   * True when any configuration of the target itself sets MARKETING_VERSION or
   * CURRENT_PROJECT_VERSION (values inherited from the project level don't count).
   */
  hasVersionSettings: boolean;
  /** Distinct MARKETING_VERSION values across the target's configurations, as written. */
  marketingVersions: string[];
  /** Distinct CURRENT_PROJECT_VERSION values across the target's configurations, as written. */
  buildNumbers: string[];
}

/** Every `PBXNativeTarget` of the project, in project order (used by `init`). */
export function listNativeTargets(text: string, file: string): NativeTargetSummary[] {
  return loadModel(text, file).targets.map((t) => {
    const distinct = (field: Field): string[] => [
      ...new Set(t.configs.flatMap((c) => (c[field] ? [c[field].node.value] : []))),
    ];
    const summary: NativeTargetSummary = {
      name: t.name,
      hasVersionSettings: hasVersionSettings(t),
      marketingVersions: distinct("marketing"),
      buildNumbers: distinct("build"),
    };
    if (t.productType !== undefined) summary.productType = t.productType;
    return summary;
  });
}

function selectTargets(model: Model, names: string[] | undefined, file: string): TargetInfo[] {
  const all = model.targets;
  if (names && names.length > 0) {
    const selected: TargetInfo[] = [];
    for (const name of names) {
      const matches = all.filter((t) => t.name === name);
      if (matches.length === 0) {
        const available = all.map((t) => t.name).join(", ") || "none";
        throw new StampError(
          file,
          `unknown target "${name}" in xcodeTargets. Native targets in this project: ${available}`,
        );
      }
      for (const m of matches) if (!selected.includes(m)) selected.push(m);
    }
    return selected;
  }
  const selected = all.filter((t) => hasVersionSettings(t) || inheritsVersionSettings(t, model));
  if (selected.length === 0) {
    const names = all.map((t) => t.name).join(", ") || "none";
    throw new StampError(
      file,
      `no native target or project-level configuration sets MARKETING_VERSION or CURRENT_PROJECT_VERSION (targets: ${names}). Set them in the Build Settings in Xcode; if they come from an .xcconfig file, use source kind "xcconfig" for that file instead.`,
    );
  }
  return selected;
}

interface Located {
  field: Field;
  /** What owns the setting, for messages and keys: `target "App", configuration "Debug"`. */
  what: string;
  /** Short owner for FoundValue keys: the target name, or `project level`. */
  owner: string;
  configName: string;
  node: PString;
}

const PROJECT_LEVEL = "project level";

/**
 * The settings to read or stamp, one per distinct configuration and field.
 *
 * A target configuration that doesn't set a field inherits it from the project-level configuration
 * of the same name (Xcode's own resolution), so that configuration is located instead. Targets
 * that set something themselves, or were named in `targets` (`explicit`), must resolve every
 * field in `required`; default-selected targets that only inherit resolve what the project provides.
 *
 * `mode` decides which problems matter: when writing, a conditional assignment of a located field
 * is an error (it would ship another value); when reading, only conditionals are ignored.
 */
function locate(
  model: Model,
  targets: TargetInfo[],
  fields: Field[],
  required: Field[],
  mode: "read" | "write",
  explicit: boolean,
  file: string,
): Located[] {
  const seen = new Set<string>();
  const out: Located[] = [];

  const take = (field: Field, owner: string, what: string, config: ConfigInfo): boolean => {
    const problem = config.problems[field];
    const usable = config[field] !== undefined;
    if (problem && (mode === "write" || !problem.conditional)) {
      throw new StampError(file, `${what}: ${problem.message}`);
    }
    const setting = config[field];
    if (!usable || !setting) return false;
    const id = `${config.id}:${field}`;
    if (!seen.has(id)) {
      seen.add(id);
      out.push({ field, what, owner, configName: config.name, node: setting.node });
    }
    return true;
  };

  for (const target of targets) {
    const strict = explicit || hasVersionSettings(target);
    for (const config of target.configs) {
      const what = `target "${target.name}", configuration "${config.name}"`;
      for (const field of fields) {
        if (take(field, target.name, what, config)) continue;
        const inherited = model.projectConfigs.find((p) => p.name === config.name);
        const projectWhat = `project-level configuration "${config.name}" (inherited by target "${target.name}")`;
        if (inherited && take(field, PROJECT_LEVEL, projectWhat, inherited)) continue;
        if (strict && required.includes(field)) {
          throw new StampError(
            file,
            `${what} doesn't set ${FIELD_KEY[field]}, and neither does the project-level configuration, so it can't be stamped. Set it in Build Settings in Xcode, or limit xcodeTargets to the targets that carry the version.`,
          );
        }
      }
    }
  }

  for (const field of required) {
    if (!out.some((l) => l.field === field)) {
      const names = targets.map((t) => t.name).join(", ");
      throw new StampError(
        file,
        `none of the selected targets (${names}) or their project-level configuration sets ${FIELD_KEY[field]}, so there is nothing to stamp. Set it in Build Settings in Xcode.`,
      );
    }
  }
  return out;
}

/** The `$(...)` check and error for a value that is about to be written. */
function assertLiteral(l: Located, file: string): void {
  if (isBuildSettingReference(l.node.value)) {
    throw new StampError(
      file,
      `${l.what}: ${FIELD_KEY[l.field]} is the build-setting reference ${l.node.value}, which launchset won't overwrite. Set a literal value in the Xcode project, or use source kind "xcconfig" for the file that defines it.`,
    );
  }
}

export const pbxproj: TextStamper<{ targets?: string[] }> = {
  read(text, file, options) {
    const model = loadModel(text, file);
    const targets = selectTargets(model, options.targets, file);
    // Marketing versions are required everywhere (the consistency check compares them);
    // a missing build number is only an error when one is written.
    const found = locate(
      model,
      targets,
      ["marketing", "build"],
      ["marketing"],
      "read",
      Boolean(options.targets?.length),
      file,
    );
    return found.map(
      (l): FoundValue => ({
        field: l.field,
        key: `${FIELD_KEY[l.field]} (${l.owner}, ${l.configName})`,
        value: l.node.value,
        line: lineOf(text, l.node.start),
      }),
    );
  },

  write(text, file, values, options) {
    if (values.marketing === undefined && values.build === undefined) return text;
    if (values.marketing !== undefined) assertIosMarketing(values.marketing, file);
    if (values.build !== undefined) assertBuildNumber(values.build, file);
    const model = loadModel(text, file);
    const targets = selectTargets(model, options.targets, file);
    const fields: Field[] = [];
    if (values.marketing !== undefined) fields.push("marketing");
    if (values.build !== undefined) fields.push("build");
    const located = locate(
      model,
      targets,
      fields,
      fields,
      "write",
      Boolean(options.targets?.length),
      file,
    );

    const splices: Splice[] = located.map((l) => {
      assertLiteral(l, file);
      const value = l.field === "marketing" ? (values.marketing as string) : String(values.build);
      return {
        start: l.node.start,
        end: l.node.end,
        text: l.node.quoted ? `"${value}"` : value,
      };
    });
    return applySplices(text, splices);
  },
};
