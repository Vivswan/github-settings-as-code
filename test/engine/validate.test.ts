import { describe, expect, test } from "bun:test";
import { err, ok } from "neverthrow";
import { validateSectionShapes } from "../../src/engine/validate.js";
import type { ListSection, SectionKey } from "../../src/schema.js";
import { listLayering, SECTIONS } from "../../src/sections/registry.js";

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
      /^pages\.source has no empty state; write a mapping of its fields$/,
    ],
  ])("the fields handlers dereference are shape-checked: %s", (_what, doc, issue) => {
    expect(issuesOf(doc)).toEqual([expect.stringMatching(issue)]);
  });

  // The cascade's null is the EMPTY value on GitHub, so a key with no empty state refuses it naming the values that exist;
  // a whole section takes null only where null is its off state. The messages are the fix, not zod's type prose.
  test.each<[string, Record<string, unknown>, string]>([
    [
      "a boolean",
      { repository: { enable_git_lfs: null } },
      "repository.enable_git_lfs has no empty state; write true or false",
    ],
    [
      "an enum",
      { actions: { default_workflow_permissions: null } },
      'actions.default_workflow_permissions has no empty state; write one of "read", "write"',
    ],
    [
      "a string inside a keyed entry",
      { labels: [{ name: "bug", description: null }] },
      "labels[0].description has no empty state; write a string",
    ],
    [
      "a list",
      { rulesets: [{ name: "main", bypass_actors: null }] },
      "rulesets[0].bypass_actors has no empty state; write a list ([] for none)",
    ],
    [
      "a union of a string and a list",
      { repository: { topics: null } },
      "repository.topics has no empty state; write a string, or a list ([] for none)",
    ],
    [
      "a nested list section",
      { environments: [{ name: "prod", variables: null }] },
      "environments[0].variables has no empty state; write a list of entries ([] for none)",
    ],
    [
      "a whole mapping section",
      { repository: null },
      "repository: null has no meaning; remove the section or declare its fields",
    ],
    [
      "a whole list section",
      { labels: null },
      "labels: null has no meaning; remove the section or declare its entries",
    ],
  ])("a null a key does not admit names the legal values: %s", (_what, doc, issue) => {
    expect(issuesOf(doc)).toEqual([issue]);
  });

  test("a shape's own diagnostic for a null keeps its words: no value would make the key legal", () => {
    // The environments slice refuses a singular `secret` key by name; the null rewrite has nothing truer to say.
    expect(issuesOf({ environments: [{ name: "prod", secret: null }] })).toEqual([
      expect.stringMatching(
        /^environments\[0\]\.secret: environment secrets belong under the entry's `secrets` list/,
      ),
    ]);
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

describe("file-only checks run inside document validation", () => {
  // Thrown from a section's plan() instead, a duplicate would surface only after the sections before it had written.
  test("a duplicated identity is a malformed-sections issue at the later entry's field, beside a sibling section's shape issue", () => {
    expect(
      issuesOf({
        labels: [{ name: "bug" }, { name: "Bug" }],
        pages: { source: null },
      }),
    ).toEqual([
      'labels[1].name: "Bug" names the same label as "bug" declared earlier; keep exactly one entry per label',
      "pages.source has no empty state; write a mapping of its fields",
    ]);
  });

  test("the wrapped form's issue path goes through .entries, as a zod issue on the same entry would", () => {
    expect(
      issuesOf({ labels: { _undeclared: "keep", entries: [{ name: "a" }, { name: "A" }] } }),
    ).toEqual([
      'labels.entries[1].name: "A" names the same label as "a" declared earlier; keep exactly one entry per label',
    ]);
  });

  test("a non-finite number in a passthrough field is refused at the boundary, where a typed field's shape already refuses it", () => {
    expect(
      issuesOf({
        repository: { description: "changed" },
        actions_variables: [{ name: "REGION", value: "eu", extra: Number.NaN }],
      }),
    ).toEqual([
      "actions_variables[0].extra is NaN, which JSON cannot carry (it would become null); declare a finite number or remove the key",
    ]);
    expect(
      issuesOf({ actions: { cache: { max_cache_size_gb: Number.POSITIVE_INFINITY } } }),
    ).toEqual([expect.stringMatching(/^actions\.cache\.max_cache_size_gb: .*received Infinity/)]);
  });

  test("a section whose shape failed is not handed to its hook: the shape issue is the one reported", () => {
    expect(issuesOf({ labels: [{ name: "a" }, { name: 2 }] })).toEqual([
      expect.stringMatching(/^labels\[1\]\.name: .*expected string/),
    ]);
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

  // Without this gate, plan()'s payload proof would throw on the cycle only after earlier sections wrote.
  test("a YAML alias cycle in a passthrough field is refused at the boundary with its path", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(issuesOf({ repository: { enable_git_lfs: loop } })).toEqual([
      expect.stringMatching(/^repository\.enable_git_lfs: .*a mapping is not a boolean/),
    ]);
    expect(
      issuesOf({
        repository: { description: "changed" },
        actions_variables: [{ name: "REGION", value: "eu", extra: loop }],
      }),
    ).toEqual([
      "actions_variables[0].extra.self refers back to one of its own containers (a YAML alias cycle), which JSON cannot carry; spell the value out instead",
    ]);
    const shared = { enabled: true };
    expect(
      validateSectionShapes({ repository: { first: shared, second: shared } }, "f.yml").isOk(),
    ).toBe(true);
  });

  // YAML spells none of these, but a library caller's document can; each would reach plan()'s payload proof through a
  // passthrough field and throw there, after the repository section beside it had written.
  test.each<[what: string, value: unknown, reason: string]>([
    ["a bigint", 10n, "a bigint"],
    ["a function", () => true, "a function"],
    ["a symbol", Symbol("s"), "a symbol"],
    [
      "a symbol-keyed mapping",
      { ok: true, [Symbol("hidden")]: 1 },
      "a mapping with a symbol-keyed property, which JSON drops",
    ],
    [
      "a list of a subclass",
      new (class Tagged extends Array {})(),
      "a list of a subclass, which JSON serializes as a plain list",
    ],
    [
      "a list carrying named properties",
      Object.assign([1], { extra: 2 }),
      "a list carrying named properties, which JSON drops",
    ],
    [
      // The walk must not call the list's own keys(): here it is a number.
      "a list whose named property shadows a method",
      Object.assign([1], { keys: 0 }),
      "a list carrying named properties, which JSON drops",
    ],
    [
      "a list with a hole",
      Object.assign(new Array(3), { 0: 1, 2: 3 }),
      "a list with a hole (which JSON renders as null) or a non-enumerable item",
    ],
    ["a class instance", new Date(0), "a Date, e.g. from a YAML !!timestamp tag"],
  ])(
    "%s in a passthrough field is refused at the boundary with its path",
    (_what, value, reason) => {
      expect(
        issuesOf({
          repository: { description: "changed" },
          actions_variables: [{ name: "REGION", value: "eu", extra: value }],
        }),
      ).toEqual([
        `actions_variables[0].extra is not plain YAML data (${reason}); replace it with a plain value`,
      ]);
    },
  );

  // zod reads a schema field by name whatever its enumerability, so its output carries what Object.entries skipped.
  test("a non-plain value under a NON-ENUMERABLE schema field is refused on zod's output", () => {
    const branch = Object.defineProperty({ name: "main" }, "protection", {
      value: { extra: 10n },
      enumerable: false,
    });
    expect(issuesOf({ repository: { description: "changed" }, branches: [branch] })).toEqual([
      "branches[0].protection.extra is not plain YAML data (a bigint); replace it with a plain value",
    ]);
  });

  test("an undefined LIST ITEM is refused at its path; an undefined FIELD is what JSON drops, so it passes", () => {
    expect(
      issuesOf({ actions_variables: [{ name: "REGION", value: "eu", extra: [undefined] }] }),
    ).toEqual([
      "actions_variables[0].extra[0] is not plain YAML data (an undefined list item, which JSON would turn into null); replace it with a plain value",
    ]);
    expect(
      validateSectionShapes(
        { actions_variables: [{ name: "REGION", value: "eu", extra: undefined }] },
        "f.yml",
      ).isOk(),
    ).toBe(true);
  });
});

describe("secret values are judged at validation, under the document's provenance", () => {
  const LITERAL =
    'the secret entry "DEPLOY_TOKEN" carries a literal value, but settings files are committed plaintext - exactly what secret references exist to prevent. Set it to a whole-value $NAME reference and define NAME in the step\'s env block';

  test("a literal value is refused under the section key, in every secrets-carrying section", () => {
    expect(issuesOf({ actions_secrets: [{ name: "DEPLOY_TOKEN", value: "hunter2" }] })).toEqual([
      `actions_secrets: ${LITERAL}`,
    ]);
    expect(
      issuesOf({
        environments: [{ name: "prod", secrets: [{ name: "DEPLOY_TOKEN", value: "hunter2" }] }],
      }),
    ).toEqual([
      `environments: ${LITERAL.replace('"DEPLOY_TOKEN"', '"DEPLOY_TOKEN" of environment "prod"')}`,
    ]);
    expect(
      issuesOf({ webhooks: [{ config: { url: "https://x.test/h", secret: "prefix-$TOKEN" } }] }),
    ).toEqual([
      'webhooks: the webhook "https://x.test/h" config.secret embeds $TOKEN without being a whole-value reference; it would otherwise ship verbatim as the secret. Make the entire value a single $NAME reference',
    ]);
  });

  test("a whole-value reference passes as an operator's; the same document from a target is refused", () => {
    const doc = { actions_secrets: [{ name: "DEPLOY_TOKEN", value: "$DEPLOY_TOKEN" }] };
    expect(validateSectionShapes(doc, "f.yml").isOk()).toBe(true);
    expect(validateSectionShapes(doc, "f.yml", "operator").isOk()).toBe(true);
    expect(
      validateSectionShapes(doc, "o/r:.github/settings.yml", "target").match(
        () => null,
        (problem) => problem.issues,
      ),
    ).toEqual([
      'actions_secrets: the secret entry "DEPLOY_TOKEN" uses the secret reference $DEPLOY_TOKEN in a target-fetched settings file; ' +
        "references are honored only in operator-owned settings sources, so a target repository cannot read the operator's environment",
    ]);
  });

  test("a secret problem joins the section's other issues in one list, after the shape's own", () => {
    expect(
      issuesOf({
        actions_secrets: [
          { name: "A", value: "hunter2" },
          { name: "a", value: "$A" },
        ],
      }),
    ).toEqual([
      expect.stringMatching(/^actions_secrets\[1\]\.name: /),
      `actions_secrets: the secret entry "A" carries a literal value, but settings files are committed plaintext - exactly what secret references exist to prevent. Set it to a whole-value $NAME reference and define NAME in the step's env block`,
    ]);
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
              consequence: string;
            },
            keyField: listLayering(section.key as ListSection).keyField,
          },
        ],
  );

  test("every closed section refuses a misspelled key by the entry's index and identity, naming the key, its known keys, and its consequence; a correct entry passes", () => {
    expect(Object.keys(ENTRIES).sort()).toEqual(closed.map((section) => section.key).sort());
    for (const { key, surface, keyField } of closed) {
      const entry = ENTRIES[key] as Record<string, unknown>;
      expect(validateSectionShapes({ [key]: [entry] }, "f.yml").isOk(), key).toBe(true);
      const misspelled = { ...entry, permision: "admin" };
      expect(issuesOf({ [key]: [misspelled] }), key).toEqual([
        `${key}[0] (${keyField} ${JSON.stringify(entry[keyField])}): declares "permision", which this section does not recognize ` +
          `(known keys: ${Object.keys(surface.known).join(", ")}) - ${surface.consequence}. Fix the key name, or remove it`,
      ]);
    }
  });

  test("closed-surface entry checks see through the wrapper, spelled as every wrapper issue is (collaborators)", () => {
    expect(
      issuesOf({
        collaborators: { _undeclared: "keep", entries: [{ username: "alice", permision: "x" }] },
      }),
    ).toEqual([
      expect.stringMatching(
        /^collaborators\.entries\[0\] \(username "alice"\): declares "permision", /,
      ),
    ]);
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

describe("every parse error in a document is reported in one run", () => {
  // zod skips an object's own refinements once a nested value failed; the sections' cross-field rules would then
  // surface one run after the typo beside them, and the user fixes the file one run at a time.
  const pinned = Array.from({ length: 11 }, (_, i) => ({ name: `env-${i}`, pinned: true }));
  pinned[0] = { name: "env-0", pinned: true, reviewers: [{ type: "Bot", id: 1 }] } as never;
  test.each<[what: string, doc: Record<string, unknown>, issues: (string | RegExp)[]]>([
    [
      "a property-level enum failure and the object-level pair rule in one environment entry",
      {
        environments: [
          {
            name: "production",
            reviewers: [{ type: "Bot", id: 1 }],
            deployment_branch_policies: [{ name: "release/*" }],
          },
        ],
      },
      [
        /^environments\[0\]\.reviewers\[0\]\.type: Invalid option/,
        /^environments\[0\]\.deployment_branch_policies: the "production" entry declares deployment_branch_policies, so it must also declare deployment_branch_policy with custom_branch_policies: true/,
      ],
    ],
    [
      "a property-level enum failure and the object-level contradiction rule in the actions mapping",
      {
        actions: { allowed_actions: "sometimes", selected_actions: { github_owned_allowed: true } },
      },
      [
        /^actions\.allowed_actions: Invalid option/,
        'actions.selected_actions: selected_actions is declared together with allowed_actions: "sometimes", but an allowlist only applies under allowed_actions: "selected". Set allowed_actions to "selected", or remove selected_actions',
      ],
    ],
    [
      // The rule reads the list's length; a string has one too, and an empty string's is zero.
      "a raw reviewers value beside prevent_self_review: true, which the pair rule does not count as no reviewers",
      { environments: [{ name: "production", prevent_self_review: true, reviewers: "" }] },
      [/^environments\[0\]\.reviewers: Invalid input: expected array, received string/],
    ],
    [
      // zod runs a length check on any value with a length; a raw list's zero is not an empty delimiter.
      "a raw start_delimiter, which the empty-delimiter check does not read as an empty string",
      {
        secret_scanning_custom_patterns: [
          { name: "synthetic-token", pattern: "x", start_delimiter: [] },
        ],
      },
      [
        /^secret_scanning_custom_patterns\[0\]\.start_delimiter: Invalid input: expected string, received array/,
      ],
    ],
    [
      // The rule compares the two flags; two equal raw values are not two false ones.
      "two raw deployment_branch_policy flags, which the exclusive-flag rule does not read as both false",
      {
        environments: [
          {
            name: "production",
            deployment_branch_policy: { protected_branches: 0, custom_branch_policies: 0 },
          },
        ],
      },
      [
        /^environments\[0\]\.deployment_branch_policy\.protected_branches: Invalid input: expected boolean/,
        /^environments\[0\]\.deployment_branch_policy\.custom_branch_policies: Invalid input: expected boolean/,
      ],
    ],
    [
      // The rule branches on the flag; a raw number is truthy without being true.
      "a raw use_default beside include_claim_keys, which the template rule does not read as the default template",
      { actions: { oidc_customization_sub: { use_default: 1, include_claim_keys: ["repo"] } } },
      [/^actions\.oidc_customization_sub\.use_default: Invalid discriminator value/],
    ],
    [
      "a property-level type failure and the object-level misplaced-key rule in one webhook entry",
      {
        webhooks: [{ config: { url: "https://hooks.example/x" }, active: "yes", secret: "$HOOK" }],
      },
      [
        /^webhooks\[0\]\.active: Invalid input: expected boolean/,
        /^webhooks\[0\]\.secret: a webhook secret belongs under config\.secret/,
      ],
    ],
    [
      "a failed entry and the list-level cap rule over its siblings (environments pinned)",
      { environments: pinned },
      [
        /^environments\[0\]\.reviewers\[0\]\.type: Invalid option/,
        /^environments\[10\]\.pinned: .*GitHub allows at most 10 pinned environments per repository/,
      ],
    ],
    [
      "a failed entry and a rule the section attaches to its loosened list (branches wildcard keys)",
      {
        branches: [
          { name: 1, protection: null },
          { name: "release/*", protection: { restrictions: { users: [], teams: [], apps: [] } } },
        ],
      },
      [
        /^branches\[0\]\.name: Invalid input: expected string/,
        /^branches\[1\]\.protection\.restrictions: the wildcard entry "release\/\*" declares protection\.restrictions, which this section does not manage on wildcard rules/,
      ],
    ],
    [
      "a rule branching on a failed sibling's type guards the read: no false wildcard finding for a mapping name",
      {
        branches: [
          {
            name: { main: true },
            protection: { restrictions: { users: [], teams: [], apps: [] } },
          },
        ],
      },
      [/^branches\[0\]\.name: Invalid input: expected string/],
    ],
    [
      "a rule judging the failed value itself adds nothing: the shape's own issue there is the report",
      { branches: [{ name: "release/*", protection: "yes" }] },
      [/^branches\[0\]\.protection: Invalid input: expected object/],
    ],
    [
      "two sections each with a shape failure",
      { labels: [{ name: 1 }], pages: { source: null } },
      [
        /^labels\[0\]\.name: Invalid input: expected string/,
        "pages.source has no empty state; write a mapping of its fields",
      ],
    ],
  ])("%s", (_what, doc, issues) => {
    expect(issuesOf(doc)).toEqual(
      issues.map((issue) => (typeof issue === "string" ? issue : expect.stringMatching(issue))),
    );
  });
});
