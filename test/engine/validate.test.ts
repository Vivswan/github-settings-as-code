import { describe, expect, test } from "bun:test";
import { err, ok } from "neverthrow";
import { validateSectionShapes } from "../../src/engine/validate.js";
import type { SectionKey } from "../../src/schema.js";
import { SECTIONS } from "../../src/sections/registry.js";

function issuesOf(doc: Record<string, unknown>, sourceLabel = "f.yml"): readonly string[] | null {
  return validateSectionShapes(doc, sourceLabel).match(
    () => null,
    (problem) => problem.issues,
  );
}

describe("section shape validation", () => {
  test("pages: null passes", () => {
    expect(validateSectionShapes({ pages: null }, "f.yml")).toEqual(ok({ pages: null }));
  });

  test("a shape failure is one problem naming the source, with every issue listed", () => {
    expect(
      validateSectionShapes({ workflows: [{ path: "ci.yml", state: "paused" }] }, "settings.yml"),
    ).toEqual(
      err({
        code: "settings-malformed-sections",
        source: "settings.yml",
        issues: [expect.stringMatching(/^workflows\[0\]\.state: /)],
      }),
    );
  });

  test.each<[what: string, doc: Record<string, unknown>, issue: RegExp]>([
    // A missing "-" makes include a string; the handler would call .map on it.
    [
      "a string where the handler maps a list",
      { rulesets: [{ name: "protect-main", conditions: { ref_name: { include: "main" } } }] },
      /^rulesets\[0\]\.conditions\.ref_name\.include: .*expected array/,
    ],
    // YAML parses new_name: 2.0 as a number; the handler lowercases it.
    [
      "a number where the handler lowercases a string",
      { labels: [{ name: "v2", new_name: 2 }] },
      /^labels\[0\]\.new_name: .*expected string/,
    ],
    // The handler reads source.path, which throws on source: null.
    [
      "a null where the handler dereferences a mapping",
      { pages: { source: null } },
      /^pages\.source: .*expected object/,
    ],
  ])("the fields handlers dereference are shape-checked: %s", (_what, doc, issue) => {
    expect(issuesOf(doc)).toEqual([expect.stringMatching(issue)]);
  });

  test("the happy shapes pass, and the parsed document carries the unknown keys through untouched", () => {
    const happy = {
      rulesets: [{ name: "r", conditions: { ref_name: { include: ["main"] } }, extra: 1 }],
      labels: [{ name: "v2", new_name: "2.0" }],
      pages: { source: { branch: "main" }, extra_field: true },
    };
    // The slice fills a ruleset's target and enforcement at parse; nothing else changes.
    const parsed = {
      ...happy,
      rulesets: [{ ...happy.rulesets[0], target: "branch" as const, enforcement: "active" }],
    };
    expect<unknown>(validateSectionShapes(happy, "f.yml")).toEqual(ok(parsed));
  });

  test("only the declared known sections make up the parsed document", () => {
    const verdict = validateSectionShapes(
      { _layering: "replace", pages: { source: { branch: "main" } } },
      "f.yml",
    );
    expect(verdict).toEqual(ok({ pages: { source: { branch: "main" } } }));
  });
});

describe("YAML-tagged values are rejected anywhere in a section", () => {
  // zod object schemas accept a Date or Set as an empty mapping, so without the plain-data gate these would validate and silently configure nothing.
  test("a tagged section VALUE is rejected for a mapping section that has no required key", () => {
    expect(issuesOf({ actions: new Date(0) }, "settings.yml")).toEqual([
      "actions is not plain YAML data (a Date, e.g. from a YAML !!timestamp tag); replace it with a plain value",
    ]);
  });

  test("a tagged NESTED value is rejected with its key path", () => {
    expect(issuesOf({ actions: { cache: new Date(0) } })).toEqual([
      "actions.cache is not plain YAML data (a Date, e.g. from a YAML !!timestamp tag); replace it with a plain value",
    ]);
    expect(issuesOf({ labels: [{ name: "bug", color: new Set(["d73a4a"]) }] })).toEqual([
      "labels[0].color is not plain YAML data (a set, e.g. from a YAML !!set tag); replace it with a plain value",
    ]);
  });

  test("a cyclic document (YAML anchors) does not hang the validator", () => {
    const cyclic: Record<string, unknown> = { description: "x" };
    cyclic.self = cyclic;
    // Not endorsed, but the walk must terminate; the shape parse still rules.
    expect(() => issuesOf({ repository: cyclic } as Record<string, unknown>)).not.toThrow();
  });
});

describe("closed-surface sections reject unrecognized entry keys upfront", () => {
  const ENTRIES: Partial<Record<SectionKey, Record<string, unknown>>> = {
    collaborators: { username: "alice" },
    teams: { name: "t" },
    workflows: { path: "ci.yml", state: "active" },
    custom_properties: { property_name: "team", value: "platform" },
    secret_scanning_custom_patterns: { name: "internal-token", pattern: "int_[a-z0-9]{8}" },
    actions_secrets: { name: "S", value: "$S" },
    dependabot_secrets: { name: "S", value: "$S" },
    codespaces_secrets: { name: "S", value: "$S" },
    agents_secrets: { name: "S", value: "$S" },
  };
  const closed = SECTIONS.flatMap((section) =>
    section.closedSurface === undefined
      ? []
      : [
          {
            key: section.key,
            surface: section.closedSurface as {
              known: Readonly<Record<string, true>>;
              describe: (entry: Record<string, unknown>) => string;
              consequence: string;
            },
          },
        ],
  );

  test("every closed section refuses a misspelled key, naming the key, its known keys, and its consequence; a correct entry passes", () => {
    expect(Object.keys(ENTRIES).sort()).toEqual(closed.map((section) => section.key).sort());
    for (const { key, surface } of closed) {
      const entry = ENTRIES[key] as Record<string, unknown>;
      expect(validateSectionShapes({ [key]: [entry] }, "f.yml").isOk(), key).toBe(true);
      const misspelled = { ...entry, permision: "admin" };
      expect(issuesOf({ [key]: [misspelled] }), key).toEqual([
        `${key}[${surface.describe(misspelled)}]: declares "permision", which this section does not recognize ` +
          `(known keys: ${Object.keys(surface.known).join(", ")}) - ${surface.consequence}. Fix the key name, or remove it`,
      ]);
    }
  });

  test("closed-surface entry checks see through the wrapper (collaborators)", () => {
    expect(
      issuesOf({
        collaborators: { _undeclared: "keep", entries: [{ username: "alice", permision: "x" }] },
      }),
    ).toEqual([expect.stringMatching(/^collaborators\[alice\]: declares "permision", /)]);
  });
});

describe("the wrapped undeclared-policy form", () => {
  test("both policies and the bare wrapper validate", () => {
    const doc = {
      labels: { _undeclared: "keep", entries: [{ name: "bug" }] },
      autolinks: { _undeclared: "keep", entries: [{ key_prefix: "J-", url_template: "u/<num>" }] },
      collaborators: { entries: [{ username: "alice" }] },
      rulesets: { _undeclared: "delete", entries: [{ name: "r" }] },
      milestones: { _undeclared: "delete", entries: [{ title: "v1" }] },
    };
    // The one slice with defaults fills them; every other entry parses as written.
    const parsed = {
      ...doc,
      rulesets: {
        _undeclared: "delete",
        entries: [{ name: "r", target: "branch", enforcement: "active" }],
      },
    };
    expect<unknown>(validateSectionShapes(doc, "f.yml")).toEqual(ok(parsed));
  });

  test("wrapper typos fail upfront: an unknown wrapper key, a bad policy value, and an own __proto__ key", () => {
    // The wrapper is this action's own strict vocabulary, so a misspelled "entries" reads as both a missing list and an unrecognized key.
    expect(issuesOf({ labels: { entires: [{ name: "bug" }] } })).toEqual([
      expect.stringMatching(/^labels\.entries: /),
      expect.stringMatching(/^labels: Unrecognized key: "entires"/),
    ]);
    expect(issuesOf({ milestones: { _undeclared: "detele", entries: [] } })).toEqual([
      expect.stringMatching(/^milestones\._undeclared: /),
    ]);
    // JSON.parse creates "__proto__" as an OWN key; on the strict wrapper it is an unrecognized key like any other.
    expect(
      issuesOf(JSON.parse('{"rulesets":{"entries":[{"name":"r"}],"__proto__":{"planted":2}}}')),
    ).toEqual([expect.stringMatching(/^rulesets: Unrecognized key: "__proto__"/)]);
  });

  test("an unknown underscore key on a wrapper names the two directives, on a top-level and a nested wrapper alike", () => {
    expect(issuesOf({ labels: { _notes: "private", entries: [{ name: "bug" }] } })).toEqual([
      expect.stringMatching(/^labels: Unrecognized key: "_notes"; .*"_undeclared".*"_layering"/),
    ]);
    expect(
      issuesOf({
        environments: [{ name: "prod", variables: { _layering: "deep", entries: [] } }],
      }),
    ).toEqual([
      expect.stringMatching(/^environments\[0\]\.variables: Unrecognized key: "_layering"; /),
    ]);
    // Beside a plain typo the clause names the underscore key it is about; the typo stays on zod's own line.
    expect(issuesOf({ labels: { _notes: "x", entires: [], entries: [] } })).toEqual([
      expect.stringMatching(/^labels: Unrecognized keys: "_notes", "entires"; "_notes": /),
    ]);
    // Beside the pre-v3 policy key both clauses appear, so one run names every fix.
    expect(issuesOf({ labels: { undeclared: "keep", _owner: "note", entries: [] } })).toEqual([
      expect.stringMatching(
        /^labels: Unrecognized keys: "undeclared", "_owner"; .*"undeclared" was renamed to "_undeclared".*; "_owner": /,
      ),
    ]);
  });

  test("entry paths keep their precision inside the wrapper", () => {
    expect(
      issuesOf({
        rulesets: { entries: [{ name: "r", conditions: { ref_name: { include: "main" } } }] },
      }),
    ).toEqual([
      expect.stringMatching(
        /^rulesets\.entries\[0\]\.conditions\.ref_name\.include: .*expected array/,
      ),
    ]);
  });

  test("the pre-v3 policy key fails naming the rename on a nested environments list", () => {
    expect(
      issuesOf({
        environments: [
          { name: "prod", variables: { undeclared: "keep", entries: [{ name: "A", value: "1" }] } },
        ],
      }),
    ).toEqual([
      expect.stringMatching(
        /^environments\[0\]\.variables: Unrecognized key: "undeclared"; .*"undeclared" was renamed to "_undeclared"/,
      ),
    ]);
  });
});

describe("a long problem list is cut, and the remainder is counted", () => {
  // Both arms cut at the same depth: zod issues within one section, and unrecognized keys across a closed section's entries.
  const SHOWN = 5;
  test.each<[arm: string, docOf: (n: number) => Record<string, unknown>, noun: [string, string]]>([
    [
      "shape issues",
      (n) => ({
        workflows: Array.from({ length: n }, (_, i) => ({ path: `w${i}.yml`, state: "paused" })),
      }),
      ["issue", "issues"],
    ],
    [
      "unrecognized entry keys",
      (n) => ({
        collaborators: Array.from({ length: n }, (_, i) => ({ username: `u${i}`, permision: "x" })),
      }),
      ["entry", "entries"],
    ],
  ])(
    "%s: N problems render the first five and count the rest, the noun agreeing with the count; five render whole",
    (_arm, docOf, [one, many]) => {
      const tail = new RegExp(`\\.\\.\\.and (\\d+) more (${one}|${many}) `);
      /** The count and the noun of the remainder line after `n` hidden problems, or the whole line when it has neither. */
      const remainder = (n: number): [number, string] | string => {
        const line = (issuesOf(docOf(SHOWN + n)) ?? [])[SHOWN] ?? "";
        const found = tail.exec(line);
        return found ? [Number(found[1]), found[2] ?? ""] : line;
      };
      const cut = issuesOf(docOf(SHOWN + 3)) ?? [];
      expect(cut).toHaveLength(SHOWN + 1);
      expect(cut.slice(0, SHOWN).filter((line) => tail.test(line))).toEqual([]);
      expect(remainder(3)).toEqual([3, many]);
      expect(remainder(2)).toEqual([2, many]);
      expect(remainder(1)).toEqual([1, one]);
      const whole = issuesOf(docOf(SHOWN)) ?? [];
      expect(whole).toHaveLength(SHOWN);
      expect(whole.filter((line) => tail.test(line))).toEqual([]);
    },
  );
});
