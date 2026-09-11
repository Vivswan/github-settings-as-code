/**
 * The layered merge: an ORDERED list of settings documents folded low to
 * high into one document. Plain objects merge key by key; a higher scalar,
 * array, or YAML-tagged value replaces; a higher `null` deletes what a lower
 * layer declared (reported as a notice) and stays as written when nothing
 * below declares the key, so `pages: null` keeps its engine meaning. The
 * knobbed list sections (UNDECLARED_POLICY_SECTIONS) are the one place lists
 * combine: under "merge", a section whose module declares a `layering` unions
 * its entries by identity (two entries whose key sets intersect are one);
 * every other list is replaced by the higher layer's.
 * A layer that refers back into itself (a YAML anchor aliased inside its own
 * node) is refused at the boundary: layers are trees.
 * Pure: no Io, no GitHub. The helpers merge.ts shares live here too.
 */

import { UNDECLARED_POLICY_SECTIONS, type UndeclaredPolicySection } from "../schema.js";
import { defaultUndeclaredPolicy, type KeyedListLayering } from "../sections/contract/module.js";
import { sectionModule } from "../sections/registry.js";
import type { UndeclaredPolicy } from "../types.js";

/** One settings document in the stack, named for notices and refusals. */
export interface Layer {
  readonly name: string;
  readonly doc: unknown;
}

/** How a knobbed section combines with the layers below it. */
export type Layering = "merge" | "replace";

/** A lower declaration a higher layer deleted with `null`. */
export interface OptOutNotice {
  readonly layer: string;
  readonly path: string;
}

/** The directive key, on a knobbed wrapper or at a document's top level. */
const LAYERING_KEY = "_layering";

const LAYERINGS: readonly Layering[] = ["merge", "replace"];

function isLayering(value: unknown): value is Layering {
  return LAYERINGS.some((layering) => layering === value);
}

/**
 * A PLAIN mapping only: the prototype must be Object.prototype or null. A
 * YAML explicit tag (!!timestamp, !!set) parses to a Date or Set, which is
 * an object too - treating one as a mapping would spread it into `{}` and
 * quietly hand the merge (or a knobbed-section normalization) a document
 * nobody wrote. Non-plain objects REPLACE like scalars, surviving the merge
 * as written for post-merge validation to reject.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Rewrite each UNDECLARED_POLICY_SECTIONS value from the plain array form to
 * the wrapped one, PRESERVING OMISSION of the policy key - a plain array
 * becomes `{entries}` with NO `_undeclared`. That omission is what lets a
 * merge inherit a lower layer's policy: had the plain form been resolved to
 * its default here, the higher layer's resolved default would overwrite the
 * lower's explicit policy. Values in neither form (null opt-outs, malformed
 * declarations) pass through untouched so the null semantics and post-merge
 * validation see them as written; a wrapper keeps every key it carries,
 * `_layering` included. Returns a shallow copy; the input is never mutated.
 */
function normalizeKnobbedSections(settings: unknown): unknown {
  // A document that is not a mapping (a raw list, a scalar) has no sections
  // to normalize; hand it on untouched so the top-level validator still sees
  // exactly what was written.
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

/** The section's own default policy, from its undeclaredDefault declaration. */
function sectionDefaultPolicy(key: UndeclaredPolicySection): UndeclaredPolicy {
  return defaultUndeclaredPolicy(sectionModule(key));
}

/**
 * After a merge: a wrapped section that still carries no explicit policy
 * resolves to the section's default, so the merged document is
 * self-describing. Runs on the merged document the caller owns.
 */
function resolveUndeclaredPolicies(merged: Record<string, unknown>): void {
  for (const key of UNDECLARED_POLICY_SECTIONS) {
    const value = merged[key];
    if (isPlainObject(value) && Array.isArray(value.entries) && value._undeclared === undefined) {
      value._undeclared = sectionDefaultPolicy(key);
    }
  }
}

/**
 * The clone in progress of every node on the current descent. A node met
 * again while its clone is being built encloses itself and gets that clone,
 * so a cyclic document terminates; a node aliased twice without enclosing
 * itself is cloned per occurrence, in the position each occurrence sits in
 * (a wrapper shared between a private key and `rulesets` is data under one
 * and a keyed list under the other).
 */
type Descent = WeakMap<object, unknown>;

/** The keyed layering of a knobbed section's entries; undefined for a section that always replaces. */
function sectionLayering(key: string): KeyedListLayering | undefined {
  const section = UNDECLARED_POLICY_SECTIONS.find((candidate) => candidate === key);
  return section === undefined ? undefined : sectionModule(section).layering;
}

/** A value the merge does not merge into: a mapping walks on, anything else is copied as written. */
function stripValue(value: unknown, descent: Descent): unknown {
  return isPlainObject(value) ? stripMapping(value, undefined, descent) : structuredClone(value);
}

/**
 * The merge's walk over one mapping (mergeMappings): every null-valued key
 * is a marker and drops; `keyed` names the fields whose lists the merge
 * combines by key, exactly as it names them there.
 */
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

/**
 * A keyed list as the merge combines it (unionKeyed): only a "merge"-combined
 * list is entered, its mapping entries walked with their own nested keyed
 * lists; a "replace"-combined list, or a value that is not a list, is data
 * the merge copies as written, nulls included.
 */
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
 * Drop every null the merge would read as a marker, so a layer validated on
 * its own is seen as the merge could leave it: null-valued mapping keys at
 * any depth the merge walks, including inside the entries of a keyed list it
 * combines by key (`rulesets[main].bypass_actors: null`). Every other list is
 * data the merge copies as written, so a null inside one stays for the
 * validator to judge (`branches[].protection: null`, a null list element). A
 * knobbed section is read in either of its forms, the plain list or the
 * wrapper. Returns a fresh document; a cyclic input yields a cyclic clone,
 * finite like the input (the merge is what refuses those).
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

/**
 * The kinds of problem the layer boundary refuses. Each carries only what
 * its prose needs - an entry index, a module-declared field name, or a value
 * to describe by SHAPE - so no string taken from the document has a way in.
 */
type Problem =
  | { readonly kind: "cycle" }
  | {
      readonly kind: "wrong-shape";
      readonly expected: string;
      readonly actual: unknown;
      readonly detail?: string;
    }
  | { readonly kind: "bad-directive"; readonly actual: unknown }
  | { readonly kind: "no-layering-key" }
  | { readonly kind: "no-key"; readonly keyField: string }
  | {
      readonly kind: "duplicate-key";
      readonly keyField: string;
      readonly first: number;
      readonly second: number;
    };

/** A layer the merge refuses at its boundary; worded by describeRefusal alone. */
class LayerRefusal extends Error {}

/**
 * The ONE place a refusal is worded, and with describeOptOut the only prose
 * the merge produces. INVARIANT: a message names the layer as the layer list
 * names it, the site's key path (section keys, mapping keys, module-declared
 * field names, entry indices), and the kind of problem - never a value from
 * the document. mode: merge has no private-repos redaction context, so a
 * value echoed here (a label name, a rule type, a mis-shaped section body)
 * could land a private repository's settings in a public log. A Problem
 * carries indices, field names, and values described by shape only.
 */
function describeRefusal(layer: string, site: string, problem: Problem): string {
  const at = `layer ${quote(layer)}: ${site}`;
  switch (problem.kind) {
    case "cycle":
      return `${at} contains a reference cycle (a YAML anchor that includes itself); layers must be trees`;
    case "wrong-shape":
      return `${at} must be ${problem.expected}; got ${describeShape(problem.actual)}${problem.detail ?? ""}`;
    case "bad-directive":
      return `${at} must be "merge" or "replace"; got ${describeShape(problem.actual)}${typeof problem.actual === "string" ? " that is neither" : ""}`;
    case "no-layering-key":
      return `${at} has no layering key, so it cannot be layered by "merge"; declare ${LAYERING_KEY}: replace or drop the directive`;
    case "no-key":
      return `${at} carries no string ${quote(problem.keyField)}, which every entry needs to layer by`;
    case "duplicate-key":
      return `${at}[${problem.first}] and ${site}[${problem.second}] both claim one ${problem.keyField}; each ${problem.keyField} belongs to one entry within a layer`;
  }
}

function refuse(layer: string, site: string, problem: Problem): never {
  throw new LayerRefusal(describeRefusal(layer, site, problem));
}

/** An opt-out notice's prose; value-free under the same invariant as describeRefusal. */
export function describeOptOut(notice: OptOutNotice): string {
  return `${notice.layer}: null removed ${notice.path} declared by a lower layer`;
}

/** The fold state one layer's step reads and reports into. */
interface Step {
  readonly layer: string;
  readonly notices: OptOutNotice[];
}

/** A knobbed section of one admitted layer, ready to combine. */
interface AdmittedSection {
  /** The wrapper's keys besides `entries` and `_layering` (`_undeclared`, or a typo for validation). */
  readonly knobs: Readonly<Record<string, unknown>>;
  readonly entries: readonly Readonly<Record<string, unknown>>[];
  /** How this section combines with the layers below it in this step. */
  readonly layering: Layering;
  /** The section module's keyed layering, absent for a section that always replaces. */
  readonly keyed: KeyedListLayering | undefined;
}

/** One layer past the boundary: every knobbed section checked and typed, the rest as written. */
interface AdmittedLayer {
  readonly name: string;
  readonly doc: Readonly<Record<string, unknown>>;
  readonly sections: ReadonlyMap<string, AdmittedSection>;
}

function quote(value: unknown): string {
  return JSON.stringify(String(value));
}

/** A value's kind for refusal prose: what it is, not what it contains. */
function describeShape(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "a list";
  }
  if (isPlainObject(value)) {
    return "a mapping";
  }
  if (typeof value === "object") {
    return `a ${value.constructor?.name ?? "tagged"} value`;
  }
  return `a ${typeof value}`;
}

/** The entries as mappings, or null when one is not. */
function asMappings(list: readonly unknown[]): readonly Readonly<Record<string, unknown>>[] | null {
  return list.every(isPlainObject) ? list : null;
}

/**
 * The entries as mappings, or a refusal naming the first that is not, by its
 * index under `path` and its shape.
 */
function admitEntries(
  layer: string,
  path: string,
  list: readonly unknown[],
): readonly Readonly<Record<string, unknown>>[] {
  const mappings = asMappings(list);
  if (mappings !== null) {
    return mappings;
  }
  const index = list.findIndex((entry) => !isPlainObject(entry));
  return refuse(layer, `${path}[${index}]`, {
    kind: "wrong-shape",
    expected: "a mapping",
    actual: list[index],
  });
}

/**
 * Refuse a keyed list a layer declares with an entry that carries no key or
 * two entries claiming one key (a label renaming into a sibling's name), at
 * any nesting the declaration names; each entry's nested keyed lists are
 * checked the same way. Past this check, every entry of the list has keys
 * and no two claim one, so a layer's entries never collide among themselves
 * in the union.
 */
function checkKeyed(
  layer: string,
  entries: readonly Readonly<Record<string, unknown>>[],
  keyed: KeyedListLayering,
  path: string,
): void {
  const seen = new Map<string, number>();
  entries.forEach((entry, index) => {
    const keys = keyed.keys(entry);
    if (keys === null) {
      refuse(layer, `${path}[${index}]`, { kind: "no-key", keyField: keyed.keyField });
    }
    for (const key of keys) {
      const first = seen.get(key);
      if (first !== undefined) {
        refuse(layer, path, {
          kind: "duplicate-key",
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
      checkKeyed(layer, admitEntries(layer, nestedPath, value), nested, nestedPath);
    }
  });
}

/**
 * The top-level `_layering` of a document, validated; undefined when absent.
 * Consumed here, so it never reaches the merged document.
 */
function fileLayering(layer: string, doc: Readonly<Record<string, unknown>>): Layering | undefined {
  const value = doc[LAYERING_KEY];
  if (value === undefined) {
    return undefined;
  }
  if (!isLayering(value)) {
    refuse(layer, LAYERING_KEY, { kind: "bad-directive", actual: value });
  }
  return value;
}

/** One knobbed section past the boundary, or a refusal naming the layer and the section. */
function admitSection(
  layer: string,
  key: UndeclaredPolicySection,
  value: unknown,
  fallback: { readonly file: Layering | undefined; readonly run: Layering },
): AdmittedSection {
  if (!isPlainObject(value) || !Array.isArray(value.entries)) {
    refuse(layer, key, {
      kind: "wrong-shape",
      expected: "a list of mappings or an {_undeclared, entries} wrapper",
      actual: value,
      detail: isPlainObject(value) ? " without an entries list" : "",
    });
  }
  const entries = admitEntries(layer, key, value.entries);
  const { entries: _entries, [LAYERING_KEY]: directive, ...knobs } = value;
  if (directive !== undefined && !isLayering(directive)) {
    refuse(layer, `${key}.${LAYERING_KEY}`, { kind: "bad-directive", actual: directive });
  }
  const explicit = directive ?? fallback.file;
  const keyed = sectionModule(key).layering;
  if (keyed === undefined && explicit === "merge") {
    refuse(layer, key, { kind: "no-layering-key" });
  }
  if (keyed !== undefined) {
    checkKeyed(layer, entries, keyed, key);
  }
  return { knobs, entries, layering: explicit ?? fallback.run, keyed };
}

/**
 * Whether a node refers back into itself through lists and plain mappings (a
 * YAML anchor aliased inside its own node). A node aliased twice without
 * enclosing itself is a tree to the merge, which clones it per site, so only
 * a node on the current descent counts; a node fully walked without one is
 * never entered again.
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
 * The layer boundary: a cyclic document is refused before anything walks it;
 * a non-mapping document passes as written (the top-level validator names
 * it); a mapping has its directive and every knobbed section checked once, so
 * the fold below never meets an unkeyed or duplicated entry.
 */
function admit(layer: Layer, run: Layering): AdmittedLayer | null {
  if (hasCycle(layer.doc, new WeakSet(), new WeakSet())) {
    refuse(layer.name, "the document", { kind: "cycle" });
  }
  const doc = normalizeKnobbedSections(layer.doc);
  if (!isPlainObject(doc)) {
    return null;
  }
  const file = fileLayering(layer.name, doc);
  const sections = new Map<string, AdmittedSection>();
  for (const key of UNDECLARED_POLICY_SECTIONS) {
    const value = doc[key];
    if (value !== undefined && value !== null) {
      sections.set(key, admitSection(layer.name, key, value, { file, run }));
    }
  }
  return { name: layer.name, doc, sections };
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

/**
 * A higher `null`: deletes a lower declaration and says so, or stays as
 * written when nothing below declares the key. A lower null is not a
 * declaration, so nulling it again is not an opt-out and earns no notice.
 */
function applyNull(out: Record<string, unknown>, key: string, path: string, step: Step): void {
  const lower = own(out, key);
  if (lower !== undefined && lower !== null) {
    delete out[key];
    step.notices.push({ layer: step.layer, path });
    return;
  }
  put(out, key, null);
}

/**
 * A higher value over a lower one: mappings merge key by key (with `keyed`
 * naming the nested keyed lists, see mergeMappings), anything else replaces.
 */
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

/**
 * Key-by-key merge of two mappings; `keyed` names the fields whose arrays on
 * both sides are keyed lists (a merged ruleset's `rules`). Lower key order is
 * preserved and higher-only keys follow.
 */
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

/**
 * A higher entry's place in the union: at the slot of the first lower entry it
 * matches, or appended. `index` is its position in the higher list, which is
 * how the layer's notices name it.
 */
type Placement =
  | {
      readonly item: Readonly<Record<string, unknown>>;
      readonly index: number;
      readonly keys: readonly string[];
      readonly slot: number;
    }
  | { readonly item: unknown; readonly slot: undefined };

/**
 * The keyed union. A higher entry supersedes every lower entry it matches
 * (their key sets intersect) and stands where the first of them stood: under
 * "replace" as written, under "merge" merged key by key into that first one,
 * with its own nested keyed lists. Unmatched lower entries keep their order;
 * higher-only entries append in theirs. Matching reads the lower list as it
 * stood before this layer, so which entries result does not depend on the
 * higher entries' order (only their order within one slot does): a lower
 * entry two higher entries claim between them is superseded by both, and
 * since the boundary keeps a layer's entries key-disjoint, the result is one
 * the section's planner accepts. Total over whatever the lists hold: an item
 * without keys pairs with nothing.
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

/**
 * One knobbed section over the accumulated document: the knobs merge key by
 * key (an omitted `_undeclared` inherits the lower one), the entries combine
 * per the section's layering in this step. A lower value that is not a
 * wrapper (absent, or a null that stayed as written) declares nothing.
 */
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

/** One fold step: the admitted layer over the accumulated document. */
function mergeStep(acc: unknown, layer: AdmittedLayer, notices: OptOutNotice[]): unknown {
  const step: Step = { layer: layer.name, notices };
  // A non-mapping below cannot be merged into; the mapping replaces it.
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

/**
 * Fold the layers low to high into one settings document (see the module
 * header for the dialect). `layering` is the run's default for the knobbed
 * sections; a layer overrides it per section with the wrapper's `_layering`,
 * or for the whole document with a top-level one, both consumed here. The
 * result carries every knobbed section resolved to an explicit policy and
 * never a `_layering` key. Inputs are never mutated; a layer the boundary
 * refuses comes back as an error naming it.
 */
export function mergeLayers(
  layers: readonly Layer[],
  options: { readonly layering: Layering },
): { settings: unknown; notices: OptOutNotice[] } | { error: string } {
  const notices: OptOutNotice[] = [];
  let acc: unknown = {};
  try {
    for (const layer of layers) {
      const admitted = admit(layer, options.layering);
      acc = admitted === null ? structuredClone(layer.doc) : mergeStep(acc, admitted, notices);
    }
  } catch (error) {
    if (error instanceof LayerRefusal) {
      return { error: error.message };
    }
    throw error;
  }
  if (isPlainObject(acc)) {
    resolveUndeclaredPolicies(acc);
  }
  return { settings: acc, notices };
}
