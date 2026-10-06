import { validateSettingsDoc } from "../../../src/engine/orchestrate.js";
import { SectionSelection } from "../../../src/engine/section-selection.js";
import { silentIo } from "../../../src/io.js";
import {
  LIST_SECTIONS,
  type ListSection,
  SECTION_KEYS,
  type SectionKey,
  UNDECLARED_POLICY_SECTIONS,
} from "../../../src/schema.js";
import {
  DEFAULT_LAYERING_DIRECTIVE,
  entriesOf,
  type Json,
  LAYERING_DIRECTIVES,
  LAYERING_KEY,
  type LayeringDirective,
  REMOVE_KEY,
  UNDECLARED_KEY,
  UNDECLARED_POLICIES,
  type UndeclaredPolicyWord,
} from "../gen-support.js";
import type { Rng } from "../prng.js";
import type { Scenario } from "../schema.js";
import { genSettings, validateAgainstPublishedSchema } from "./settings.js";
import type { GenScenarioOptions } from "./single-scenario.js";

/** `name` is the file name the runner writes and the action's refusals and notices report. */
export interface MergeLayer {
  name: string;
  doc: Json;
}

/**
 * Each is refused with a message naming the layer: at the layer boundary, by the layer's own validation (null-section),
 * or by the fold (remove-unmatched). A reference cycle cannot be spelled in scenario JSON, so it is not generated.
 */
export const MERGE_REFUSAL_KINDS = [
  /** Two entries of one keyed list sharing a key: rules, by type. */
  "duplicate-rule-type",
  /** Two entries of one keyed list sharing a key: labels, by case-folded name. */
  "duplicate-label",
  /** A wrapper's `_layering` outside replace|shallow|deep. */
  "bad-wrapper-layering",
  /** A file's top-level `_layering` outside replace|shallow|deep. */
  "bad-file-layering",
  /** A top-level `_undeclared` outside keep|delete (null among them: the knob has no empty state). */
  "bad-file-undeclared",
  /** A `_remove: true` entry in a list whose effective directive is replace. */
  "remove-under-replace",
  /** A `_remove: true` entry no lower layer declares a key for. */
  "remove-unmatched",
  /** A `_remove: true` entry carrying a field beside its key. */
  "remove-with-fields",
  /** A whole-section null on a section whose value null is not. */
  "null-section",
] as const;
type MergeRefusalKind = (typeof MERGE_REFUSAL_KINDS)[number];

/**
 * Read off the FINAL layer documents by mergeFeaturesOf, never off the draws (a later mutation can undo one), so the
 * fuzz histogram and the generator tests count shapes the run actually saw. A refused stack asserts no document, so it
 * counts for "refused" alone.
 */
export const MERGE_FEATURES = [
  /** A section declared non-null by a layer while the fold already holds it. */
  "override",
  /** Labels declared under an effective shallow or deep layering while the fold holds labels. */
  "union-labels",
  /** Rulesets declared under an effective shallow or deep layering while the fold holds rulesets. */
  "union-rulesets",
  /**
   * Environments declared under an effective shallow or deep layering while the fold holds environments: a plain-list
   * union, its nested lists with it under deep.
   */
  "union-environments",
  /** A plain-list section (environments, branches, workflows) drawn in its `{_layering, entries}` wrapper form. */
  "wrapper-layered",
  /** A unioned label whose name differs only by case from the spelling the fold holds. */
  "label-case-fold",
  /** A unioned label pairing with a held label through a rename: one of the two claims the other's name as its rename target or current name. */
  "label-rename-union",
  /** A unioned ruleset re-declaring a held rule type with different parameters, so the swap (shallow) or the field merge (deep) is observable. */
  "rule-parameters",
  /** A top-level null on a section whose value null is (NULLABLE_SECTIONS), held below or not: the fold writes it. */
  "null-section",
  /** A null inside a mapping section, at a key the schema admits null for (a passthrough key, a nullable field). */
  "null-nested",
  /** A null field inside a keyed entry (a branch's `protection: null`). */
  "null-entry-field",
  /** A `_remove: true` label dropping a held label. */
  "remove-entry",
  /** A `_remove: true` rule dropping a held rule type inside a deep-merged ruleset. */
  "remove-nested",
  "wrapper-undeclared",
  /** A layer's top-level `_undeclared`: the fold's fallback policy for every list without its own. */
  "file-undeclared",
  "run-undeclared-keep",
  "run-undeclared-delete",
  "run-undeclared-default",
  "wrapper-layering-replace",
  "wrapper-layering-shallow",
  "wrapper-layering-deep",
  "file-layering",
  "run-layering-replace",
  "run-layering-shallow",
  "run-layering-deep",
  "run-layering-default",
  "empty-layer",
  "refused",
] as const;
type MergeFeature = (typeof MERGE_FEATURES)[number];

/**
 * The layers exactly as the runner files them (lowest first, settings.yml last). `refusal` names the one layer built
 * to be refused, so tests check the oracle's own boundary read against the generator's intent.
 */
export interface MergeScenarioMeta {
  layers: MergeLayer[];
  layering: LayeringDirective;
  /** The run's `undeclared` input, unset unless the scenario set it. */
  undeclared?: UndeclaredPolicyWord | undefined;
  refusal?: { layer: string; kind: MergeRefusalKind };
  features: MergeFeature[];
}

/**
 * Constructed, never rejection-sampled, so every battery entry exists for every master seed. The valid force gives
 * every mapping section ONE contribution, so no cross-field rule can trip on a merge of two.
 */
export type MergeForce =
  | { kind: "valid"; layering: LayeringDirective }
  | { kind: "refused"; refusal: MergeRefusalKind };

/** The sections whose top-level null is the section's value; on every other section a whole-section null fails validation. */
const NULLABLE_SECTIONS = ["pages", "interaction_limits"] as const satisfies readonly SectionKey[];

function isNullValued(key: string): boolean {
  return (NULLABLE_SECTIONS as readonly string[]).includes(key);
}

function isKnobbedSection(key: string): key is (typeof UNDECLARED_POLICY_SECTIONS)[number] {
  return (UNDECLARED_POLICY_SECTIONS as readonly string[]).includes(key);
}

function isListSectionKey(key: string): key is ListSection {
  return (LIST_SECTIONS as readonly string[]).includes(key);
}

/** The nested keyed lists of a list section's entry, in the harness's own words (the oracle spells the keys). */
const NESTED_LIST_FIELDS: Readonly<Partial<Record<ListSection, readonly string[]>>> = {
  rulesets: ["rules"],
  environments: [
    "variables",
    "secrets",
    "deployment_branch_policies",
    "deployment_protection_rules",
    "reviewers",
  ],
};

function isLayeringDirective(value: unknown): value is LayeringDirective {
  return (LAYERING_DIRECTIVES as readonly unknown[]).includes(value);
}

function isPlainMapping(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A layer as its standalone validation sees it, in the harness's own words: the document minus the directives the
 * fold consumes, `_layering` (top and wrapper), the top-level `_undeclared`, and every entry carrying `_remove` (top
 * and nested, in either form, any value: the fold judges the marker). Every value stays, null included: a null a key
 * does not admit is the layer's own validation error.
 */
export function standaloneViewOf(doc: Json): Json {
  const withoutRemovals = (entries: readonly unknown[], nested: readonly string[]): unknown[] =>
    entries
      .filter((entry) => !(isPlainMapping(entry) && entry[REMOVE_KEY] !== undefined))
      .map((entry) => (isPlainMapping(entry) ? withoutNested(entry, nested) : entry));
  const withoutNested = (entry: Json, nested: readonly string[]): Json => {
    const out: Json = { ...entry };
    for (const field of nested) {
      const value = entry[field];
      if (Array.isArray(value)) {
        out[field] = withoutRemovals(value, NESTED_OF_NESTED[field] ?? []);
      } else if (isPlainMapping(value) && Array.isArray(value.entries)) {
        const { entries, ...knobs } = value;
        out[field] = { ...knobs, entries: withoutRemovals(entries, NESTED_OF_NESTED[field] ?? []) };
      }
    }
    return out;
  };
  const { [LAYERING_KEY]: _file, [UNDECLARED_KEY]: _policy, ...out } = doc;
  for (const [key, value] of Object.entries(out)) {
    if (!isListSectionKey(key)) {
      continue;
    }
    const nested = NESTED_LIST_FIELDS[key] ?? [];
    if (Array.isArray(value)) {
      out[key] = withoutRemovals(value, nested);
    } else if (isPlainMapping(value) && Array.isArray(value.entries)) {
      const { entries, [LAYERING_KEY]: _wrapper, ...knobs } = value;
      out[key] = { ...knobs, entries: withoutRemovals(entries, nested) };
    }
  }
  return out;
}

/** No nested keyed list nests another today; the table exists so the walk above stays total when one does. */
const NESTED_OF_NESTED: Readonly<Partial<Record<string, readonly string[]>>> = {};

/**
 * The published schema cannot spell the cross-field rules the zod shapes refine (interaction_limits needs one of its
 * limits, selected_actions is refused beside an allowed_actions other than selected), so null placements are probed
 * through the action's own validator.
 */
function standaloneValid(doc: Json): boolean {
  return !(
    "error" in validateSettingsDoc(standaloneViewOf(doc), "layer", SectionSelection.ALL, silentIo())
  );
}

/** The runner's file name for layer `index` of `count`: settings.yml is always the top. */
function mergeLayerName(index: number, count: number): string {
  return index === count - 1 ? "settings.yml" : `layer-${index}.yml`;
}

/**
 * Every nested key path through a mapping section's plain mappings; lists are data to the merge, so the walk never
 * enters one, nor a list section's wrapper.
 */
function nestedMappingPaths(doc: Json): string[][] {
  const paths: string[][] = [];
  const walk = (value: unknown, path: string[]): void => {
    if (!isPlainMapping(value)) {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (child === null) {
        continue;
      }
      paths.push([...path, key]);
      walk(child, [...path, key]);
    }
  };
  for (const [key, value] of Object.entries(doc)) {
    if (!isListSectionKey(key) && key !== LAYERING_KEY) {
      walk(value, [key]);
    }
  }
  return paths;
}

function setPath(doc: Json, path: readonly string[], value: unknown): void {
  let node: Json = doc;
  for (const key of path.slice(0, -1)) {
    const next = node[key];
    if (!isPlainMapping(next)) {
      node[key] = {};
    }
    node = node[key] as Json;
  }
  node[path[path.length - 1] as string] = value;
}

/** The layer with a null written at `path`, as the validator will see it: the null is a value it must admit. */
function withNullAt(doc: Json, path: readonly string[]): Json {
  const out = structuredClone(doc);
  setPath(out, path, null);
  return out;
}

function rulesetEntries(doc: Json): Json[] {
  const value = doc.rulesets;
  return value === undefined || value === null ? [] : entriesOf(value);
}

/** Returns the entry list by reference (an empty plain list when absent), so a mutation appends into whichever form the layer drew. */
function ensureEntries(doc: Json, key: SectionKey): Json[] {
  const value = doc[key];
  if (value === undefined || value === null) {
    const entries: Json[] = [];
    doc[key] = entries;
    return entries;
  }
  return entriesOf(value);
}

/** `merge` is the directive's retired spelling: it fails as any unknown value does. */
const BAD_LAYERING_VALUES = ["merge", "DEEP", "union", "both", 1] as const;

/** Outside keep|delete; null among them, since the knob has no empty state and the fold refuses it like any other value. */
const BAD_UNDECLARED_VALUES = ["remove", "KEEP", "kep", true, null] as const;

interface LayerDraft {
  doc: Json;
  fileDirective: LayeringDirective | undefined;
  wrapperDirectives: Partial<Record<SectionKey, LayeringDirective>>;
}

/** Spelled as the entry spells them, so one claims function serves the layer's entries and the held ones. */
interface LabelIdentity {
  name: string;
  new_name?: string;
}

/**
 * What the fold holds of the keyed sections after the layers so far: labels with their spellings, and per ruleset name
 * its rules by type as JSON, so a parameters difference shows.
 */
interface HeldKeyed {
  labels: LabelIdentity[];
  rulesets: Map<string, Map<string, string>>;
}

function labelIdentity(entry: Json): LabelIdentity | undefined {
  if (typeof entry.name !== "string") {
    return undefined;
  }
  return typeof entry.new_name === "string"
    ? { name: entry.name, new_name: entry.new_name }
    : { name: entry.name };
}

/** A label's claims, case-folded: its name and its rename target. Two labels are one resource when their claims intersect. */
function labelClaims(label: LabelIdentity): string[] {
  const names = label.new_name === undefined ? [label.name] : [label.name, label.new_name];
  return [...new Set(names.map((name) => name.toLowerCase()))];
}

function claimsIntersect(a: readonly string[], b: readonly string[]): boolean {
  return a.some((claim) => b.includes(claim));
}

/** Every held label a layer's entry would pair with in a union (a rename can claim two). */
function heldLabelsFor(held: HeldKeyed, entry: Json): LabelIdentity[] {
  const identity = labelIdentity(entry);
  if (identity === undefined) {
    return [];
  }
  const claims = labelClaims(identity);
  return held.labels.filter((label) => claimsIntersect(labelClaims(label), claims));
}

/**
 * `effective` is the section's directive at this layer, or "replace" when the fold holds nothing yet: under replace
 * the held identities start over, under shallow a same-key entry swaps whole (its rules with it), under deep the
 * rules union by type. A removal drops what it names.
 */
function advanceHeld(
  held: HeldKeyed,
  key: "labels" | "rulesets",
  value: unknown,
  effective: LayeringDirective,
): void {
  const unite = effective !== "replace";
  if (value === null || !unite) {
    if (key === "labels") {
      held.labels = [];
    } else {
      held.rulesets.clear();
    }
    if (value === null) {
      return;
    }
  }
  for (const entry of entriesOf(value)) {
    if (typeof entry.name !== "string") {
      continue;
    }
    const removal = entry[REMOVE_KEY] === true;
    if (key === "labels") {
      const identity = labelIdentity(entry) as LabelIdentity;
      const claims = labelClaims(identity);
      held.labels = held.labels.filter((label) => !claimsIntersect(labelClaims(label), claims));
      if (!removal) {
        held.labels.push(identity);
      }
      continue;
    }
    if (removal) {
      held.rulesets.delete(entry.name);
      continue;
    }
    // Under deep the pair merges, so the held rules carry over; under shallow the entry swaps whole, so they start over.
    const rules =
      effective === "deep"
        ? (held.rulesets.get(entry.name) ?? new Map<string, string>())
        : new Map<string, string>();
    for (const rule of Array.isArray(entry.rules) ? entry.rules : []) {
      if (!isPlainMapping(rule) || typeof rule.type !== "string") {
        continue;
      }
      if (rule[REMOVE_KEY] === true) {
        rules.delete(rule.type);
      } else {
        rules.set(rule.type, JSON.stringify(rule));
      }
    }
    held.rulesets.set(entry.name, rules);
  }
}

function wrapperDirective(value: unknown): unknown {
  return Array.isArray(value) || !isPlainMapping(value) ? undefined : value[LAYERING_KEY];
}

function hasNestedNull(value: Json): boolean {
  return Object.values(value).some(
    (child) => child === null || (isPlainMapping(child) && hasNestedNull(child)),
  );
}

/** The same walk over presence, directives, and held identities the fold performs, reduced to the shapes each layer adds. */
export function mergeFeaturesOf(
  layers: readonly MergeLayer[],
  runInput: LayeringDirective | undefined,
  refused: boolean,
  runUndeclared: UndeclaredPolicyWord | undefined = undefined,
): MergeFeature[] {
  const features = new Set<MergeFeature>();
  if (refused) {
    features.add("refused");
    return MERGE_FEATURES.filter((feature) => features.has(feature));
  }
  features.add(runInput === undefined ? "run-layering-default" : `run-layering-${runInput}`);
  features.add(
    runUndeclared === undefined ? "run-undeclared-default" : `run-undeclared-${runUndeclared}`,
  );
  const run = runInput ?? DEFAULT_LAYERING_DIRECTIVE;
  const present = new Set<string>();
  const held: HeldKeyed = { labels: [], rulesets: new Map() };
  for (const layer of layers) {
    const doc = layer.doc;
    const fileDirective = doc[LAYERING_KEY];
    if (fileDirective !== undefined) {
      features.add("file-layering");
    }
    if (doc[UNDECLARED_KEY] !== undefined) {
      features.add("file-undeclared");
    }
    const keys = Object.keys(doc).filter((key) => key !== LAYERING_KEY && key !== UNDECLARED_KEY);
    if (keys.length === 0) {
      features.add("empty-layer");
    }
    for (const key of keys) {
      const value = doc[key];
      if (value === null) {
        // The fold writes `key: null` as the section's value (only a null-valued section passes validation with one),
        // so the section stays held and a later declaration over it is an override, not a first declaration.
        features.add("null-section");
        present.add(key);
        if (key === "labels" || key === "rulesets") {
          advanceHeld(held, key, null, "replace");
        }
        continue;
      }
      if (present.has(key)) {
        features.add("override");
      }
      if (isListSectionKey(key)) {
        if (!Array.isArray(value)) {
          const wrapper = value as Json;
          if (wrapper[UNDECLARED_KEY] !== undefined) {
            features.add("wrapper-undeclared");
          }
          if (!isKnobbedSection(key)) {
            features.add("wrapper-layered");
          }
          const directive = wrapper[LAYERING_KEY];
          if (isLayeringDirective(directive)) {
            features.add(`wrapper-layering-${directive}`);
          }
        }
        if (key === "environments") {
          const effective = wrapperDirective(value) ?? fileDirective ?? run;
          if (present.has(key) && effective !== "replace") {
            features.add("union-environments");
          }
        }
        if (key === "labels" || key === "rulesets") {
          const wrapper = wrapperDirective(value);
          const effective: LayeringDirective =
            (isLayeringDirective(wrapper) ? wrapper : undefined) ??
            (isLayeringDirective(fileDirective) ? fileDirective : undefined) ??
            run;
          const unite = present.has(key) && effective !== "replace";
          if (unite) {
            features.add(key === "labels" ? "union-labels" : "union-rulesets");
            for (const entry of entriesOf(value)) {
              if (typeof entry.name !== "string") {
                continue;
              }
              if (entry[REMOVE_KEY] === true) {
                features.add("remove-entry");
                continue;
              }
              if (key === "labels") {
                const paired = heldLabelsFor(held, entry);
                if (paired.length === 0) {
                  continue;
                }
                const spellings = paired.flatMap((label) =>
                  label.new_name === undefined ? [label.name] : [label.name, label.new_name],
                );
                const name = entry.name;
                if (spellings.some((s) => s !== name && s.toLowerCase() === name.toLowerCase())) {
                  features.add("label-case-fold");
                }
                if (
                  entry.new_name !== undefined ||
                  paired.some((label) => label.new_name !== undefined)
                ) {
                  features.add("label-rename-union");
                }
                continue;
              }
              const heldRules = held.rulesets.get(entry.name);
              for (const rule of Array.isArray(entry.rules) ? entry.rules : []) {
                if (!isPlainMapping(rule) || typeof rule.type !== "string") {
                  continue;
                }
                if (rule[REMOVE_KEY] === true) {
                  features.add("remove-nested");
                  continue;
                }
                const below = heldRules?.get(rule.type);
                if (below !== undefined && below !== JSON.stringify(rule)) {
                  features.add("rule-parameters");
                }
              }
            }
          }
          advanceHeld(held, key, value, unite ? effective : "replace");
        }
        for (const entry of entriesOf(value)) {
          if (Object.values(entry).some((field) => field === null)) {
            features.add("null-entry-field");
          }
        }
      } else if (isPlainMapping(value) && hasNestedNull(value)) {
        features.add("null-nested");
      }
      present.add(key);
    }
  }
  return MERGE_FEATURES.filter((feature) => features.has(feature));
}

/**
 * Every admitted layer is valid on its own by construction; the folded document is what the oracle predicts, and it is
 * not always a merged one.
 *   nested null placement              -> probed through the action's validator with the null written into this layer
 *   top-level null                     -> only on a section whose value null is, so it needs no probe
 *   the refused layer                  -> rewritten after the check, invalid by design
 *   two valid mapping sections merged  -> can trip a cross-field rule; the valid force gives every mapping section one contribution
 */
export function genMergeScenario(
  rng: Rng,
  options: GenScenarioOptions & { force?: MergeForce } = {},
): { scenario: Scenario; meta: MergeScenarioMeta } {
  const pool =
    options.sections !== undefined && options.sections.length > 0 ? options.sections : SECTION_KEYS;
  const count = rng.int(4) + 2;
  const force = options.force;

  const rolledLayering = rng.pick([...LAYERING_DIRECTIVES, undefined]);
  const runLayering: LayeringDirective | undefined =
    force?.kind === "valid" ? force.layering : rolledLayering;
  const effectiveRunLayering: LayeringDirective = runLayering ?? DEFAULT_LAYERING_DIRECTIVE;
  const runUndeclared = rng.fork("run-undeclared").pick([...UNDECLARED_POLICIES, undefined]);

  const rolledRefusal = rng.bool(0.2)
    ? { index: rng.int(count), kind: rng.pick(MERGE_REFUSAL_KINDS) }
    : undefined;
  const refusal =
    force === undefined
      ? rolledRefusal
      : force.kind === "refused"
        ? { index: rng.fork("refused-index").int(count), kind: force.refusal }
        : undefined;

  const layers: MergeLayer[] = [];
  const drafts: LayerDraft[] = [];
  /** The top-level sections the fold holds (declared non-null) after the layers so far. */
  const present = new Set<SectionKey>();
  /** The non-knobbed sections the fold holds as mappings: under the valid force, declared once. */
  const heldMappings = new Set<SectionKey>();
  const held: HeldKeyed = { labels: [], rulesets: new Map() };

  for (let i = 0; i < count; i++) {
    const layerRng = rng.fork(`layer:${i}`);
    const name = mergeLayerName(i, count);
    const layerPool = force?.kind === "valid" ? pool.filter((key) => !heldMappings.has(key)) : pool;
    const draft = drawLayer(layerRng, layerPool);
    const lower = drafts[i - 1];
    if (lower !== undefined) {
      renameLabelsIntoHeld(layerRng.fork("rename"), draft, held, effectiveRunLayering, present);
      respellLabels(layerRng.fork("case"), draft, held, effectiveRunLayering, present);
      placeNulls(layerRng.fork("nulls"), draft, lower, present, pool);
      placeRemovals(layerRng.fork("removals"), draft, held, effectiveRunLayering, present);
    }
    if (!standaloneValid(draft.doc)) {
      // Every placement above is probed, so an invalid layer here is a hole in the probes, not a scenario to run.
      throw new Error(
        `BUG: merge layer ${name} fails its standalone validation: ${JSON.stringify(draft.doc)}`,
      );
    }
    if (refusal !== undefined && refusal.index === i) {
      refuseLayer(layerRng.fork("refusal"), draft, refusal.kind);
    }
    for (const [key, value] of Object.entries(draft.doc)) {
      if (key === LAYERING_KEY || key === UNDECLARED_KEY) {
        continue;
      }
      const section = key as SectionKey;
      if (key === "labels" || key === "rulesets") {
        advanceHeld(
          held,
          key,
          value,
          present.has(section) ? effectiveLayering(draft, key, effectiveRunLayering) : "replace",
        );
      }
      if (value === null) {
        present.delete(section);
        heldMappings.delete(section);
        continue;
      }
      present.add(section);
      if (!isListSectionKey(key) && isPlainMapping(value)) {
        heldMappings.add(section);
      } else {
        heldMappings.delete(section);
      }
    }
    drafts.push(draft);
    layers.push({ name, doc: draft.doc });
  }

  const top = layers[count - 1] as MergeLayer;
  const scenario: Scenario = {
    name: `fuzz-merge-${rng.seed}`,
    tiers: ["mock"],
    settings: top.doc,
    settings_layers: layers.slice(0, -1).map((layer) => layer.doc),
    inputs: {
      mode: "render",
      ...(runLayering === undefined ? {} : { layering: runLayering }),
      ...(runUndeclared === undefined ? {} : { undeclared: runUndeclared }),
    },
    denial_style: "fine_grained",
    owner_kind: "org",
    expect: { exit_code: 0 },
  };
  return {
    scenario,
    meta: {
      layers,
      layering: effectiveRunLayering,
      undeclared: runUndeclared,
      ...(refusal === undefined
        ? {}
        : { refusal: { layer: mergeLayerName(refusal.index, count), kind: refusal.kind } }),
      features: mergeFeaturesOf(layers, runLayering, refusal !== undefined, runUndeclared),
    },
  };
}

/** The list sections are favored, so unions happen. */
function drawLayer(rng: Rng, pool: readonly SectionKey[]): LayerDraft {
  const chosen = rng.bool(0.08)
    ? []
    : pool.filter((key) => rng.bool(isListSectionKey(key) ? 0.6 : 0.3));
  const doc: Json = {};
  for (const key of chosen) {
    doc[key] = genSettings(rng.fork(`settings:${key}`), key);
  }
  const parameterRng = rng.fork("rule-parameters");
  for (const entry of rulesetEntries(doc)) {
    for (const rule of Array.isArray(entry.rules) ? entry.rules : []) {
      // Only a rule drawn bare takes the marker: a typed rule's parameters are what the schema requires of it.
      if (isPlainMapping(rule) && rule.parameters === undefined && parameterRng.bool(0.4)) {
        rule.parameters = { strict: parameterRng.bool() };
      }
    }
  }
  const fileDirective = rng.bool(0.2) ? rng.pick(LAYERING_DIRECTIVES) : undefined;
  if (fileDirective !== undefined) {
    doc[LAYERING_KEY] = fileDirective;
  }
  if (rng.bool(0.2)) {
    doc[UNDECLARED_KEY] = rng.pick(UNDECLARED_POLICIES);
  }
  const wrapperDirectives: LayerDraft["wrapperDirectives"] = {};
  for (const key of chosen) {
    if (!isListSectionKey(key)) {
      continue;
    }
    const entries = entriesOf(doc[key]);
    if (!rng.bool(0.4)) {
      doc[key] = entries;
      continue;
    }
    // A plain list's wrapper takes the directive alone; only a knobbed one carries the policy.
    const wrapper: Json = { entries };
    if (isKnobbedSection(key) && rng.bool(0.5)) {
      wrapper[UNDECLARED_KEY] = rng.pick(["keep", "delete"] as const);
    }
    const directive: LayeringDirective | undefined = rng.bool(0.5)
      ? rng.pick(LAYERING_DIRECTIVES)
      : undefined;
    if (directive !== undefined) {
      wrapper[LAYERING_KEY] = directive;
      wrapperDirectives[key] = directive;
    }
    doc[key] = wrapper;
  }
  validateAgainstPublishedSchema(doc);
  return { doc, fileDirective, wrapperDirectives };
}

/**
 * Respell a unioned label in the other case, so the union's case-folded matching is what keeps the list from growing.
 * A name without letters has no other case and is left alone.
 */
function respellLabels(
  rng: Rng,
  draft: LayerDraft,
  held: HeldKeyed,
  run: LayeringDirective,
  present: ReadonlySet<SectionKey>,
): void {
  const value = draft.doc.labels;
  if (
    value === undefined ||
    value === null ||
    !present.has("labels") ||
    effectiveLayering(draft, "labels", run) === "replace"
  ) {
    return;
  }
  for (const entry of entriesOf(value)) {
    if (typeof entry.name !== "string" || heldLabelsFor(held, entry).length === 0) {
      continue;
    }
    const flipped =
      entry.name === entry.name.toUpperCase() ? entry.name.toLowerCase() : entry.name.toUpperCase();
    if (flipped !== entry.name && rng.bool(0.5)) {
      entry.name = flipped;
    }
  }
}

function unionsLabels(
  draft: LayerDraft,
  run: LayeringDirective,
  present: ReadonlySet<SectionKey>,
): boolean {
  const value = draft.doc.labels;
  return (
    value !== undefined &&
    value !== null &&
    present.has("labels") &&
    effectiveLayering(draft, "labels", run) !== "replace"
  );
}

/**
 * Point one of the layer's labels at a held rename target, so the union pairs the two through the alias and the merged
 * document carries one label where a name-only match would keep two. The retargeted entry keeps its claims disjoint
 * from its siblings, as the boundary demands of every layer.
 */
function renameLabelsIntoHeld(
  rng: Rng,
  draft: LayerDraft,
  held: HeldKeyed,
  run: LayeringDirective,
  present: ReadonlySet<SectionKey>,
): void {
  const renamed = held.labels.flatMap((label) =>
    label.new_name === undefined ? [] : [label.new_name],
  );
  if (!unionsLabels(draft, run, present) || renamed.length === 0 || !rng.bool(0.7)) {
    return;
  }
  const entries = entriesOf(draft.doc.labels);
  const target = rng.pick(renamed);
  const claimsOf = (entry: Json): string[] => {
    const identity = labelIdentity(entry);
    return identity === undefined ? [] : labelClaims(identity);
  };
  const candidates = entries.filter((entry) => {
    if (typeof entry.name !== "string") {
      return false;
    }
    const siblings = entries.filter((other) => other !== entry).flatMap(claimsOf);
    return !claimsIntersect(claimsOf({ ...entry, name: target }), siblings);
  });
  if (candidates.length > 0) {
    rng.pick(candidates).name = target;
  }
}

function effectiveLayering(
  draft: LayerDraft,
  key: SectionKey,
  run: LayeringDirective,
): LayeringDirective {
  return draft.wrapperDirectives[key] ?? draft.fileDirective ?? run;
}

/**
 * Every null placed here is one the schema admits, so the layer stays valid on its own:
 *   a whole section         -> only where null is the section's value (pages, interaction limits), held below or not
 *   a nested mapping key    -> a key the lower layer declares, probed through the action's validator with the null
 *                              written into this document (a passthrough key, or a nullable field) and into the lower
 *                              declaration, which is what the fold makes of the pair: a cross-field rule the null
 *                              trips only beside the lower fields (runner_type: labeled with runner_label: null) is
 *                              caught here, not read as an invalid fold
 *   a keyed entry's field   -> a held branch's `protection: null`, the entry schema's own nullable field
 */
function placeNulls(
  rng: Rng,
  draft: LayerDraft,
  lower: LayerDraft,
  present: ReadonlySet<SectionKey>,
  pool: readonly SectionKey[],
): void {
  if (!rng.bool(0.6)) {
    return;
  }
  const doc = draft.doc;
  const attempts = rng.int(2) + 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const roll = rng.int(3);
    if (roll === 0) {
      const candidates = pool.filter((key) => isNullValued(key) && doc[key] === undefined);
      if (candidates.length > 0) {
        doc[rng.pick(candidates)] = null;
      }
      continue;
    }
    if (roll === 1) {
      // Only a null the schema admits at that path (a passthrough key, a nullable field) keeps the layer valid, and
      // only one the lower declaration admits beside its other fields keeps the fold valid.
      const candidates = nestedMappingPaths(lower.doc).filter((path) => {
        const top = path[0] as string;
        return (
          doc[top] !== null &&
          !isKnobbedSection(top) &&
          standaloneValid(withNullAt(doc, path)) &&
          standaloneValid(withNullAt(lower.doc, path))
        );
      });
      if (candidates.length > 0) {
        setPath(doc, rng.pick(candidates), null);
      }
      continue;
    }
    if (!present.has("branches") || doc.branches === null) {
      continue;
    }
    const claimed = new Set(entriesOf(doc.branches ?? []).map((entry) => entry.name));
    const candidates = entriesOf(lower.doc.branches ?? []).flatMap((entry) =>
      typeof entry.name === "string" && !claimed.has(entry.name) ? [entry.name] : [],
    );
    if (candidates.length > 0) {
      ensureEntries(doc, "branches").push({ name: rng.pick(candidates), protection: null });
    }
  }
}

/**
 * A removal names a held key: a label the fold holds (dropped under shallow or deep), or a rule type inside a held
 * ruleset (dropped only when deep merges the pair). The removal never shares a claim with a sibling entry, as the
 * boundary demands of every layer.
 */
function placeRemovals(
  rng: Rng,
  draft: LayerDraft,
  held: HeldKeyed,
  run: LayeringDirective,
  present: ReadonlySet<SectionKey>,
): void {
  if (!rng.bool(0.45)) {
    return;
  }
  const doc = draft.doc;
  if (rng.bool(0.6) && unionsLabels(draft, run, present) && held.labels.length > 0) {
    const entries = entriesOf(doc.labels);
    const claimedHere = entries.flatMap((entry) => {
      const identity = labelIdentity(entry);
      return identity === undefined ? [] : labelClaims(identity);
    });
    const candidates = held.labels.filter(
      (label) => !claimsIntersect(labelClaims(label), claimedHere),
    );
    if (candidates.length > 0) {
      const target = rng.pick(candidates);
      const spelled = rng.bool(0.5) ? target.name.toUpperCase() : target.name;
      entries.push({ name: spelled, [REMOVE_KEY]: true });
    }
    return;
  }
  if (
    doc.rulesets === undefined ||
    doc.rulesets === null ||
    !present.has("rulesets") ||
    effectiveLayering(draft, "rulesets", run) !== "deep"
  ) {
    return;
  }
  const candidates = [...held.rulesets.entries()].flatMap(([name, rules]) =>
    [...rules.keys()].map((type) => ({ name, type })),
  );
  if (candidates.length === 0) {
    return;
  }
  const { name, type } = rng.pick(candidates);
  const entries = ensureEntries(doc, "rulesets");
  const own = entries.find((entry) => entry.name === name);
  const rules = own === undefined ? [] : Array.isArray(own.rules) ? (own.rules as Json[]) : [];
  if (rules.some((rule) => isPlainMapping(rule) && rule.type === type)) {
    return;
  }
  rules.push({ type, [REMOVE_KEY]: true });
  if (own === undefined) {
    entries.push({ name, rules });
  } else {
    own.rules = rules;
  }
}

/** When the layer lacks the section a kind needs, one is created, outside the pool if need be: the refusal is the point of the layer. */
function refuseLayer(rng: Rng, draft: LayerDraft, kind: MergeRefusalKind): void {
  const doc = draft.doc;
  switch (kind) {
    case "duplicate-rule-type": {
      const entries = ensureEntries(doc, "rulesets");
      const entry = entries[0] ?? { name: "dup-rules", target: "branch" };
      if (entries.length === 0) {
        entries.push(entry);
      }
      const type = rng.pick(["deletion", "non_fast_forward", "required_signatures"]);
      entry.rules = [{ type }, { type }];
      return;
    }
    case "duplicate-label": {
      const entries = ensureEntries(doc, "labels");
      const entry = entries[0] ?? { name: "bug", color: "d73a4a" };
      if (entries.length === 0) {
        entries.push(entry);
      }
      const name = String(entry.name);
      const flipped = name.toUpperCase();
      entries.push({ name: rng.bool(0.5) && flipped !== name ? flipped : name });
      return;
    }
    case "bad-wrapper-layering": {
      const declared = LIST_SECTIONS.filter((key) => doc[key] !== undefined && doc[key] !== null);
      const key = declared.length > 0 ? rng.pick(declared) : "labels";
      const entries = ensureEntries(doc, key);
      doc[key] = { entries, [LAYERING_KEY]: rng.pick(BAD_LAYERING_VALUES) };
      return;
    }
    case "bad-file-layering": {
      doc[LAYERING_KEY] = rng.pick(BAD_LAYERING_VALUES);
      return;
    }
    case "bad-file-undeclared": {
      doc[UNDECLARED_KEY] = rng.pick(BAD_UNDECLARED_VALUES);
      return;
    }
    case "remove-under-replace": {
      const entries = ensureEntries(doc, "labels");
      doc.labels = {
        entries: [...entries, { name: "zz-removed", [REMOVE_KEY]: true }],
        [LAYERING_KEY]: "replace",
      };
      return;
    }
    case "remove-unmatched": {
      // A name outside every generator pool, so no lower layer can hold it; a wrapper directive keeps replace away.
      const entries = ensureEntries(doc, "labels");
      doc.labels = {
        entries: [...entries, { name: "zz-unmatched", [REMOVE_KEY]: true }],
        [LAYERING_KEY]: "deep",
      };
      return;
    }
    case "remove-with-fields": {
      const entries = ensureEntries(doc, "labels");
      entries.push({ name: "zz-removed", [REMOVE_KEY]: true, color: "ffffff" });
      return;
    }
    case "null-section": {
      const declared = SECTION_KEYS.filter((key) => !isNullValued(key) && doc[key] !== undefined);
      doc[declared.length > 0 ? rng.pick(declared) : "labels"] = null;
      return;
    }
    default: {
      const never: never = kind;
      throw new Error(`unknown merge refusal kind ${String(never)}`);
    }
  }
}
