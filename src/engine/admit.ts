/**
 * The layer boundary: past `admit`, the merge (layers.ts) never meets a cycle, an unkeyed entry, a duplicated key, a
 * malformed removal, or a directive outside its value set. What a refusal may carry is `Refusal`'s rule, and the
 * merge's own refusals (refuseStep) keep it.
 */

import { err, ok, type Result } from "neverthrow";
import { isPlainObject } from "../plain-data.js";
import type { LayerProblem } from "../problem.js";
import { LIST_SECTIONS, type ListSection } from "../schema.js";
import type { KeyedListLayering } from "../sections/contract/module.js";
import { listLayering } from "../sections/registry.js";
import {
  LAYERINGS,
  type Layering,
  UNDECLARED_POLICIES,
} from "../sections/shared/schema-helpers.js";
import type { DistributiveOmit, UndeclaredPolicy } from "../types.js";
import { KNOBBED, LAYERING_KEY, nestedForm, REMOVE_KEY, UNDECLARED_KEY } from "./directives.js";
import type { Layer } from "./layers.js";

function isLayering(value: unknown): value is Layering {
  return LAYERINGS.some((layering) => layering === value);
}

function isUndeclaredPolicy(value: unknown): value is UndeclaredPolicy {
  return UNDECLARED_POLICIES.some((policy) => policy === value);
}

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

/** A layer refusal minus its position: the boundary adds the layer and site where it fires. */
export type Refusal = DistributiveOmit<LayerProblem, "layer" | "site">;

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

export interface AdmittedSection {
  /** The wrapper's keys besides `entries` and `_layering`: `_undeclared`, or a typo kept for validation to name. */
  readonly knobs: Readonly<Record<string, unknown>>;
  readonly entries: readonly Readonly<Record<string, unknown>>[];
  readonly layering: Layering;
  readonly keyed: KeyedListLayering;
}

export interface AdmittedLayer {
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
 * A non-mapping passes as written for the top-level validator to name; so does a null section (the validator decides
 * whether the section takes null).
 */
export function admit(layer: Layer, run: Layering): Result<AdmittedLayer | null, LayerProblem> {
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
