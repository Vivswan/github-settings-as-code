/**
 * The layered merge, folded low to high over the layers admit.ts let past, and the standalone view each layer is
 * validated through on the way (the document minus what the fold consumes); pure (no Io, no GitHub). The cascade the
 * merge applies is docs/operate/layering.md's.
 */

import { err, ok, type Result } from "neverthrow";
import { isPlainObject, own, put } from "../plain-data.js";
import type { LayerProblem } from "../problem.js";
import { LIST_SECTIONS } from "../schema.js";
import type { KeyedListLayering } from "../sections/contract/module.js";
import {
  LAYERINGS,
  type Layering,
  UNDECLARED_POLICIES,
} from "../sections/shared/schema-helpers.js";
import type { UndeclaredPolicy } from "../types.js";
import { type AdmittedLayer, type AdmittedSection, admit, type Refusal } from "./admit.js";
import {
  KNOBBED,
  LAYERING_KEY,
  type NestedForm,
  nestedForm,
  REMOVE_KEY,
  UNDECLARED_KEY,
} from "./directives.js";
import { separateRemovals } from "./separate-removals.js";
import { resolveUndeclaredPolicies } from "./undeclared.js";

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

/** The knobs a fold or a single document is resolved under; `undeclared` is the run input, unset unless the workflow set it. */
export interface FoldOptions {
  readonly layering: Layering;
  readonly undeclared?: UndeclaredPolicy | undefined;
}

/** The directives under which a knobbed list unions by key instead of being replaced. */
type Uniting = Exclude<Layering, "replace">;

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

/** Whether a keyed entry is a removal: `_remove: true` beside its key. admit.ts refused every other `_remove`. */
function isRemoval(entry: unknown): entry is Readonly<Record<string, unknown>> {
  return isPlainObject(entry) && entry[REMOVE_KEY] === true;
}

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

/**
 * Value-free under the refusals' invariant (`Refusal` in admit.ts): mode: render has no redaction context, so no
 * document value may reach a log through the merge.
 */
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

function childPath(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
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
