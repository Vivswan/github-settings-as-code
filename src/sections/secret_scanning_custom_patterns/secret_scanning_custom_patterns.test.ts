import { describe, expect, test } from "bun:test";
import { MockApi } from "../../../test/mock-api.js";
import { ctx } from "../../../test/sections/context.js";
import { validateSettingsDoc } from "../../engine/orchestrate.js";
import type { Io } from "../../io.js";
import { secretScanningPatternsSection } from "./index.js";

/** A no-op Io so validateSettingsDoc can run without @actions/core. */
const silentIo: Io = { annotate() {}, log() {}, mask() {} };

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

describe("secret_scanning_custom_patterns", () => {
  test("creates missing, updates divergent declared fields, keeps undeclared by default", async () => {
    const api = new MockApi(
      listRoute([
        livePattern({ id: 5, name: "internal-token", pattern: "old_[0-9]{4}" }),
        livePattern({ id: 6, name: "unmanaged", custom_pattern_version: "v3" }),
      ]),
    ).allowMutations(
      "POST /repos/o/r/secret-scanning/custom-patterns",
      "PATCH /repos/o/r/secret-scanning/custom-patterns/*",
    );
    const result = await secretScanningPatternsSection.run(ctx(api), [
      { name: "internal-token", pattern: "int_[a-z0-9]{8}" },
      { name: "vendor-key", pattern: "key-[0-9]{6}", start_delimiter: "\\b" },
    ]);
    expect(result.changes).toEqual([
      'created secret scanning custom pattern "vendor-key"',
      'updated secret scanning custom pattern "internal-token"',
    ]);
    expect(result.notes).toEqual([
      'secret scanning custom pattern "unmanaged" exists on the repo but is not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply DELETE it (its alerts are then resolved, not deleted)',
    ]);
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "POST /repos/o/r/secret-scanning/custom-patterns",
      "PATCH /repos/o/r/secret-scanning/custom-patterns/5",
    ]);
    // ONE bulk POST carrying every missing pattern with its declared fields.
    expect(api.mutations()[0]?.payload).toEqual({
      patterns: [{ name: "vendor-key", pattern: "key-[0-9]{6}", start_delimiter: "\\b" }],
    });
    // The PATCH sends the live version plus ONLY the divergent fields.
    expect(api.mutations()[1]?.payload).toEqual({
      custom_pattern_version: "v1",
      pattern: "int_[a-z0-9]{8}",
    });
  });

  test("an undeclared optional is never compared: a live delimiter alone is converged", async () => {
    const api = new MockApi(
      listRoute([livePattern({ start_delimiter: "\\A|[^0-9A-Za-z]", must_match: ["^prefix"] })]),
    );
    const result = await secretScanningPatternsSection.run(ctx(api), [
      { name: "internal-token", pattern: "int_[a-z0-9]{8}" },
    ]);
    expect(result.changes).toEqual([]);
    // An apply-mode result has no drift list at all (the mode-split types).
    expect(result.drift).toBeUndefined();
    expect(api.mutations()).toEqual([]);
  });

  test("the must_match lists compare by value, in order", async () => {
    const api = new MockApi(listRoute([livePattern({ must_match: ["a", "b"] })])).allowMutations(
      "PATCH /repos/o/r/secret-scanning/custom-patterns/*",
    );
    // Same values -> converged; different order -> an update.
    const same = await secretScanningPatternsSection.run(ctx(api), [
      { name: "internal-token", pattern: "int_[a-z0-9]{8}", must_match: ["a", "b"] },
    ]);
    expect(same.changes).toEqual([]);
    const reordered = await secretScanningPatternsSection.run(ctx(api), [
      { name: "internal-token", pattern: "int_[a-z0-9]{8}", must_match: ["b", "a"] },
    ]);
    expect(reordered.changes).toEqual(['updated secret scanning custom pattern "internal-token"']);
    expect(api.mutations()[0]?.payload).toEqual({
      custom_pattern_version: "v1",
      must_match: ["b", "a"],
    });
  });

  test("a declared empty list equals a live null or absent list (no perpetual rewrite)", async () => {
    // The GET marks the lists nullable, so a declared [] against a live
    // null would otherwise diverge and PATCH [] on EVERY run - forever, if
    // GitHub stores [] back as null. Both spellings of "no list" converge.
    const api = new MockApi(
      listRoute([livePattern({ must_match: null, must_not_match: undefined })]),
    );
    const applied = await secretScanningPatternsSection.run(ctx(api), [
      { name: "internal-token", pattern: "int_[a-z0-9]{8}", must_match: [], must_not_match: [] },
    ]);
    expect(applied.changes).toEqual([]);
    expect(api.mutations()).toEqual([]);
    const checked = await secretScanningPatternsSection.run(ctx(api, true), [
      { name: "internal-token", pattern: "int_[a-z0-9]{8}", must_match: [], must_not_match: [] },
    ]);
    expect(checked.drift).toEqual([]);
  });

  test("a declared empty list still clears a live non-empty one", async () => {
    const api = new MockApi(listRoute([livePattern({ must_match: ["a"] })])).allowMutations(
      "PATCH /repos/o/r/secret-scanning/custom-patterns/*",
    );
    const result = await secretScanningPatternsSection.run(ctx(api), [
      { name: "internal-token", pattern: "int_[a-z0-9]{8}", must_match: [] },
    ]);
    expect(result.changes).toEqual(['updated secret scanning custom pattern "internal-token"']);
    expect(api.mutations()[0]?.payload).toEqual({ custom_pattern_version: "v1", must_match: [] });
  });

  test("a rename is delete plus create under undeclared:delete - never a PATCH (no rename inference)", async () => {
    const api = new MockApi(
      listRoute([livePattern({ id: 9, name: "old-name", custom_pattern_version: "v7" })]),
    ).allowMutations(
      "POST /repos/o/r/secret-scanning/custom-patterns",
      "DELETE /repos/o/r/secret-scanning/custom-patterns",
    );
    // The declared pattern carries the SAME fields as the live one, only the
    // name differs: still create + delete, because the name is the identity.
    const result = await secretScanningPatternsSection.run(ctx(api), {
      undeclared: "delete",
      entries: [{ name: "new-name", pattern: "int_[a-z0-9]{8}" }],
    });
    expect(result.changes).toEqual([
      'created secret scanning custom pattern "new-name"',
      'DELETED undeclared secret scanning custom pattern "old-name" (alerts resolved, not deleted)',
    ]);
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "POST /repos/o/r/secret-scanning/custom-patterns",
      "DELETE /repos/o/r/secret-scanning/custom-patterns",
    ]);
  });

  test("a rename under the DEFAULT keep creates the new name and only NOTES the old one", async () => {
    // "Delete plus create" holds only under undeclared: delete; the default
    // keep policy leaves the renamed-away pattern live, surfaced as a note.
    const api = new MockApi(
      listRoute([livePattern({ id: 9, name: "old-name", custom_pattern_version: "v7" })]),
    ).allowMutations("POST /repos/o/r/secret-scanning/custom-patterns");
    const result = await secretScanningPatternsSection.run(ctx(api), [
      { name: "new-name", pattern: "int_[a-z0-9]{8}" },
    ]);
    expect(result.changes).toEqual(['created secret scanning custom pattern "new-name"']);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain('"old-name"');
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "POST /repos/o/r/secret-scanning/custom-patterns",
    ]);
  });

  test("the bulk DELETE always sends resolve_alerts and each pattern's version", async () => {
    // The resolve_alerts stance is policy, not configuration: a settings
    // change must never destroy alert history, so upstream's delete_alerts
    // default is never sent and no knob exists.
    const api = new MockApi(
      listRoute([
        livePattern({ id: 3, name: "stale-a", custom_pattern_version: "v3" }),
        livePattern({ id: 4, name: "stale-b", custom_pattern_version: "v9" }),
      ]),
    ).allowMutations("DELETE /repos/o/r/secret-scanning/custom-patterns");
    await secretScanningPatternsSection.run(ctx(api), { undeclared: "delete", entries: [] });
    expect(api.mutations()).toHaveLength(1);
    expect(api.mutations()[0]?.payload).toEqual({
      patterns: [
        { pattern_id: 3, custom_pattern_version: "v3" },
        { pattern_id: 4, custom_pattern_version: "v9" },
      ],
      post_delete_action: "resolve_alerts",
    });
  });

  test("check mode reports per-field drift, creates, and deletes without mutating", async () => {
    const api = new MockApi(
      listRoute([
        livePattern({ id: 5, pattern: "old_[0-9]{4}", end_delimiter: "\\z" }),
        livePattern({ id: 6, name: "stale" }),
      ]),
    );
    const result = await secretScanningPatternsSection.run(ctx(api, true), {
      undeclared: "delete",
      entries: [
        { name: "internal-token", pattern: "int_[a-z0-9]{8}", end_delimiter: "\\b" },
        { name: "vendor-key", pattern: "key-[0-9]{6}" },
      ],
    });
    expect(result.drift).toEqual([
      'secret_scanning_custom_patterns[internal-token].pattern: declared "int_[a-z0-9]{8}" != live "old_[0-9]{4}"; apply will set the declared value',
      'secret_scanning_custom_patterns[internal-token].end_delimiter: declared "\\\\b" != live "\\\\z"; apply will set the declared value',
      "secret_scanning_custom_patterns[vendor-key]: missing - declared in the settings file but not on the repo; apply will create it",
      "secret_scanning_custom_patterns[stale]: undeclared - not in the settings file, so apply will DELETE it and resolve its alerts; add it to the settings file to keep it",
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("check mode under the keep default notes the undeclared pattern instead of drifting", async () => {
    const api = new MockApi(listRoute([livePattern({})]));
    const result = await secretScanningPatternsSection.run(ctx(api, true), []);
    expect(result.drift).toEqual([]);
    expect(result.notes).toHaveLength(1);
  });

  test("two entries with the same name are rejected before any API call", async () => {
    const api = new MockApi({});
    await expect(
      secretScanningPatternsSection.run(ctx(api), [
        { name: "dup", pattern: "a" },
        { name: "dup", pattern: "b" },
      ]),
    ).rejects.toThrow(/same secret_scanning_custom_patterns entry/);
    expect(api.calls).toHaveLength(0);
  });

  test("an empty delimiter is rejected at document validation (clearing is not expressible)", async () => {
    // "" cannot mean "clear it": the PATCH updates provided fields only, and
    // a normalize-back-to-null would repeat the write forever. The rejection
    // lives in the zod shape, so an invalid document fails BOTH modes before
    // any repository is touched (the run() path below proves the shape is
    // what rejects, with zero API calls).
    for (const key of ["start_delimiter", "end_delimiter"] as const) {
      const doc = {
        secret_scanning_custom_patterns: [
          { name: "internal-token", pattern: "int_[a-z0-9]{8}", [key]: "" },
        ],
      };
      const invalid = validateSettingsDoc(doc, "test doc", new Set(), silentIo);
      expect("error" in invalid ? invalid.error : "").toContain(
        "cannot be cleared with an empty string",
      );
    }
  });

  test("a live entry without a string name or numeric id is a loud contract violation", async () => {
    const api = new MockApi(listRoute([{ name: "no-id" }]));
    await expect(secretScanningPatternsSection.run(ctx(api), [])).rejects.toThrow(
      /without a string "name" and numeric "id"/,
    );
  });

  test("a non-string, non-null live version is a loud contract violation, never a silent bypass", async () => {
    // string = concurrency token; null/absent = none offered; a number (or
    // anything else) must not quietly disable the 412 protection.
    const api = new MockApi(
      listRoute([livePattern({ id: 5, name: "stale", custom_pattern_version: 7 })]),
    );
    await expect(secretScanningPatternsSection.run(ctx(api), [])).rejects.toThrow(
      /non-string custom_pattern_version \(7\)/,
    );
  });

  test("a version-less live pattern updates with custom_pattern_version: null", async () => {
    // The GET marks the version optional AND nullable, and the PATCH body
    // requires the key but accepts null: a pattern predating the versioning
    // field writes without the concurrency check, as GitHub itself allows -
    // it must never brick the run.
    const api = new MockApi(
      listRoute([
        livePattern({
          id: 5,
          name: "internal-token",
          pattern: "old_[0-9]{4}",
          custom_pattern_version: undefined,
        }),
      ]),
    ).allowMutations("PATCH /repos/o/r/secret-scanning/custom-patterns/5");
    const result = await secretScanningPatternsSection.run(ctx(api), [
      { name: "internal-token", pattern: "int_[a-z0-9]{8}" },
    ]);
    expect(result.changes).toEqual(['updated secret scanning custom pattern "internal-token"']);
    expect(api.mutations()[0]?.payload).toEqual({
      custom_pattern_version: null,
      pattern: "int_[a-z0-9]{8}",
    });
  });

  test("a version-less undeclared pattern deletes with the version field omitted", async () => {
    // The bulk DELETE's per-entry schema requires only pattern_id; check
    // mode reports the same will-DELETE drift without throwing, and keep
    // stays a note.
    const versionless = livePattern({
      id: 5,
      name: "stale",
      custom_pattern_version: undefined,
    });
    const checkApi = new MockApi(listRoute([versionless]));
    const checked = await secretScanningPatternsSection.run(ctx(checkApi, true), {
      undeclared: "delete",
      entries: [],
    });
    expect(checked.drift?.join("\n")).toContain("apply will DELETE it");
    const applyApi = new MockApi(listRoute([versionless])).allowMutations(
      "DELETE /repos/o/r/secret-scanning/custom-patterns",
    );
    await secretScanningPatternsSection.run(ctx(applyApi), {
      undeclared: "delete",
      entries: [],
    });
    expect(applyApi.mutations()[0]?.payload).toEqual({
      patterns: [{ pattern_id: 5 }],
      post_delete_action: "resolve_alerts",
    });
    const keepApi = new MockApi(listRoute([versionless]));
    const kept = await secretScanningPatternsSection.run(ctx(keepApi, true), []);
    expect(kept.notes).toHaveLength(1);
  });
});

describe("secret_scanning_custom_patterns closed surface", () => {
  test("rejects the read-only state and push_protection_enabled keys BY NAME, before any call", () => {
    // True by construction (closedSurface lists the six declared fields),
    // but no other test names the two read-only fields a user would most
    // plausibly try to declare.
    for (const key of ["state", "push_protection_enabled"]) {
      const error = validateSettingsDoc(
        {
          secret_scanning_custom_patterns: [
            { name: "internal-token", pattern: "int_[a-z0-9]{8}", [key]: true },
          ],
        },
        "settings.yml",
        new Set(),
        silentIo,
      );
      expect("error" in error, `a declared "${key}" must be rejected`).toBe(true);
      const message = "error" in error ? error.error : "";
      expect(message).toContain(`"${key}"`);
      expect(message).toContain("read-only");
    }
  });
});
