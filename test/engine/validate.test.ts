import { describe, expect, test } from "bun:test";
import { err, ok } from "neverthrow";
import { validateSectionShapes } from "../../src/engine/validate.js";

/** The verdict's issue list, or null when the document validated. */
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
        issues: ['workflows[0].state: Invalid option: expected one of "active"|"disabled"'],
      }),
    );
  });

  test.each<[what: string, doc: Record<string, unknown>, issue: string]>([
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
  ])("the fields handlers dereference are shape-checked: %s", (_what, doc, issue) => {
    expect(issuesOf(doc)).toEqual([issue]);
  });

  test("the happy shapes pass, and the parsed document carries the unknown keys through untouched", () => {
    const happy = {
      rulesets: [{ name: "r", conditions: { ref_name: { include: ["main"] } }, extra: 1 }],
      labels: [{ name: "v2", new_name: "2.0" }],
      pages: { source: { branch: "main" }, extra_field: true },
    };
    expect(validateSectionShapes(happy, "f.yml")).toEqual(ok(happy));
  });

  test("only the declared known sections make up the parsed document", () => {
    const verdict = validateSectionShapes(
      { _notes: "private", pages: { source: { branch: "main" } } },
      "f.yml",
    );
    expect(verdict).toEqual(ok({ pages: { source: { branch: "main" } } }));
  });
});

describe("YAML-tagged values are rejected anywhere in a section", () => {
  // zod object schemas accept a Date or Set as an empty mapping, so without the plain-data gate these would validate and silently configure nothing.
  test.each<[site: string, doc: Record<string, unknown>]>([
    ["actions", { actions: new Date(0) }],
    ["pages", { pages: new Date(0) }],
  ])(
    "a tagged section VALUE is rejected for the mapping section %s, which has no required key",
    (site, doc) => {
      expect(issuesOf(doc, "settings.yml")).toEqual([
        `${site} is not plain YAML data (a Date, e.g. from a YAML !!timestamp tag); replace it with a plain value`,
      ]);
    },
  );

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
  const ROLE_CONSEQUENCE =
    'a misspelled "permission" key would silently grant the default "push" role instead of the ' +
    "intended one";

  test("a misspelled collaborator permission fails validation, before any write", () => {
    expect(issuesOf({ collaborators: [{ username: "alice", permision: "admin" }] })).toEqual([
      'collaborators[alice]: declares "permision", which this section does not recognize ' +
        `(known keys: username, permission) - ${ROLE_CONSEQUENCE}. Fix the key name, or remove it`,
    ]);
  });

  test("teams and workflows are closed too", () => {
    expect(issuesOf({ teams: [{ name: "t", permissions: "admin" }] })).toEqual([
      'teams[t]: declares "permissions", which this section does not recognize ' +
        `(known keys: name, permission) - ${ROLE_CONSEQUENCE}. Fix the key name, or remove it`,
    ]);
    expect(issuesOf({ workflows: [{ path: "ci.yml", state: "active", enabled: true }] })).toEqual([
      'workflows[ci.yml]: declares "enabled", which this section does not recognize (known keys: ' +
        "path, state) - the enable/disable calls send no payload, so the key would silently do " +
        "nothing. Fix the key name, or remove it",
    ]);
  });

  test("open sections still pass extra keys through", () => {
    const doc = {
      collaborators: [{ username: "alice", permission: "admin" }],
      milestones: [{ title: "v1", due_on: "2027-01-01T00:00:00Z" }],
      labels: [{ name: "bug", extra_field: true }],
    };
    expect(validateSectionShapes(doc, "f.yml")).toEqual(ok(doc));
  });

  test("closed-surface entry checks see through the wrapper (collaborators)", () => {
    expect(
      issuesOf({
        collaborators: { _undeclared: "keep", entries: [{ username: "alice", permision: "x" }] },
      }),
    ).toEqual([
      'collaborators[alice]: declares "permision", which this section does not recognize ' +
        `(known keys: username, permission) - ${ROLE_CONSEQUENCE}. Fix the key name, or remove it`,
    ]);
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
    expect<unknown>(validateSectionShapes(doc, "f.yml")).toEqual(ok(doc));
  });

  test("wrapper typos fail upfront: an unknown wrapper key and a bad policy value", () => {
    // The wrapper is this action's own strict vocabulary, so a misspelled "entries" reads as both a missing list and an unrecognized key.
    expect(issuesOf({ labels: { entires: [{ name: "bug" }] } })).toEqual([
      "labels.entries: Invalid input: expected array, received undefined",
      'labels: Unrecognized key: "entires"',
    ]);
    expect(issuesOf({ milestones: { _undeclared: "detele", entries: [] } })).toEqual([
      'milestones._undeclared: Invalid option: expected one of "keep"|"delete"',
    ]);
  });

  test("entry paths keep their precision inside the wrapper", () => {
    expect(
      issuesOf({
        rulesets: { entries: [{ name: "r", conditions: { ref_name: { include: "main" } } }] },
      }),
    ).toEqual([
      "rulesets.entries[0].conditions.ref_name.include: Invalid input: expected array, received string",
    ]);
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
    expect(issuesOf(doc)).toEqual([
      `${site}: Unrecognized key: "undeclared"; the wrapper's policy key "undeclared" was renamed ` +
        'to "_undeclared" in v3 (a directive, like _layering) - write _undeclared: keep or ' +
        "_undeclared: delete",
    ]);
  });
});
