/**
 * The one order every rendered document has: the snapshot file and the merged file are the same bytes for the same
 * content, whatever order GitHub listed a resource in or a layer spelled its keys in. Pure: a fresh tree over a
 * validated document, guided by the schema in src/schema.ts (the order the published JSON schema declares).
 *
 *   the top level                     -> the sections in SECTION_KEYS order, then the document directives where the
 *                                        schema places them (`_layering` after every section), then unknown keys
 *   a mapping the schema declares     -> its properties in the schema's declared order, unknown keys after them
 *   a mapping the schema leaves open  -> keys by code point (a record, a value under z.unknown): it declares no order
 *   a list with an identity           -> sorted by the identity (LIST_IDENTITY), then by the entry's canonical JSON
 *   `environments`                    -> the pinned entries lead in their written order (the planner reads that order
 *                                        as pin rank, so it is content), the rest sorted by name
 *   any other list                    -> as written: a scalar list, a mapping list without an identity, and `branches`
 *                                        (LISTS_AS_WRITTEN) carry the author's order, and GitHub returns each in one
 *   unknown keys, everywhere          -> by code point after the declared ones; JavaScript enumerates an integer-like
 *                                        key ("10") ahead of every other key in numeric order, so those lead
 *   scalars                           -> as written
 */

import { stringify as stringifyYaml } from "yaml";
import type { z } from "zod";
import { isPlainObject, own, put } from "../plain-data.js";
import { SECTION_KEYS, SettingsFile } from "../schema.js";
import { defOf, detectKnobUnion } from "../sections/contract/module.js";

/**
 * The identity field of every mapping list the walk sorts, by list path: the section key, `[]` per entry level,
 * `.field` per nested mapping; a knob wrapper's `entries` is transparent (`labels`, not `labels.entries`). A list
 * section's entry is what its declaration keys the planner by (test/engine/canonical.test.ts pins the six); a bespoke
 * section's is the field its planner pairs live items on. A dotted value is a path into the entry (`config.url`).
 */
export const LIST_IDENTITY: Readonly<Record<string, string>> = {
  labels: "name",
  rulesets: "name",
  "rulesets[].rules": "type",
  "rulesets[].rules[].parameters.code_scanning_tools": "tool",
  "rulesets[].rules[].parameters.required_reviewers": "reviewer.id",
  environments: "name",
  "environments[].deployment_branch_policies": "name",
  "environments[].deployment_protection_rules": "app",
  "environments[].variables": "name",
  "environments[].secrets": "name",
  autolinks: "key_prefix",
  actions_secrets: "name",
  dependabot_secrets: "name",
  codespaces_secrets: "name",
  agents_secrets: "name",
  workflows: "path",
  "check_suite_preferences.auto_trigger_checks": "app_id",
  collaborators: "username",
  teams: "name",
  milestones: "title",
  actions_variables: "name",
  agents_variables: "name",
  webhooks: "config.url",
  custom_properties: "property_name",
  deploy_keys: "title",
  secret_scanning_custom_patterns: "name",
  // GitHub keys a required check by (context, app_id) and allows one context under two Apps; the
  // walk takes one field, so the name sorts and the canonical-JSON tiebreak orders the App ids.
  "branches[].protection.required_status_checks.checks": "context",
};

/**
 * The mapping lists kept as written, each with the reason its order is content or has no key. The completeness
 * test pins every mapping list the schema declares to LIST_IDENTITY or this table.
 */
export const LISTS_AS_WRITTEN: Readonly<Record<string, string>> = {
  branches:
    "GitHub applies overlapping wildcard rules in creation order, and apply creates the entries in file order",
  "rulesets[].bypass_actors":
    "an actor is a pair of fields GitHub keys, with no one identity field",
  "rulesets[].rules[].parameters.required_status_checks":
    "a check is a context and an integration_id GitHub keys together, with no one identity field",
  "rulesets[].rules[].parameters.workflows":
    "a workflow is a repository_id, path, and ref GitHub keys together, with no one identity field",
  "rulesets[].rules[].parameters.dismissal_restriction.allowed_actors":
    "an actor is a type and an id, with no one identity field",
  "environments[].reviewers": "a reviewer is a type and an id, with no one identity field",
  "repository.security_and_analysis.secret_scanning_delegated_bypass_options.reviewers":
    "a reviewer is a type and an id, with no one identity field",
};

/** The list whose leading entries carry a rank: `pinned: true` environments lead, in their written order. */
const RANKED_LIST = "environments";

/** Code-point order, the one string order that needs no locale; a code point above U+FFFF sorts after every one below it. */
export function compareByCodePoint(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const difference = (left[index]?.codePointAt(0) ?? 0) - (right[index]?.codePointAt(0) ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}

/** The keys of `value` in order: the known ones the schema declares, then the rest by code point; an undefined value is no key. */
function orderedKeys(value: Readonly<Record<string, unknown>>, known: readonly string[]): string[] {
  const present = known.filter((key) => Object.hasOwn(value, key) && value[key] !== undefined);
  const rest = Object.keys(value)
    .filter((key) => !known.includes(key) && value[key] !== undefined)
    .sort(compareByCodePoint);
  return [...present, ...rest];
}

/** A node the schema says nothing about: mappings by code point, lists as written, scalars as they are. */
function unknownNode(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(unknownNode);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const key of orderedKeys(value, [])) {
    put(out, key, unknownNode(value[key]));
  }
  return out;
}

/** The value at a dotted path into an entry (`config.url`), when it is a string or a number (an app id). */
function identityOf(entry: unknown, field: string): string | number | undefined {
  let node: unknown = entry;
  for (const step of field.split(".")) {
    if (!isPlainObject(node)) {
      return undefined;
    }
    node = node[step];
  }
  return typeof node === "string" || typeof node === "number" ? node : undefined;
}

interface Keyed {
  readonly entry: unknown;
  readonly identity: string | number | undefined;
  readonly json: string;
}

/** Numbers numerically, strings by code point, a number before a string, an entry without an identity last. */
function compareIdentities(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  if (typeof a === "number" || typeof b === "number") {
    return typeof a === "number" ? -1 : 1;
  }
  return compareByCodePoint(a, b);
}

/** By identity, ties by the canonical JSON; Array.prototype.sort is stable for what is left. */
function compareEntries(a: Keyed, b: Keyed): number {
  if (a.identity !== b.identity) {
    if (a.identity === undefined || b.identity === undefined) {
      return a.identity === undefined ? 1 : -1;
    }
    return compareIdentities(a.identity, b.identity);
  }
  return compareByCodePoint(a.json, b.json);
}

/** `entries` already canonical, so the JSON tiebreak compares canonical text. */
function sortEntries(path: string, entries: readonly unknown[]): unknown[] {
  const field = LIST_IDENTITY[path];
  if (field === undefined) {
    return [...entries];
  }
  const keyed = entries.map(
    (entry): Keyed => ({ entry, identity: identityOf(entry, field), json: JSON.stringify(entry) }),
  );
  const ranked = (item: Keyed): boolean =>
    path === RANKED_LIST && isPlainObject(item.entry) && item.entry.pinned === true;
  const leading = keyed.filter(ranked);
  const rest = keyed.filter((item) => !ranked(item)).sort(compareEntries);
  return [...leading, ...rest].map((item) => item.entry);
}

/** Whether a value could be an instance of the option, by shape alone; the walk parses only when two options could. */
function admits(schema: z.ZodType, value: unknown): boolean {
  const def = defOf(schema);
  switch (def.type) {
    case "array":
      return Array.isArray(value);
    case "object":
    case "record":
      return isPlainObject(value);
    case "optional":
    case "default":
      return value === undefined || admits(def.innerType as z.ZodType, value);
    case "nullable":
      return value === null || admits(def.innerType as z.ZodType, value);
    case "null":
      return value === null;
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "union":
      return (def.options ?? []).some((option) => admits(option, value));
    default:
      return true;
  }
}

function mappingNode(
  value: Readonly<Record<string, unknown>>,
  shape: Readonly<Record<string, z.ZodType>>,
  known: readonly string[],
  childPath: (key: string) => string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of orderedKeys(value, known)) {
    put(out, key, canonicalNode(value[key], own(shape, key), childPath(key)));
  }
  return out;
}

function canonicalNode(value: unknown, schema: z.ZodType | undefined, path: string): unknown {
  if (schema === undefined || value === null || value === undefined) {
    return unknownNode(value);
  }
  const def = defOf(schema);
  switch (def.type) {
    case "optional":
    case "nullable":
    case "default":
      return canonicalNode(value, def.innerType as z.ZodType, path);
    case "object": {
      if (!isPlainObject(value)) {
        return unknownNode(value);
      }
      const shape = def.shape ?? {};
      return mappingNode(value, shape, Object.keys(shape), (key) => `${path}.${key}`);
    }
    case "array":
      if (!Array.isArray(value)) {
        return unknownNode(value);
      }
      return sortEntries(
        path,
        value.map((item) => canonicalNode(item, def.element as z.ZodType, `${path}[]`)),
      );
    case "record": {
      if (!isPlainObject(value)) {
        return unknownNode(value);
      }
      const out: Record<string, unknown> = {};
      for (const key of orderedKeys(value, [])) {
        put(out, key, canonicalNode(value[key], def.valueType as z.ZodType, `${path}.*`));
      }
      return out;
    }
    case "union": {
      const options = def.options ?? [];
      const knob = detectKnobUnion(options);
      if (knob !== null) {
        if (Array.isArray(value)) {
          return canonicalNode(value, knob.list, path);
        }
        if (!isPlainObject(value)) {
          return unknownNode(value);
        }
        const shape = defOf(knob.wrapper).shape ?? {};
        // The wrapper is transparent to the list path, so `labels` names the entries under both forms.
        return mappingNode(value, shape, Object.keys(shape), (key) =>
          key === "entries" ? path : `${path}.${key}`,
        );
      }
      const fits = options.filter((option) => admits(option, value));
      const option =
        fits.length > 1 ? (fits.find((o) => o.safeParse(value).success) ?? fits[0]) : fits[0];
      return option === undefined ? unknownNode(value) : canonicalNode(value, option, path);
    }
    default:
      // The scalar leaves; a mapping under z.unknown has no declared order.
      return unknownNode(value);
  }
}

const TOP_LEVEL_SHAPE: Readonly<Record<string, z.ZodType>> = SettingsFile.shape;

/** The sections in execution order, then the directives in the order the schema declares them. */
const TOP_LEVEL_KEYS: readonly string[] = [
  ...SECTION_KEYS,
  ...Object.keys(TOP_LEVEL_SHAPE).filter(
    (key) => !(SECTION_KEYS as readonly string[]).includes(key),
  ),
];

/** The document as a fresh tree in the canonical order; the input is left as it was. */
export function canonicalDocument(
  document: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return mappingNode(document, TOP_LEVEL_SHAPE, TOP_LEVEL_KEYS, (key) => key);
}

/**
 * The document's YAML, the one rendering the snapshot file and the merged file share. The walk rebuilds every node,
 * so the writer meets no shared object and emits no alias (an alias would trip the reader's cap on the next run).
 */
export function renderCanonicalYaml(document: Readonly<Record<string, unknown>>): string {
  return stringifyYaml(canonicalDocument(document));
}
