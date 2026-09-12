/**
 * The layered merge, folded low to high; pure (no Io, no GitHub), and layers are trees: a document aliasing a node
 * inside itself is refused. Lists never combine except a knobbed section's entries under "merge", unioned by the
 * module's key (and the nested lists that key declares).
 *
 * higher plain mapping                  -> merged key by key
 * higher scalar, list, tagged           -> replaces
 * higher null over a lower declaration  -> deletes it (an opt-out notice)
 * higher null over nothing, or a null   -> stays as written, so `pages: null` keeps its engine meaning
 */

import { err, ok, type Result } from "neverthrow";
import { isPlainObject } from "../plain-data.js";
import type { LayerProblem } from "../problem.js";
import { UNDECLARED_POLICY_SECTIONS, type UndeclaredPolicySection } from "../schema.js";
import { defaultUndeclaredPolicy, type KeyedListLayering } from "../sections/contract/module.js";
import { sectionModule } from "../sections/registry.js";
import type { DistributiveOmit, UndeclaredPolicy } from "../types.js";

/** One settings document in the stack, named for notices and refusals. */
export interface Layer {
  readonly name: string;
  readonly doc: unknown;
}

export type Layering = "merge" | "replace";

/** A lower declaration a higher layer deleted with `null`. */
export interface OptOutNotice {
  readonly layer: string;
  readonly path: string;
}

const LAYERING_KEY = "_layering";

const LAYERINGS: readonly Layering[] = ["merge", "replace"];

function isLayering(value: unknown): value is Layering {
  return LAYERINGS.some((layering) => layering === value);
}

/**
 * A plain array becomes `{entries}` with NO `_undeclared`: that omission is what lets a merge inherit a lower layer's
 * policy. Resolved to the section default here, a higher layer's default would overwrite the lower's explicit policy.
 */
function normalizeKnobbedSections(settings: unknown): unknown {
  if (!isPlainObject(settings)) {
    return settings;
  }
  const out: Record<string, unknown> = { ...settings };
  for (const key of UNDECLARED_POLICY_SECTIONS) {
    const value = out[key];
    if (Array.isArray(value)) {
      out[key] = { entries: value };
    }
  }
  return out;
}

function sectionDefaultPolicy(key: UndeclaredPolicySection): UndeclaredPolicy {
  return defaultUndeclaredPolicy(sectionModule(key));
}

/** After the fold, a wrapper still without `_undeclared` takes the section default, so the merged document is self-describing. */
function resolveUndeclaredPolicies(merged: Record<string, unknown>): void {
  for (const key of UNDECLARED_POLICY_SECTIONS) {
    const value = merged[key];
    if (isPlainObject(value) && Array.isArray(value.entries) && value._undeclared === undefined) {
      value._undeclared = sectionDefaultPolicy(key);
    }
  }
}

/**
 * The clone in progress of every node on the current descent: a node met again inside itself gets that clone, so a
 * cyclic document terminates. A node aliased twice WITHOUT enclosing itself is cloned per occurrence, in the position
 * each sits in (a wrapper shared between a private key and `rulesets` is data under one and a keyed list under the other).
 */
type Descent = WeakMap<object, unknown>;

function sectionLayering(key: string): KeyedListLayering | undefined {
  const section = UNDECLARED_POLICY_SECTIONS.find((candidate) => candidate === key);
  return section === undefined ? undefined : sectionModule(section).layering;
}

function stripValue(value: unknown, descent: Descent): unknown {
  return isPlainObject(value) ? stripMapping(value, undefined, descent) : structuredClone(value);
}

/** Mirrors mergeMappings: a null-valued key is a marker and drops, and `keyed` names the same fields it names there. */
function stripMapping(
  map: Readonly<Record<string, unknown>>,
  keyed: Readonly<Record<string, KeyedListLayering>> | undefined,
  descent: Descent,
): Record<string, unknown> {
  const enclosing = descent.get(map);
  if (enclosing !== undefined) {
    return enclosing as Record<string, unknown>;
  }
  const out: Record<string, unknown> = {};
  descent.set(map, out);
  for (const [key, value] of Object.entries(map)) {
    if (value === null) {
      continue;
    }
    const nested = keyed === undefined ? undefined : own(keyed, key);
    put(
      out,
      key,
      nested === undefined ? stripValue(value, descent) : stripKeyedList(value, nested, descent),
    );
  }
  descent.delete(map);
  return out;
}

/** Mirrors unionKeyed: the same lists are entered. */
function stripKeyedList(list: unknown, keyed: KeyedListLayering, descent: Descent): unknown {
  if (!Array.isArray(list) || keyed.combine === "replace") {
    return stripValue(list, descent);
  }
  const enclosing = descent.get(list);
  if (enclosing !== undefined) {
    return enclosing;
  }
  const out: unknown[] = [];
  descent.set(list, out);
  for (const item of list) {
    out.push(
      isPlainObject(item) ? stripMapping(item, keyed.nested, descent) : structuredClone(item),
    );
  }
  descent.delete(list);
  return out;
}

/**
 * A layer validated on its own is seen as the merge could leave it: every null the merge would read as a marker drops,
 * every other null stays for the validator to judge. A cyclic input yields a cyclic clone; the merge is what refuses those.
 *
 * `rulesets[main].bypass_actors: null`  -> dropped (a mapping key inside a keyed list the merge combines)
 * `branches[].protection: null`         -> kept (inside a list the merge copies as written)
 * a null list element                   -> kept
 */
export function stripNulls(doc: unknown): unknown {
  if (!isPlainObject(doc)) {
    return structuredClone(doc);
  }
  const descent: Descent = new WeakMap();
  const out: Record<string, unknown> = {};
  descent.set(doc, out);
  for (const [key, value] of Object.entries(doc)) {
    if (value === null) {
      continue;
    }
    const layering = sectionLayering(key);
    let stripped: unknown;
    if (layering === undefined) {
      stripped = stripValue(value, descent);
    } else if (isPlainObject(value)) {
      stripped = stripMapping(value, { entries: layering }, descent);
    } else {
      stripped = stripKeyedList(value, layering, descent);
    }
    put(out, key, stripped);
  }
  return out;
}

/** A layer refusal minus its position: the boundary adds the layer and site where it fires. */
type Refusal = DistributiveOmit<LayerProblem, "layer" | "site">;

/**
 * No document key or value ever enters a refusal's prose; the marker test in test/engine/layers.test.ts pins it.
 *
 * `actual`    -> the only document value carried, and describeProblem describes it by shape
 * `keyField`  -> the module's declared key field
 * `site`      -> section keys, entry indices, module-declared field names, LAYERING_KEY, "the document"
 */
function refuse(layer: string, site: string, refusal: Refusal): Result<never, LayerProblem> {
  return err({ layer, site, ...refusal });
}

/** Value-free under the refusals' invariant: mode: merge has no redaction context, so no document value may reach a log through the merge. */
export function describeOptOut(notice: OptOutNotice): string {
  return `${notice.layer}: null removed ${notice.path} declared by a lower layer`;
}

interface Step {
  readonly layer: string;
  readonly notices: OptOutNotice[];
}

interface AdmittedSection {
  /** The wrapper's keys besides `entries` and `_layering`: `_undeclared`, or a typo kept for validation to name. */
  readonly knobs: Readonly<Record<string, unknown>>;
  readonly entries: readonly Readonly<Record<string, unknown>>[];
  readonly layering: Layering;
  readonly keyed: KeyedListLayering | undefined;
}

interface AdmittedLayer {
  readonly name: string;
  readonly doc: Readonly<Record<string, unknown>>;
  readonly sections: ReadonlyMap<string, AdmittedSection>;
}

function asMappings(list: readonly unknown[]): readonly Readonly<Record<string, unknown>>[] | null {
  return list.every(isPlainObject) ? list : null;
}

function admitEntries(
  layer: string,
  path: string,
  list: readonly unknown[],
): Result<readonly Readonly<Record<string, unknown>>[], LayerProblem> {
  const mappings = asMappings(list);
  if (mappings !== null) {
    return ok(mappings);
  }
  const index = list.findIndex((entry) => !isPlainObject(entry));
  return refuse(layer, `${path}[${index}]`, {
    code: "layer-wrong-shape",
    expected: "a mapping",
    actual: list[index],
  });
}

/** Two entries of one layer claiming a key (a label renaming into a sibling's name) are refused here, so unionKeyed never meets them. */
function checkKeyed(
  layer: string,
  entries: readonly Readonly<Record<string, unknown>>[],
  keyed: KeyedListLayering,
  path: string,
): Result<void, LayerProblem> {
  const seen = new Map<string, number>();
  for (const [index, entry] of entries.entries()) {
    const keys = keyed.keys(entry);
    if (keys === null) {
      return refuse(layer, `${path}[${index}]`, { code: "layer-no-key", keyField: keyed.keyField });
    }
    for (const key of keys) {
      const first = seen.get(key);
      if (first !== undefined) {
        return refuse(layer, path, {
          code: "layer-duplicate-key",
          keyField: keyed.keyField,
          first,
          second: index,
        });
      }
      seen.set(key, index);
    }
    for (const [field, nested] of Object.entries(keyed.nested ?? {})) {
      const value = entry[field];
      if (!Array.isArray(value)) {
        continue;
      }
      const nestedPath = `${path}[${index}].${field}`;
      const checked = admitEntries(layer, nestedPath, value).andThen((mappings) =>
        checkKeyed(layer, mappings, nested, nestedPath),
      );
      if (checked.isErr()) {
        return checked;
      }
    }
  }
  return ok();
}


function fileLayering(
  layer: string,
  doc: Readonly<Record<string, unknown>>,
): Result<Layering | undefined, LayerProblem> {
  const value = doc[LAYERING_KEY];
  if (value === undefined) {
    return ok(undefined);
  }
  if (!isLayering(value)) {
    return refuse(layer, LAYERING_KEY, { code: "layer-bad-directive", actual: value });
  }
  return ok(value);
}


function admitSection(
  layer: string,
  key: UndeclaredPolicySection,
  value: unknown,
  fallback: { readonly file: Layering | undefined; readonly run: Layering },
): Result<AdmittedSection, LayerProblem> {
  if (!isPlainObject(value) || !Array.isArray(value.entries)) {
    return refuse(layer, key, {
      code: "layer-wrong-shape",
      expected: "a list of mappings or an {_undeclared, entries} wrapper",
      actual: value,
      detail: isPlainObject(value) ? " without an entries list" : undefined,
    });
  }
  return admitEntries(layer, key, value.entries).andThen((entries) => {
    const { entries: _entries, [LAYERING_KEY]: directive, ...knobs } = value;
    if (directive !== undefined && !isLayering(directive)) {
      return refuse(layer, `${key}.${LAYERING_KEY}`, {
        code: "layer-bad-directive",
        actual: directive,
      });
    }
    const explicit = directive ?? fallback.file;
    const keyed = sectionModule(key).layering;
    if (keyed === undefined && explicit === "merge") {
      return refuse(layer, key, { code: "layer-no-layering-key" });
    }
    const section: AdmittedSection = { knobs, entries, layering: explicit ?? fallback.run, keyed };
    return keyed === undefined
      ? ok(section)
      : checkKeyed(layer, entries, keyed, key).map(() => section);
  });
}

/**
 * Only a node on the current descent counts: a node aliased twice without enclosing itself is a tree to the merge, which
 * clones it per site. `walked` keeps a fully walked node from being entered again.
 */
function hasCycle(value: unknown, descent: WeakSet<object>, walked: WeakSet<object>): boolean {
  if (!Array.isArray(value) && !isPlainObject(value)) {
    return false;
  }
  if (walked.has(value)) {
    return false;
  }
  if (descent.has(value)) {
    return true;
  }
  descent.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  const cyclic = children.some((child) => hasCycle(child, descent, walked));
  descent.delete(value);
  walked.add(value);
  return cyclic;
}

/**
 * The layer boundary: past it the fold never meets a cycle, an unkeyed entry, or a duplicated key. A non-mapping
 * passes as written for the top-level validator to name.
 */
function admit(layer: Layer, run: Layering): Result<AdmittedLayer | null, LayerProblem> {
  if (hasCycle(layer.doc, new WeakSet(), new WeakSet())) {
    return refuse(layer.name, "the document", { code: "layer-cycle" });
  }
  const doc = normalizeKnobbedSections(layer.doc);
  if (!isPlainObject(doc)) {
    return ok(null);
  }
  return fileLayering(layer.name, doc).andThen((file) => {
    const sections = new Map<string, AdmittedSection>();
    for (const key of UNDECLARED_POLICY_SECTIONS) {
      const value = doc[key];
      if (value === undefined || value === null) {
        continue;
      }
      const admitted = admitSection(layer.name, key, value, { file, run });
      if (admitted.isErr()) {
        return err(admitted.error);
      }
      sections.set(key, admitted.value);
    }
    return ok({ name: layer.name, doc, sections });
  });
}

function childPath(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

/** An own property's value: an inherited name (`constructor`) is not a document key. */
function own<V>(record: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Set an own data property whatever the key; assigning `__proto__` would set the prototype. */
function put(record: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function applyNull(out: Record<string, unknown>, key: string, path: string, step: Step): void {
  const lower = own(out, key);
  if (lower !== undefined && lower !== null) {
    delete out[key];
    step.notices.push({ layer: step.layer, path });
    return;
  }
  put(out, key, null);
}

function mergeValue(
  below: unknown,
  above: unknown,
  path: string,
  step: Step,
  keyed?: Readonly<Record<string, KeyedListLayering>>,
): unknown {
  if (isPlainObject(below) && isPlainObject(above)) {
    return mergeMappings(below, above, path, step, keyed);
  }
  return structuredClone(above);
}

function mergeMappings(
  below: Readonly<Record<string, unknown>>,
  above: Readonly<Record<string, unknown>>,
  path: string,
  step: Step,
  keyed?: Readonly<Record<string, KeyedListLayering>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...below };
  for (const [key, value] of Object.entries(above)) {
    if (value === undefined) {
      continue;
    }
    const here = childPath(path, key);
    if (value === null) {
      applyNull(out, key, here, step);
      continue;
    }
    const nested = keyed === undefined ? undefined : own(keyed, key);
    const lower = own(out, key);
    if (nested !== undefined && Array.isArray(lower) && Array.isArray(value)) {
      put(out, key, unionKeyed(lower, value, nested, here, step));
      continue;
    }
    put(out, key, mergeValue(lower, value, here, step));
  }
  return out;
}

/** `index` is the entry's position in the higher list, which is how the layer's notices name it. */
type Placement =
  | {
      readonly item: Readonly<Record<string, unknown>>;
      readonly index: number;
      readonly keys: readonly string[];
      readonly slot: number;
    }
  | { readonly item: unknown; readonly slot: undefined };

/**
 * Matching reads the lower list as it stood before this layer, so which entries result does not depend on the higher
 * entries' order; a lower entry two higher entries claim is superseded by both, and checkKeyed's key-disjointness keeps
 * the result one the section's planner accepts.
 */
function unionKeyed(
  lower: readonly unknown[],
  higher: readonly unknown[],
  keyed: KeyedListLayering,
  path: string,
  step: Step,
): unknown[] {
  const intersect = (a: readonly string[], b: readonly string[]): boolean =>
    a.some((key) => b.includes(key));
  const lowerKeys = lower.map((item) => (isPlainObject(item) ? keyed.keys(item) : null) ?? []);
  const placements = higher.map((item, index): Placement => {
    const keys = isPlainObject(item) ? keyed.keys(item) : null;
    const slot = keys === null ? -1 : lowerKeys.findIndex((claims) => intersect(claims, keys));
    return isPlainObject(item) && keys !== null && slot !== -1
      ? { item, index, keys, slot }
      : { item, slot: undefined };
  });
  const placed = placements.flatMap((p) => (p.slot === undefined ? [] : [p]));
  const out: unknown[] = [];
  lower.forEach((below, index) => {
    if (!placed.some((p) => intersect(lowerKeys[index] ?? [], p.keys))) {
      out.push(below);
      return;
    }
    for (const placement of placed) {
      if (placement.slot === index) {
        out.push(
          keyed.combine === "replace"
            ? structuredClone(placement.item)
            : mergeValue(below, placement.item, `${path}[${placement.index}]`, step, keyed.nested),
        );
      }
    }
  });
  for (const { item, slot } of placements) {
    if (slot === undefined) {
      out.push(structuredClone(item));
    }
  }
  return out;
}

function mergeSection(
  key: string,
  lower: unknown,
  section: AdmittedSection,
  step: Step,
): Record<string, unknown> {
  const wrapper = isPlainObject(lower) ? lower : {};
  const { entries: lowerEntries, ...lowerKnobs } = wrapper;
  const out = mergeMappings(lowerKnobs, section.knobs, key, step);
  const unite =
    section.layering === "merge" && section.keyed !== undefined && Array.isArray(lowerEntries);
  out.entries = unite
    ? unionKeyed(lowerEntries, section.entries, section.keyed, key, step)
    : structuredClone(section.entries);
  return out;
}

function mergeStep(acc: unknown, layer: AdmittedLayer, notices: OptOutNotice[]): unknown {
  const step: Step = { layer: layer.name, notices };
  const below = isPlainObject(acc) ? acc : {};
  const out: Record<string, unknown> = { ...below };
  for (const [key, value] of Object.entries(layer.doc)) {
    if (key === LAYERING_KEY || value === undefined) {
      continue;
    }
    if (value === null) {
      applyNull(out, key, key, step);
      continue;
    }
    const section = layer.sections.get(key);
    const lower = own(out, key);
    put(
      out,
      key,
      section === undefined
        ? mergeValue(lower, value, key, step)
        : mergeSection(key, lower, section, step),
    );
  }
  return out;
}

export function mergeLayers(
  layers: readonly Layer[],
  options: { readonly layering: Layering },
): Result<{ settings: unknown; notices: OptOutNotice[] }, LayerProblem> {
  const notices: OptOutNotice[] = [];
  let acc: unknown = {};
  for (const layer of layers) {
    const admitted = admit(layer, options.layering);
    if (admitted.isErr()) {
      return err(admitted.error);
    }
    acc =
      admitted.value === null
        ? structuredClone(layer.doc)
        : mergeStep(acc, admitted.value, notices);
  }
  if (isPlainObject(acc)) {
    resolveUndeclaredPolicies(acc);
  }
  return ok({ settings: acc, notices });
}
