import { describe, expect, test } from "bun:test";
import { err, ok } from "neverthrow";
import { type Layer, type Layering, mergeLayers, stripNulls } from "../../src/engine/layers.js";
import { validateSettingsDoc } from "../../src/engine/orchestrate.js";
import { silentIo } from "../../src/io.js";
import { describeProblem, type LayerProblem } from "../../src/problem.js";
import { planContext } from "../../src/sections/contract/plan.js";
import { labelsSection } from "../../src/sections/labels/index.js";
import { MockApi } from "../mock-api.js";
import { REPO } from "../sections/section-run.js";

/** Frozen to the leaves: a fold step that touched an input would throw, so every test also pins that inputs are never mutated. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function layer(name: string, doc: unknown): Layer {
  return { name, doc: deepFreeze(doc) };
}

function merge(layers: Layer[], layering: Layering = "merge") {
  return mergeLayers(layers, { layering }).match(
    (folded) => folded,
    (problem) => ({ code: problem.code, error: describeProblem(problem) }),
  );
}

const MAIN_RULESET = {
  name: "main",
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  rules: [
    { type: "deletion" },
    {
      type: "pull_request",
      parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true },
    },
  ],
};

describe("mergeLayers: the mapping dialect", () => {
  test("a single layer passes through", () => {
    const doc = { repository: { has_wiki: false }, pages: { build_type: "workflow" } };
    expect(merge([layer("fleet", doc)])).toEqual({ settings: doc, notices: [] });
  });

  test("mappings merge key by key with the higher layer winning; higher-only sections ride along", () => {
    const result = merge([
      layer("fleet", { repository: { has_wiki: false, description: "fleet", topics: "a" } }),
      layer("repo", {
        repository: { description: "mine", has_issues: true },
        pages: { build_type: "workflow" },
      }),
    ]);
    expect(result).toEqual({
      settings: {
        repository: { has_wiki: false, description: "mine", topics: "a", has_issues: true },
        pages: { build_type: "workflow" },
      },
      notices: [],
    });
  });

  test("a higher null deletes a lower declaration at the top level and nested, with a notice each", () => {
    const result = merge([
      layer("fleet", {
        repository: { has_wiki: false, description: "fleet" },
        pages: { build_type: "workflow" },
        actions: { enabled: true },
      }),
      layer("repo", { pages: null, repository: { description: null } }),
    ]);
    expect(result).toEqual({
      settings: { repository: { has_wiki: false }, actions: { enabled: true } },
      notices: [
        { layer: "repo", path: "pages" },
        { layer: "repo", path: "repository.description" },
      ],
    });
  });

  test("the top layer beats everything, re-declaring a key a middle layer nulled", () => {
    const result = merge([
      layer("fleet", { pages: { build_type: "workflow" } }),
      layer("team", { pages: null }),
      layer("repo", { pages: { build_type: "legacy" } }),
    ]);
    expect(result).toEqual({
      settings: { pages: { build_type: "legacy" } },
      notices: [{ layer: "team", path: "pages" }],
    });
  });

  test.each([
    ["nothing below", [layer("repo", { pages: null })]],
    [
      "a null below, which declares nothing",
      [layer("fleet", { pages: null }), layer("repo", { pages: null })],
    ],
  ])("a null over %s stays as written with no notice", (_case, layers) => {
    expect(merge(layers)).toEqual({ settings: { pages: null }, notices: [] });
  });

  test("arrays outside the keyed sections replace wholesale, whatever the run layering", () => {
    const layers = [
      layer("fleet", {
        autolinks: [{ key_prefix: "F-", url_template: "https://f/<num>" }],
        branches: [{ name: "main", protection: { enforce_admins: true } }],
        repository: { topics: ["fleet", "shared"] },
      }),
      layer("repo", {
        autolinks: [{ key_prefix: "R-", url_template: "https://r/<num>" }],
        branches: [{ name: "release", protection: null }],
        repository: { topics: ["mine"] },
      }),
    ];
    const expected = {
      settings: {
        autolinks: {
          _undeclared: "delete",
          entries: [{ key_prefix: "R-", url_template: "https://r/<num>" }],
        },
        branches: [{ name: "release", protection: null }],
        repository: { topics: ["mine"] },
      },
      notices: [],
    };
    expect(merge(layers, "merge")).toEqual(expected);
    expect(merge(layers, "replace")).toEqual(expected);
  });

  test("a nested key called labels or rulesets below the top level is plain data", () => {
    const result = merge([
      layer("fleet", { actions: { labels: [{ name: "a" }], rulesets: { fleet: 1 } } }),
      layer("repo", { actions: { labels: [{ name: "b" }] } }),
    ]);
    expect(result).toEqual({
      settings: { actions: { labels: [{ name: "b" }], rulesets: { fleet: 1 } } },
      notices: [],
    });
  });

  test.each([
    ["a Date", new Date(0)],
    ["a raw list", ["a", "b"]],
    ["a scalar", "oops"],
  ])("%s at the top level passes through for validation to name", (_kind, doc) => {
    expect(merge([layer("fleet", { labels: [{ name: "fleet" }] }), layer("repo", doc)])).toEqual({
      settings: doc,
      notices: [],
    });
  });

  test("a mapping over a non-mapping replaces it", () => {
    expect(
      merge([layer("fleet", ["a"]), layer("repo", { repository: { has_wiki: false } })]),
    ).toEqual({
      settings: { repository: { has_wiki: false } },
      notices: [],
    });
  });

  test("inputs are never mutated", () => {
    const fleet = {
      repository: { has_wiki: false, description: "fleet" },
      labels: [{ name: "bug", color: "d73a4a" }],
      rulesets: [MAIN_RULESET],
    };
    const repo = {
      repository: { description: null },
      labels: [{ name: "Bug", color: "ffffff" }],
      rulesets: [{ name: "main", rules: [{ type: "non_fast_forward" }] }],
    };
    const copies = structuredClone({ fleet, repo });
    const result = merge([layer("fleet", fleet), layer("repo", repo)]);
    expect(result).toEqual({
      settings: {
        repository: { has_wiki: false },
        labels: { _undeclared: "delete", entries: [{ name: "Bug", color: "ffffff" }] },
        rulesets: {
          _undeclared: "keep",
          entries: [
            { ...MAIN_RULESET, rules: [...MAIN_RULESET.rules, { type: "non_fast_forward" }] },
          ],
        },
      },
      notices: [{ layer: "repo", path: "repository.description" }],
    });
    expect({ fleet, repo }).toEqual(copies);
  });

  test("a nested YAML-tagged value replaces a mapping and is replaced by one, never spread", () => {
    const layers = [
      layer("fleet", { actions: { since: { year: 1970 } }, pages: { cname: new Date(0) } }),
      layer("repo", { actions: { since: new Date(0) }, pages: { cname: { host: "x" } } }),
    ];
    expect(merge(layers)).toEqual({
      settings: { actions: { since: new Date(0) }, pages: { cname: { host: "x" } } },
      notices: [],
    });
  });

  test("keys named after Object.prototype members are ordinary document keys", () => {
    const proto = "__proto__";
    const below = { custom_properties: [{ property_name: "a" }], repository: {}, actions: {} };
    const above = JSON.parse(
      '{"repository": {"constructor": {"x": 1}, "__proto__": {"y": 2}}, "actions": {"constructor": null}}',
    );
    const result = merge([layer("fleet", below), layer("repo", above)]);
    expect(result).toEqual({
      settings: {
        custom_properties: { _undeclared: "keep", entries: [{ property_name: "a" }] },
        repository: { constructor: { x: 1 }, [proto]: { y: 2 } },
        actions: { constructor: null },
      },
      notices: [],
    });
    if ("error" in result) {
      throw new Error(result.error);
    }
    const repository = (result.settings as { repository: object }).repository;
    expect([Object.hasOwn(repository, proto), Object.getPrototypeOf(repository)]).toEqual([
      true,
      Object.prototype,
    ]);
  });
});

describe("mergeLayers: keyed sections", () => {
  test("labels union by name: a same-name entry is replaced wholesale, both sides' extras keep their order", () => {
    const result = merge([
      layer("fleet", {
        labels: [
          { name: "bug", color: "d73a4a", description: "Fleet bug" },
          { name: "docs", color: "0075ca", description: "Fleet docs" },
        ],
      }),
      layer("repo", {
        labels: [
          { name: "docs", color: "ffffff" },
          { name: "infra", color: "111111" },
        ],
      }),
    ]);
    expect(result).toEqual({
      settings: {
        labels: {
          _undeclared: "delete",
          entries: [
            { name: "bug", color: "d73a4a", description: "Fleet bug" },
            { name: "docs", color: "ffffff" },
            { name: "infra", color: "111111" },
          ],
        },
      },
      notices: [],
    });
  });

  test("label names match case-insensitively and the higher spelling wins", () => {
    const result = merge([
      layer("fleet", { labels: [{ name: "Bug", color: "d73a4a" }] }),
      layer("repo", { labels: [{ name: "bug", color: "ffffff" }] }),
    ]);
    expect(result).toEqual({
      settings: { labels: { _undeclared: "delete", entries: [{ name: "bug", color: "ffffff" }] } },
      notices: [],
    });
  });

  /** The labels planner over an empty repository rejects two entries claiming one label, so a merged document it plans is one apply accepts. */
  async function planLabels(entries: readonly Record<string, unknown>[]) {
    const api = new MockApi({ "GET /repos/o/r/labels?per_page=100&page=1": { data: [] } });
    const plan = await labelsSection.plan(
      planContext(labelsSection, api, REPO),
      entries as Parameters<typeof labelsSection.plan>[1],
    );
    return plan.ops.map((op) => op.describe);
  }

  test.each([
    [
      "the plain label above the rename",
      {
        lower: [{ name: "bug", new_name: "defect" }],
        higher: [{ name: "defect", color: "ffffff" }],
      },
      [{ name: "defect", color: "ffffff" }],
    ],
    [
      "the rename above the plain label",
      {
        lower: [{ name: "defect", color: "ffffff" }],
        higher: [{ name: "bug", new_name: "defect" }],
      },
      [{ name: "bug", new_name: "defect" }],
    ],
  ])(
    "a label renaming into a name another layer declares is one label, the higher entry (%s)",
    async (_order, { lower, higher }, entries) => {
      const result = merge([layer("fleet", { labels: lower }), layer("repo", { labels: higher })]);
      expect(result).toEqual({
        settings: { labels: { _undeclared: "delete", entries } },
        notices: [],
      });
      expect(await planLabels(entries)).toEqual(['creating label "defect"']);
    },
  );

  test("a higher entry claiming two lower labels supersedes both: the merged document is one entry", async () => {
    const result = merge([
      layer("fleet", { labels: [{ name: "defect" }, { name: "bug" }] }),
      layer("repo", { labels: [{ name: "Bug", new_name: "Defect" }] }),
    ]);
    const entries = [{ name: "Bug", new_name: "Defect" }];
    expect(result).toEqual({
      settings: { labels: { _undeclared: "delete", entries } },
      notices: [],
    });
    expect(await planLabels(entries)).toEqual(['creating label "Defect"']);
  });

  test.each([
    ["rename first", [{ name: "bug", new_name: "defect" }, { name: "docs" }]],
    ["rename last", [{ name: "docs" }, { name: "bug", new_name: "defect" }]],
  ])(
    "the result does not depend on the higher entries' order (%s): a lower rename two higher entries claim between them is superseded by both",
    async (_order, higher) => {
      const result = merge([
        layer("fleet", { labels: [{ name: "bug" }, { name: "docs", new_name: "defect" }] }),
        layer("repo", { labels: higher }),
      ]);
      const entries = [{ name: "bug", new_name: "defect" }, { name: "docs" }];
      expect(result).toEqual({
        settings: { labels: { _undeclared: "delete", entries } },
        notices: [],
      });
      expect(await planLabels(entries)).toEqual([
        'creating label "defect"',
        'creating label "docs"',
      ]);
    },
  );

  test("a higher rename onto an untouched lower label keeps the other lower labels distinct", async () => {
    const result = merge([
      layer("fleet", { labels: [{ name: "bug" }, { name: "docs" }] }),
      layer("repo", { labels: [{ name: "bug", new_name: "defect" }, { name: "infra" }] }),
    ]);
    const entries = [{ name: "bug", new_name: "defect" }, { name: "docs" }, { name: "infra" }];
    expect(result).toEqual({
      settings: { labels: { _undeclared: "delete", entries } },
      notices: [],
    });
    expect(await planLabels(entries)).toEqual([
      'creating label "defect"',
      'creating label "docs"',
      'creating label "infra"',
    ]);
  });

  test("same-name rulesets merge key by key; a partial higher ruleset keeps the lower conditions and rules append by type", () => {
    const result = merge([
      layer("fleet", { rulesets: [MAIN_RULESET] }),
      layer("repo", {
        rulesets: [
          { name: "main", enforcement: "evaluate", rules: [{ type: "required_signatures" }] },
        ],
      }),
    ]);
    expect(result).toEqual({
      settings: {
        rulesets: {
          _undeclared: "keep",
          entries: [
            {
              ...MAIN_RULESET,
              enforcement: "evaluate",
              rules: [...MAIN_RULESET.rules, { type: "required_signatures" }],
            },
          ],
        },
      },
      notices: [],
    });
  });

  test("a higher layer adds a rule type and replaces a same-type rule in place, wholesale", () => {
    const result = merge([
      layer("fleet", { rulesets: [MAIN_RULESET] }),
      layer("repo", {
        rulesets: [
          {
            name: "main",
            rules: [
              { type: "pull_request", parameters: { required_approving_review_count: 2 } },
              { type: "non_fast_forward" },
            ],
          },
        ],
      }),
    ]);
    expect(result).toEqual({
      settings: {
        rulesets: {
          _undeclared: "keep",
          entries: [
            {
              ...MAIN_RULESET,
              rules: [
                { type: "deletion" },
                { type: "pull_request", parameters: { required_approving_review_count: 2 } },
                { type: "non_fast_forward" },
              ],
            },
          ],
        },
      },
      notices: [],
    });
  });

  test("bypass_actors: null on a higher ruleset removes the lower key with a notice", () => {
    const bypass = [{ actor_id: 1, actor_type: "Team", bypass_mode: "always" }];
    const result = merge([
      layer("fleet", { rulesets: [{ ...MAIN_RULESET, bypass_actors: bypass }] }),
      layer("repo", { rulesets: [{ name: "main", bypass_actors: null }] }),
    ]);
    expect(result).toEqual({
      settings: { rulesets: { _undeclared: "keep", entries: [MAIN_RULESET] } },
      notices: [{ layer: "repo", path: "rulesets[0].bypass_actors" }],
    });
  });

  test("a notice names the entry by its index in the layer it names, not by its name or its lower slot", () => {
    const tags = { name: "tags", target: "tag" };
    const result = merge([
      layer("fleet", { rulesets: [tags, { ...MAIN_RULESET, bypass_actors: [{ actor_id: 1 }] }] }),
      layer("repo", { rulesets: [{ name: "main", bypass_actors: null }] }),
    ]);
    expect(result).toEqual({
      settings: { rulesets: { _undeclared: "keep", entries: [tags, MAIN_RULESET] } },
      notices: [{ layer: "repo", path: "rulesets[0].bypass_actors" }],
    });
  });

  test("higher-only rulesets append after the lower ones", () => {
    const result = merge([
      layer("fleet", { rulesets: [{ name: "main", rules: [{ type: "deletion" }] }] }),
      layer("repo", {
        rulesets: [
          { name: "tags", target: "tag" },
          { name: "main", enforcement: "active" },
        ],
      }),
    ]);
    expect(result).toEqual({
      settings: {
        rulesets: {
          _undeclared: "keep",
          entries: [
            { name: "main", rules: [{ type: "deletion" }], enforcement: "active" },
            { name: "tags", target: "tag" },
          ],
        },
      },
      notices: [],
    });
  });
});

describe("mergeLayers: the undeclared knob across layers", () => {
  const fleetKeep = layer("fleet", {
    labels: { _undeclared: "keep", entries: [{ name: "fleet" }] },
  });

  test.each([
    ["merge", { _undeclared: "keep", entries: [{ name: "fleet" }, { name: "mine" }] }],
    ["replace", { _undeclared: "keep", entries: [{ name: "mine" }] }],
  ] as const)(
    "a plain array inherits the lower wrapper's policy under the %s run default",
    (layering, labels) => {
      expect(merge([fleetKeep, layer("repo", { labels: [{ name: "mine" }] })], layering)).toEqual({
        settings: { labels },
        notices: [],
      });
    },
  );

  test("an explicit higher policy wins", () => {
    const result = merge([
      layer("fleet", { rulesets: [{ name: "fleet" }] }),
      layer("repo", { rulesets: { _undeclared: "delete", entries: [{ name: "mine" }] } }),
    ]);
    expect(result).toEqual({
      settings: {
        rulesets: { _undeclared: "delete", entries: [{ name: "fleet" }, { name: "mine" }] },
      },
      notices: [],
    });
  });

  test("a bare {entries} wrapper inherits like a plain array", () => {
    const result = merge([
      layer("fleet", { rulesets: { _undeclared: "delete", entries: [{ name: "fleet" }] } }),
      layer("repo", { rulesets: { entries: [{ name: "mine" }] } }),
    ]);
    expect(result).toEqual({
      settings: {
        rulesets: { _undeclared: "delete", entries: [{ name: "fleet" }, { name: "mine" }] },
      },
      notices: [],
    });
  });

  test("two plain arrays resolve to the section default, not each other's", () => {
    const result = merge([
      layer("fleet", { labels: [{ name: "fleet" }], milestones: [{ title: "v0" }] }),
      layer("repo", { labels: [{ name: "mine" }], milestones: [{ title: "v1" }] }),
    ]);
    expect(result).toEqual({
      settings: {
        labels: { _undeclared: "delete", entries: [{ name: "fleet" }, { name: "mine" }] },
        milestones: { _undeclared: "keep", entries: [{ title: "v1" }] },
      },
      notices: [],
    });
  });

  test("a knobbed section only a lower layer declares reaches the result resolved", () => {
    const result = merge([
      layer("fleet", { autolinks: [{ key_prefix: "J-", url_template: "u<num>" }] }),
      layer("repo", { repository: { has_wiki: false } }),
    ]);
    expect(result).toEqual({
      settings: {
        autolinks: {
          _undeclared: "delete",
          entries: [{ key_prefix: "J-", url_template: "u<num>" }],
        },
        repository: { has_wiki: false },
      },
      notices: [],
    });
  });

  test("policies resolve once after the fold, so a higher _undeclared: null over a plain array stays as written", () => {
    const result = merge([
      layer("fleet", { labels: [] }),
      layer("repo", { labels: { _undeclared: null, entries: [] } }),
    ]);
    expect(result).toEqual({
      settings: { labels: { _undeclared: null, entries: [] } },
      notices: [],
    });
  });

  test("_undeclared: null deletes the lower policy with a notice, and the default fills in", () => {
    const result = merge([
      fleetKeep,
      layer("repo", { labels: { _undeclared: null, entries: [] } }),
    ]);
    expect(result).toEqual({
      settings: { labels: { _undeclared: "delete", entries: [{ name: "fleet" }] } },
      notices: [{ layer: "repo", path: "labels._undeclared" }],
    });
  });
});

describe("mergeLayers: the _layering directive", () => {
  const fleet = layer("fleet", { labels: [{ name: "fleet" }], rulesets: [{ name: "fleet" }] });

  test.each([
    ["merge", "replace", [{ name: "mine" }]],
    ["replace", "merge", [{ name: "fleet" }, { name: "mine" }]],
  ] as const)(
    "under a %s run, a wrapper's _layering: %s overrides the run for its section alone",
    (run, directive, entries) => {
      const repo = layer("repo", { labels: { _layering: directive, entries: [{ name: "mine" }] } });
      expect(merge([fleet, repo], run)).toEqual({
        settings: {
          labels: { _undeclared: "delete", entries },
          rulesets: { _undeclared: "keep", entries: [{ name: "fleet" }] },
        },
        notices: [],
      });
    },
  );

  test("a lower layer's directive governs only its own step", () => {
    const result = merge([
      layer("fleet", {
        _layering: "replace",
        labels: { _layering: "replace", entries: [{ name: "fleet" }] },
      }),
      layer("repo", { labels: [{ name: "mine" }] }),
    ]);
    expect(result).toEqual({
      settings: {
        labels: { _undeclared: "delete", entries: [{ name: "fleet" }, { name: "mine" }] },
      },
      notices: [],
    });
  });

  test("a file-level _layering: replace, with one section's wrapper back to merge; the result carries no directive", () => {
    const result = merge([
      fleet,
      layer("repo", {
        _layering: "replace",
        labels: [{ name: "mine" }],
        rulesets: { _layering: "merge", entries: [{ name: "mine" }] },
      }),
    ]);
    expect(result).toEqual({
      settings: {
        labels: { _undeclared: "delete", entries: [{ name: "mine" }] },
        rulesets: { _undeclared: "keep", entries: [{ name: "fleet" }, { name: "mine" }] },
      },
      notices: [],
    });
  });

  test("a directive with nothing to combine leaves no trace", () => {
    expect(merge([layer("repo", { _layering: "replace" })])).toEqual({ settings: {}, notices: [] });
  });
});

describe("mergeLayers: layer-boundary refusals", () => {
  const fleet = layer("fleet", { labels: [{ name: "fleet" }], milestones: [{ title: "v0" }] });

  test.each<[string, unknown, LayerProblem["code"], string]>([
    [
      "a rule without a type",
      { rulesets: [{ name: "main", rules: [{ parameters: {} }] }] },
      "layer-no-key",
      'layer "repo": rulesets[0].rules[0] carries no string "type", which every entry needs to layer by',
    ],
    [
      "a duplicate rule type in one ruleset",
      { rulesets: [{ name: "main", rules: [{ type: "deletion" }, { type: "deletion" }] }] },
      "layer-duplicate-key",
      'layer "repo": rulesets[0].rules[0] and rulesets[0].rules[1] both claim one type; each type belongs to one entry within a layer',
    ],
    [
      "a non-mapping rule",
      { rulesets: [{ name: "main", rules: ["deletion"] }] },
      "layer-wrong-shape",
      'layer "repo": rulesets[0].rules[0] must be a mapping; got a string',
    ],
    [
      "a non-mapping rule in the second ruleset, after a mapping rule",
      { rulesets: [{ name: "tags" }, { name: "main", rules: [{ type: "deletion" }, 7] }] },
      "layer-wrong-shape",
      'layer "repo": rulesets[1].rules[1] must be a mapping; got a number',
    ],
    [
      "duplicate label names, case-folded",
      { labels: [{ name: "Bug" }, { name: "bug" }] },
      "layer-duplicate-key",
      'layer "repo": labels[0] and labels[1] both claim one name; each name belongs to one entry within a layer',
    ],
    [
      "a label renaming into a sibling's name in one layer",
      { labels: [{ name: "bug", new_name: "Defect" }, { name: "docs" }, { name: "defect" }] },
      "layer-duplicate-key",
      'layer "repo": labels[0] and labels[2] both claim one name; each name belongs to one entry within a layer',
    ],
    [
      "duplicate ruleset names",
      { rulesets: [{ name: "main" }, { name: "main" }] },
      "layer-duplicate-key",
      'layer "repo": rulesets[0] and rulesets[1] both claim one name; each name belongs to one entry within a layer',
    ],
    [
      "a nameless label",
      { labels: [{ name: "ok" }, { color: "ffffff" }] },
      "layer-no-key",
      'layer "repo": labels[1] carries no string "name", which every entry needs to layer by',
    ],
    [
      "a scalar where a list belongs",
      { labels: "oops" },
      "layer-wrong-shape",
      'layer "repo": labels must be a list of mappings or an {_undeclared, entries} wrapper; got a string',
    ],
    [
      "a wrapper without entries",
      { labels: { _undeclared: "keep" } },
      "layer-wrong-shape",
      'layer "repo": labels must be a list of mappings or an {_undeclared, entries} wrapper; got a mapping without an entries list',
    ],
    [
      "a YAML-tagged value where a list belongs",
      { milestones: new Date(0) },
      "layer-wrong-shape",
      'layer "repo": milestones must be a list of mappings or an {_undeclared, entries} wrapper; got a Date value',
    ],
    [
      "a non-mapping entry in a section without a layering key",
      { milestones: [{ title: "v1" }, "v2"] },
      "layer-wrong-shape",
      'layer "repo": milestones[1] must be a mapping; got a string',
    ],
    [
      "an invalid top-level directive",
      { _layering: "union", labels: [{ name: "mine" }] },
      "layer-bad-directive",
      'layer "repo": _layering must be "merge" or "replace"; got a string that is neither',
    ],
    [
      "an invalid wrapper directive",
      { labels: { _layering: "union", entries: [{ name: "mine" }] } },
      "layer-bad-directive",
      'layer "repo": labels._layering must be "merge" or "replace"; got a string that is neither',
    ],
    [
      "a non-string wrapper directive",
      { labels: { _layering: true, entries: [{ name: "mine" }] } },
      "layer-bad-directive",
      'layer "repo": labels._layering must be "merge" or "replace"; got a boolean',
    ],
    [
      "a wrapper merge directive on a section without a layering key",
      { milestones: { _layering: "merge", entries: [{ title: "v1" }] } },
      "layer-no-layering-key",
      'layer "repo": milestones has no layering key, so it cannot be layered by "merge"; declare _layering: replace or drop the directive',
    ],
    [
      "a file-level merge directive reaching a section without a layering key",
      { _layering: "merge", milestones: [{ title: "v1" }] },
      "layer-no-layering-key",
      'layer "repo": milestones has no layering key, so it cannot be layered by "merge"; declare _layering: replace or drop the directive',
    ],
  ])("%s is refused naming the layer", (_case, doc, code, error) => {
    expect(merge([fleet, layer("repo", doc)])).toEqual({ code, error });
    expect(merge([fleet, layer("repo", doc)], "replace")).toEqual({ code, error });
  });

  test("a section without a layering key merges under the run default without complaint", () => {
    expect(merge([fleet, layer("repo", { milestones: [{ title: "v1" }] })])).toEqual({
      settings: {
        labels: { _undeclared: "delete", entries: [{ name: "fleet" }] },
        milestones: { _undeclared: "keep", entries: [{ title: "v1" }] },
      },
      notices: [],
    });
  });

  test("no refusal, of any kind, echoes a value or key taken from the document", () => {
    // Every identity, malformed value, and private key below holds the marker; the recognized keys (labels, color) are structure the prose may name.
    const M = "ZZ_MARKER";
    const cyclic: Record<string, unknown> = { [M]: M };
    cyclic[`${M}_self`] = cyclic;
    const shaped: [string, unknown, LayerProblem["code"], string][] = [
      [
        "a scalar section",
        { labels: M },
        "layer-wrong-shape",
        'layer "repo": labels must be a list of mappings or an {_undeclared, entries} wrapper; got a string',
      ],
      [
        "a wrapper without entries",
        { labels: { _undeclared: M, [M]: M } },
        "layer-wrong-shape",
        'layer "repo": labels must be a list of mappings or an {_undeclared, entries} wrapper; got a mapping without an entries list',
      ],
      [
        "a scalar entry",
        { rulesets: [{ name: M, rules: [M] }] },
        "layer-wrong-shape",
        'layer "repo": rulesets[0].rules[0] must be a mapping; got a string',
      ],
      [
        "a directive that is a marker",
        { labels: { _layering: M, entries: [{ name: M }] } },
        "layer-bad-directive",
        'layer "repo": labels._layering must be "merge" or "replace"; got a string that is neither',
      ],
    ];
    const kinded: [string, unknown][] = [
      ["a top-level directive that is a marker", { _layering: M, labels: [{ name: M }] }],
      [
        "a merge directive on a section without a layering key",
        { milestones: { _layering: "merge", entries: [{ title: M }] } },
      ],
      ["an entry without its key", { labels: [{ color: M, [M]: M }] }],
      ["two entries claiming one key", { labels: [{ name: M }, { name: M.toLowerCase() }] }],
      ["a cycle", { repository: cyclic }],
    ];
    for (const [, doc, code, error] of shaped) {
      expect(merge([fleet, layer("repo", doc)])).toEqual({ code, error });
    }
    for (const [name, doc] of [...shaped, ...kinded]) {
      const result = merge([fleet, layer("repo", doc)]);
      if (!("error" in result)) {
        throw new Error(`expected a refusal for ${name}`);
      }
      expect(result.error.toLowerCase()).not.toContain(M.toLowerCase());
    }
  });
});

/** A cyclic document: a section aliased inside itself, with a marker null beside the alias. */
function cyclicMapping(): Record<string, unknown> {
  const repository: Record<string, unknown> = { description: "x", homepage: null };
  repository.self = repository;
  return { repository };
}

/** A cyclic document through a list: a ruleset's rules list holds the ruleset. */
function cyclicList(): Record<string, unknown> {
  const rules: unknown[] = [{ type: "deletion" }];
  const ruleset = { name: "main", rules };
  rules.push(ruleset);
  return { rulesets: [ruleset] };
}

describe("mergeLayers: cyclic documents", () => {
  const fleet = layer("fleet", { repository: { description: "fleet" } });

  test.each([
    ["a mapping", cyclicMapping],
    ["a list", cyclicList],
  ])(
    "a layer that includes itself through %s is refused by name, before any merge",
    (_kind, make) => {
      const refused = {
        code: "layer-cycle" as const,
        error:
          'layer "repo": the document contains a reference cycle (a YAML anchor that includes itself); layers must be trees',
      };
      expect(merge([fleet, layer("repo", make())])).toEqual(refused);
      expect(merge([layer("repo", make()), fleet])).toEqual(refused);
    },
  );

  test("a node aliased twice without enclosing itself is a tree and merges", () => {
    const shared = { has_wiki: false, extra: null };
    const result = merge([
      fleet,
      layer("repo", { repository: shared, actions: { nested: shared, list: [shared, shared] } }),
    ]);
    expect(result).toEqual({
      settings: {
        repository: { description: "fleet", has_wiki: false, extra: null },
        actions: {
          nested: { has_wiki: false, extra: null },
          list: [
            { has_wiki: false, extra: null },
            { has_wiki: false, extra: null },
          ],
        },
      },
      notices: [],
    });
  });
});

describe("stripNulls", () => {
  test("drops the nulls the merge reads as markers and keeps the nulls it copies as data", () => {
    const doc = deepFreeze({
      a: null,
      b: { c: null, d: 1, e: { f: null } },
      list: [null, { g: null }],
      branches: [null, { name: "release", protection: null }],
      labels: { _undeclared: null, entries: [{ name: "bug", description: null }] },
      milestones: { _undeclared: null, entries: [{ title: "v1", due_on: null }] },
      rulesets: [
        null,
        {
          name: "main",
          bypass_actors: null,
          conditions: { ref_name: { include: null, exclude: [] } },
          rules: [null, { type: "pull_request", parameters: null }],
        },
      ],
      zero: 0,
    });
    expect(stripNulls(doc)).toEqual({
      b: { d: 1, e: {} },
      list: [null, { g: null }],
      branches: [null, { name: "release", protection: null }],
      labels: { entries: [{ name: "bug", description: null }] },
      milestones: { entries: [{ title: "v1", due_on: null }] },
      rulesets: [
        null,
        {
          name: "main",
          conditions: { ref_name: { exclude: [] } },
          rules: [null, { type: "pull_request", parameters: null }],
        },
      ],
      zero: 0,
    });
  });

  test("the wrapper form of a keyed section is entered like the plain list", () => {
    const doc = deepFreeze({
      rulesets: { _undeclared: "keep", entries: [{ name: "main", bypass_actors: null }] },
    });
    expect(stripNulls(doc)).toEqual({
      rulesets: { _undeclared: "keep", entries: [{ name: "main" }] },
    });
  });

  test.each([
    ["before", (shared: unknown) => ({ _template: shared, rulesets: shared })],
    ["after", (shared: unknown) => ({ rulesets: shared, _template: shared })],
  ])(
    "a wrapper aliased under a private key %s the section is stripped by the position it sits in, not the one first met",
    (_order, compose) => {
      const shared = { entries: [{ name: "main", bypass_actors: null }] };
      expect(stripNulls(deepFreeze(compose(shared)))).toEqual({
        _template: { entries: [{ name: "main", bypass_actors: null }] },
        rulesets: { entries: [{ name: "main" }] },
      });
    },
  );

  test("the merge agrees: a lower layer declaring every stripped key is deleted with a notice, the kept nulls survive as data", () => {
    const fleet = layer("fleet", {
      a: 1,
      b: { c: 2, e: { f: 3 } },
      labels: { _undeclared: "keep", entries: [{ name: "bug", description: "Fleet bug" }] },
      rulesets: [
        {
          name: "main",
          bypass_actors: [{ actor_id: 1 }],
          conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } },
          rules: [{ type: "pull_request", parameters: { required_approving_review_count: 1 } }],
        },
      ],
    });
    const repo = layer("repo", {
      a: null,
      b: { c: null, e: { f: null } },
      branches: [{ name: "release", protection: null }],
      labels: { _undeclared: null, entries: [{ name: "bug", description: null }] },
      rulesets: [
        {
          name: "main",
          bypass_actors: null,
          conditions: { ref_name: { include: null, exclude: [] } },
          rules: [{ type: "pull_request", parameters: null }],
        },
      ],
    });
    expect(merge([fleet, repo])).toEqual({
      settings: {
        b: { e: {} },
        labels: { _undeclared: "delete", entries: [{ name: "bug", description: null }] },
        rulesets: {
          _undeclared: "keep",
          entries: [
            {
              name: "main",
              conditions: { ref_name: { exclude: [] } },
              rules: [{ type: "pull_request", parameters: null }],
            },
          ],
        },
        branches: [{ name: "release", protection: null }],
      },
      notices: [
        { layer: "repo", path: "a" },
        { layer: "repo", path: "b.c" },
        { layer: "repo", path: "b.e.f" },
        { layer: "repo", path: "labels._undeclared" },
        { layer: "repo", path: "rulesets[0].bypass_actors" },
        { layer: "repo", path: "rulesets[0].conditions.ref_name.include" },
      ],
    });
  });

  test("a layer nulling a ruleset key validates alone once stripped, merges with a notice, and the merged document validates", () => {
    const lower = { rulesets: [{ ...MAIN_RULESET, bypass_actors: [{ actor_id: 1 }] }] };
    const upper = deepFreeze({ rulesets: [{ name: "main", bypass_actors: null }] });
    // Widened so the whole verdict can be pinned by value; the brand is opaque to toEqual.
    const validate = (doc: unknown): unknown =>
      validateSettingsDoc(doc, "repo", new Set(), silentIo());
    expect(validate(upper)).toEqual(
      err({
        code: "settings-malformed-sections",
        source: "repo",
        issues: [expect.stringContaining("rulesets")],
      }),
    );
    expect(validate(stripNulls(upper))).toEqual(ok({ rulesets: [{ name: "main" }] }));
    const merged = merge([layer("fleet", lower), layer("repo", upper)]);
    expect(merged).toEqual({
      settings: { rulesets: { _undeclared: "keep", entries: [MAIN_RULESET] } },
      notices: [{ layer: "repo", path: "rulesets[0].bypass_actors" }],
    });
    if ("error" in merged) {
      throw new Error(merged.error);
    }
    expect(validate(merged.settings)).toEqual(
      ok({ rulesets: { _undeclared: "keep", entries: [MAIN_RULESET] } }),
    );
  });

  test("a key named __proto__ survives as an own property", () => {
    const proto = "__proto__";
    const out = stripNulls(JSON.parse('{"__proto__": {"a": null, "b": 1}}')) as Record<
      string,
      unknown
    >;
    expect(out).toEqual({ [proto]: { b: 1 } });
    expect(Object.hasOwn(out, proto)).toBe(true);
  });

  test("a non-mapping document comes back as a clone", () => {
    const list = deepFreeze([{ a: null }]);
    const out = stripNulls(list);
    expect(out).toEqual([{ a: null }]);
    expect(out).not.toBe(list);
  });

  test("a document that includes itself comes back as a cyclic clone with its marker nulls dropped", () => {
    const doc = deepFreeze(cyclicMapping());
    const repository: Record<string, unknown> = { description: "x" };
    repository.self = repository;
    const out = stripNulls(doc);
    expect(out).toEqual({ repository });
    expect(out).not.toBe(doc);
  });
});
