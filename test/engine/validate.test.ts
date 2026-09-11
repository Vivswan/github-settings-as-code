import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../src/engine/validate.js";

/** The verdict's error prose, or null when the document validated. */
function errorOf(doc: Record<string, unknown>, sourceLabel = "f.yml"): string | null {
  const verdict = validateSectionShapes(doc, sourceLabel);
  return "error" in verdict ? verdict.error : null;
}

/**
 * Every shape verdict is one line: the source label, the problems joined by
 * "; ", and the same passthrough clause. The tables below carry the problem
 * list and the assertion pins the whole line.
 */
const PASSTHROUGH =
  "Fix these values in the settings file (only the named keys are validated; extra fields pass " +
  "through, except in closed sections and strict nested objects like actions.cache, which reject " +
  "unrecognized keys)";

describe("section shape validation", () => {
  test("pages: null passes", () => {
    expect(validateSectionShapes({ pages: null }, "f.yml")).toEqual({ settings: { pages: null } });
  });

  test.each<[what: string, doc: Record<string, unknown>, problem: string]>([
    [
      "a bad workflows state fails naming the path",
      { workflows: [{ path: "ci.yml", state: "paused" }] },
      'workflows[0].state: Invalid option: expected one of "active"|"disabled"',
    ],
    // A missing "-" makes include a string; the handler would call .map on it.
    [
      "a string where the handler maps a list",
      { rulesets: [{ name: "protect-main", conditions: { ref_name: { include: "main" } } }] },
      "rulesets[0].conditions.ref_name.include: Invalid input: expected array, received string",
    ],
    // YAML parses new_name: 2.0 as a number; the handler lowercases it.
    [
      "a number where the handler lowercases a string",
      { labels: [{ name: "v2", new_name: 2 }] },
      "labels[0].new_name: Invalid input: expected string, received number",
    ],
    // The handler reads source.path, which throws on source: null.
    [
      "a null where the handler dereferences a mapping",
      { pages: { source: null } },
      "pages.source: Invalid input: expected object, received null",
    ],
  ])("the fields handlers dereference are shape-checked: %s", (_what, doc, problem) => {
    expect(errorOf(doc)).toBe(`f.yml has malformed section entries: ${problem}. ${PASSTHROUGH}`);
  });

  test("the happy shapes pass, and the parsed document carries the unknown keys through untouched", () => {
    const happy = {
      rulesets: [{ name: "r", conditions: { ref_name: { include: ["main"] } }, extra: 1 }],
      labels: [{ name: "v2", new_name: "2.0" }],
      pages: { source: { branch: "main" }, extra_field: true },
    };
    expect(validateSectionShapes(happy, "f.yml")).toEqual({ settings: happy });
  });

  test("only the declared known sections make up the parsed document", () => {
    const verdict = validateSectionShapes(
      { _notes: "private", pages: { source: { branch: "main" } } },
      "f.yml",
    );
    expect(verdict).toEqual({ settings: { pages: { source: { branch: "main" } } } });
  });
});

describe("YAML-tagged values are rejected anywhere in a section", () => {
  // zod object schemas accept a Date or Set as an empty mapping, so without
  // the plain-data gate these would validate and silently configure nothing.
  test.each<[site: string, doc: Record<string, unknown>]>([
    ["actions", { actions: new Date(0) }],
    ["pages", { pages: new Date(0) }],
  ])(
    "a tagged section VALUE is rejected for the mapping section %s, which has no required key",
    (site, doc) => {
      expect(errorOf(doc, "settings.yml")).toBe(
        `settings.yml has malformed section entries: ${site} is not plain YAML data (a Date, ` +
          `e.g. from a YAML !!timestamp tag); replace it with a plain value. ${PASSTHROUGH}`,
      );
    },
  );

  test("a tagged NESTED value is rejected with its key path", () => {
    expect(errorOf({ actions: { cache: new Date(0) } })).toBe(
      "f.yml has malformed section entries: actions.cache is not plain YAML data (a Date, e.g. " +
        `from a YAML !!timestamp tag); replace it with a plain value. ${PASSTHROUGH}`,
    );
    expect(errorOf({ labels: [{ name: "bug", color: new Set(["d73a4a"]) }] })).toBe(
      "f.yml has malformed section entries: labels[0].color is not plain YAML data (a set, e.g. " +
        `from a YAML !!set tag); replace it with a plain value. ${PASSTHROUGH}`,
    );
  });

  test("a cyclic document (YAML anchors) does not hang the validator", () => {
    const cyclic: Record<string, unknown> = { description: "x" };
    cyclic.self = cyclic;
    // Not endorsed, but the walk must terminate; the shape parse still rules.
    expect(() => errorOf({ repository: cyclic } as Record<string, unknown>)).not.toThrow();
  });
});

describe("closed-surface sections reject unrecognized entry keys upfront", () => {
  const ROLE_CONSEQUENCE =
    'a misspelled "permission" key would silently grant the default "push" role instead of the ' +
    "intended one";

  test("a misspelled collaborator permission fails validation, before any write", () => {
    expect(errorOf({ collaborators: [{ username: "alice", permision: "admin" }] })).toBe(
      'f.yml has malformed section entries: collaborators[alice]: declares "permision", which ' +
        `this section does not recognize (known keys: username, permission) - ${ROLE_CONSEQUENCE}. ` +
        `Fix the key name, or remove it. ${PASSTHROUGH}`,
    );
  });

  test("teams and workflows are closed too", () => {
    expect(errorOf({ teams: [{ name: "t", permissions: "admin" }] })).toBe(
      'f.yml has malformed section entries: teams[t]: declares "permissions", which this ' +
        `section does not recognize (known keys: name, permission) - ${ROLE_CONSEQUENCE}. ` +
        `Fix the key name, or remove it. ${PASSTHROUGH}`,
    );
    expect(errorOf({ workflows: [{ path: "ci.yml", state: "active", enabled: true }] })).toBe(
      'f.yml has malformed section entries: workflows[ci.yml]: declares "enabled", which this ' +
        "section does not recognize (known keys: path, state) - the enable/disable calls send no " +
        `payload, so the key would silently do nothing. Fix the key name, or remove it. ${PASSTHROUGH}`,
    );
  });

  test("open sections still pass extra keys through", () => {
    const doc = {
      collaborators: [{ username: "alice", permission: "admin" }],
      milestones: [{ title: "v1", due_on: "2027-01-01T00:00:00Z" }],
      labels: [{ name: "bug", extra_field: true }],
    };
    expect(validateSectionShapes(doc, "f.yml")).toEqual({ settings: doc });
  });

  test("closed-surface entry checks see through the wrapper (collaborators)", () => {
    expect(
      errorOf({
        collaborators: { _undeclared: "keep", entries: [{ username: "alice", permision: "x" }] },
      }),
    ).toBe(
      'f.yml has malformed section entries: collaborators[alice]: declares "permision", which ' +
        `this section does not recognize (known keys: username, permission) - ${ROLE_CONSEQUENCE}. ` +
        `Fix the key name, or remove it. ${PASSTHROUGH}`,
    );
  });
});

describe("the wrapped undeclared-policy form", () => {
  test("both policies and the bare wrapper validate on every knobbed section", () => {
    const doc = {
      labels: { _undeclared: "keep", entries: [{ name: "bug" }] },
      autolinks: { _undeclared: "keep", entries: [{ key_prefix: "J-", url_template: "u" }] },
      collaborators: { entries: [{ username: "alice" }] },
      rulesets: { _undeclared: "delete", entries: [{ name: "r" }] },
      milestones: { _undeclared: "delete", entries: [{ title: "v1" }] },
    };
    expect<unknown>(validateSectionShapes(doc, "f.yml")).toEqual({ settings: doc });
  });

  test("wrapper typos fail upfront: an unknown wrapper key and a bad policy value", () => {
    // The wrapper is this action's own strict vocabulary; unlike entry
    // passthrough fields, its extra keys have nowhere to go. A misspelled
    // "entries" reads as both a missing list and an unrecognized key.
    expect(errorOf({ labels: { entires: [{ name: "bug" }] } })).toBe(
      "f.yml has malformed section entries: labels.entries: Invalid input: expected array, " +
        `received undefined; labels: Unrecognized key: "entires". ${PASSTHROUGH}`,
    );
    expect(errorOf({ milestones: { _undeclared: "detele", entries: [] } })).toBe(
      "f.yml has malformed section entries: milestones._undeclared: Invalid option: expected " +
        `one of "keep"|"delete". ${PASSTHROUGH}`,
    );
  });

  test("entry paths keep their precision inside the wrapper", () => {
    expect(
      errorOf({
        rulesets: { entries: [{ name: "r", conditions: { ref_name: { include: "main" } } }] },
      }),
    ).toBe(
      "f.yml has malformed section entries: rulesets.entries[0].conditions.ref_name.include: " +
        `Invalid input: expected array, received string. ${PASSTHROUGH}`,
    );
  });

  test.each([
    {
      name: "a top-level section",
      doc: { labels: { undeclared: "keep", entries: [{ name: "bug" }] } },
      site: "labels",
    },
    {
      name: "a nested environments list",
      doc: {
        environments: [
          { name: "prod", variables: { undeclared: "keep", entries: [{ name: "A", value: "1" }] } },
        ],
      },
      site: "environments[0].variables",
    },
  ])("the pre-v3 policy key fails naming the rename on $name", ({ doc, site }) => {
    expect(errorOf(doc)).toBe(
      `f.yml has malformed section entries: ${site}: Unrecognized key: "undeclared"; the wrapper's ` +
        `policy key "undeclared" was renamed to "_undeclared" in v3 (a directive, like _layering) - ` +
        `write _undeclared: keep or _undeclared: delete. Fix these values in the settings file (only ` +
        `the named keys are validated; extra fields pass through, except in closed sections and strict ` +
        `nested objects like actions.cache, which reject unrecognized keys)`,
    );
  });
});
