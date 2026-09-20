import { describe, expect, test } from "bun:test";
import {
  type Delta,
  deltas,
  phantomKeys,
  phantomNote,
  refuseOmitted,
  renderDelta,
  subsetDiff,
} from "../../src/engine/diff.js";

describe("deltas", () => {
  test("structures every divergence of an object: scalar mismatch, absent key, nested path, and the tolerated empties", () => {
    const desired = {
      a: 1,
      gone: "x",
      nested: { b: "y", deeper: { c: true } },
      empty: "",
      nil: null,
      list: [1],
    };
    const live = { a: 2, nested: { b: "z", deeper: {} }, empty: null, extra: 1, list: "no" };
    expect(deltas(desired, live)).toEqual([
      { kind: "mismatch", path: ["a"], desired: 1, live: 2 },
      { kind: "phantom", path: ["gone"], desired: "x" },
      { kind: "mismatch", path: ["nested", "b"], desired: "y", live: "z" },
      { kind: "phantom", path: ["nested", "deeper", "c"], desired: true },
      { kind: "mismatch", path: ["list"], desired: [1], live: "no" },
    ]);
  });

  test.each<[name: string, delta: Delta, line: string]>([
    ["scalar mismatch", { kind: "mismatch", path: ["a"], desired: 1, live: 2 }, "x.a: 1 != 2"],
    [
      "object where live has a scalar",
      { kind: "mismatch", path: ["o"], desired: { k: 1 }, live: 3 },
      "x.o: expected object, live has 3",
    ],
    [
      "list where live has none",
      { kind: "mismatch", path: [], desired: [1], live: null },
      "x: expected list, live has null",
    ],
    [
      "declared empty, live filled",
      { kind: "mismatch", path: ["e"], desired: null, live: "v" },
      'x.e: expected empty, live has "v"',
    ],
    [
      "phantom scalar",
      { kind: "phantom", path: ["colr"], desired: "ff0000" },
      'x.colr: declared "ff0000" but the API response has no such field (new or write-only field?)',
    ],
    [
      "phantom object",
      { kind: "phantom", path: ["o"], desired: {} },
      "x.o: expected object, live has undefined",
    ],
    [
      "missing keyed item",
      { kind: "missing", path: ["rules", { key: "deletion" }], desired: {}, match: "key" },
      "x.rules[deletion]: missing live",
    ],
    [
      "undeclared keyed item",
      { kind: "undeclared", path: ["rules", { key: "update" }], live: {}, match: "key" },
      "x.rules[update]: present live but not declared",
    ],
    [
      "missing shape item",
      { kind: "missing", path: ["actors", 1], desired: { id: 2 }, match: "shape" },
      'x.actors[1]: no matching live entry for {"id":2}',
    ],
    [
      "undeclared shape item",
      { kind: "undeclared", path: ["actors"], live: { id: 9 }, match: "shape" },
      'x.actors: live entry not declared: {"id":9}',
    ],
    [
      "missing value",
      { kind: "missing", path: ["topics"], desired: "a", match: "value" },
      'x.topics: missing "a"',
    ],
    [
      "undeclared value",
      { kind: "undeclared", path: ["topics"], live: "c", match: "value" },
      'x.topics: unexpected "c"',
    ],
    [
      "omitted list",
      { kind: "omitted", path: ["bypass_actors"], live: [{ actor_id: 5 }], nullable: false },
      'x.bypass_actors: live has [{"actor_id":5}] but the settings file omits it, so apply would REMOVE it; declare bypass_actors to keep it, or bypass_actors: [] to remove it on purpose',
    ],
    [
      "omitted nested flag",
      {
        kind: "omitted",
        path: ["rules", { key: "pull_request" }, "parameters", "strict"],
        live: true,
        nullable: false,
      },
      "x.rules[pull_request].parameters.strict: live has true but the settings file omits it, so apply would REMOVE it; declare rules[pull_request].parameters.strict to keep it, or rules[pull_request].parameters.strict: false to remove it on purpose",
    ],
    [
      "omitted object whose slice refuses null, so no clearing value is offered",
      {
        kind: "omitted",
        path: ["deployment_branch_policy"],
        live: { protected_branches: true },
        nullable: false,
      },
      'x.deployment_branch_policy: live has {"protected_branches":true} but the settings file omits it, so apply would REMOVE it; declare deployment_branch_policy to keep it',
    ],
    [
      "omitted object whose slice accepts null, which is its clearing spelling",
      {
        kind: "omitted",
        path: ["deployment_branch_policy"],
        live: { protected_branches: true },
        nullable: true,
      },
      'x.deployment_branch_policy: live has {"protected_branches":true} but the settings file omits it, so apply would REMOVE it; declare deployment_branch_policy to keep it, or deployment_branch_policy: null to remove it on purpose',
    ],
    [
      "omitted number",
      { kind: "omitted", path: ["wait_timer"], live: 5, nullable: false },
      "x.wait_timer: live has 5 but the settings file omits it, so apply would REMOVE it; declare wait_timer to keep it, or wait_timer: 0 to remove it on purpose",
    ],
    [
      "omitted string, outside every enum when emptied, so no clearing value is offered",
      { kind: "omitted", path: ["enforcement"], live: "active", nullable: false },
      'x.enforcement: live has "active" but the settings file omits it, so apply would REMOVE it; declare enforcement to keep it',
    ],
  ])("renders a %s delta as its drift line", (_name, delta, line) => {
    expect(renderDelta("x", delta)).toBe(line);
  });

  test("a declared matchBy pairs a list by its key at any type multiplicity, and the pairing is exact", () => {
    const desired = {
      reviewers: [
        { type: "User", id: 1 },
        { type: "User", id: 2 },
      ],
    };
    const live = {
      reviewers: [
        { type: "User", id: 2 },
        { type: "User", id: 1, extra: true },
      ],
    };
    // Repeated types defeat the legacy sniffing (shape pairing still matches here)...
    expect(deltas(desired, live)).toEqual([]);
    // ...and a declared key pairs by id, so a divergent field under a paired id is a mismatch.
    const drifted = {
      reviewers: [
        { type: "User", id: 1 },
        { type: "Team", id: 2 },
      ],
    };
    expect(deltas(drifted, live, { matchBy: { reviewers: "id" } })).toEqual([
      {
        kind: "mismatch",
        path: ["reviewers", { key: "2" }, "type"],
        desired: "Team",
        live: "User",
      },
    ]);
  });

  test("a composite matchBy pairs an item by its fields together: a changed bypass_mode is ONE mismatch on that actor, and an actor without an id pairs on its type alone", () => {
    const desired = {
      bypass_actors: [
        { actor_id: 1, actor_type: "Team", bypass_mode: "always" },
        { actor_type: "DeployKey", bypass_mode: "always" },
      ],
    };
    const live = {
      bypass_actors: [
        { actor_id: null, actor_type: "DeployKey", bypass_mode: "always" },
        { actor_id: 1, actor_type: "Team", bypass_mode: "pull_request" },
      ],
    };
    const opts = { matchBy: { bypass_actors: ["actor_type", "actor_id"] } };
    expect(deltas(desired, live, opts)).toEqual([
      {
        kind: "mismatch",
        path: ["bypass_actors", { key: "Team 1" }, "bypass_mode"],
        desired: "always",
        live: "pull_request",
      },
    ]);
    // Without the composite key the same change reads as two false lines, a missing actor and an undeclared one.
    expect(deltas(desired, live, { matchBy: {} }).map((d) => renderDelta("x", d))).toEqual([
      'x.bypass_actors[0]: no matching live entry for {"actor_id":1,"actor_type":"Team","bypass_mode":"always"}',
      'x.bypass_actors: live entry not declared: {"actor_id":1,"actor_type":"Team","bypass_mode":"pull_request"}',
    ]);
    expect(() =>
      deltas({ items: [{ nope: 1 }] }, { items: [] }, { matchBy: { items: ["a", "b"] } }),
    ).toThrow(/list "items" by "a", "b", but a desired item carries no such key/);
  });

  test("with matchBy declared, an undeclared list never sniffs a type key: unique types pair by shape", () => {
    const desired = { rules: [{ type: "deletion", extra: 1 }] };
    const live = { rules: [{ type: "deletion" }, { type: "update" }] };
    expect(subsetDiff(desired, live, "x")).toEqual([
      "x.rules[deletion].extra: declared 1 but the API response has no such field (new or write-only field?)",
      "x.rules[update]: present live but not declared",
    ]);
    expect(deltas(desired, live, { matchBy: {} }).map((d) => renderDelta("x", d))).toEqual([
      'x.rules[0]: no matching live entry for {"type":"deletion","extra":1}',
      'x.rules: live entry not declared: {"type":"deletion"}',
      'x.rules: live entry not declared: {"type":"update"}',
    ]);
  });

  test.each<[defect: string, desired: unknown, live: unknown, message: RegExp]>([
    ["a live item without the key", [{ id: 1 }], [{ nope: 1 }], /live item carries no such key/],
    ["a desired item without the key", [{ nope: 1 }], [], /desired item carries no such key/],
    ["a repeated live key", [{ id: 1 }], [{ id: 1 }, { id: 1 }], /live list repeats "1"/],
    ["a repeated desired key", [{ id: 1 }, { id: 1 }], [], /declared list repeats "1"/],
  ])(
    "a matchBy list with %s is a declaration bug, named by list and key",
    (_defect, desired, live, message) => {
      expect(() =>
        deltas({ items: desired }, { items: live }, { matchBy: { items: "id" } }),
      ).toThrow(message);
      expect(() =>
        deltas({ items: desired }, { items: live }, { matchBy: { items: "id" } }),
      ).toThrow(/list "items" by "id"/);
    },
  );
});

describe("replace-style writes", () => {
  test("every non-empty live value the declaration omits is an omitted delta, at any depth and inside paired list items; GitHub's zero values (null, an empty list, mapping, or string, 0, false, a holder of empty lists) are not", () => {
    const desired = {
      name: "main",
      conditions: { ref_name: { include: ["~ALL"] } },
      rules: [{ type: "pull_request", parameters: { required_approving_review_count: 1 } }],
      bypass_actors: [{ actor_id: 1, actor_type: "Team" }],
    };
    const live = {
      name: "main",
      enforcement: "active",
      conditions: { ref_name: { include: ["~ALL"], exclude: ["refs/heads/wip"] } },
      rules: [
        {
          type: "pull_request",
          parameters: {
            required_approving_review_count: 1,
            require_code_owner_review: true,
            dismiss_stale_reviews_on_push: false,
          },
        },
      ],
      bypass_actors: [{ actor_id: 1, actor_type: "Team", bypass_mode: "pull_request" }],
      zero: 0,
      off: false,
      blank: "",
      none: null,
      nothing: [],
      bare: {},
      holder: { users: [], teams: [], apps: [] },
    };
    const matchBy = { rules: "type" };
    expect(deltas(desired, live, { matchBy, replace: { passthrough: [], nullable: [] } })).toEqual([
      {
        kind: "omitted",
        path: ["conditions", "ref_name", "exclude"],
        live: ["refs/heads/wip"],
        nullable: false,
      },
      {
        kind: "omitted",
        path: ["rules", { key: "pull_request" }, "parameters", "require_code_owner_review"],
        live: true,
        nullable: false,
      },
      {
        kind: "omitted",
        path: ["bypass_actors", 0, "bypass_mode"],
        live: "pull_request",
        nullable: false,
      },
      { kind: "omitted", path: ["enforcement"], live: "active", nullable: false },
    ]);
    // GitHub fills defaults inside a passthrough path, so the sweep skips it, an omitted passthrough key included,
    // while the typed list key holding passthrough items still counts.
    const passthrough = ["rules[].parameters", "bypass_actors[]"];
    expect(deltas(desired, live, { matchBy, replace: { passthrough, nullable: [] } })).toEqual([
      {
        kind: "omitted",
        path: ["conditions", "ref_name", "exclude"],
        live: ["refs/heads/wip"],
        nullable: false,
      },
      { kind: "omitted", path: ["enforcement"], live: "active", nullable: false },
    ]);
    expect(
      deltas(
        { name: "main", rules: [{ type: "pull_request" }] },
        {
          name: "main",
          rules: [{ type: "pull_request", parameters: { allowed_merge_methods: ["merge"] } }],
          bypass_actors: [{ actor_id: 1 }],
        },
        { matchBy, replace: { passthrough, nullable: [] } },
      ),
    ).toEqual([
      { kind: "omitted", path: ["bypass_actors"], live: [{ actor_id: 1 }], nullable: false },
    ]);
    // Without `replace` the same pair is clean: declared keys only.
    expect(deltas(desired, live, { matchBy })).toEqual([]);
  });

  test("refuseOmitted is nothing without omitted lines, and otherwise a hook that throws them as one failure", () => {
    expect(refuseOmitted("rulesets[main]", [])).toBeUndefined();
    const one = refuseOmitted("rulesets[main]", ["rulesets[main].bypass_actors: live has [1]"]);
    expect(one).toThrow(
      "rulesets[main]: not applied - the update would remove a live value the settings file omits. rulesets[main].bypass_actors: live has [1]",
    );
    const two = refuseOmitted("environments[prod]", ["a line", "another line"]);
    expect(two).toThrow(
      "environments[prod]: not applied - the update would remove live values the settings file omits. a line another line",
    );
  });
});

describe("subsetDiff", () => {
  test.each<[branch: string, desired: unknown, live: unknown, lines: string[]]>([
    [
      "object where live is a scalar",
      { o: { k: 1 } },
      { o: 3 },
      ["x.o: expected object, live has 3"],
    ],
    [
      "object where live is absent",
      { o: { k: 1 } },
      {},
      ["x.o: expected object, live has undefined"],
    ],
    ["list where live is a scalar", { l: [1] }, { l: "no" }, ['x.l: expected list, live has "no"']],
    ["list where live is absent", { l: [1] }, {}, ["x.l: expected list, live has undefined"]],
    ["declared null, live filled", { e: null }, { e: "v" }, ['x.e: expected empty, live has "v"']],
    [
      "absent scalar",
      { colr: "ff0000" },
      {},
      [
        'x.colr: declared "ff0000" but the API response has no such field (new or write-only field?)',
      ],
    ],
    [
      "keyed missing entry",
      { rules: [{ type: "a" }] },
      { rules: [] },
      ["x.rules[a]: missing live"],
    ],
    [
      "keyed entry with a nested mismatch",
      { rules: [{ type: "a", p: 1 }] },
      { rules: [{ type: "a", p: 2 }] },
      ["x.rules[a].p: 1 != 2"],
    ],
    [
      "shape-matched list, missing and leftover",
      { actors: [{ id: 1 }, { id: 2 }] },
      { actors: [{ id: 2 }, { id: 3 }] },
      [
        'x.actors[0]: no matching live entry for {"id":1}',
        'x.actors: live entry not declared: {"id":3}',
      ],
    ],
    [
      "scalar list, both directions",
      { t: ["a", "b"] },
      { t: ["b", "c"] },
      ['x.t: missing "a"', 'x.t: unexpected "c"'],
    ],
    [
      "scalar list, repeated values count once",
      { t: ["a", "a"] },
      { t: ["c", "c"] },
      ['x.t: missing "a"', 'x.t: unexpected "c"'],
    ],
    ["undeclared live key, ignored", { a: 1 }, { a: 1, b: 2 }, []],
    ["empty string against live null, tolerated", { d: "" }, { d: null }, []],
    [
      "root-level type-keyed list, reordered",
      [{ type: "deletion" }, { type: "update" }],
      [{ type: "update" }, { type: "deletion" }],
      [],
    ],
  ])("renders the %s branch", (_branch, desired, live, lines) => {
    expect(subsetDiff(desired, live, "x")).toEqual(lines);
  });
});

describe("phantomNote", () => {
  test.each<[keys: string[], line: string]>([
    [
      ["colr"],
      'labels[bug]: declared key "colr" does not exist on the live label, so if GitHub ignores it this update will re-run on every apply without converging. Fix the key name, or remove it from the settings file',
    ],
    [
      ["colr", "descr"],
      'labels[bug]: declared keys "colr", "descr" do not exist on the live label, so if GitHub ignores them this update will re-run on every apply without converging. Fix the key name, or remove it from the settings file',
    ],
  ])("%j reads with its noun, verb, and pronoun agreed to the count", (keys, line) => {
    expect(phantomNote("labels[bug]", keys, "label", "this update will re-run")).toBe(line);
  });
});

describe("phantomKeys", () => {
  test("names declared keys the live object does not carry", () => {
    expect(phantomKeys({ colr: "ff0000", description: "x" }, { description: "x" })).toEqual([
      "colr",
    ]);
  });
  test("excludes null and empty-string values (deltas tolerates them)", () => {
    expect(phantomKeys({ a: null, b: "", c: undefined }, {})).toEqual([]);
  });
  test("a live key holding any value is not phantom, even when it differs", () => {
    expect(phantomKeys({ state: "open" }, { state: "closed" })).toEqual([]);
    expect(phantomKeys({ state: "open" }, { state: null })).toEqual([]);
  });
  test("a non-object live value yields nothing", () => {
    expect(phantomKeys({ a: 1 }, null)).toEqual([]);
    expect(phantomKeys({ a: 1 }, [])).toEqual([]);
  });
  test("a phantom nested under a declared object, or inside a keyed item, is named by its dotted path, so the never-converges note covers it", () => {
    const desired = {
      security_and_analysis: { secret_scanning_ai_detection: { status: "enabled" } },
      rules: [{ type: "deletion", extra: 1 }],
    };
    const live = { security_and_analysis: {}, rules: [{ type: "deletion" }] };
    expect(phantomKeys(desired, live)).toEqual([
      "security_and_analysis.secret_scanning_ai_detection",
      "rules[deletion].extra",
    ]);
  });
});
