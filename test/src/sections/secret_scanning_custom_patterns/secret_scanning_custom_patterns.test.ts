import { describe, expect, test } from "bun:test";
import { validateSettingsDoc } from "../../../../src/engine/orchestrate.js";
import { SectionSelection } from "../../../../src/engine/section-selection.js";
import { snapshotRepository } from "../../../../src/engine/snapshot.js";
import { silentIo } from "../../../../src/io.js";
import { describeProblem } from "../../../../src/problem.js";
import type { SectionInput } from "../../../../src/sections/contract/module.js";
import {
  type PlainData,
  planContext,
  type SectionPlan,
} from "../../../../src/sections/contract/plan.js";
import { secretScanningPatternsSection } from "../../../../src/sections/secret_scanning_custom_patterns/index.js";
import type { SecretScanningPatternConfig } from "../../../../src/sections/secret_scanning_custom_patterns/schema.js";
import { captureIo } from "../../../io/capture.js";
import { MockApi } from "../../../mock-api.js";
import { fragmentFake } from "../../../sections/fragment-fake.js";
import { provePlanIdempotent } from "../../../sections/plan-idempotence.js";
import { REPO, unwrap } from "../../../sections/section-run.js";
import { validatedInput } from "../../../sections/validated-input.js";
import { secretScanningCustomPatternsMockHandlers } from "./mock.js";

/** The bare-array list body the mock serves for a live pattern set. */
function listRoute(patterns: Array<Record<string, unknown>>) {
  return {
    "GET /repos/o/r/secret-scanning/custom-patterns?per_page=100&page=1": { data: patterns },
  };
}

/** A complete live GET-shape pattern; overrides win. */
function livePattern(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 1,
    name: "internal-token",
    slug: "internal-token",
    pattern: "int_[a-z0-9]{8}",
    state: "published",
    push_protection_enabled: false,
    custom_pattern_version: "v1",
    ...overrides,
  };
}

const plan = async (api: MockApi, desired: SectionInput<"secret_scanning_custom_patterns">) =>
  unwrap(
    await secretScanningPatternsSection.plan(
      planContext(secretScanningPatternsSection, api, REPO),
      validatedInput("secret_scanning_custom_patterns", desired),
    ),
  );

/** A plan with every change thunk rendered; the section builds the lines at plan time. */
function rendered(result: SectionPlan) {
  return {
    ...result,
    ops: result.ops.map((op) => ({
      ...op,
      change: typeof op.change === "function" ? [unwrap(op.change(null))].flat() : [op.change],
    })),
  };
}

const INTERNAL: SecretScanningPatternConfig = {
  name: "internal-token",
  pattern: "int_[a-z0-9]{8}",
};

describe("secret_scanning_custom_patterns", () => {
  test("plans one bulk create, one versioned PATCH of only the divergent fields, and keeps undeclared by default", async () => {
    // A fake that would accept any write: the plan must still issue none.
    const api = new MockApi(
      listRoute([
        livePattern({
          id: 5,
          name: "internal-token",
          pattern: "old_[0-9]{4}",
          end_delimiter: "\\z",
        }),
        livePattern({ id: 6, name: "unmanaged", custom_pattern_version: "v3" }),
      ]),
      { unroutedMutations: "succeed" },
    );
    const result = await plan(api, [
      { ...INTERNAL, end_delimiter: "\\b" },
      { name: "vendor-key", pattern: "key-[0-9]{6}", start_delimiter: "\\b" },
    ]);
    expect(rendered(result)).toEqual({
      ops: [
        {
          role: "create",
          payload: {
            patterns: [{ name: "vendor-key", pattern: "key-[0-9]{6}", start_delimiter: "\\b" }],
          },
          describe: 'creating secret scanning pattern "vendor-key"',
          drift: [
            "secret_scanning_custom_patterns[vendor-key]: missing - declared in the settings file but not on the repo; apply will create it",
          ],
          change: ['created secret scanning custom pattern "vendor-key"'],
        },
        {
          role: "update",
          params: { pattern_id: "5" },
          payload: {
            custom_pattern_version: "v1",
            pattern: "int_[a-z0-9]{8}",
            end_delimiter: "\\b",
          },
          describe: 'updating secret scanning pattern "internal-token"',
          drift: [
            'secret_scanning_custom_patterns[internal-token].pattern: declared "int_[a-z0-9]{8}" != live "old_[0-9]{4}"; apply will set the declared value',
            'secret_scanning_custom_patterns[internal-token].end_delimiter: declared "\\\\b" != live "\\\\z"; apply will set the declared value',
          ],
          change: ['updated secret scanning custom pattern "internal-token"'],
        },
      ],
      notes: [
        'secret scanning custom pattern "unmanaged" exists on the repo but is not declared in ' +
          'the settings file; kept under "_undeclared: keep" - add it to the settings file to ' +
          'manage it, or set "_undeclared: delete" to have apply DELETE it (its alerts are then ' +
          "resolved, not deleted)",
      ],
      drift: [],
    });
    expect(api.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  test.each<[form: string, live: Record<string, unknown>, declared: SecretScanningPatternConfig]>([
    [
      "an undeclared optional is never compared: a live delimiter alone",
      { start_delimiter: "\\A|[^0-9A-Za-z]", must_match: ["^prefix"] },
      INTERNAL,
    ],
    [
      "the must_match list in the same order",
      { must_match: ["a", "b"] },
      { ...INTERNAL, must_match: ["a", "b"] },
    ],
    [
      "a declared empty list against a live null or absent list",
      { must_match: null, must_not_match: undefined },
      { ...INTERNAL, must_match: [], must_not_match: [] },
    ],
  ])("%s plans nothing", async (_form, live, declared) => {
    expect(await plan(new MockApi(listRoute([livePattern(live)])), [declared])).toEqual({
      ops: [],
      notes: [],
      drift: [],
    });
  });

  test.each<
    [
      form: string,
      live: Record<string, unknown>,
      declared: SecretScanningPatternConfig,
      payload: PlainData,
    ]
  >([
    [
      "the must_match list reordered (compared in order)",
      { must_match: ["a", "b"] },
      { ...INTERNAL, must_match: ["b", "a"] },
      { custom_pattern_version: "v1", must_match: ["b", "a"] },
    ],
    [
      "a declared empty list against a live non-empty one",
      { must_match: ["a"] },
      { ...INTERNAL, must_match: [] },
      { custom_pattern_version: "v1", must_match: [] },
    ],
    [
      "a version-less live pattern (custom_pattern_version: null skips the concurrency check)",
      { pattern: "old_[0-9]{4}", custom_pattern_version: undefined },
      INTERNAL,
      { custom_pattern_version: null, pattern: "int_[a-z0-9]{8}" },
    ],
  ])("%s plans one PATCH carrying %j", async (_form, live, declared, payload) => {
    const result = await plan(new MockApi(listRoute([livePattern(live)])), [declared]);
    expect(result.ops.map((op) => [op.role, op.params, op.payload])).toEqual([
      ["update", { pattern_id: "1" }, payload],
    ]);
  });

  test("several creates and deletes name their patterns in the plural", async () => {
    const api = new MockApi(
      listRoute([livePattern({ id: 1, name: "old-a" }), livePattern({ id: 2, name: "old-b" })]),
    );
    const result = await plan(api, {
      _undeclared: "delete",
      entries: [
        { name: "new-a", pattern: "a_[0-9]{4}" },
        { name: "new-b", pattern: "b_[0-9]{4}" },
      ],
    });
    expect(rendered(result).ops.map((op) => op.describe)).toEqual([
      'creating secret scanning patterns "new-a", "new-b"',
      'deleting undeclared secret scanning patterns "old-a", "old-b"',
    ]);
  });

  test("a rename is create plus bulk delete under _undeclared:delete, never a PATCH (no rename inference)", async () => {
    // The declared pattern carries the same fields as the live one, only the name differs: the name is the identity.
    const api = new MockApi(
      listRoute([livePattern({ id: 9, name: "old-name", custom_pattern_version: "v7" })]),
    );
    const result = await plan(api, {
      _undeclared: "delete",
      entries: [{ name: "new-name", pattern: "int_[a-z0-9]{8}" }],
    });
    expect(rendered(result).ops).toEqual([
      {
        role: "create",
        payload: { patterns: [{ name: "new-name", pattern: "int_[a-z0-9]{8}" }] },
        describe: 'creating secret scanning pattern "new-name"',
        drift: [
          "secret_scanning_custom_patterns[new-name]: missing - declared in the settings file but not on the repo; apply will create it",
        ],
        change: ['created secret scanning custom pattern "new-name"'],
      },
      {
        role: "remove",
        payload: {
          patterns: [{ pattern_id: 9, custom_pattern_version: "v7" }],
          post_delete_action: "resolve_alerts",
        },
        describe: 'deleting undeclared secret scanning pattern "old-name"',
        drift: [
          'secret_scanning_custom_patterns[old-name]: undeclared - not in the settings file and "_undeclared: delete" is set, so apply will DELETE it and resolve its alerts; add it to the settings file to keep it',
        ],
        change: [
          'DELETED undeclared secret scanning custom pattern "old-name" (alerts resolved, not deleted)',
        ],
      },
    ]);
    const kept = await plan(api, [{ name: "new-name", pattern: "int_[a-z0-9]{8}" }]);
    expect(kept.ops.map((op) => op.role)).toEqual(["create"]);
    expect(kept.notes).toHaveLength(1);
    expect(kept.notes[0]).toContain('"old-name"');
  });

  test("the bulk DELETE always sends resolve_alerts and each pattern's version, omitting a version-less one", async () => {
    // resolve_alerts is policy, not configuration: upstream's delete_alerts default is never sent and no knob exists.
    const api = new MockApi(
      listRoute([
        livePattern({ id: 3, name: "stale-a", custom_pattern_version: "v3" }),
        livePattern({ id: 4, name: "stale-b", custom_pattern_version: "v9" }),
        livePattern({ id: 5, name: "stale-c", custom_pattern_version: undefined }),
      ]),
    );
    const result = await plan(api, { _undeclared: "delete", entries: [] });
    expect(result.ops.map((op) => [op.role, op.payload])).toEqual([
      [
        "remove",
        {
          patterns: [
            { pattern_id: 3, custom_pattern_version: "v3" },
            { pattern_id: 4, custom_pattern_version: "v9" },
            { pattern_id: 5 },
          ],
          post_delete_action: "resolve_alerts",
        },
      ],
    ]);
    expect(result.ops[0]?.drift).toHaveLength(3);
  });

  test("two entries with the same name are a validate issue, so the document fails before any API call", () => {
    expect(
      secretScanningPatternsSection.validate([
        { name: "dup", pattern: "a" },
        { name: "dup", pattern: "b" },
      ]),
    ).toEqual([
      {
        path: "[1].name",
        message:
          '"dup" names the same custom pattern as "dup" declared earlier; keep exactly one entry per custom pattern',
      },
    ]);
  });

  test.each<[form: string, live: Record<string, unknown>, at: RegExp]>([
    ["no id", { name: "no-id" }, /\[0\]\.id/],
    ["a non-string name", { id: 1, name: 5 }, /\[0\]\.name/],
    // string = concurrency token, null/absent = none offered; anything else must not quietly disable the 412 protection.
    [
      "a numeric version",
      livePattern({ custom_pattern_version: 7 }),
      /\[0\]\.custom_pattern_version/,
    ],
  ])("a live entry with %s is a loud contract violation", async (_form, live, at) => {
    const rejection = plan(new MockApi(listRoute([live])), []).catch(
      (error: Error) => error.message,
    );
    await expect(rejection).resolves.toMatch(/returned a body outside the documented shape/);
    await expect(rejection).resolves.toMatch(at);
  });

  test("an empty delimiter is rejected at document validation (clearing is not expressible)", () => {
    // "" cannot mean "clear it": the PATCH updates provided fields only.
    for (const key of ["start_delimiter", "end_delimiter"] as const) {
      const doc = { secret_scanning_custom_patterns: [{ ...INTERNAL, [key]: "" }] };
      const invalid = validateSettingsDoc(doc, "test doc", SectionSelection.ALL, silentIo());
      expect(invalid.match(() => "", describeProblem)).toContain(
        "cannot be cleared with an empty string",
      );
    }
  });

  test("executing the plan against the mock fragment converges: the re-plan is empty", async () => {
    const api = fragmentFake(
      secretScanningPatternsSection,
      secretScanningCustomPatternsMockHandlers,
      {
        secret_scanning_patterns: [
          livePattern({ id: 501, name: "internal-token", pattern: "int_[a-z0-9]{16}" }),
          livePattern({ id: 502, name: "retired", custom_pattern_version: "v2" }),
        ],
      },
    );
    const { second, changes, notes } = await provePlanIdempotent(
      secretScanningPatternsSection,
      api,
      {
        _undeclared: "delete",
        entries: [
          { ...INTERNAL, start_delimiter: "\\b" },
          { name: "vendor-key", pattern: "key-[0-9]{6}", must_not_match: ["example"] },
        ],
      },
    );
    expect(changes).toEqual([
      'created secret scanning custom pattern "vendor-key"',
      'updated secret scanning custom pattern "internal-token"',
      'DELETED undeclared secret scanning custom pattern "retired" (alerts resolved, not deleted)',
    ]);
    expect(notes).toEqual([]);
    expect(api.writes).toEqual([
      "POST /repos/o/r/secret-scanning/custom-patterns",
      "PATCH /repos/o/r/secret-scanning/custom-patterns/501",
      "DELETE /repos/o/r/secret-scanning/custom-patterns",
    ]);
    expect(second).toEqual({ ops: [], notes: [], drift: [] });
    expect(
      api.state.secret_scanning_patterns.map((p) => [p.name, p.pattern, p.start_delimiter]),
    ).toEqual([
      ["internal-token", "int_[a-z0-9]{8}", "\\b"],
      ["vendor-key", "key-[0-9]{6}", undefined],
    ]);
  });
});

describe("secret_scanning_custom_patterns snapshot", () => {
  const snapshot = (patterns: Array<Record<string, unknown>>) =>
    snapshotRepository(
      new MockApi(listRoute(patterns)),
      {
        repo: REPO,
        sections: SectionSelection.of({
          only: ["secret_scanning_custom_patterns"],
        })._unsafeUnwrap(),
        onMissingPermission: "fail",
      },
      captureIo().io,
    );

  // GitHub compiles these with Hyperscan and holds them; a JavaScript RegExp alone refuses each, and
  // a live value has no file-side fix, so the snapshot must translate rather than fail.
  test.each([
    ["a plain pattern (control)", "key_[A-Z0-9]{32}"],
    ["a Python-style named group", "(?P<token>key_[A-Z0-9]{32})"],
    ["an inline comment", "(?#vendor)key_[A-Z0-9]{32}"],
    ["a braced hex escape in a class range", "[\\x{41}-\\x{5A}]{32}"],
  ])("a live pattern with %s reads back verbatim", async (_form, pattern) => {
    const result = await snapshot([livePattern({ id: 7, name: "vendor-key", pattern })]);
    expect(result.result).toBe("snapshot");
    expect(result.outcomes).toEqual([
      { key: "secret_scanning_custom_patterns", status: "snapshot", detail: [] },
    ]);
    expect<unknown>(result.settings?.secret_scanning_custom_patterns).toEqual({
      _undeclared: "keep",
      entries: [{ name: "vendor-key", pattern }],
    });
  });

  test("a live pattern no dialect parses is left out with a note naming it, never a failed snapshot", async () => {
    // GitHub would not hold an unbalanced group, but the mock can, and the guard must hold for
    // whatever the translation table does not cover: the entry is left out, the rest is written.
    const result = await snapshot([
      livePattern({ id: 7, name: "vendor-key", pattern: "key_[A-Z0-9]{32}" }),
      livePattern({ id: 8, name: "odd-one", pattern: "(key_[A-Z0-9]{32}", must_match: ["[0-9"] }),
    ]);
    expect(result.result).toBe("snapshot");
    expect(result.outcomes).toEqual([
      {
        key: "secret_scanning_custom_patterns",
        status: "snapshot",
        detail: [
          // The engine's own reason sits in each parenthesis; its wording is the runtime's, not pinned.
          expect.stringMatching(
            new RegExp(
              "^secret_scanning_custom_patterns\\[odd-one\\]: left out of the snapshot - " +
                "its pattern \\(Invalid regular expression: .+\\), must_match\\[0\\] \\(Invalid regular expression: .+\\) " +
                "cannot be verified as regular expressions by this tool; the pattern stays live and undeclared under the keep default$",
            ),
          ),
        ],
      },
    ]);
    expect<unknown>(result.settings?.secret_scanning_custom_patterns).toEqual({
      _undeclared: "keep",
      entries: [{ name: "vendor-key", pattern: "key_[A-Z0-9]{32}" }],
    });
  });

  test.each<[form: string, live: Record<string, unknown>]>([
    ["a list where a string belongs", { pattern: ["("] }],
    [
      "a number where a string belongs, beside an unverifiable list",
      { pattern: 7, must_match: ["("] },
    ],
  ])("a live entry with %s is still the engine's BUG, not a left-out note", async (_form, live) => {
    // The left-out path is for values the check cannot verify, never for a body outside the shape.
    const result = await snapshot([livePattern({ id: 8, name: "odd-one", ...live })]);
    expect(result.result).toBe("failed");
    expect(result.outcomes[0]?.detail).toEqual([expect.stringMatching(/^BUG: /)]);
  });

  test("a live set whose every pattern is left out snapshots as an empty declaration under keep, with only the notes", async () => {
    // Something exists on the repository, so the outcome must not also say nothing does: the left-out
    // pattern stays live under the keep policy the empty declaration spells.
    const result = await snapshot([livePattern({ id: 8, name: "odd-one", pattern: "(key" })]);
    expect(result.result).toBe("snapshot");
    expect<unknown>(result.settings?.secret_scanning_custom_patterns).toEqual({
      _undeclared: "keep",
      entries: [],
    });
    expect(result.outcomes[0]?.detail).toEqual([
      expect.stringMatching(
        /^secret_scanning_custom_patterns\[odd-one\]: left out of the snapshot - its pattern \(/,
      ),
    ]);
  });
});
