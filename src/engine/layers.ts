/**
 * The layered merge, folded low to high; pure (no Io, no GitHub), and layers are trees: a document aliasing a node
 * inside itself is refused. Lists never combine except a list section's entries, unioned by the module's key
 * (and the nested lists that key declares) under the effective directive: the wrapper's `_layering`, else the file's,
 * else the run's. A list section is knobbed (`{_undeclared, entries}`, the policy resolved after the fold) or plain
 * (`{_layering, entries}`, unwrapped to the bare list after the fold: the directive was its only content).
 *
 * higher plain mapping                  -> merged key by key
 * higher scalar, list, tagged           -> replaces
 * higher null over a lower declaration  -> deletes it (an opt-out notice), except on a section that takes null as its
 *                                          value, where it is written (`pages: null` turns Pages off whatever a lower layer declared)
 * higher null over nothing, or a null   -> stays as written below the top level and on a section that takes null as its
 *                                          value; on any other section it opted out of nothing and drops, so a one-layer
 *                                          `labels: null` folds to no labels
 * knobbed entries under replace         -> the higher list wins
 * knobbed entries under shallow         -> union by key; a same-key entry is swapped for the higher one
 * knobbed entries under deep            -> union by key; a same-key pair merges field by field, nested keyed lists too
 */

import { err, ok, type Result } from "neverthrow";
import { isPlainObject } from "../plain-data.js";
import type { LayerProblem } from "../problem.js";
import {
  LIST_SECTIONS,
  type ListSection,
  SECTION_KEYS,
  type SectionKey,
  type SettingsFile,
  UNDECLARED_POLICY_SECTIONS,
  type UndeclaredPolicySection,
} from "../schema.js";
import { defaultUndeclaredPolicy, type KeyedListLayering } from "../sections/contract/module.js";
import { listLayering, sectionModule } from "../sections/registry.js";
import { LAYERINGS, type Layering } from "../sections/shared/schema-helpers.js";
import type { DistributiveOmit, MustBeNever, UndeclaredPolicy } from "../types.js";

// The flows may not import src/sections (architecture.yml), so the value set reaches them through the engine.
export { LAYERINGS, type Layering };

/** One settings document in the stack, named for notices and refusals. */
export interface Layer {
  readonly name: string;
  readonly doc: unknown;
}

/** A lower declaration a higher layer deleted with `null`. */
export interface OptOutNotice {
  readonly layer: string;
  readonly path: string;
}

const LAYERING_KEY = "_layering";

function isLayering(value: unknown): value is Layering {
  return LAYERINGS.some((layering) => layering === value);
}

/** The directives under which a knobbed list unions by key instead of being replaced. */
type Uniting = Exclude<Layering, "replace">;

const KNOWN_SECTIONS: ReadonlySet<string> = new Set(SECTION_KEYS);

const KNOBBED: ReadonlySet<string> = new Set(UNDECLARED_POLICY_SECTIONS);

function isListSection(key: string): key is ListSection {
  return LIST_SECTIONS.some((section) => section === key);
}

/**
 * The sections whose null is a document value (Pages disabled, no interaction limits), the only top-level nulls the
 * fold may leave standing; the two pins fail to compile when a section's schema starts or stops admitting null.
 * This set governs whole top-level sections; the `nullValued` facet on a list declaration governs nullable fields
 * inside an entry; no key can be both.
 */
const NULL_VALUED_SECTIONS = [
  "pages",
  "interaction_limits",
] as const satisfies readonly SectionKey[];
type NullValuedSection = {
  [K in SectionKey]: null extends SettingsFile[K] ? K : never;
}[SectionKey];
type _NullValuedComplete = MustBeNever<
  Exclude<NullValuedSection, (typeof NULL_VALUED_SECTIONS)[number]>
>;
type _NullValuedSound = MustBeNever<
  Exclude<(typeof NULL_VALUED_SECTIONS)[number], NullValuedSection>
>;

const NULL_VALUED: ReadonlySet<string> = new Set(NULL_VALUED_SECTIONS);

/**
 * A plain array becomes `{entries}` with NO `_undeclared`: that omission is what lets a merge inherit a lower layer's
 * policy. Resolved to the section default here, a higher layer's default would overwrite the lower's explicit policy.
 */
function normalizeListSections(settings: unknown): unknown {
  if (!isPlainObject(settings)) {
    return settings;
  }
  const out: Record<string, unknown> = { ...settings };
  for (const key of LIST_SECTIONS) {
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

/**
 * After the fold, a wrapper still without `_undeclared` takes the section default, so the merged document is
 * self-describing; the knob leads the wrapper, where an author's own sits after the fold.
 */
function resolveUndeclaredPolicies(merged: Record<string, unknown>): void {
  for (const key of UNDECLARED_POLICY_SECTIONS) {
    const value = merged[key];
    if (isPlainObject(value) && Array.isArray(value.entries) && value._undeclared === undefined) {
      put(merged, key, { _undeclared: sectionDefaultPolicy(key), ...value });
    }
  }
}

/**
 * A plain-list section's wrapper carried only the directive the fold consumed, so the rendered document holds the bare
 * list. A wrapper still carrying another key is left for validation to name (its strict shape takes none).
 */
function unwrapPlainLists(merged: Record<string, unknown>): void {
  for (const key of LIST_SECTIONS) {
    const value = merged[key];
    if (KNOBBED.has(key) || !isPlainObject(value) || !Array.isArray(value.entries)) {
      continue;
    }
    if (Object.keys(value).every((knob) => knob === "entries")) {
      put(merged, key, value.entries);
    }
  }
}

/** A nested keyed list in either form: the bare list, or the nested `{_undeclared, entries}` wrapper; null when neither. */
interface NestedForm {
  readonly entries: readonly unknown[];
  /** The wrapper's keys besides `entries`; null for the bare list, so the fold can tell the two forms apart. */
  readonly knobs: Readonly<Record<string, unknown>> | null;
}

function nestedForm(value: unknown): NestedForm | null {
  if (Array.isArray(value)) {
    return { entries: value, knobs: null };
  }
  if (isPlainObject(value) && Array.isArray(value.entries)) {
    const { entries, ...knobs } = value;
    return { entries, knobs };
  }
  return null;
}

/**
 * The clone in progress of every node on the current descent: a node met again inside itself gets that clone, so a
 * cyclic document terminates. A node aliased twice WITHOUT enclosing itself is cloned per occurrence, in the position
 * each sits in (a wrapper aliased under an open section and under `rulesets` is data under one and a keyed list under the other).
 */
type Descent = WeakMap<object, unknown>;

/**
 * What the fold knows inside one keyed entry, at `prefix` below the entry's top: the nested keyed lists its module
 * declares (reachable at the top only) and the paths whose null is a value, not a marker.
 */
interface EntryScope {
  readonly nested: Readonly<Record<string, KeyedListLayering>> | undefined;
  readonly nullValued: ReadonlySet<string>;
  readonly prefix: string;
}

function entryScope(keyed: KeyedListLayering): EntryScope {
  return { nested: keyed.nested, nullValued: new Set(keyed.nullValued ?? []), prefix: "" };
}

function within(scope: EntryScope | undefined, key: string): EntryScope | undefined {
  return scope === undefined ? undefined : { ...scope, prefix: childPath(scope.prefix, key) };
}

function nullIsValue(scope: EntryScope | undefined, key: string): boolean {
  return scope?.nullValued.has(childPath(scope.prefix, key)) === true;
}

function nestedList(scope: EntryScope | undefined, key: string): KeyedListLayering | undefined {
  return scope === undefined || scope.prefix !== "" || scope.nested === undefined
    ? undefined
    : own(scope.nested, key);
}

function stripValue(value: unknown, scope: EntryScope | undefined, descent: Descent): unknown {
  return isPlainObject(value) ? stripMapping(value, scope, descent) : structuredClone(value);
}

/** Mirrors mergeMappings: a null-valued key is a marker and drops unless the scope names it a value, and `scope` names the same lists. */
function stripMapping(
  map: Readonly<Record<string, unknown>>,
  scope: EntryScope | undefined,
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
      if (nullIsValue(scope, key)) {
        put(out, key, null);
      }
      continue;
    }
    const nested = nestedList(scope, key);
    put(
      out,
      key,
      nested === undefined
        ? stripValue(value, within(scope, key), descent)
        : stripNested(value, nested, descent),
    );
  }
  descent.delete(map);
  return out;
}

/** A wrapper as a scope: its knobs are mapping keys (a null one a marker), its `entries` the keyed list. */
function wrapperScope(keyed: KeyedListLayering): EntryScope {
  return { nested: { entries: keyed }, nullValued: new Set(), prefix: "" };
}

/** A nested list in either form: the wrapper is a mapping whose `entries` is the keyed list, the bare list the keyed list itself. */
function stripNested(value: unknown, keyed: KeyedListLayering, descent: Descent): unknown {
  return isPlainObject(value) && Array.isArray(value.entries)
    ? stripMapping(value, wrapperScope(keyed), descent)
    : stripKeyedList(value, keyed, descent);
}

/** Mirrors unionKeyed under deep: the same lists are entered. */
function stripKeyedList(list: unknown, keyed: KeyedListLayering, descent: Descent): unknown {
  if (!Array.isArray(list)) {
    return stripValue(list, undefined, descent);
  }
  const enclosing = descent.get(list);
  if (enclosing !== undefined) {
    return enclosing;
  }
  const out: unknown[] = [];
  descent.set(list, out);
  for (const item of list) {
    out.push(
      isPlainObject(item) ? stripMapping(item, entryScope(keyed), descent) : structuredClone(item),
    );
  }
  descent.delete(list);
  return out;
}

/** The directive a list section folds under, read as admitSection reads it; a value outside the set is not a directive. */
function effectiveLayering(wrapper: unknown, file: Layering | undefined, run: Layering): Layering {
  const directive = isPlainObject(wrapper) ? wrapper[LAYERING_KEY] : undefined;
  return (isLayering(directive) ? directive : undefined) ?? file ?? run;
}

/**
 * A layer validated on its own is seen as the merge could leave it: every null the merge would read as a marker drops,
 * every other null stays for the validator to judge. A list section's entries are entered only under `deep`, the
 * one directive that merges a same-key pair; under `shallow` and `replace` an entry is copied as written. A cyclic
 * input yields a cyclic clone; the merge is what refuses those.
 *
 * `rulesets[main].bypass_actors: null` under deep  -> dropped (a mapping key inside an entry the merge combines)
 * the same under `_layering: shallow`              -> kept (the merge swaps the entry in whole)
 * `branches[].protection: null`                    -> kept (a null-valued entry path: the entry schema types it)
 * `pages: null`                                    -> kept (the section's value; the merge writes it, never reads it as a marker)
 * a null list element                              -> kept
 */
export function stripNulls(doc: unknown, run: Layering): unknown {
  if (!isPlainObject(doc)) {
    return structuredClone(doc);
  }
  const file = isLayering(doc[LAYERING_KEY]) ? doc[LAYERING_KEY] : undefined;
  const descent: Descent = new WeakMap();
  const out: Record<string, unknown> = {};
  descent.set(doc, out);
  for (const [key, value] of Object.entries(doc)) {
    if (value === null && !NULL_VALUED.has(key)) {
      continue;
    }
    let stripped: unknown;
    if (!isListSection(key) || effectiveLayering(value, file, run) !== "deep") {
      stripped = stripValue(value, undefined, descent);
    } else if (isPlainObject(value)) {
      stripped = stripMapping(value, wrapperScope(listLayering(key)), descent);
    } else {
      stripped = stripKeyedList(value, listLayering(key), descent);
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

/** Value-free under the refusals' invariant: mode: render has no redaction context, so no document value may reach a log through the merge. */
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
  readonly keyed: KeyedListLayering;
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
      return refuse(layer, `${path}[${index}]`, {
        code: "layer-no-key",
        keyField: keyed.keyField,
        ...(keyed.keyKind === undefined ? {} : { keyKind: keyed.keyKind }),
      });
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
      const form = nestedForm(entry[field]);
      if (form === null) {
        continue;
      }
      // The wrapper is transparent to the path, as in the rendered order: `environments[0].variables[1]` under both forms.
      const nestedPath = `${path}[${index}].${field}`;
      const checked = admitEntries(layer, nestedPath, form.entries).andThen((mappings) =>
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
    return refuse(layer, LAYERING_KEY, {
      code: "layer-bad-directive",
      actual: value,
      allowed: LAYERINGS,
    });
  }
  return ok(value);
}

function admitSection(
  layer: string,
  key: ListSection,
  value: unknown,
  fallback: { readonly file: Layering | undefined; readonly run: Layering },
): Result<AdmittedSection, LayerProblem> {
  if (!isPlainObject(value) || !Array.isArray(value.entries)) {
    return refuse(layer, key, {
      code: "layer-wrong-shape",
      expected: KNOBBED.has(key)
        ? "a list of mappings or an {_undeclared, entries} wrapper"
        : "a list of mappings or an {_layering, entries} wrapper",
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
        allowed: LAYERINGS,
      });
    }
    const keyed = listLayering(key);
    const section: AdmittedSection = {
      knobs,
      entries,
      layering: directive ?? fallback.file ?? fallback.run,
      keyed,
    };
    return checkKeyed(layer, entries, keyed, key).map(() => section);
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
  const doc = normalizeListSections(layer.doc);
  if (!isPlainObject(doc)) {
    return ok(null);
  }
  return fileLayering(layer.name, doc).andThen((file) => {
    const sections = new Map<string, AdmittedSection>();
    for (const key of LIST_SECTIONS) {
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

/** `stays`: whether a null that met nothing below is kept as written; only a top-level null on a section that has no null value drops. */
function applyNull(
  out: Record<string, unknown>,
  key: string,
  path: string,
  step: Step,
  stays = true,
): void {
  const lower = own(out, key);
  if (lower !== undefined && lower !== null) {
    delete out[key];
    step.notices.push({ layer: step.layer, path });
    return;
  }
  if (stays) {
    put(out, key, null);
  }
}

/**
 * A top-level null is the section's value where the section takes null (`pages: null` is the only spelling of "Pages
 * off", so it is written even over a lower site); elsewhere it opts out of a lower declaration, and over nothing it
 * stays only on an unknown key, for the validator to name.
 */
function applyTopLevelNull(out: Record<string, unknown>, key: string, step: Step): void {
  if (NULL_VALUED.has(key)) {
    put(out, key, null);
    return;
  }
  applyNull(out, key, key, step, !KNOWN_SECTIONS.has(key));
}

function mergeValue(
  below: unknown,
  above: unknown,
  path: string,
  step: Step,
  scope?: EntryScope,
): unknown {
  if (isPlainObject(below) && isPlainObject(above)) {
    return mergeMappings(below, above, path, step, scope);
  }
  return structuredClone(above);
}

function mergeMappings(
  below: Readonly<Record<string, unknown>>,
  above: Readonly<Record<string, unknown>>,
  path: string,
  step: Step,
  scope?: EntryScope,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...below };
  for (const [key, value] of Object.entries(above)) {
    if (value === undefined) {
      continue;
    }
    const here = childPath(path, key);
    if (value === null) {
      if (nullIsValue(scope, key)) {
        put(out, key, null);
      } else {
        applyNull(out, key, here, step);
      }
      continue;
    }
    const nested = nestedList(scope, key);
    const lower = own(out, key);
    const lowerForm = nested === undefined ? null : nestedForm(lower);
    const higherForm = nested === undefined ? null : nestedForm(value);
    if (nested !== undefined && lowerForm !== null && higherForm !== null) {
      put(out, key, mergeNested(lowerForm, higherForm, nested, here, step));
      continue;
    }
    put(out, key, mergeValue(lower, value, here, step, within(scope, key)));
  }
  return out;
}

/**
 * Only a deep merge of two entries reaches a nested keyed list, so its pairs merge field by field too. Two bare lists
 * fold to a bare list; a wrapper on either side keeps the wrapper form, its knobs (`_undeclared`) merged as the
 * top-level knobs are, so a lower policy is inherited by a higher bare list.
 */
function mergeNested(
  lower: NestedForm,
  higher: NestedForm,
  keyed: KeyedListLayering,
  path: string,
  step: Step,
): unknown {
  const entries = unionKeyed(lower.entries, higher.entries, keyed, "deep", path, step);
  if (lower.knobs === null && higher.knobs === null) {
    return entries;
  }
  const knobs = mergeMappings(lower.knobs ?? {}, higher.knobs ?? {}, path, step);
  return { ...knobs, entries };
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
 * entries' order. Only a one-to-one pair merges field by field under deep: an entry that claims, or is claimed by, more
 * than one entry across the two lists is placed as written. Merging a lower entry into one of two higher claimants
 * would carry its rename target into a second entry (a document the section's planner refuses), and merging a higher
 * entry with the first of two lower entries it claims would make the fold depend on the lower order. An empty higher
 * list adds nothing: clearing a list takes `replace`.
 */
function unionKeyed(
  lower: readonly unknown[],
  higher: readonly unknown[],
  keyed: KeyedListLayering,
  directive: Uniting,
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
  const claims = (keys: readonly string[], among: readonly (readonly string[])[]): number =>
    among.filter((other) => intersect(keys, other)).length;
  const out: unknown[] = [];
  lower.forEach((below, index) => {
    const keys = lowerKeys[index] ?? [];
    if (!placed.some((p) => intersect(keys, p.keys))) {
      out.push(below);
      return;
    }
    for (const placement of placed) {
      if (placement.slot !== index) {
        continue;
      }
      const paired =
        claims(
          keys,
          placed.map((p) => p.keys),
        ) === 1 && claims(placement.keys, lowerKeys) === 1;
      out.push(
        directive === "deep" && paired
          ? mergeValue(
              below,
              placement.item,
              `${path}[${placement.index}]`,
              step,
              entryScope(keyed),
            )
          : structuredClone(placement.item),
      );
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
  out.entries =
    section.layering !== "replace" && Array.isArray(lowerEntries)
      ? unionKeyed(lowerEntries, section.entries, section.keyed, section.layering, key, step)
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
      applyTopLevelNull(out, key, step);
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
    unwrapPlainLists(acc);
  }
  return ok({ settings: acc, notices });
}
