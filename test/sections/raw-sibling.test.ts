/**
 * A rule of a registered shape meets the raw value of a sibling that failed its type (reportingBesideFailures in
 * src/sections/contract/module.ts), and a throw there is swallowed with the findings the rule had not reached. The
 * walk takes the structure from the authored document schema (the loosened shape hides a knobbed list behind its
 * routed transform), builds one well-typed value per section plus a variant per other value a field admits (so a
 * rule gated on a flag or an option runs), then puts each raw value at every property and list item in turn and runs
 * document validation, which parses the registered shape; the seam reports every swallowed throw.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { validateSectionShapes } from "../../src/engine/validate.js";
import { SECTION_KEYS, type SectionKey, SettingsFile } from "../../src/schema.js";
import { loosen, observeSwallowedThrows } from "../../src/sections/contract/module.js";

/** The zod internals the walk reads (the loosen() idiom). */
interface DefView {
  type: string;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  innerType?: z.ZodType;
  options?: readonly z.ZodType[];
  valueType?: z.ZodType;
  entries?: Record<string, unknown>;
  values?: readonly unknown[];
}

function defOf(schema: z.ZodType): DefView {
  return (schema as unknown as { _zod: { def: DefView } })._zod.def;
}

function first<T>(items: readonly T[] | undefined, what: string): T {
  const item = items?.[0];
  if (item === undefined) {
    throw new Error(`the ${what} node admits no value; teach the walk the node`);
  }
  return item;
}

/**
 * The well-typed value of a node: every optional or defaulted property present, one item per list, the first option
 * of a union or enum. A string format a leaf refines is not honored: a refinement's own finding does not abort the
 * parse. A default wrapper unwraps to its inner type: the default value is what absence parses to, not a raw value.
 */
function canonical(schema: z.ZodType): unknown {
  const def = defOf(schema);
  switch (def.type) {
    case "object":
      return Object.fromEntries(
        Object.entries(def.shape ?? {}).map(([key, value]) => [key, canonical(value)]),
      );
    case "array":
      return [canonical(def.element as z.ZodType)];
    case "record":
      return { key: canonical(def.valueType as z.ZodType) };
    case "optional":
    case "nullable":
    case "default":
      return canonical(def.innerType as z.ZodType);
    case "union":
      return canonical(first(def.options, "union"));
    case "string":
    case "unknown":
      return "a";
    case "number":
      return 1;
    case "boolean":
      return true;
    case "null":
      return null;
    case "enum":
      return first(Object.values(def.entries ?? {}), "enum");
    case "literal":
      return first(def.values, "literal");
    default:
      throw new Error(`no well-typed value for a "${def.type}" node; teach canonical() the node`);
  }
}

/** A property left out of the document. */
const ABSENT = Symbol("absent");

/** The other well-typed values a node admits: absence, null, false, the other options of an enum or union. */
function alternatives(schema: z.ZodType): unknown[] {
  const def = defOf(schema);
  switch (def.type) {
    case "optional":
    case "default":
      return [ABSENT, ...alternatives(def.innerType as z.ZodType)];
    case "nullable":
      return [null, ...alternatives(def.innerType as z.ZodType)];
    case "union":
      return (def.options ?? []).slice(1).map(canonical);
    case "boolean":
      return [false];
    case "enum":
      return Object.values(def.entries ?? {}).slice(1);
    default:
      return [];
  }
}

type Step = string | number;

interface Gate {
  readonly path: readonly Step[];
  readonly value: unknown;
}

/** Every property below the canonical value with each other value it admits, one Gate per pair. */
function gates(schema: z.ZodType, prefix: readonly Step[] = []): Gate[] {
  const def = defOf(schema);
  switch (def.type) {
    case "optional":
    case "nullable":
    case "default":
      return gates(def.innerType as z.ZodType, prefix);
    case "union":
      return gates(first(def.options, "union"), prefix);
    case "object":
      return Object.entries(def.shape ?? {}).flatMap(([key, property]) => {
        const path = [...prefix, key];
        return [
          ...alternatives(property).map((value) => ({ path, value })),
          ...gates(property, path),
        ];
      });
    case "array":
      return gates(def.element as z.ZodType, [...prefix, 0]);
    case "record":
      return gates(def.valueType as z.ZodType, [...prefix, "key"]);
    default:
      return [];
  }
}

/** Every property and list item below the value; the value itself is not a path (a pathless refusal runs no rule). */
function pathsBelow(value: unknown, prefix: readonly Step[] = []): Step[][] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => [
      [...prefix, index],
      ...pathsBelow(item, [...prefix, index]),
    ]);
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => [
      [...prefix, key],
      ...pathsBelow(item, [...prefix, key]),
    ]);
  }
  return [];
}

/** A structural copy with `replacement` at `path`; ABSENT leaves the property or item out. */
function replacedAt(value: unknown, path: readonly Step[], replacement: unknown): unknown {
  const [head, ...rest] = path;
  if (head === undefined) {
    return replacement;
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      if (index !== head) {
        return [item];
      }
      const next = replacedAt(item, rest, replacement);
      return next === ABSENT ? [] : [next];
    });
  }
  const record = { ...(value as Record<string, unknown>) };
  const next = replacedAt(record[head], rest, replacement);
  if (next === ABSENT) {
    delete record[head];
  } else {
    record[head] = next;
  }
  return record;
}

/** A YAML alias to an ancestor: the raw walk in engine/validate.ts passes a cycle on to the shape, so a rule meets it. */
const CYCLE: Record<string, unknown> = {};
CYCLE.self = CYCLE;

/**
 * What a failed sibling leaves in a rule's hands: one value of each JSON kind (the string is one a table lookup finds
 * on Object.prototype), the empty and false primitives (each satisfies a guard written for the other kind: a
 * `.length === 0` read, a falsy test, `[0]` of a string), a number that is not one, a mapping no string conversion
 * survives and a cycle JSON.stringify refuses (a bare rendering into a message throws on either), a mapping whose
 * length is such a value (a length check compares it), and absence (a valid one at a node changes nothing).
 */
const RAW_VALUES: readonly unknown[] = [
  1,
  0,
  Number.NaN,
  null,
  false,
  "toString",
  "",
  {},
  { toString: null },
  { length: { toString: null } },
  CYCLE,
  [],
  ABSENT,
];

/**
 * A rule that runs only for a specific string (the wildcard sweep of branches) needs a base holding it, which the
 * generated bases cannot know; these are walked the same way, without variants.
 */
const SEEDED_BASES: Partial<Record<SectionKey, readonly unknown[]>> = {
  branches: [
    [
      {
        name: "release/*",
        protection: {
          required_status_checks: { contexts: ["ci"] },
          required_pull_request_reviews: { required_approving_review_count: 1 },
        },
      },
    ],
  ],
};

function render(path: readonly Step[]): string {
  return path.map((step) => (typeof step === "number" ? `[${step}]` : `.${step}`)).join("");
}

function show(value: unknown): string {
  if (value === ABSENT) {
    return "absent";
  }
  if (Number.isNaN(value)) {
    return "NaN";
  }
  return value === CYCLE ? "a cycle" : JSON.stringify(value);
}

/**
 * The documents with a raw value at the path, each with the label of the placement: every raw value at the path, and
 * at a list item every raw value repeated at two items (a YAML alias to one mapping), which a duplicate check meets a
 * second time.
 */
function placements(value: unknown, path: readonly Step[]): [where: string, document: unknown][] {
  const single = RAW_VALUES.map((raw): [string, unknown] => [
    `${render(path)} = ${show(raw)}`,
    replacedAt(value, path, raw),
  ]);
  const parent = path.slice(0, -1);
  if (typeof path[path.length - 1] !== "number") {
    return single;
  }
  const repeated = RAW_VALUES.filter((raw) => raw !== ABSENT).map((raw): [string, unknown] => [
    `${render(parent)}[*] = ${show(raw)} twice`,
    replacedAt(value, parent, [raw, raw]),
  ]);
  return [...single, ...repeated];
}

interface Base {
  readonly value: unknown;
  readonly label: string;
}

/** The canonical value, one variant per gate, the other top-level forms (a knobbed list's wrapper), and the seeds. */
function basesOf(key: SectionKey): Base[] {
  const schema = SettingsFile.shape[key];
  const base = canonical(schema);
  return [
    { value: base, label: "" },
    ...gates(schema).map((gate) => ({
      value: replacedAt(base, gate.path, gate.value),
      label: ` with ${render(gate.path)} = ${show(gate.value)}`,
    })),
    ...alternatives(schema)
      .filter((value) => value !== ABSENT && value !== null)
      .map((value) => ({ value, label: " in the other top-level form" })),
    ...(SEEDED_BASES[key] ?? []).map((value) => ({ value, label: " in the seeded base" })),
  ];
}

describe("every rule of a registered shape tolerates a raw sibling", () => {
  const swallowed: unknown[] = [];
  beforeAll(() => observeSwallowedThrows((error) => swallowed.push(error)));
  afterAll(() => observeSwallowedThrows(null));

  test("control: the seam reports a rule that throws on a raw item beside the item's own issue", () => {
    const throwing = z.object({ list: z.array(z.string()) }).superRefine((value) => {
      value.list.map((item) => item.toLowerCase());
    });
    swallowed.length = 0;
    expect(loosen(throwing).safeParse({ list: [1] }).success).toBe(false);
    expect(swallowed.map((error) => (error as Error).constructor.name)).toEqual(["TypeError"]);
  });

  test("control: the walk reaches a rule gated on a flag and a property left out", () => {
    // The variant with the flag off runs the rule the canonical base (flag on) never reaches, and the rule reports.
    const flagOff = basesOf("environments").find(
      (base) => base.label === " with [0].deployment_branch_policy.custom_branch_policies = false",
    );
    const result = validateSectionShapes({ environments: flagOff?.value }, "test");
    expect("error" in result ? result.error.issues : []).toContainEqual(
      expect.stringContaining(
        "declares deployment_branch_policies, so it must also declare deployment_branch_policy",
      ),
    );
    expect(replacedAt({ keep: 1, drop: 2 }, ["drop"], ABSENT)).toEqual({ keep: 1 });
  });

  test.each([...SECTION_KEYS])("%s: no rule throws with a raw value at any path", (key) => {
    // One line per throw, under the first base that reached it: the variants repeat a throw at the same path.
    const thrown = new Map<string, string>();
    for (const base of basesOf(key)) {
      for (const path of pathsBelow(base.value)) {
        for (const [where, document] of placements(base.value, path)) {
          swallowed.length = 0;
          validateSectionShapes({ [key]: document }, "test");
          for (const error of swallowed) {
            const site = `${key}${where}: ${String(error)}`;
            thrown.set(site, thrown.get(site) ?? `${site}${base.label}`);
          }
        }
      }
    }
    expect([...thrown.values()]).toEqual([]);
  });
});
