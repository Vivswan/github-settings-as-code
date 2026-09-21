import { describe, expect, test } from "bun:test";
import { err, ok } from "neverthrow";
import { type Layer, type Layering, mergeLayers, stripNulls } from "../../src/engine/layers.js";
import { validateSettingsDoc } from "../../src/engine/orchestrate.js";
import { SectionSelection } from "../../src/engine/section-selection.js";
import { silentIo } from "../../src/io.js";
import { describeProblem, type LayerProblem } from "../../src/problem.js";
import { LIST_SECTIONS, type ListSection } from "../../src/schema.js";
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

function merge(layers: Layer[], layering: Layering = "deep") {
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
      parameters: {
        required_approving_review_count: 1,
        dismiss_stale_reviews_on_push: true,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
      },
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
      layer("repo", { actions: null, repository: { description: null } }),
    ]);
    expect(result).toEqual({
      settings: { repository: { has_wiki: false }, pages: { build_type: "workflow" } },
      notices: [
        { layer: "repo", path: "actions" },
        { layer: "repo", path: "repository.description" },
      ],
    });
  });

  test("the top layer beats everything, re-declaring a key a middle layer nulled", () => {
    const result = merge([
      layer("fleet", { actions: { enabled: true } }),
      layer("team", { actions: null }),
      layer("repo", { actions: { enabled: false } }),
    ]);
    expect(result).toEqual({
      settings: { actions: { enabled: false } },
      notices: [{ layer: "team", path: "actions" }],
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

  // `pages: null` is the only spelling of "Pages off"; read as an opt-out marker it would leave a fleet-declared site running.
  test.each([
    ["pages", { build_type: "workflow" }, { settings: { pages: null }, notices: [] }],
    [
      "interaction_limits",
      { limit: "collaborators_only" },
      { settings: { interaction_limits: null }, notices: [] },
    ],
    [
      "labels",
      [{ name: "bug", color: "d73a4a" }],
      { settings: {}, notices: [{ layer: "repo", path: "labels" }] },
    ],
  ])(
    "a higher %s: null over a lower declaration is the section's value where the section takes null, and an opt-out elsewhere",
    (key, lower, expected) => {
      expect(merge([layer("fleet", { [key]: lower }), layer("repo", { [key]: null })])).toEqual(
        expected,
      );
    },
  );

  test("a null on a section that has no null value, over one layer, opts out of nothing: it drops, with no notice", () => {
    expect(merge([layer("repo", { repository: { has_wiki: false }, labels: null })])).toEqual({
      settings: { repository: { has_wiki: false } },
      notices: [],
    });
  });

  test("a null on an unknown key over nothing stays as written for the validator to name", () => {
    expect(merge([layer("repo", { typo: null })])).toEqual({
      settings: { typo: null },
      notices: [],
    });
  });

  test.each<[Layering, Record<string, unknown>[]]>([
    [
      "deep",
      [
        { key_prefix: "F-", url_template: "https://f/<num>" },
        { key_prefix: "R-", url_template: "https://r/<num>" },
      ],
    ],
    [
      "shallow",
      [
        { key_prefix: "F-", url_template: "https://f/<num>" },
        { key_prefix: "R-", url_template: "https://r/<num>" },
      ],
    ],
    ["replace", [{ key_prefix: "R-", url_template: "https://r/<num>" }]],
  ])(
    "lists outside the list sections replace wholesale under %s, while a list section's entries follow the directive",
    (layering, autolinks) => {
      // A scalar list and a mapping list inside a mapping section: neither is a list section, so neither unions.
      const layers = [
        layer("fleet", {
          autolinks: [{ key_prefix: "F-", url_template: "https://f/<num>" }],
          check_suite_preferences: { auto_trigger_checks: [{ app_id: 1, setting: true }] },
          repository: { topics: ["fleet", "shared"] },
        }),
        layer("repo", {
          autolinks: [{ key_prefix: "R-", url_template: "https://r/<num>" }],
          check_suite_preferences: { auto_trigger_checks: [{ app_id: 2, setting: false }] },
          repository: { topics: ["mine"] },
        }),
      ];
      expect(merge(layers, layering)).toEqual({
        settings: {
          autolinks: { _undeclared: "delete", entries: autolinks },
          check_suite_preferences: { auto_trigger_checks: [{ app_id: 2, setting: false }] },
          repository: { topics: ["mine"] },
        },
        notices: [],
      });
    },
  );

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
  test.each<[Layering, Record<string, unknown>]>([
    ["deep", { name: "docs", color: "ffffff", description: "Fleet docs" }],
    ["shallow", { name: "docs", color: "ffffff" }],
  ])(
    "labels union by name under %s: the same-name entry merges field by field or is swapped, both sides' extras keep their order",
    (layering, docs) => {
      const result = merge(
        [
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
        ],
        layering,
      );
      expect(result).toEqual({
        settings: {
          labels: {
            _undeclared: "delete",
            entries: [
              { name: "bug", color: "d73a4a", description: "Fleet bug" },
              docs,
              { name: "infra", color: "111111" },
            ],
          },
        },
        notices: [],
      });
    },
  );

  /** The labels planner over an empty repository rejects two entries claiming one label, so a merged document it plans is one apply accepts. */
  async function planLabels(entries: readonly Record<string, unknown>[]) {
    const api = new MockApi({ "GET /repos/o/r/labels?per_page=100&page=1": { data: [] } });
    const plan = await labelsSection.plan(
      planContext(labelsSection, api, REPO),
      entries as Parameters<typeof labelsSection.plan>[1],
    );
    return plan.ops.map((op) => op.describe);
  }

  test.each<
    [
      string,
      Layering,
      { lower: Record<string, unknown>[]; higher: Record<string, unknown>[] },
      Record<string, unknown>[],
    ]
  >([
    [
      "the plain label above the rename, swapped",
      "shallow",
      {
        lower: [{ name: "bug", new_name: "defect" }],
        higher: [{ name: "defect", color: "ffffff" }],
      },
      [{ name: "defect", color: "ffffff" }],
    ],
    [
      "the rename above the plain label, swapped",
      "shallow",
      {
        lower: [{ name: "defect", color: "ffffff" }],
        higher: [{ name: "bug", new_name: "defect" }],
      },
      [{ name: "bug", new_name: "defect" }],
    ],
    [
      "the plain label above the rename, merged: the lower rename target rides along as a self-rename",
      "deep",
      {
        lower: [{ name: "bug", new_name: "defect" }],
        higher: [{ name: "defect", color: "ffffff" }],
      },
      [{ name: "defect", new_name: "defect", color: "ffffff" }],
    ],
    [
      "the rename above the plain label, merged: the lower color rides along",
      "deep",
      {
        lower: [{ name: "defect", color: "ffffff" }],
        higher: [{ name: "bug", new_name: "defect" }],
      },
      [{ name: "bug", color: "ffffff", new_name: "defect" }],
    ],
  ])(
    "a label renaming into a name another layer declares is one label the planner creates once (%s)",
    async (_case, layering, { lower, higher }, entries) => {
      const result = merge(
        [layer("fleet", { labels: lower }), layer("repo", { labels: higher })],
        layering,
      );
      expect(result).toEqual({
        settings: { labels: { _undeclared: "delete", entries } },
        notices: [],
      });
      expect(await planLabels(entries)).toEqual(['creating label "defect"']);
    },
  );

  test("a higher entry claiming two lower labels supersedes both as written, under deep too: neither lower field rides along, whichever came first", async () => {
    const entries = [{ name: "Bug", new_name: "Defect" }];
    for (const lower of [
      [
        { name: "defect", color: "111111" },
        { name: "bug", description: "lower" },
      ],
      [
        { name: "bug", description: "lower" },
        { name: "defect", color: "111111" },
      ],
    ]) {
      for (const layering of ["deep", "shallow"] as const) {
        expect(
          merge([layer("fleet", { labels: lower }), layer("repo", { labels: entries })], layering),
        ).toEqual({
          settings: { labels: { _undeclared: "delete", entries } },
          notices: [],
        });
      }
    }
    expect(await planLabels(entries)).toEqual(['creating label "Defect"']);
  });

  test.each([
    ["rename first", [{ name: "bug", new_name: "defect" }, { name: "docs" }]],
    ["rename last", [{ name: "docs" }, { name: "bug", new_name: "defect" }]],
  ])(
    "a lower rename two higher entries claim between them is superseded by both as written, under deep too (%s), so the planner never meets two entries claiming one name",
    async (_order, higher) => {
      // Merged field by field, the lower's new_name would ride into both higher entries and the planner would refuse the document.
      const layers = [
        layer("fleet", { labels: [{ name: "bug" }, { name: "docs", new_name: "defect" }] }),
        layer("repo", { labels: higher }),
      ];
      const entries = [{ name: "bug", new_name: "defect" }, { name: "docs" }];
      for (const layering of ["deep", "shallow"] as const) {
        expect(merge(layers, layering)).toEqual({
          settings: { labels: { _undeclared: "delete", entries } },
          notices: [],
        });
      }
      expect(await planLabels(entries)).toEqual([
        'creating label "defect"',
        'creating label "docs"',
      ]);
    },
  );

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

  test("under deep a higher layer adds a rule type and merges a same-type rule field by field, its parameters included", () => {
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
                {
                  type: "pull_request",
                  parameters: {
                    required_approving_review_count: 2,
                    dismiss_stale_reviews_on_push: true,
                    require_code_owner_review: false,
                    require_last_push_approval: false,
                    required_review_thread_resolution: false,
                  },
                },
                { type: "non_fast_forward" },
              ],
            },
          ],
        },
      },
      notices: [],
    });
  });

  test("under shallow the same-name ruleset is swapped whole: the lower conditions and rules are gone with it", () => {
    const higher = {
      name: "main",
      rules: [{ type: "pull_request", parameters: { required_approving_review_count: 2 } }],
    };
    const result = merge(
      [layer("fleet", { rulesets: [MAIN_RULESET] }), layer("repo", { rulesets: [higher] })],
      "shallow",
    );
    expect(result).toEqual({
      settings: { rulesets: { _undeclared: "keep", entries: [higher] } },
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
});

describe("mergeLayers: the undeclared knob across layers", () => {
  const fleetKeep = layer("fleet", {
    labels: { _undeclared: "keep", entries: [{ name: "fleet" }] },
  });

  test.each([
    ["deep", { _undeclared: "keep", entries: [{ name: "fleet" }, { name: "mine" }] }],
    ["shallow", { _undeclared: "keep", entries: [{ name: "fleet" }, { name: "mine" }] }],
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
        milestones: { _undeclared: "keep", entries: [{ title: "v0" }, { title: "v1" }] },
      },
      notices: [],
    });
  });

  test("a resolved policy leads its wrapper, where an author's own sits after the fold", () => {
    const result = merge([
      layer("fleet", { labels: [{ name: "a" }] }),
      layer("repo", { rulesets: { entries: [{ name: "r" }], _undeclared: "delete" } }),
    ]);
    if ("error" in result) {
      throw new Error(result.error);
    }
    const settings = result.settings as Record<string, object | undefined>;
    expect(Object.keys(settings.labels ?? {})).toEqual(["_undeclared", "entries"]);
    expect(Object.keys(settings.rulesets ?? {})).toEqual(["_undeclared", "entries"]);
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
    ["deep", "replace", [{ name: "mine" }]],
    ["replace", "deep", [{ name: "fleet" }, { name: "mine" }]],
    ["replace", "shallow", [{ name: "fleet" }, { name: "mine" }]],
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

  test("a file-level _layering: replace, with one section's wrapper back to deep; the result carries no directive", () => {
    const result = merge([
      fleet,
      layer("repo", {
        _layering: "replace",
        labels: [{ name: "mine" }],
        rulesets: { _layering: "deep", entries: [{ name: "mine" }] },
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
});

/**
 * Two layers sharing ONE key per list section, spelled as the section's planner folds it (case for labels,
 * collaborators, teams, and environments; case for the uppercased secret and variable names; a workflow's bare file
 * name against its .github/workflows/ path; verbatim elsewhere), with a lower-only field so the field merge is
 * visible. Typed over every list section, so a new one fails here until it has a row.
 */
const SHARED_KEY_LAYERS: {
  [K in ListSection]: {
    lower: Record<string, unknown>;
    /** A second lower entry under another key: it survives a union and goes with the list under replace. */
    other: Record<string, unknown>;
    higher: Record<string, unknown>;
    deep: Record<string, unknown>;
  };
} = {
  labels: {
    lower: { name: "Bug", color: "111111" },
    other: { name: "docs", color: "222222" },
    higher: { name: "bug", description: "mine" },
    deep: { name: "bug", color: "111111", description: "mine" },
  },
  rulesets: {
    lower: { name: "main", target: "branch" },
    other: { name: "tags", target: "tag" },
    higher: { name: "main", enforcement: "active" },
    deep: { name: "main", target: "branch", enforcement: "active" },
  },
  environments: {
    lower: { name: "Prod", wait_timer: 5 },
    other: { name: "staging" },
    higher: { name: "prod", prevent_self_review: true },
    deep: { name: "prod", wait_timer: 5, prevent_self_review: true },
  },
  branches: {
    lower: { name: "main", protection: { enforce_admins: true } },
    other: { name: "release", protection: null },
    higher: { name: "main", protection: { required_signatures: true } },
    deep: { name: "main", protection: { enforce_admins: true, required_signatures: true } },
  },
  workflows: {
    lower: { path: "ci.yml", state: "active" },
    other: { path: "nightly.yml", state: "disabled" },
    higher: { path: ".github/workflows/ci.yml", state: "disabled" },
    deep: { path: ".github/workflows/ci.yml", state: "disabled" },
  },
  autolinks: {
    lower: { key_prefix: "J-", url_template: "https://j/<num>" },
    other: { key_prefix: "K-", url_template: "https://k/<num>" },
    higher: { key_prefix: "J-", is_alphanumeric: false },
    deep: { key_prefix: "J-", url_template: "https://j/<num>", is_alphanumeric: false },
  },
  actions_secrets: {
    lower: { name: "MY_SECRET", value: "$FLEET" },
    other: { name: "OTHER", value: "$OTHER" },
    higher: { name: "my_secret", value: "$MINE" },
    deep: { name: "my_secret", value: "$MINE" },
  },
  dependabot_secrets: {
    lower: { name: "MY_SECRET", value: "$FLEET" },
    other: { name: "OTHER", value: "$OTHER" },
    higher: { name: "my_secret", value: "$MINE" },
    deep: { name: "my_secret", value: "$MINE" },
  },
  codespaces_secrets: {
    lower: { name: "MY_SECRET", value: "$FLEET" },
    other: { name: "OTHER", value: "$OTHER" },
    higher: { name: "my_secret", value: "$MINE" },
    deep: { name: "my_secret", value: "$MINE" },
  },
  agents_secrets: {
    lower: { name: "MY_SECRET", value: "$FLEET" },
    other: { name: "OTHER", value: "$OTHER" },
    higher: { name: "my_secret", value: "$MINE" },
    deep: { name: "my_secret", value: "$MINE" },
  },
  collaborators: {
    lower: { username: "Octocat", permission: "push" },
    other: { username: "hubot", permission: "pull" },
    higher: { username: "octocat" },
    deep: { username: "octocat", permission: "push" },
  },
  teams: {
    lower: { name: "Prod", permission: "push" },
    other: { name: "docs", permission: "pull" },
    higher: { name: "prod" },
    deep: { name: "prod", permission: "push" },
  },
  milestones: {
    lower: { title: "v1", description: "first" },
    other: { title: "v2" },
    higher: { title: "v1", state: "closed" },
    deep: { title: "v1", description: "first", state: "closed" },
  },
  actions_variables: {
    lower: { name: "MY_VAR", value: "fleet" },
    other: { name: "OTHER", value: "other" },
    higher: { name: "my_var", value: "mine" },
    deep: { name: "my_var", value: "mine" },
  },
  agents_variables: {
    lower: { name: "MY_VAR", value: "fleet" },
    other: { name: "OTHER", value: "other" },
    higher: { name: "my_var", value: "mine" },
    deep: { name: "my_var", value: "mine" },
  },
  webhooks: {
    lower: {
      config: { url: "https://hooks.example.com/a", content_type: "json" },
      events: ["push"],
    },
    other: { config: { url: "https://hooks.example.com/b" } },
    higher: { config: { url: "https://hooks.example.com/a" }, active: false },
    deep: {
      config: { url: "https://hooks.example.com/a", content_type: "json" },
      events: ["push"],
      active: false,
    },
  },
  custom_properties: {
    lower: { property_name: "team", value: "fleet" },
    other: { property_name: "tier", value: "gold" },
    higher: { property_name: "team", value: "mine" },
    deep: { property_name: "team", value: "mine" },
  },
  deploy_keys: {
    lower: { title: "ci", key: "ssh-ed25519 AAAA" },
    other: { title: "deploy", key: "ssh-ed25519 BBBB" },
    higher: { title: "ci", read_only: false },
    deep: { title: "ci", key: "ssh-ed25519 AAAA", read_only: false },
  },
  secret_scanning_custom_patterns: {
    lower: { name: "token", pattern: "tok_[a-z]+" },
    other: { name: "key", pattern: "key_[a-z]+" },
    higher: { name: "token", push_protection: true },
    deep: { name: "token", pattern: "tok_[a-z]+", push_protection: true },
  },
};

describe("mergeLayers: every list section layers by the key its planner folds", () => {
  /** The folded entries of one section: a knobbed one's `entries` (the resolved knob set aside), a plain list itself. */
  function entriesOf(layers: Layer[], layering: Layering, key: ListSection): unknown {
    const result = merge(layers, layering);
    if ("error" in result) {
      throw new Error(result.error);
    }
    const section = (result.settings as Record<string, { entries: unknown } | unknown[]>)[key];
    return Array.isArray(section) ? section : section?.entries;
  }

  test.each([...LIST_SECTIONS])(
    "%s: a shared key spelled two ways folds to one entry under shallow and deep, and the higher list wins under replace",
    (key) => {
      const { lower, other, higher, deep } = SHARED_KEY_LAYERS[key];
      const layers = [
        layer("fleet", { [key]: [lower, other] }),
        layer("repo", { [key]: [higher] }),
      ];
      expect(entriesOf(layers, "shallow", key)).toEqual([higher, other]);
      expect(entriesOf(layers, "deep", key)).toEqual([deep, other]);
      expect(entriesOf(layers, "replace", key)).toEqual([higher]);
    },
  );

  test.each([...LIST_SECTIONS])("%s: an empty higher list adds nothing under deep", (key) => {
    const { lower, other } = SHARED_KEY_LAYERS[key];
    const layers = [layer("fleet", { [key]: [lower, other] }), layer("repo", { [key]: [] })];
    expect(entriesOf(layers, "deep", key)).toEqual([lower, other]);
  });
});

describe("mergeLayers: the plain-list sections", () => {
  const PROD = {
    name: "prod",
    wait_timer: 5,
    variables: [
      { name: "REGION", value: "eu" },
      { name: "LOG_LEVEL", value: "info" },
    ],
    secrets: { _undeclared: "keep", entries: [{ name: "TOKEN", value: "$A" }] },
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    deployment_branch_policies: [{ name: "release/*" }],
    deployment_protection_rules: [{ app: "gate" }],
    reviewers: [
      { type: "User", id: 1 },
      { type: "Team", id: 1 },
    ],
  };

  test.each<[Layering, unknown]>([
    ["replace", [{ name: "qa" }]],
    ["shallow", [{ name: "prod", wait_timer: 5 }, { name: "qa" }]],
    ["deep", [{ name: "prod", wait_timer: 5 }, { name: "qa" }]],
  ])(
    "a plain-list section folds under its wrapper's _layering: %s and comes out as the bare list, the directive consumed",
    (directive, environments) => {
      const result = merge([
        layer("fleet", { environments: [{ name: "prod", wait_timer: 5 }] }),
        layer("repo", { environments: { _layering: directive, entries: [{ name: "qa" }] } }),
      ]);
      expect(result).toEqual({ settings: { environments }, notices: [] });
    },
  );

  test("a bare {entries} wrapper on a plain-list section folds like the plain list, under the file's directive", () => {
    const result = merge([
      layer("fleet", { workflows: [{ path: "ci.yml", state: "active" }] }),
      layer("repo", {
        _layering: "replace",
        workflows: { entries: [{ path: "nightly.yml", state: "disabled" }] },
      }),
    ]);
    expect(result).toEqual({
      settings: { workflows: [{ path: "nightly.yml", state: "disabled" }] },
      notices: [],
    });
  });

  test("under deep an environment's nested lists union by their own keys, in either form, with the lower wrapper's policy inherited", () => {
    const result = merge([
      layer("fleet", { environments: [PROD] }),
      layer("repo", {
        environments: [
          {
            name: "Prod",
            variables: [
              { name: "region", value: "us" },
              { name: "TIMEOUT", value: "30" },
            ],
            secrets: [{ name: "token", value: "$B" }],
            deployment_branch_policies: [{ name: "release/*", type: "tag" }, { name: "hotfix/*" }],
            deployment_protection_rules: { entries: [{ app: "gate" }, { app: "scan" }] },
            reviewers: [
              { type: "Team", id: 1 },
              { type: "User", id: 2 },
            ],
          },
        ],
      }),
    ]);
    expect(result).toEqual({
      settings: {
        environments: [
          {
            name: "Prod",
            wait_timer: 5,
            variables: [
              { name: "region", value: "us" },
              { name: "LOG_LEVEL", value: "info" },
              { name: "TIMEOUT", value: "30" },
            ],
            secrets: { _undeclared: "keep", entries: [{ name: "token", value: "$B" }] },
            deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
            deployment_branch_policies: [{ name: "release/*", type: "tag" }, { name: "hotfix/*" }],
            deployment_protection_rules: { entries: [{ app: "gate" }, { app: "scan" }] },
            reviewers: [
              { type: "User", id: 1 },
              { type: "Team", id: 1 },
              { type: "User", id: 2 },
            ],
          },
        ],
      },
      notices: [],
    });
  });

  test("a higher nested wrapper's explicit _undeclared wins over a lower bare list, and the wrapper form is kept", () => {
    const result = merge([
      layer("fleet", { environments: [{ name: "prod", variables: [{ name: "A", value: "1" }] }] }),
      layer("repo", {
        environments: [
          {
            name: "prod",
            variables: { _undeclared: "delete", entries: [{ name: "B", value: "2" }] },
          },
        ],
      }),
    ]);
    expect(result).toEqual({
      settings: {
        environments: [
          {
            name: "prod",
            variables: {
              _undeclared: "delete",
              entries: [
                { name: "A", value: "1" },
                { name: "B", value: "2" },
              ],
            },
          },
        ],
      },
      notices: [],
    });
  });

  test("under shallow the same-name environment is swapped whole, its nested lists with it", () => {
    const higher = { name: "prod", variables: [{ name: "TIMEOUT", value: "30" }] };
    const result = merge(
      [layer("fleet", { environments: [PROD] }), layer("repo", { environments: [higher] })],
      "shallow",
    );
    expect(result).toEqual({ settings: { environments: [higher] }, notices: [] });
  });

  test("a null at a plain-list entry's nullable path is the value under deep; a null elsewhere in the entry deletes with a notice", () => {
    const result = merge([
      layer("fleet", {
        branches: [
          {
            name: "main",
            protection: { enforce_admins: true, required_deployments: { environments: ["prod"] } },
          },
          { name: "release/*", protection: { required_signatures: true } },
        ],
        environments: [PROD],
      }),
      layer("repo", {
        branches: [
          { name: "main", protection: { required_deployments: null } },
          { name: "release/*", protection: null },
        ],
        environments: [{ name: "prod", deployment_branch_policy: null, wait_timer: null }],
      }),
    ]);
    expect(result).toEqual({
      settings: {
        branches: [
          { name: "main", protection: { enforce_admins: true, required_deployments: null } },
          { name: "release/*", protection: null },
        ],
        environments: [{ ...PROD, deployment_branch_policy: null, wait_timer: undefined }],
      },
      notices: [{ layer: "repo", path: "environments[0].wait_timer" }],
    });
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
      "a scalar where a plain list belongs, named with the wrapper it does take",
      { environments: "oops" },
      "layer-wrong-shape",
      'layer "repo": environments must be a list of mappings or an {_layering, entries} wrapper; got a string',
    ],
    [
      "two environments under one name, spelled two ways",
      { environments: [{ name: "Prod" }, { name: "prod" }] },
      "layer-duplicate-key",
      'layer "repo": environments[0] and environments[1] both claim one name; each name belongs to one entry within a layer',
    ],
    [
      "a nameless environment variable, under the nested wrapper form",
      { environments: [{ name: "prod", variables: { entries: [{ value: "x" }] } }] },
      "layer-no-key",
      'layer "repo": environments[0].variables[0] carries no string "name", which every entry needs to layer by',
    ],
    [
      "two environment secrets under one uppercased name",
      {
        environments: [
          {
            name: "prod",
            secrets: [
              { name: "token", value: "$A" },
              { name: "TOKEN", value: "$B" },
            ],
          },
        ],
      },
      "layer-duplicate-key",
      'layer "repo": environments[0].secrets[0] and environments[0].secrets[1] both claim one name; each name belongs to one entry within a layer',
    ],
    [
      "a reviewer whose id is not a number",
      { environments: [{ name: "prod", reviewers: [{ type: "User", id: "1" }] }] },
      "layer-no-key",
      'layer "repo": environments[0].reviewers[0] carries no numeric "id", which every entry needs to layer by',
    ],
    [
      "a workflow named twice, by its bare name and its path",
      {
        workflows: [
          { path: "ci.yml", state: "active" },
          { path: ".github/workflows/ci.yml", state: "disabled" },
        ],
      },
      "layer-duplicate-key",
      'layer "repo": workflows[0] and workflows[1] both claim one path; each path belongs to one entry within a layer',
    ],
    [
      "a branch protected twice",
      {
        branches: [
          { name: "main", protection: null },
          { name: "main", protection: null },
        ],
      },
      "layer-duplicate-key",
      'layer "repo": branches[0] and branches[1] both claim one name; each name belongs to one entry within a layer',
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
      "a non-mapping milestone entry",
      { milestones: [{ title: "v1" }, "v2"] },
      "layer-wrong-shape",
      'layer "repo": milestones[1] must be a mapping; got a string',
    ],
    [
      "a titleless milestone",
      { milestones: [{ title: "v1" }, { description: "no title" }] },
      "layer-no-key",
      'layer "repo": milestones[1] carries no string "title", which every entry needs to layer by',
    ],
    [
      "the retired top-level directive, an unknown value like any other",
      { _layering: "merge", labels: [{ name: "mine" }] },
      "layer-bad-directive",
      'layer "repo": _layering must be one of "replace", "shallow", "deep"; got a string that is none of them',
    ],
    [
      "an invalid wrapper directive",
      { labels: { _layering: "union", entries: [{ name: "mine" }] } },
      "layer-bad-directive",
      'layer "repo": labels._layering must be one of "replace", "shallow", "deep"; got a string that is none of them',
    ],
    [
      "a non-string wrapper directive",
      { labels: { _layering: true, entries: [{ name: "mine" }] } },
      "layer-bad-directive",
      'layer "repo": labels._layering must be one of "replace", "shallow", "deep"; got a boolean',
    ],
  ])("%s is refused naming the layer", (_case, doc, code, error) => {
    for (const layering of ["deep", "shallow", "replace"] as const) {
      expect(merge([fleet, layer("repo", doc)], layering)).toEqual({ code, error });
    }
  });

  test("every knobbed section unions by its key under the run default, milestones by title", () => {
    expect(merge([fleet, layer("repo", { milestones: [{ title: "v1" }] })])).toEqual({
      settings: {
        labels: { _undeclared: "delete", entries: [{ name: "fleet" }] },
        milestones: { _undeclared: "keep", entries: [{ title: "v0" }, { title: "v1" }] },
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
        'layer "repo": labels._layering must be one of "replace", "shallow", "deep"; got a string that is none of them',
      ],
    ];
    const kinded: [string, unknown][] = [
      ["a top-level directive that is a marker", { _layering: M, labels: [{ name: M }] }],
      ["an entry without its key", { labels: [{ color: M, [M]: M }] }],
      ["a milestone without its key", { milestones: [{ description: M }] }],
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
  test("drops the nulls the merge reads as markers under deep and keeps the nulls it copies as data", () => {
    const doc = deepFreeze({
      a: null,
      b: { c: null, d: 1, e: { f: null } },
      list: [null, { g: null }],
      branches: [null, { name: "release", protection: null, extra: null }],
      environments: [
        {
          name: "prod",
          wait_timer: null,
          deployment_branch_policy: null,
          variables: { _undeclared: null, entries: [{ name: "A", value: null }] },
          secrets: [{ name: "B", value: null }],
        },
      ],
      workflows: { _layering: "shallow", entries: [{ path: "ci.yml", state: null }] },
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
      pages: null,
      zero: 0,
    });
    expect(stripNulls(doc, "deep")).toEqual({
      b: { d: 1, e: {} },
      list: [null, { g: null }],
      branches: [null, { name: "release", protection: null }],
      environments: [
        {
          name: "prod",
          deployment_branch_policy: null,
          variables: { entries: [{ name: "A" }] },
          secrets: [{ name: "B" }],
        },
      ],
      workflows: { _layering: "shallow", entries: [{ path: "ci.yml", state: null }] },
      labels: { entries: [{ name: "bug" }] },
      milestones: { entries: [{ title: "v1" }] },
      rulesets: [
        null,
        {
          name: "main",
          conditions: { ref_name: { exclude: [] } },
          rules: [null, { type: "pull_request" }],
        },
      ],
      pages: null,
      zero: 0,
    });
  });

  test("the wrapper form of a keyed section is entered like the plain list", () => {
    const doc = deepFreeze({
      rulesets: { _undeclared: "keep", entries: [{ name: "main", bypass_actors: null }] },
    });
    expect(stripNulls(doc, "deep")).toEqual({
      rulesets: { _undeclared: "keep", entries: [{ name: "main" }] },
    });
  });

  test.each([
    ["before", (shared: unknown) => ({ _template: shared, rulesets: shared })],
    ["after", (shared: unknown) => ({ rulesets: shared, _template: shared })],
  ])(
    "a wrapper aliased under a non-section key %s the section is stripped by the position it sits in, not the one first met",
    (_order, compose) => {
      const shared = { entries: [{ name: "main", bypass_actors: null }] };
      expect(stripNulls(deepFreeze(compose(shared)), "deep")).toEqual({
        _template: { entries: [{ name: "main", bypass_actors: null }] },
        rulesets: { entries: [{ name: "main" }] },
      });
    },
  );

  test("a null at a null-valued entry path is the value under deep, in the per-layer view and the fold alike; a null elsewhere in the entry is still a marker", () => {
    // custom_properties' `value: null` unsets the property, so a lone layer saying it validates and a higher one writes it over the lower value with no notice.
    const lower = { custom_properties: [{ property_name: "pilot", value: "true", note: "lower" }] };
    const higher = deepFreeze({
      custom_properties: [{ property_name: "pilot", value: null, note: null }],
    });
    expect(stripNulls(higher, "deep")).toEqual({
      custom_properties: [{ property_name: "pilot", value: null }],
    });
    expect(merge([layer("fleet", lower), layer("repo", higher)])).toEqual({
      settings: {
        custom_properties: {
          _undeclared: "keep",
          entries: [{ property_name: "pilot", value: null }],
        },
      },
      notices: [{ layer: "repo", path: "custom_properties[0].note" }],
    });
  });

  test("the merge agrees: a lower layer declaring every stripped key is deleted with a notice, the kept nulls survive as data or as the section value", () => {
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
      pages: { build_type: "workflow" },
    });
    const repo = layer("repo", {
      a: null,
      b: { c: null, e: { f: null } },
      pages: null,
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
        labels: { _undeclared: "delete", entries: [{ name: "bug" }] },
        rulesets: {
          _undeclared: "keep",
          entries: [
            {
              name: "main",
              conditions: { ref_name: { exclude: [] } },
              rules: [{ type: "pull_request" }],
            },
          ],
        },
        pages: null,
        branches: [{ name: "release", protection: null }],
      },
      notices: [
        { layer: "repo", path: "a" },
        { layer: "repo", path: "b.c" },
        { layer: "repo", path: "b.e.f" },
        { layer: "repo", path: "labels._undeclared" },
        { layer: "repo", path: "labels[0].description" },
        { layer: "repo", path: "rulesets[0].bypass_actors" },
        { layer: "repo", path: "rulesets[0].conditions.ref_name.include" },
        { layer: "repo", path: "rulesets[0].rules[0].parameters" },
      ],
    });
  });

  test("a layer nulling a ruleset key validates alone once stripped, merges with a notice, and the merged document validates", () => {
    const lower = { rulesets: [{ ...MAIN_RULESET, bypass_actors: [{ actor_id: 1 }] }] };
    const upper = deepFreeze({ rulesets: [{ name: "main", bypass_actors: null }] });
    // Widened so the whole verdict can be pinned by value; the brand is opaque to toEqual.
    const validate = (doc: unknown): unknown =>
      validateSettingsDoc(doc, "repo", SectionSelection.ALL, silentIo());
    expect(validate(upper)).toEqual(
      err({
        code: "settings-malformed-sections",
        source: "repo",
        issues: [expect.stringContaining("rulesets")],
      }),
    );
    expect(validate(stripNulls(upper, "deep"))).toEqual(
      ok({ rulesets: [{ name: "main", target: "branch", enforcement: "active" }] }),
    );
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
    const out = stripNulls(JSON.parse('{"__proto__": {"a": null, "b": 1}}'), "deep") as Record<
      string,
      unknown
    >;
    expect(out).toEqual({ [proto]: { b: 1 } });
    expect(Object.hasOwn(out, proto)).toBe(true);
  });

  test("a non-mapping document comes back as a clone", () => {
    const list = deepFreeze([{ a: null }]);
    const out = stripNulls(list, "deep");
    expect(out).toEqual([{ a: null }]);
    expect(out).not.toBe(list);
  });

  test("a document that includes itself comes back as a cyclic clone with its marker nulls dropped", () => {
    const doc = deepFreeze(cyclicMapping());
    const repository: Record<string, unknown> = { description: "x" };
    repository.self = repository;
    const out = stripNulls(doc, "deep");
    expect(out).toEqual({ repository });
    expect(out).not.toBe(doc);
  });
});
