import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../src/engine/validate.js";

/** The verdict's error prose, or null when the document validated. */
function errorOf(doc: Record<string, unknown>, sourceLabel = "f.yml"): string | null {
  const verdict = validateSectionShapes(doc, sourceLabel);
  return "error" in verdict ? verdict.error : null;
}

describe("section shape validation", () => {
  test("pages: null passes; a bad workflows state fails naming the path", () => {
    expect(validateSectionShapes({ pages: null }, "f.yml")).toEqual({ settings: { pages: null } });
    const error = errorOf({ workflows: [{ path: "ci.yml", state: "paused" }] });
    expect(error).toContain("workflows[0].state");
  });

  test("the fields handlers dereference are shape-checked, naming the key path", () => {
    // A missing "-" makes include a string; the handler would call .map on it.
    const include = errorOf({
      rulesets: [{ name: "protect-main", conditions: { ref_name: { include: "main" } } }],
    });
    expect(include).toContain("rulesets[0].conditions.ref_name.include");
    // YAML parses new_name: 2.0 as a number; the handler lowercases it.
    const rename = errorOf({ labels: [{ name: "v2", new_name: 2 }] });
    expect(rename).toContain("labels[0].new_name");
    // The handler reads source.path, which throws on source: null.
    const source = errorOf({ pages: { source: null } });
    expect(source).toContain("pages.source");
    // The happy shapes still pass, and the parsed document carries the
    // unknown keys through untouched.
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
  test("a tagged section VALUE is rejected for mapping sections without a required key", () => {
    // zod object schemas accept a Date or Set as an empty mapping, so
    // without the plain-data gate these would validate and silently
    // configure nothing.
    for (const doc of [{ actions: new Date(0) }, { pages: new Date(0) }]) {
      const error = errorOf(doc as Record<string, unknown>, "settings.yml");
      expect(error).toContain("not plain YAML data");
      expect(error).toContain("!!timestamp");
    }
  });

  test("a tagged NESTED value is rejected with its key path", () => {
    const error = errorOf({ actions: { cache: new Date(0) } } as Record<string, unknown>);
    expect(error).toContain("actions.cache is not plain YAML data");
    const inList = errorOf({ labels: [{ name: "bug", color: new Set(["d73a4a"]) }] } as Record<
      string,
      unknown
    >);
    expect(inList).toContain("labels[0].color is not plain YAML data");
    expect(inList).toContain("!!set");
  });

  test("a cyclic document (YAML anchors) does not hang the validator", () => {
    const cyclic: Record<string, unknown> = { description: "x" };
    cyclic.self = cyclic;
    // Not endorsed, but the walk must terminate; the shape parse still rules.
    expect(() => errorOf({ repository: cyclic } as Record<string, unknown>)).not.toThrow();
  });
});

describe("closed-surface sections reject unrecognized entry keys upfront", () => {
  test("a misspelled collaborator permission fails validation, before any write", () => {
    const error = errorOf({ collaborators: [{ username: "alice", permision: "admin" }] });
    expect(error).toContain('collaborators[alice]: declares "permision"');
    expect(error).toContain("known keys: username, permission");
    expect(error).toContain('default "push" role');
  });

  test("teams and workflows are closed too", () => {
    const teams = errorOf({ teams: [{ name: "t", permissions: "admin" }] });
    expect(teams).toContain('teams[t]: declares "permissions"');
    const workflows = errorOf({ workflows: [{ path: "ci.yml", state: "active", enabled: true }] });
    expect(workflows).toContain('workflows[ci.yml]: declares "enabled"');
    expect(workflows).toContain("send no payload");
  });

  test("open sections still pass extra keys through", () => {
    const doc = {
      collaborators: [{ username: "alice", permission: "admin" }],
      milestones: [{ title: "v1", due_on: "2027-01-01T00:00:00Z" }],
      labels: [{ name: "bug", extra_field: true }],
    };
    expect(validateSectionShapes(doc, "f.yml")).toEqual({ settings: doc });
  });
});

describe("the wrapped undeclared-policy form", () => {
  test("both policies and the bare wrapper validate on every knobbed section", () => {
    const doc = {
      labels: { undeclared: "keep", entries: [{ name: "bug" }] },
      autolinks: { undeclared: "keep", entries: [{ key_prefix: "J-", url_template: "u" }] },
      collaborators: { entries: [{ username: "alice" }] },
      rulesets: { undeclared: "delete", entries: [{ name: "r" }] },
      milestones: { undeclared: "delete", entries: [{ title: "v1" }] },
    };
    expect<unknown>(validateSectionShapes(doc, "f.yml")).toEqual({ settings: doc });
  });

  test("wrapper typos fail upfront: an unknown wrapper key and a bad policy value", () => {
    // The wrapper is this action's own strict vocabulary; unlike entry
    // passthrough fields, its extra keys have nowhere to go.
    const unknownKey = errorOf({ labels: { entires: [{ name: "bug" }] } });
    expect(unknownKey).toContain('"entires"');
    const badPolicy = errorOf({ milestones: { undeclared: "detele", entries: [] } });
    expect(badPolicy).toContain("milestones.undeclared");
  });

  test("entry paths keep their precision inside the wrapper", () => {
    const error = errorOf({
      rulesets: { entries: [{ name: "r", conditions: { ref_name: { include: "main" } } }] },
    });
    expect(error).toContain("rulesets.entries[0].conditions.ref_name.include");
  });

  test("closed-surface entry checks see through the wrapper (collaborators)", () => {
    const error = errorOf({
      collaborators: { undeclared: "keep", entries: [{ username: "alice", permision: "x" }] },
    });
    expect(error).toContain('collaborators[alice]: declares "permision"');
  });
});
