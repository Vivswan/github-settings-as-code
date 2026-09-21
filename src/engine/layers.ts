/**
 * The layered merge, folded low to high; pure (no Io, no GitHub), and layers are trees: a document aliasing a node
 * inside itself is refused. Lists never combine except a list section's entries, unioned by the module's key
 * (and the nested lists that key declares) under the effective directive: the wrapper's `_layering`, else the file's,
 * else the run's. A list section is knobbed (`{_undeclared, entries}`, the policy resolved after the fold) or plain
 * (`{_layering, entries}`, unwrapped to the bare list after the fold: the directive was its only content).
 *
 * The undeclared policy resolves once, here after the fold and in the validator for a single document
 * (resolveUndeclaredPolicies), so a planner reads an explicit policy off every wrapper and never derives one:
 * the wrapper's `_undeclared`, else the file's top-level `_undeclared`, else the run's `undeclared` input, else the
 * list's own default. The file-wide key is a directive the boundary admits and the fold consumes: the highest layer
 * that sets it steers the whole fold, and it never reaches the rendered document.
 *
 * The cascade: the higher layer's value wins, and null is a value like any other, the EMPTY or OFF state on GitHub.
 * The fold never reads a null as a marker; whether a key admits null is the schema's question, asked of every layer
 * and of the fold (engine/validate.ts). What a higher layer cannot say with a value, it says with a directive.
 *
 * higher plain mapping                  -> merged key by key
 * higher scalar, list, null, tagged     -> replaces
 * knobbed entries under replace         -> the higher list wins
 * knobbed entries under shallow         -> union by key; a same-key entry is swapped for the higher one
 * knobbed entries under deep            -> union by key; a same-key pair merges field by field, nested keyed lists too
 * `_remove: true` on a keyed entry      -> drops the lower entry it claims, with a notice; the marker never reaches the
 *                                          rendered document, and one that has nothing to remove is refused
 */

import { err, ok, type Result } from "neverthrow";
import { isPlainObject } from "../plain-data.js";
import type { LayerProblem } from "../problem.js";
import {
  LIST_SECTIONS,
  type ListSection,
  UNDECLARED_POLICY_SECTIONS,
  type UndeclaredPolicySection,
} from "../schema.js";
import { defaultUndeclaredPolicy, type KeyedListLayering } from "../sections/contract/module.js";
import { listLayering, sectionModule } from "../sections/registry.js";
import {
  LAYERINGS,
  type Layering,
  UNDECLARED_POLICIES,
} from "../sections/shared/schema-helpers.js";
import type { DistributiveOmit, UndeclaredPolicy } from "../types.js";

// The flows may not import src/sections (architecture.yml), so the value sets reach them through the engine.
export { LAYERINGS, type Layering, UNDECLARED_POLICIES };

/** One settings document in the stack, named for notices and refusals. */
export interface Layer {
  readonly name: string;
  readonly doc: unknown;
}

/** A lower entry a higher layer's `_remove: true` dropped; `path` names the removal entry by its index in that layer. */
export interface RemovalNotice {
  readonly layer: string;
  readonly path: string;
}

const LAYERING_KEY = "_layering";

/** The policy knob's key: on a knobbed wrapper (top-level or nested) a value, at a file's top level a directive. */
const UNDECLARED_KEY = "_undeclared";

/** The one entry-level directive: `_remove: true` names a lower entry by its key and drops it. */
const REMOVE_KEY = "_remove";

function isLayering(value: unknown): value is Layering {
  return LAYERINGS.some((layering) => layering === value);
}

function isUndeclaredPolicy(value: unknown): value is UndeclaredPolicy {
  return UNDECLARED_POLICIES.some((policy) => policy === value);
}

/** The knobs a fold or a single document is resolved under; `undeclared` is the run input, unset unless the workflow set it. */
export interface FoldOptions {
  readonly layering: Layering;
  readonly undeclared?: UndeclaredPolicy | undefined;
}

/** The directives under which a knobbed list unions by key instead of being replaced. */
type Uniting = Exclude<Layering, "replace">;

const KNOBBED: ReadonlySet<string> = new Set(UNDECLARED_POLICY_SECTIONS);

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
 * A list in either form with its policy made explicit: the wrapper's own, else `fallback`, else `own` (the list's
 * default). A `_undeclared` that is present but not a policy (null) is left for the validator to refuse; the knob
 * leads the wrapper, where an author's own sits after the fold. A library caller's object can carry the key with an
 * explicit undefined, which is no policy: it is dropped before the resolved one is set, so it cannot overwrite it.
 */
function resolvedWrapper(
  value: unknown,
  fallback: UndeclaredPolicy | undefined,
  own: UndeclaredPolicy,
): unknown {
  const form = nestedForm(value);
  if (form === null || form.knobs?.[UNDECLARED_KEY] !== undefined) {
    return value;
  }
  const { [UNDECLARED_KEY]: _unset, ...knobs } = form.knobs ?? {};
  return { [UNDECLARED_KEY]: fallback ?? own, ...knobs, entries: form.entries };
}

/** An entry with each nested list that takes the knob resolved; entries are shared with the layers, so a resolved one is a new object. */
function resolveNestedPolicies(
  entry: unknown,
  keyed: KeyedListLayering,
  fallback: UndeclaredPolicy | undefined,
): unknown {
  if (!isPlainObject(entry)) {
    return entry;
  }
  let out: Record<string, unknown> | null = null;
  for (const [field, nested] of Object.entries(keyed.nested ?? {})) {
    if (nested.undeclaredDefault === undefined) {
      continue;
    }
    const value = own(entry, field);
    const resolved = resolvedWrapper(value, fallback, nested.undeclaredDefault);
    if (resolved !== value) {
      out ??= { ...entry };
      put(out, field, resolved);
    }
  }
  return out ?? entry;
}

/**
 * The ONE resolution of the undeclared policy, over a folded or a validated document: every knobbed section and every
 * nested list that takes the knob comes out in wrapper form with an explicit `_undeclared`: the wrapper's own, else
 * `fallback` (the file's top-level directive, else the run input, both admitted by the caller), else the list's default.
 */
export function resolveUndeclaredPolicies(
  doc: Record<string, unknown>,
  fallback: UndeclaredPolicy | undefined,
): void {
  for (const key of UNDECLARED_POLICY_SECTIONS) {
    const value = own(doc, key);
    if (value !== undefined) {
      put(doc, key, resolvedWrapper(value, fallback, sectionDefaultPolicy(key)));
    }
  }
  for (const key of LIST_SECTIONS) {
    const form = nestedForm(own(doc, key));
    const keyed = listLayering(key);
    if (form === null || keyed.nested === undefined) {
      continue;
    }
    const entries = form.entries.map((entry) => resolveNestedPolicies(entry, keyed, fallback));
    put(doc, key, form.knobs === null ? entries : { ...form.knobs, entries });
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

/** Whether a keyed entry is a removal: `_remove: true` beside its key. The boundary refused every other `_remove`. */
function isRemoval(entry: unknown): entry is Readonly<Record<string, unknown>> {
  return isPlainObject(entry) && entry[REMOVE_KEY] === true;
}

/** What the fold knows inside one keyed entry, at `prefix` below the entry's top: the nested keyed lists its module declares (reachable at the top only). */
interface EntryScope {
  readonly nested: Readonly<Record<string, KeyedListLayering>> | undefined;
  readonly prefix: string;
}

function entryScope(keyed: KeyedListLayering): EntryScope {
  return { nested: keyed.nested, prefix: "" };
}

function within(scope: EntryScope | undefined, key: string): EntryScope | undefined {
  return scope === undefined ? undefined : { ...scope, prefix: childPath(scope.prefix, key) };
}

function nestedList(scope: EntryScope | undefined, key: string): KeyedListLayering | undefined {
  return scope === undefined || scope.prefix !== "" || scope.nested === undefined
    ? undefined
    : own(scope.nested, key);
}

/** A layer refusal minus its position: the boundary adds the layer and site where it fires. */
type Refusal = DistributiveOmit<LayerProblem, "layer" | "site">;

/**
 * No document value ever enters a refusal's prose; the marker test in test/engine/layers.test.ts pins it. Of the
 * author's keys, only the paths riding beside a removal marker do (`extra`), so the author can find and drop them.
 *
 * `actual`    -> the only document value carried, and describeProblem describes it by shape
 * `keyField`  -> the module's declared key field; `keyPaths` the dotted paths a removal names its entry by
 * `extra`     -> the author's own dotted paths beside a removal marker, never their values
 * `site`      -> section keys, entry indices, module-declared field names, LAYERING_KEY, REMOVE_KEY, "the document"
 */
function refuse(layer: string, site: string, refusal: Refusal): Result<never, LayerProblem> {
  return err({ layer, site, ...refusal });
}

/** Value-free under the refusals' invariant: mode: render has no redaction context, so no document value may reach a log through the merge. */
export function describeRemoval(notice: RemovalNotice): string {
  return `${notice.layer}: ${notice.path} carries _remove: true and dropped the entry a lower layer declared under its key`;
}

/** One layer's step: its removals, and the first refusal the fold met while placing its entries. */
interface Step {
  readonly layer: string;
  readonly notices: RemovalNotice[];
  refusal: LayerProblem | undefined;
}

/** Only the first refusal is kept: the fold stops at the layer that carries it. */
function refuseStep(step: Step, site: string, refusal: Refusal): void {
  step.refusal ??= { layer: step.layer, site, ...refusal };
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
  /** The layer's file-wide `_undeclared`, when it sets one. */
  readonly undeclared: UndeclaredPolicy | undefined;
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

/** The dotted paths a removal entry may carry beside `_remove`: the key field's own (`config.url`) unless the module names a composite. */
function removalPaths(keyed: KeyedListLayering): readonly string[] {
  return keyed.removalPaths ?? [keyed.keyField];
}

type Segments = readonly string[];

function sameSegments(a: Segments, b: Segments): boolean {
  return a.length === b.length && a.every((segment, index) => segment === b[index]);
}

function leadsTo(prefix: Segments, path: Segments): boolean {
  return path.length > prefix.length && prefix.every((segment, index) => segment === path[index]);
}

/**
 * The paths of `entry` outside `allowed`, named in full (`config.secret`), compared segment by segment so a literal
 * key spelled `config.url` never passes for the nested one: a mapping on the way to an allowed path is walked, the
 * value at an allowed path is the key's own and stays unjudged here (keys() reads it).
 */
function pathsOutside(
  entry: Readonly<Record<string, unknown>>,
  allowed: readonly Segments[],
  prefix: Segments = [],
): string[] {
  const outside: string[] = [];
  for (const [field, value] of Object.entries(entry)) {
    const path = [...prefix, field];
    if (
      (prefix.length === 0 && field === REMOVE_KEY) ||
      allowed.some((known) => sameSegments(known, path))
    ) {
      continue;
    }
    if (isPlainObject(value) && allowed.some((known) => leadsTo(path, known))) {
      outside.push(...pathsOutside(value, allowed, path));
      continue;
    }
    outside.push(path.join("."));
  }
  return outside;
}

/**
 * A removal entry names its key and nothing else: a field beside the marker, at any depth of the key's container,
 * would be silently lost, and a marker that is not `true` would be a value the schema never sees (the standalone view
 * drops removal entries before validation).
 */
function checkRemoval(
  layer: string,
  entry: Readonly<Record<string, unknown>>,
  keyed: KeyedListLayering,
  site: string,
  directive: Layering | undefined,
): Result<void, LayerProblem> {
  const marker = entry[REMOVE_KEY];
  if (marker === undefined) {
    return ok();
  }
  if (marker !== true) {
    return refuse(layer, `${site}.${REMOVE_KEY}`, {
      code: "layer-remove-not-true",
      actual: marker,
    });
  }
  const keyPaths = removalPaths(keyed);
  const extra = pathsOutside(
    entry,
    keyPaths.map((path) => path.split(".")),
  );
  if (extra.length > 0) {
    return refuse(layer, site, { code: "layer-remove-with-fields", keyPaths, extra });
  }
  if (directive === "replace") {
    return refuse(layer, site, { code: "layer-remove-nothing", reason: "replace" });
  }
  return ok();
}

/**
 * Two entries of one layer claiming a key (a label renaming into a sibling's name) are refused here, so unionKeyed
 * never meets them; a removal entry is checked for its shape here and for something to remove at the fold. `directive`
 * is the section's at the top level and undefined inside a nested list, whose fate the parent pair decides.
 */
function checkKeyed(
  layer: string,
  entries: readonly Readonly<Record<string, unknown>>[],
  keyed: KeyedListLayering,
  path: string,
  directive: Layering | undefined,
): Result<void, LayerProblem> {
  const seen = new Map<string, number>();
  for (const [index, entry] of entries.entries()) {
    const site = `${path}[${index}]`;
    const removal = checkRemoval(layer, entry, keyed, site, directive);
    if (removal.isErr()) {
      return removal;
    }
    const keys = keyed.keys(entry);
    if (keys === null) {
      const alongside = removalPaths(keyed).filter((path) => path !== keyed.keyField);
      return refuse(layer, site, {
        code: "layer-no-key",
        keyField: keyed.keyField,
        ...(keyed.keyKind === undefined ? {} : { keyKind: keyed.keyKind }),
        ...(alongside.length === 0 ? {} : { alongside }),
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
      const nestedPath = `${site}.${field}`;
      const checked = admitEntries(layer, nestedPath, form.entries).andThen((mappings) =>
        checkKeyed(layer, mappings, nested, nestedPath, undefined),
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

/** The file-wide policy, admitted here and carried as parsed, so the resolution after the fold never re-reads the key. */
function fileUndeclared(
  layer: string,
  doc: Readonly<Record<string, unknown>>,
): Result<UndeclaredPolicy | undefined, LayerProblem> {
  const value = doc[UNDECLARED_KEY];
  if (value === undefined || isUndeclaredPolicy(value)) {
    return ok(value);
  }
  return refuse(layer, UNDECLARED_KEY, {
    code: "layer-bad-directive",
    actual: value,
    allowed: UNDECLARED_POLICIES,
  });
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
    const layering = directive ?? fallback.file ?? fallback.run;
    const section: AdmittedSection = { knobs, entries, layering, keyed };
    return checkKeyed(layer, entries, keyed, key, layering).map(() => section);
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
 * The layer boundary: past it the fold never meets a cycle, an unkeyed entry, a duplicated key, or a malformed
 * removal. A non-mapping passes as written for the top-level validator to name; so does a null section (the
 * validator decides whether the section takes null).
 */
function admit(layer: Layer, run: Layering): Result<AdmittedLayer | null, LayerProblem> {
  if (hasCycle(layer.doc, new WeakSet(), new WeakSet())) {
    return refuse(layer.name, "the document", { code: "layer-cycle" });
  }
  const doc = normalizeListSections(layer.doc);
  if (!isPlainObject(doc)) {
    return ok(null);
  }
  return fileUndeclared(layer.name, doc).andThen((undeclared) =>
    fileLayering(layer.name, doc).andThen((file) => {
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
      return ok({ name: layer.name, doc, sections, undeclared });
    }),
  );
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
 * The site of the first removal inside an entry's nested lists, or null: an entry the fold copies as written (a new
 * key, a shallow swap, a replaced list) has no lower pair for a nested `_remove` to act on, so such a marker is refused
 * instead of reaching the rendered document.
 */
function nestedRemovalSite(
  entry: Readonly<Record<string, unknown>>,
  keyed: KeyedListLayering,
  path: string,
): string | null {
  for (const [field, nested] of Object.entries(keyed.nested ?? {})) {
    const form = nestedForm(entry[field]);
    if (form === null) {
      continue;
    }
    for (const [index, item] of form.entries.entries()) {
      if (!isPlainObject(item)) {
        continue;
      }
      const site = `${path}.${field}[${index}]`;
      if (isRemoval(item)) {
        return site;
      }
      const deeper = nestedRemovalSite(item, nested, site);
      if (deeper !== null) {
        return deeper;
      }
    }
  }
  return null;
}

/** Why a removal had nothing to act on, for the refusal's prose. */
type NothingToRemove = Extract<LayerProblem, { code: "layer-remove-nothing" }>["reason"];

/**
 * An entry the fold places as written meets nothing below: a removal at its top is refused for `reason`, and one inside
 * its nested lists because the entry is copied whole (or, under replace, because the whole list already wins).
 */
function refuseRemovalsIn(
  item: Readonly<Record<string, unknown>>,
  keyed: KeyedListLayering,
  path: string,
  reason: NothingToRemove,
  step: Step,
): void {
  if (isRemoval(item)) {
    refuseStep(step, path, { code: "layer-remove-nothing", reason });
    return;
  }
  const site = nestedRemovalSite(item, keyed, path);
  if (site !== null) {
    refuseStep(step, site, {
      code: "layer-remove-nothing",
      reason: reason === "replace" ? "replace" : "swapped",
    });
  }
}

function copiedAsWritten(
  item: Readonly<Record<string, unknown>>,
  keyed: KeyedListLayering,
  path: string,
  reason: NothingToRemove,
  step: Step,
): Readonly<Record<string, unknown>> {
  refuseRemovalsIn(item, keyed, path, reason, step);
  return structuredClone(item);
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
    const nested = nestedList(scope, key);
    const lower = own(out, key);
    if (nested !== undefined) {
      const higherForm = nestedForm(value);
      const lowerForm = nestedForm(lower);
      if (higherForm !== null && lowerForm !== null) {
        put(out, key, mergeNested(lowerForm, higherForm, nested, here, step));
        continue;
      }
      if (higherForm !== null) {
        // A nested list with nothing below it: its entries are copied as written, so a removal among them is refused.
        higherForm.entries.forEach((item, index) => {
          if (isPlainObject(item)) {
            refuseRemovalsIn(item, nested, `${here}[${index}]`, "unmatched", step);
          }
        });
      }
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

/** `index` is the entry's position in the higher list, which is how the layer's notices and refusals name it. */
type Placement =
  | {
      readonly item: Readonly<Record<string, unknown>>;
      readonly index: number;
      readonly keys: readonly string[];
      readonly slot: number;
    }
  | { readonly item: unknown; readonly index: number; readonly slot: undefined };

/**
 * Matching reads the lower list as it stood before this layer, so which entries result does not depend on the higher
 * entries' order. Only a one-to-one pair merges field by field under deep: an entry that claims, or is claimed by, more
 * than one entry across the two lists is placed as written. Merging a lower entry into one of two higher claimants
 * would carry its rename target into a second entry (a document the section's planner refuses), and merging a higher
 * entry with the first of two lower entries it claims would make the fold depend on the lower order. An empty higher
 * list adds nothing: clearing a list takes `replace`. A removal drops the lower entry it claims and is never placed;
 * one that claims nothing is refused.
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
      : { item, index, slot: undefined };
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
      const site = `${path}[${placement.index}]`;
      if (isRemoval(placement.item)) {
        step.notices.push({ layer: step.layer, path: site });
        continue;
      }
      const paired =
        claims(
          keys,
          placed.map((p) => p.keys),
        ) === 1 && claims(placement.keys, lowerKeys) === 1;
      out.push(
        directive === "deep" && paired
          ? mergeValue(below, placement.item, site, step, entryScope(keyed))
          : copiedAsWritten(placement.item, keyed, site, "swapped", step),
      );
    }
  });
  for (const { item, index, slot } of placements) {
    if (slot !== undefined) {
      continue;
    }
    out.push(
      isPlainObject(item)
        ? copiedAsWritten(item, keyed, `${path}[${index}]`, "unmatched", step)
        : structuredClone(item),
    );
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
  if (section.layering !== "replace" && Array.isArray(lowerEntries)) {
    out.entries = unionKeyed(
      lowerEntries,
      section.entries,
      section.keyed,
      section.layering,
      key,
      step,
    );
    return out;
  }
  // The higher list is written whole: under replace, or with no lower list to union with.
  const reason: NothingToRemove = section.layering === "replace" ? "replace" : "unmatched";
  out.entries = section.entries.map((item, index) =>
    copiedAsWritten(item, section.keyed, `${key}[${index}]`, reason, step),
  );
  return out;
}

function mergeStep(acc: unknown, layer: AdmittedLayer, step: Step): unknown {
  const below = isPlainObject(acc) ? acc : {};
  const out: Record<string, unknown> = { ...below };
  for (const [key, value] of Object.entries(layer.doc)) {
    if (key === LAYERING_KEY || key === UNDECLARED_KEY || value === undefined) {
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

/** Whether an entry carries the marker at all, whatever its value: what the standalone view drops and a single document refuses. */
function carriesRemoval(entry: Readonly<Record<string, unknown>>): boolean {
  return entry[REMOVE_KEY] !== undefined;
}

/**
 * Per list as validation spells it over the document minus its removals (`labels`, `labels.entries`,
 * `environments[0].variables`), the source index of each kept entry; only a list a removal shifted is recorded.
 */
type SourceIndices = Map<string, readonly number[]>;

/** A keyed list's removals set apart from it, its entries' nested lists likewise, in the form the layer wrote them. */
interface Partition {
  /** The entries minus the removals, each entry's declared nested lists partitioned in turn. */
  readonly kept: unknown[];
  /** Each removal by its marker's site (`labels[0]._remove`); a removal's own nested lists are not entered. */
  readonly sites: string[];
}

/**
 * `path` names the list as the sites do, by the document's own indices; `viewPath` as validation spells the kept
 * entries (`labels.entries`, `environments[1].variables`), the key under which `sources` records their origins.
 */
function partitionRemovals(
  entries: readonly unknown[],
  keyed: KeyedListLayering,
  path: string,
  viewPath: string,
  sources: SourceIndices,
): Partition {
  const kept: unknown[] = [];
  const sites: string[] = [];
  const origins: number[] = [];
  // Indexed, not a method of the list: the walk runs on the raw document, before the plainness check that refuses a
  // list whose named property shadows one (test/engine/validate.test.ts).
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isPlainObject(entry)) {
      origins.push(index);
      kept.push(entry);
      continue;
    }
    const site = `${path}[${index}]`;
    if (carriesRemoval(entry)) {
      sites.push(`${site}.${REMOVE_KEY}`);
      continue;
    }
    const viewSite = `${viewPath}[${kept.length}]`;
    origins.push(index);
    const out: Record<string, unknown> = { ...entry };
    for (const [field, nested] of Object.entries(keyed.nested ?? {})) {
      const form = nestedForm(entry[field]);
      if (form === null) {
        continue;
      }
      const below = partitionRemovals(
        form.entries,
        nested,
        `${site}.${field}`,
        form.knobs === null ? `${viewSite}.${field}` : `${viewSite}.${field}.entries`,
        sources,
      );
      sites.push(...below.sites);
      out[field] = form.knobs === null ? below.kept : { ...form.knobs, entries: below.kept };
    }
    kept.push(out);
  }
  if (origins.some((source, index) => source !== index)) {
    sources.set(viewPath, origins);
  }
  return { kept, sites };
}

/** A path as validation spells one after the section key: `.field` or `[index]` steps (src/engine/validate.ts). */
const PATH_STEP = /\.[A-Za-z_]\w*|\[\d+\]/g;

/**
 * The way back from an issue over the document minus its removals to the document as written: the leading path's
 * list indices, list by list. An index in a list no removal shifted stays, and so does everything after the path,
 * where a message may quote a document value.
 */
function renumbering(sources: SourceIndices): (issue: string) => string {
  if (sources.size === 0) {
    return (issue) => issue;
  }
  const sections = new Set([...sources.keys()].map((path) => path.split(/[.[]/, 1)[0]));
  const leadingPath = new RegExp(`^(${[...sections].join("|")})((?:${PATH_STEP.source})*)`);
  return (issue) =>
    issue.replace(leadingPath, (_match, section: string, steps: string) => {
      let viewed = section;
      let written = section;
      for (const step of steps.match(PATH_STEP) ?? []) {
        if (step.startsWith("[")) {
          const index = Number(step.slice(1, -1));
          written += `[${sources.get(viewed)?.[index] ?? index}]`;
        } else {
          written += step;
        }
        viewed += step;
      }
      return written;
    });
}

/** A document's removal entries set apart from it; `rest` is the document itself when it is not a mapping. */
export interface SeparatedRemovals {
  /** The document minus every entry carrying `_remove`, in either list form and at any depth; the wrappers' knobs stay. */
  readonly rest: unknown;
  /** Each removal's site (`labels[0]._remove`): list sections in LIST_SECTIONS order, each list as written, nested lists under their entry. */
  readonly sites: readonly string[];
  /**
   * A validation issue over `rest`, its leading path renumbered to the document as written: a removal dropped from
   * the list shifts every entry after it, so `labels[0].color` in `rest` is the reader's `labels[1].color`.
   */
  readonly asWritten: (issue: string) => string;
}

/**
 * Every list section partitioned by the walk the fold uses. A single document has no lower layer to remove from, so
 * validateSettingsDoc refuses the sites and judges `rest`; a layer of a fold reaches it as its standalone view,
 * `rest` minus the `_layering` directives. Either way what is said about `rest` is said of the document as written.
 */
export function separateRemovals(doc: unknown): SeparatedRemovals {
  if (!isPlainObject(doc)) {
    return { rest: doc, sites: [], asWritten: (issue) => issue };
  }
  const rest: Record<string, unknown> = { ...doc };
  const sites: string[] = [];
  const sources: SourceIndices = new Map();
  for (const key of LIST_SECTIONS) {
    const form = nestedForm(doc[key]);
    if (form === null) {
      continue;
    }
    const below = partitionRemovals(
      form.entries,
      listLayering(key),
      key,
      form.knobs === null ? key : `${key}.entries`,
      sources,
    );
    sites.push(...below.sites);
    rest[key] = form.knobs === null ? below.kept : { ...form.knobs, entries: below.kept };
  }
  return { rest, sites, asWritten: renumbering(sources) };
}

/** The layer as its own validation sees it, and the way back from what that validation says to the layer as written. */
export interface StandaloneView {
  readonly doc: unknown;
  /** `SeparatedRemovals.asWritten` for the layer: the view dropped its removal entries, and validation counts what it sees. */
  readonly asWritten: (issue: string) => string;
}

/**
 * The layer as the standalone validation sees it: the document minus the directives the fold consumes. Every
 * value, null included, stays for the shapes to judge: a null the schema does not admit is the layer's own error.
 *
 * `_layering`, at the top or on a list section's wrapper  -> dropped: the fold validates the directive itself
 * `_undeclared` at the top                                -> dropped: the fold validates it and resolves it into the wrappers
 * an entry carrying `_remove`, at any depth, any value     -> dropped: it declares nothing, and the fold checks its shape
 *                                                             (a closed entry schema would otherwise name the marker an
 *                                                             unknown key before the fold could say it takes only true)
 */
export function standaloneView(doc: unknown): StandaloneView {
  const { rest, asWritten } = separateRemovals(doc);
  if (!isPlainObject(rest)) {
    return { doc: rest, asWritten };
  }
  const { _layering: _directive, _undeclared: _policy, ...out } = rest;
  for (const key of LIST_SECTIONS) {
    const value = out[key];
    if (isPlainObject(value) && Array.isArray(value.entries)) {
      const { _layering: _wrapperDirective, ...knobs } = value;
      out[key] = knobs;
    }
  }
  return { doc: out, asWritten };
}

export function mergeLayers(
  layers: readonly Layer[],
  options: FoldOptions,
): Result<{ settings: unknown; notices: RemovalNotice[] }, LayerProblem> {
  const notices: RemovalNotice[] = [];
  let acc: unknown = {};
  // The file-wide directive as the highest layer set it: a directive steering the fold, never a merged value.
  let filePolicy: UndeclaredPolicy | undefined;
  for (const layer of layers) {
    const admitted = admit(layer, options.layering);
    if (admitted.isErr()) {
      return err(admitted.error);
    }
    if (admitted.value === null) {
      acc = structuredClone(layer.doc);
      continue;
    }
    filePolicy = admitted.value.undeclared ?? filePolicy;
    const step: Step = { layer: layer.name, notices, refusal: undefined };
    acc = mergeStep(acc, admitted.value, step);
    if (step.refusal !== undefined) {
      return err(step.refusal);
    }
  }
  if (isPlainObject(acc)) {
    resolveUndeclaredPolicies(acc, filePolicy ?? options.undeclared);
    unwrapPlainLists(acc);
  }
  return ok({ settings: acc, notices });
}
