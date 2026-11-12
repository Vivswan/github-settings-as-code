/**
 * A document's removal entries set apart from it, the markers no list keys beside them, and the way back from an
 * issue over the rest to the document as written. validateSettingsDoc (orchestrate.ts) refuses a single document's
 * sites and judges the rest; the fold (layers.ts) builds each layer's standalone view on it.
 */

import { z } from "zod";
import { isPlainObject } from "../plain-data.js";
import { LIST_SECTIONS, SECTION_KEYS } from "../schema.js";
import type { KeyedListLayering } from "../sections/contract/keyed-list.js";
import { listLayering } from "../sections/registry.js";
import { nestedForm, REMOVE_KEY } from "./directives.js";

/** The sections the keyed walk never enters: every list below one is a list nothing keys. */
const MAPPING_SECTIONS = SECTION_KEYS.filter(
  (key) => !(LIST_SECTIONS as readonly string[]).includes(key),
);

/** Whether an entry carries the marker at all, whatever its value: what the standalone view drops and a single document refuses. */
function carriesRemoval(entry: Readonly<Record<string, unknown>>): boolean {
  return entry[REMOVE_KEY] !== undefined;
}

/** A path as its steps from the section key down, a list index a number; `z.core.toDotPath` spells it as validation spells an issue's, a key that is no plain name quoted. */
type Steps = readonly (string | number)[];

/**
 * Per list as validation spells it over the document minus its removals (`labels`, `labels.entries`,
 * `environments[0].variables`), the source index of each kept entry; only a list a removal shifted is recorded.
 */
type SourceIndices = Map<string, readonly number[]>;

/** What one walk of a document gathers beside its partitions. */
interface Gathered {
  /** Where each kept entry of a shifted list sat in the document as written. */
  readonly sources: SourceIndices;

  /** Each marker on an entry no list keys, by its path as validation spells one over the document minus its removals. */
  readonly unkeyed: string[];
}

/** A keyed list's removals set apart from it, its entries' nested lists likewise, in the form the layer wrote them. */
interface Partition {
  /** The entries minus the removals, each entry's declared nested lists partitioned in turn. */
  readonly kept: unknown[];

  /** Each removal by its marker's site (`labels[0]._remove`); a removal's own nested lists are not entered. */
  readonly sites: string[];
}

/**
 * The markers below a value no keyed list reaches: a `_remove` on a list's entry there removes nothing (the fold
 * replaces such a list whole), so the entry stays and each marker is gathered by its path. `above` holds the
 * containers on the way down, so a YAML alias cycle ends the descent.
 */
function gatherUnkeyed(value: unknown, path: Steps, unkeyed: string[], above: Set<object>): void {
  if ((!Array.isArray(value) && !isPlainObject(value)) || above.has(value)) {
    return;
  }

  above.add(value);
  if (Array.isArray(value)) {
    // Indexed, as in partitionRemovals: the walk runs before the plainness check.
    for (let index = 0; index < value.length; index += 1) {
      const item: unknown = value[index];
      if (isPlainObject(item) && carriesRemoval(item)) {
        unkeyed.push(z.core.toDotPath([...path, index, REMOVE_KEY]));
      }
      gatherUnkeyed(item, [...path, index], unkeyed, above);
    }
  } else {
    for (const [field, child] of Object.entries(value)) {
      gatherUnkeyed(child, [...path, field], unkeyed, above);
    }
  }
  above.delete(value);
}

/** A kept entry with each declared nested list partitioned in turn, and the sites of the removals below it; its other fields are walked for the markers no list keys. */
function partitionNestedLists(
  entry: Readonly<Record<string, unknown>>,
  keyed: KeyedListLayering,
  site: string,
  viewSite: Steps,
  gathered: Gathered,
): { entry: Record<string, unknown>; sites: string[] } {
  const out: Record<string, unknown> = { ...entry };
  const sites: string[] = [];
  const partitioned = new Set<string>();
  for (const [field, nested] of Object.entries(keyed.nested ?? {})) {
    const form = nestedForm(entry[field]);
    if (form === null) {
      continue;
    }

    const below = partitionRemovals(
      form.entries,
      nested,
      `${site}.${field}`,
      form.knobs === null ? [...viewSite, field] : [...viewSite, field, "entries"],
      gathered,
    );
    sites.push(...below.sites);
    out[field] = form.knobs === null ? below.kept : { ...form.knobs, entries: below.kept };
    partitioned.add(field);
  }

  for (const [field, value] of Object.entries(entry)) {
    if (!partitioned.has(field)) {
      gatherUnkeyed(value, [...viewSite, field], gathered.unkeyed, new Set());
    }
  }
  return { entry: out, sites };
}

/**
 * `path` names the list as the sites do, by the document's own indices; `viewPath` as validation reaches the kept
 * entries (`labels.entries`, `environments[1].variables`), the key under which `gathered` records their origins.
 */
function partitionRemovals(
  entries: readonly unknown[],
  keyed: KeyedListLayering,
  path: string,
  viewPath: Steps,
  gathered: Gathered,
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

    const viewSite = [...viewPath, kept.length];
    origins.push(index);
    const below = partitionNestedLists(entry, keyed, site, viewSite, gathered);
    sites.push(...below.sites);
    kept.push(below.entry);
  }

  if (origins.some((source, index) => source !== index)) {
    gathered.sources.set(z.core.toDotPath(viewPath), origins);
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

  /** Each `_remove` on an entry no list keys, which stays in `rest` with its marker: by its path as validation spells one (`rulesets.entries[0].bypass_actors[0]._remove`), indices as written, the list sections first. */
  readonly unkeyed: readonly string[];

  /** A validation issue over `rest`, its leading path renumbered to the document as written: a removal dropped from the list shifts every entry after it, so `labels[0].color` in `rest` is the reader's `labels[1].color`. */
  readonly asWritten: (issue: string) => string;
}

/**
 * Every section walked once: a list section partitioned by the walk the fold uses, the rest of the document searched
 * for the markers that walk does not reach. A single document has no lower layer to remove from, so
 * validateSettingsDoc refuses the sites and judges `rest`; a layer of a fold reaches it as its standalone view,
 * `rest` minus the `_layering` directives. Either way what is said about `rest` is said of the document as written.
 */
export function separateRemovals(doc: unknown): SeparatedRemovals {
  if (!isPlainObject(doc)) {
    return { rest: doc, sites: [], unkeyed: [], asWritten: (issue) => issue };
  }
  const rest: Record<string, unknown> = { ...doc };
  const sites: string[] = [];
  const gathered: Gathered = { sources: new Map(), unkeyed: [] };
  for (const key of LIST_SECTIONS) {
    const form = nestedForm(doc[key]);
    if (form === null) {
      continue;
    }
    const below = partitionRemovals(
      form.entries,
      listLayering(key),
      key,
      form.knobs === null ? [key] : [key, "entries"],
      gathered,
    );
    sites.push(...below.sites);
    rest[key] = form.knobs === null ? below.kept : { ...form.knobs, entries: below.kept };
  }

  for (const key of MAPPING_SECTIONS) {
    gatherUnkeyed(doc[key], [key], gathered.unkeyed, new Set());
  }

  const asWritten = renumbering(gathered.sources);
  return { rest, sites, unkeyed: gathered.unkeyed.map(asWritten), asWritten };
}
