/**
 * A document's removal entries set apart from it, and the way back from an issue over the rest to the document as
 * written. validateSettingsDoc (orchestrate.ts) refuses a single document's sites and judges the rest; the fold
 * (layers.ts) builds each layer's standalone view on it.
 */

import { isPlainObject } from "../plain-data.js";
import { LIST_SECTIONS } from "../schema.js";
import type { KeyedListLayering } from "../sections/contract/keyed-list.js";
import { listLayering } from "../sections/registry.js";
import { nestedForm, REMOVE_KEY } from "./directives.js";

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
