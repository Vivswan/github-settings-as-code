import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../src/engine/validate.js";

describe("section shape validation", () => {
  test("pages: null passes; a bad workflows state fails naming the path", () => {
    expect(validateSectionShapes({ pages: null }, "f.yml")).toBeNull();
    const error = validateSectionShapes(
      { workflows: [{ path: "ci.yml", state: "paused" }] },
      "f.yml",
    );
    expect(error).toContain("workflows[0].state");
  });

  test("the fields handlers dereference are shape-checked, naming the key path", () => {
    // A missing "-" makes include a string; the handler would call .map on it.
    const include = validateSectionShapes(
      { rulesets: [{ name: "protect-main", conditions: { ref_name: { include: "main" } } }] },
      "f.yml",
    );
    expect(include).toContain("rulesets[0].conditions.ref_name.include");
    // YAML parses new_name: 2.0 as a number; the handler lowercases it.
    const rename = validateSectionShapes({ labels: [{ name: "v2", new_name: 2 }] }, "f.yml");
    expect(rename).toContain("labels[0].new_name");
    // The handler reads source.path, which throws on source: null.
    const source = validateSectionShapes({ pages: { source: null } }, "f.yml");
    expect(source).toContain("pages.source");
    // The happy shapes still pass, unknown keys still flow through.
    expect(
      validateSectionShapes(
        {
          rulesets: [{ name: "r", conditions: { ref_name: { include: ["main"] } }, future: 1 }],
          labels: [{ name: "v2", new_name: "2.0" }],
          pages: { source: { branch: "main" }, future_field: true },
        },
        "f.yml",
      ),
    ).toBeNull();
  });
});

describe("closed-surface sections reject unrecognized entry keys upfront", () => {
  test("a misspelled collaborator permission fails validation, before any write", () => {
    const error = validateSectionShapes(
      { collaborators: [{ username: "alice", permision: "admin" }] },
      "f.yml",
    );
    expect(error).toContain('collaborators[alice]: declares "permision"');
    expect(error).toContain("known keys: username, permission");
    expect(error).toContain('default "push" role');
  });

  test("teams and workflows are closed too", () => {
    const teams = validateSectionShapes({ teams: [{ name: "t", permissions: "admin" }] }, "f.yml");
    expect(teams).toContain('teams[t]: declares "permissions"');
    const workflows = validateSectionShapes(
      { workflows: [{ path: "ci.yml", state: "active", enabled: true }] },
      "f.yml",
    );
    expect(workflows).toContain('workflows[ci.yml]: declares "enabled"');
    expect(workflows).toContain("send no payload");
  });

  test("open sections still pass extra keys through", () => {
    expect(
      validateSectionShapes(
        {
          collaborators: [{ username: "alice", permission: "admin" }],
          milestones: [{ title: "v1", due_on: "2027-01-01T00:00:00Z" }],
          labels: [{ name: "bug", future_field: true }],
        },
        "f.yml",
      ),
    ).toBeNull();
  });
});

describe("the wrapped undeclared-policy form", () => {
  test("both policies and the bare wrapper validate on every knobbed section", () => {
    expect(
      validateSectionShapes(
        {
          labels: { undeclared: "keep", entries: [{ name: "bug" }] },
          autolinks: { undeclared: "keep", entries: [{ key_prefix: "J-", url_template: "u" }] },
          collaborators: { entries: [{ username: "alice" }] },
          rulesets: { undeclared: "delete", entries: [{ name: "r" }] },
          milestones: { undeclared: "delete", entries: [{ title: "v1" }] },
        },
        "f.yml",
      ),
    ).toBeNull();
  });

  test("wrapper typos fail upfront: an unknown wrapper key and a bad policy value", () => {
    // The wrapper is this action's own strict vocabulary; unlike entry
    // passthrough fields, its extra keys have nowhere to go.
    const unknownKey = validateSectionShapes({ labels: { entires: [{ name: "bug" }] } }, "f.yml");
    expect(unknownKey).toContain('"entires"');
    const badPolicy = validateSectionShapes(
      { milestones: { undeclared: "detele", entries: [] } },
      "f.yml",
    );
    expect(badPolicy).toContain("milestones.undeclared");
  });

  test("entry paths keep their precision inside the wrapper", () => {
    const error = validateSectionShapes(
      { rulesets: { entries: [{ name: "r", conditions: { ref_name: { include: "main" } } }] } },
      "f.yml",
    );
    expect(error).toContain("rulesets.entries[0].conditions.ref_name.include");
  });

  test("closed-surface entry checks see through the wrapper (collaborators)", () => {
    const error = validateSectionShapes(
      { collaborators: { undeclared: "keep", entries: [{ username: "alice", permision: "x" }] } },
      "f.yml",
    );
    expect(error).toContain('collaborators[alice]: declares "permision"');
  });
});
