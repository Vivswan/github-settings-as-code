/**
 * The canonical order is a relation, not a picture: the same content in any key or list order renders to one set of
 * bytes, and every mapping list the schema declares is either sorted by a declared identity or deliberately left as
 * written.
 */

import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import {
  canonicalDocument,
  compareByCodePoint,
  LIST_IDENTITY,
  LISTS_AS_WRITTEN,
  renderCanonicalYaml,
} from "../../src/engine/canonical.js";
import { DOCUMENT_DIRECTIVE_KEYS, SECTION_KEYS, SettingsFile } from "../../src/schema.js";
import { SECTIONS } from "../../src/sections/registry.js";

/** A document spelled in the canonical order, so the shuffled twin below has something to converge on. */
const ORDERED: Record<string, unknown> = {
  repository: {
    has_issues: true,
    has_wiki: false,
    topics: ["b", "a"],
    enable_vulnerability_alerts: true,
  },
  labels: {
    _undeclared: "keep",
    entries: [
      { name: "bug", color: "d73a4a", description: "Something is broken" },
      { name: "docs", color: "0075ca" },
    ],
  },
  rulesets: [
    {
      name: "main",
      rules: [{ type: "deletion", parameters: { a: 2, z: 1 } }, { type: "non_fast_forward" }],
      bypass_actors: [{ actor_id: 2, actor_type: "Team" }],
    },
  ],
  environments: [
    { name: "prod", pinned: true },
    { name: "beta", pinned: true },
    { name: "alpha" },
    {
      name: "zeta",
      variables: [
        { name: "A", value: "2" },
        { name: "B", value: "1" },
      ],
    },
  ],
  pages: null,
  webhooks: [{ config: { url: "https://a" } }, { config: { url: "https://b" } }],
  _layering: "deep",
};

/** The same content: every mapping's keys reversed, every identity-sorted list reversed, the pinned block kept. */
const SHUFFLED: Record<string, unknown> = {
  _layering: "deep",
  webhooks: [{ config: { url: "https://b" } }, { config: { url: "https://a" } }],
  pages: null,
  environments: [
    { name: "prod", pinned: true },
    {
      variables: [
        { value: "1", name: "B" },
        { value: "2", name: "A" },
      ],
      name: "zeta",
    },
    { pinned: true, name: "beta" },
    { name: "alpha" },
  ],
  rulesets: [
    {
      bypass_actors: [{ actor_type: "Team", actor_id: 2 }],
      rules: [{ type: "non_fast_forward" }, { parameters: { z: 1, a: 2 }, type: "deletion" }],
      name: "main",
    },
  ],
  labels: {
    entries: [
      { color: "0075ca", name: "docs" },
      { description: "Something is broken", color: "d73a4a", name: "bug" },
    ],
    _undeclared: "keep",
  },
  repository: {
    has_wiki: false,
    has_issues: true,
    enable_vulnerability_alerts: true,
    topics: ["b", "a"],
  },
};

describe("canonicalDocument", () => {
  test("the same content in any key or list order renders to identical bytes, and the canonical spelling is a fixpoint", () => {
    const rendered = renderCanonicalYaml(ORDERED);
    expect(renderCanonicalYaml(SHUFFLED)).toBe(rendered);
    expect(JSON.stringify(canonicalDocument(canonicalDocument(SHUFFLED)))).toBe(
      JSON.stringify(canonicalDocument(SHUFFLED)),
    );
    // The canonical spelling above IS the canonical order: rendering it changes nothing but the serialization.
    expect(JSON.stringify(canonicalDocument(ORDERED))).toBe(JSON.stringify(ORDERED));
  });

  test("the input is left as it was", () => {
    const before = JSON.stringify(SHUFFLED);
    canonicalDocument(SHUFFLED);
    expect(JSON.stringify(SHUFFLED)).toBe(before);
  });

  test("the top level is SECTION_KEYS order, then the directives, then unknown keys by code point", () => {
    const document = Object.fromEntries([
      ["zebra", 1],
      ..._directivesFirst(),
      ...[...SECTION_KEYS].reverse().map((key) => [key, {}]),
      ["apple", 2],
    ]);
    expect(Object.keys(canonicalDocument(document))).toEqual([
      ...SECTION_KEYS,
      ...DOCUMENT_DIRECTIVE_KEYS,
      "apple",
      "zebra",
    ]);
  });

  test("a declared mapping keeps the schema's property order and puts unknown keys after it by code point; an open mapping sorts", () => {
    const canonical = canonicalDocument({
      repository: {
        zzz: 1,
        has_wiki: false,
        enable_vulnerability_alerts: true,
        aaa: 2,
        topics: [],
      },
      rulesets: [{ name: "r", rules: [{ type: "t", parameters: { z: 1, m: 2, a: 3 } }] }],
    }) as { repository: object; rulesets: Array<{ rules: Array<{ parameters: object }> }> };
    expect(Object.keys(canonical.repository)).toEqual([
      "has_wiki",
      "topics",
      "enable_vulnerability_alerts",
      "aaa",
      "zzz",
    ]);
    expect(Object.keys(canonical.rulesets[0]?.rules[0]?.parameters ?? {})).toEqual(["a", "m", "z"]);
  });

  test("the pinned environments lead in their written order (their order is the pin rank), the rest sort by name", () => {
    const rank = (entries: unknown[]): string[] =>
      (canonicalDocument({ environments: entries }).environments as Array<{ name: string }>).map(
        (entry) => entry.name,
      );
    expect(
      rank([
        { name: "b" },
        { name: "z", pinned: true },
        { name: "a" },
        { name: "c", pinned: true },
      ]),
    ).toEqual(["z", "c", "a", "b"]);
    // Swapping two pinned entries is a different document; swapping two unpinned ones is the same one.
    expect(
      rank([
        { name: "c", pinned: true },
        { name: "z", pinned: true },
      ]),
    ).toEqual(["c", "z"]);
    expect(rank([{ name: "a" }, { name: "b" }])).toEqual(rank([{ name: "b" }, { name: "a" }]));
  });

  test("two entries under one identity keep a stable order by their canonical text", () => {
    const entries = [
      { name: "bug", color: "ffffff" },
      { name: "bug", color: "000000" },
    ];
    const canonical = canonicalDocument({ labels: entries }) as { labels: typeof entries };
    expect(canonical.labels.map((entry) => entry.color)).toEqual(["000000", "ffffff"]);
    expect(canonicalDocument({ labels: [...entries].reverse() })).toEqual(canonical);
  });

  test("a scalar list, an unkeyed mapping list, and branches (their order is the rules' priority) stay as written", () => {
    const branches = [
      { name: "z*", protection: { enforce_admins: true } },
      { name: "*", protection: { required_linear_history: true } },
    ];
    const canonical = canonicalDocument({
      repository: { topics: ["b", "a"] },
      rulesets: [{ name: "r", bypass_actors: [{ actor_id: 2 }, { actor_id: 1 }] }],
      branches,
    }) as {
      repository: { topics: string[] };
      rulesets: Array<{ bypass_actors: unknown[] }>;
      branches: unknown[];
    };
    expect(canonical.repository.topics).toEqual(["b", "a"]);
    expect(canonical.rulesets[0]?.bypass_actors).toEqual([{ actor_id: 2 }, { actor_id: 1 }]);
    expect(canonical.branches).toEqual(branches);
  });

  test("a passthrough key named like an Object.prototype member is an unknown key, not a schema property", () => {
    const canonical = canonicalDocument({
      repository: { toString: "b", has_wiki: true, constructor: "a" },
    }) as { repository: Record<string, unknown> };
    expect(Object.entries(canonical.repository)).toEqual([
      ["has_wiki", true],
      ["constructor", "a"],
      ["toString", "b"],
    ]);
  });

  test("compareByCodePoint orders by code point, so a supplementary-plane character follows every BMP one", () => {
    // U+E000 is one UTF-16 code unit above U+10000's lead surrogate, so code-unit order would invert the pair.
    expect(["\u{10000}", "\u{E000}", "b", "a"].sort(compareByCodePoint)).toEqual([
      "a",
      "b",
      "\u{E000}",
      "\u{10000}",
    ]);
    expect(compareByCodePoint("ab", "a")).toBeGreaterThan(0);
    expect(compareByCodePoint("a", "a")).toBe(0);
  });
});

/** The directives as the schema declares them, spelled first so the test proves they move after the sections. */
function _directivesFirst(): Array<[string, unknown]> {
  return DOCUMENT_DIRECTIVE_KEYS.map((key) => [key, "deep"]);
}

interface Def {
  type: string;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  innerType?: z.ZodType;
  options?: readonly z.ZodType[];
  valueType?: z.ZodType;
}

const defOf = (schema: z.ZodType): Def => (schema as unknown as { _zod: { def: Def } })._zod.def;

/** Every list of mappings the schema declares, by the path LIST_IDENTITY spells (a knob wrapper's `entries` transparent). */
/** Whether a list of this element is a mapping list: a mapping, or a union whose options include one (a ruleset's rules). */
function isMappingSchema(schema: z.ZodType): boolean {
  const def = defOf(schema);
  switch (def.type) {
    case "optional":
    case "nullable":
    case "default":
      return isMappingSchema(def.innerType as z.ZodType);
    case "object":
    case "record":
      return true;
    case "union":
      return (def.options ?? []).some(isMappingSchema);
    default:
      return false;
  }
}

function mappingListPaths(schema: z.ZodType, path: string, out: Set<string>): void {
  const def = defOf(schema);
  switch (def.type) {
    case "optional":
    case "nullable":
    case "default":
      mappingListPaths(def.innerType as z.ZodType, path, out);
      return;
    case "object":
      for (const [key, child] of Object.entries(def.shape ?? {})) {
        mappingListPaths(child, path === "" ? key : `${path}.${key}`, out);
      }
      return;
    case "array": {
      const element = def.element as z.ZodType;
      if (isMappingSchema(element)) {
        out.add(path);
      }
      mappingListPaths(element, `${path}[]`, out);
      return;
    }
    case "record":
      mappingListPaths(def.valueType as z.ZodType, `${path}.*`, out);
      return;
    case "union": {
      const options = def.options ?? [];
      const wrapper = options.find((option) => defOf(option).shape?.entries !== undefined);
      for (const option of options) {
        if (option === wrapper) {
          for (const [key, child] of Object.entries(defOf(option).shape ?? {})) {
            mappingListPaths(child, key === "entries" ? path : `${path}.${key}`, out);
          }
        } else {
          mappingListPaths(option, path, out);
        }
      }
      return;
    }
    default:
      return;
  }
}

describe("LIST_IDENTITY covers the schema", () => {
  test("every mapping list the schema declares has an identity or is kept as written for a stated reason, and nothing else is listed", () => {
    const declared = new Set<string>();
    mappingListPaths(SettingsFile, "", declared);
    expect([...declared].sort()).toEqual(
      [...Object.keys(LIST_IDENTITY), ...Object.keys(LISTS_AS_WRITTEN)].sort(),
    );
  });

  test("a list section's identity is the field its declaration keys the planner by", () => {
    const declaring = SECTIONS.flatMap((section) =>
      "decl" in section
        ? [
            [
              section.key,
              (section as { decl: { identity: { field: string } } }).decl.identity.field,
            ],
          ]
        : [],
    );
    expect(declaring.length).toBeGreaterThanOrEqual(6);
    for (const [key, field] of declaring) {
      expect([key, LIST_IDENTITY[key as string]]).toEqual([key, field]);
    }
  });
});
