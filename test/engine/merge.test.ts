import { describe, expect, test } from "bun:test";
import { applyDefaults, deepMerge } from "../../src/engine/merge.js";
import { validateSettingsDoc } from "../../src/engine/orchestrate.js";
import type { SettingsFile } from "../../src/schema.js";
import { silentIo } from "../io-fake.js";

/**
 * applyDefaults hands back the merged document UNVALIDATED (unknown) - only
 * validateSettingsDoc can bless it - so the shape assertions below funnel
 * through this one test-local cast.
 */
function apply(
  defaults: SettingsFile,
  repo: unknown,
): { settings: SettingsFile; disabled: string[] } {
  const { settings, disabled } = applyDefaults(defaults, repo);
  return { settings: settings as SettingsFile, disabled };
}

describe("deepMerge", () => {
  test("objects merge recursively, override keys win", () => {
    const base = { repository: { has_wiki: false, description: "base" } };
    const override = { repository: { description: "mine" }, labels: [{ name: "bug" }] };
    expect(deepMerge(base, override)).toEqual({
      repository: { has_wiki: false, description: "mine" },
      labels: [{ name: "bug" }],
    });
  });

  test("arrays and scalars replace, never concatenate", () => {
    const base = { labels: [{ name: "a" }, { name: "b" }], repository: { topics: "x, y" } };
    const override = { labels: [{ name: "c" }], repository: { topics: "z" } };
    expect(deepMerge(base, override)).toEqual({
      labels: [{ name: "c" }],
      repository: { topics: "z" },
    });
  });

  test("nested null replaces the base value", () => {
    const merged = deepMerge(
      { branches: [{ name: "main", protection: { enforce_admins: true } }] },
      { branches: [{ name: "main", protection: null }] },
    ) as { branches: Array<{ protection: unknown }> };
    expect(merged.branches[0]?.protection).toBeNull();
  });

  test("never mutates its inputs", () => {
    const base = { repository: { has_wiki: false } };
    const override = { repository: { has_issues: true } };
    const merged = deepMerge(base, override) as { repository: Record<string, unknown> };
    merged.repository.has_wiki = true;
    expect(base.repository.has_wiki).toBe(false);
    expect(override).toEqual({ repository: { has_issues: true } });
  });
});

describe("applyDefaults", () => {
  test("top-level null section is stripped and reported as disabled", () => {
    const defaults = { labels: [{ name: "bug", color: "d73a4a" }] } as SettingsFile;
    const repo = { labels: null, repository: { has_wiki: false } } as unknown as SettingsFile;
    const { settings, disabled } = apply(defaults, repo);
    expect(disabled).toEqual(["labels"]);
    expect("labels" in settings).toBe(false);
    expect(settings.repository).toEqual({ has_wiki: false });
  });

  test("empty defaults leave the repo settings untouched", () => {
    const repo = { repository: { has_wiki: false } } as SettingsFile;
    const { settings, disabled } = apply({}, repo);
    expect(settings).toEqual(repo);
    expect(disabled).toEqual([]);
  });

  test("a null section the defaults do not declare passes through", () => {
    const defaults = { repository: { has_wiki: false } } as SettingsFile;
    const repo = { pages: null } as SettingsFile;
    const { settings, disabled } = apply(defaults, repo);
    expect(settings.pages).toBeNull();
    expect(disabled).toEqual([]);
  });

  test("a null section the defaults declare non-null is still an opt-out", () => {
    const defaults = { pages: { build_type: "workflow" } } as SettingsFile;
    const repo = { pages: null } as SettingsFile;
    const { settings, disabled } = apply(defaults, repo);
    expect("pages" in settings).toBe(false);
    expect(disabled).toEqual(["pages"]);
  });

  test("a null section in the defaults themselves passes through to every target", () => {
    const defaults = { pages: null } as SettingsFile;
    const { settings, disabled } = apply(defaults, {});
    expect(settings.pages).toBeNull();
    expect(disabled).toEqual([]);
  });
});

describe("applyDefaults undeclared-policy knob", () => {
  test("a target's plain array inherits the defaults-file policy (array over wrapper)", () => {
    const defaults = {
      labels: { undeclared: "keep", entries: [{ name: "fleet" }] },
    } as SettingsFile;
    const repo = { labels: [{ name: "mine" }] } as SettingsFile;
    const { settings } = apply(defaults, repo);
    // Entries replace wholesale (arrays never concatenate); the policy the
    // target never spelled comes from the defaults.
    expect(settings.labels).toEqual({ undeclared: "keep", entries: [{ name: "mine" }] });
  });

  test("a target's explicit policy wins over the defaults' (wrapper over array)", () => {
    const defaults = { rulesets: [{ name: "fleet" }] } as SettingsFile;
    const repo = {
      rulesets: { undeclared: "delete", entries: [{ name: "mine" }] },
    } as SettingsFile;
    const { settings } = apply(defaults, repo);
    expect(settings.rulesets).toEqual({ undeclared: "delete", entries: [{ name: "mine" }] });
  });

  test("a target's bare wrapper inherits the defaults-file policy like a plain array", () => {
    // {entries} without `undeclared` must preserve the omission through the
    // merge, so the defaults-file policy lands exactly as it does for the
    // plain array form.
    const defaults = {
      rulesets: { undeclared: "delete", entries: [{ name: "fleet" }] },
    } as SettingsFile;
    const repo = { rulesets: { entries: [{ name: "mine" }] } } as SettingsFile;
    const { settings } = apply(defaults, repo);
    expect(settings.rulesets).toEqual({ undeclared: "delete", entries: [{ name: "mine" }] });
  });

  test("a target wrapper without entries never inherits the defaults'", () => {
    // {undeclared: delete} without entries is malformed, and letting it
    // merge would hand it the DEFAULTS' entry list - a valid-looking,
    // possibly destructive declaration the target never wrote, accepted in
    // multi-repo mode while the same file fails validation standalone. It
    // must come out of the merge as written, for validation to reject.
    const defaults = {
      labels: { undeclared: "keep", entries: [{ name: "fleet" }] },
    } as SettingsFile;
    const repo = { labels: { undeclared: "delete" } } as unknown as SettingsFile;
    const { settings } = apply(defaults, repo);
    expect(settings.labels as unknown).toEqual({ undeclared: "delete" });
    // ...and the merged document is rejected downstream, naming the section.
    const invalid = validateSettingsDoc(settings, "target", new Set(), silentIo());
    expect("error" in invalid ? invalid.error : "").toContain("labels.entries");
  });

  test("an empty target wrapper never inherits the defaults' entries either", () => {
    const defaults = {
      labels: { undeclared: "keep", entries: [{ name: "fleet" }] },
    } as SettingsFile;
    const repo = { labels: {} } as unknown as SettingsFile;
    const { settings } = apply(defaults, repo);
    expect(settings.labels as unknown).toEqual({});
    const invalid = validateSettingsDoc(settings, "target", new Set(), silentIo());
    expect("error" in invalid ? invalid.error : "").toContain("labels.entries");
  });

  test("a defaults-only knobbed section materializes for a target that omits it", () => {
    // A defaults section applies to every processed target, entries and
    // policy alike - a defaults wrapper requires an entries array, and
    // `entries: []` under `undeclared: delete` declares an empty inventory
    // fleet-wide, which the undeclared-policy guide documents as
    // destructive. This pins the materialization so that warning stays true.
    const defaults = { labels: { undeclared: "delete", entries: [] } } as SettingsFile;
    const { settings } = apply(defaults, {});
    expect(settings.labels).toEqual({ undeclared: "delete", entries: [] });
    expect("error" in validateSettingsDoc(settings, "target", new Set(), silentIo())).toBe(false);
  });

  test("two plain arrays resolve to the section default, not each other's", () => {
    // The two-step order matters here: had normalization also RESOLVED the
    // policy before the merge, the target's resolved default would look like
    // an explicit choice and stomp a defaults-file policy. Both sides plain
    // means the post-merge resolve fills the section's own default in
    // (delete for labels, keep for milestones).
    const defaults = { labels: [{ name: "fleet" }] } as SettingsFile;
    const repo = {
      labels: [{ name: "mine" }],
      milestones: [{ title: "v1" }],
    } as SettingsFile;
    const { settings } = apply(defaults, repo);
    expect(settings.labels).toEqual({ undeclared: "delete", entries: [{ name: "mine" }] });
    expect(settings.milestones).toEqual({ undeclared: "keep", entries: [{ title: "v1" }] });
  });

  test("an empty defaults inventory still hands targets its policy", () => {
    // Not a policy-setting shortcut: entries: [] is a real declaration
    // that materializes for omitting targets too - see the guide's warning
    // and the materialization test above. Here the target declares its own
    // entries, so only the policy rides the merge.
    const defaults = { collaborators: { undeclared: "keep", entries: [] } } as SettingsFile;
    const repo = { collaborators: [{ username: "octocat" }] } as SettingsFile;
    const { settings } = apply(defaults, repo);
    expect(settings.collaborators).toEqual({
      undeclared: "keep",
      entries: [{ username: "octocat" }],
    });
  });

  test("a null target section still opts out of a wrapped defaults section", () => {
    const defaults = {
      labels: { undeclared: "keep", entries: [{ name: "fleet" }] },
    } as SettingsFile;
    const repo = { labels: null } as unknown as SettingsFile;
    const { settings, disabled } = apply(defaults, repo);
    expect("labels" in settings).toBe(false);
    expect(disabled).toEqual(["labels"]);
  });

  test("a knobbed section only the defaults declare reaches the target resolved", () => {
    const defaults = { autolinks: [{ key_prefix: "J-", url_template: "u<num>" }] } as SettingsFile;
    const { settings } = apply(defaults, {});
    expect(settings.autolinks).toEqual({
      undeclared: "delete",
      entries: [{ key_prefix: "J-", url_template: "u<num>" }],
    });
  });

  test("malformed knobbed values pass through untouched for validation to name", () => {
    const repo = { labels: "oops" } as unknown as SettingsFile;
    const { settings } = apply({}, repo);
    expect(settings.labels).toBe("oops" as never);
  });

  test("a YAML-tagged top-level value never merges with the defaults", () => {
    // A Date IS an object, so a naive mapping check would spread it into {}
    // and quietly hand the target the fleet defaults as if it had written
    // an empty document. It must survive the merge as written, for
    // validation to reject.
    const tagged = new Date(0);
    const { settings, disabled } = applyDefaults(
      { labels: [{ name: "fleet", color: "cccccc" }] } as SettingsFile,
      tagged,
    );
    expect(settings).toBeInstanceOf(Date);
    expect(disabled).toEqual([]);
    const verdict = validateSettingsDoc(settings, "target", new Set(), silentIo());
    expect("error" in verdict ? verdict.error : "").toContain("plain YAML mapping");
  });

  test("a non-mapping document passes through whole, so the top-level gate still fires", () => {
    // A raw list parses fine but is not a settings mapping; normalization
    // must not turn it into {0: ..., 1: ...} or the "must be a YAML mapping"
    // validator would misreport it as unknown keys.
    const doc = ["a", "b"] as unknown as SettingsFile;
    const { settings } = apply({ labels: [{ name: "fleet" }] } as SettingsFile, doc);
    expect(Array.isArray(settings)).toBe(true);
  });
});
