import { describe, expect, test } from "bun:test";
import { MARKER_LABEL, MARKER_LABEL_CONFIG } from "../../src/report/issue-report.js";
import { SECTION_KEYS } from "../../src/schema.js";
import { DENIAL_SEMANTICS } from "./denial-semantics.js";
import { mulberry32, Rng } from "./prng.js";
import { markerLabelFixtureMismatches, parseScenario } from "./schema.js";

describe("prng", () => {
  test("mulberry32 is deterministic for a seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  test("Rng.int(maxExclusive) stays in [0, max) and is deterministic", () => {
    const a = new Rng(1);
    const b = new Rng(1);
    for (let i = 0; i < 100; i++) {
      const x = a.int(7);
      expect(x).toBe(b.int(7));
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(7);
    }
  });

  test("Rng.int rejects a non-positive bound", () => {
    expect(() => new Rng(1).int(0)).toThrow();
  });

  test("Rng.pick throws on an empty array", () => {
    expect(() => new Rng(1).pick([])).toThrow();
  });

  test("Rng.bool honors its probability at the extremes", () => {
    expect(new Rng(1).bool(1)).toBe(true);
    expect(new Rng(1).bool(0)).toBe(false);
  });

  test("fork(label) is stable regardless of parent draws and varies by label", () => {
    const drained = new Rng(7);
    drained.int(10);
    drained.int(10);
    const fresh = new Rng(7);
    expect(drained.fork("labels").int(1_000_000)).toBe(fresh.fork("labels").int(1_000_000));
    expect(new Rng(7).fork("labels").float()).not.toBe(new Rng(7).fork("teams").float());
  });
});

describe("scenario schema", () => {
  test("applies defaults (tiers, denial_style, owner_kind)", () => {
    const s = parseScenario({ name: "d", settings: {}, expect: { exit_code: 0 } }, "d.yml");
    expect(s.tiers).toEqual(["mock"]);
    expect(s.denial_style).toBe("fine_grained");
    expect(s.owner_kind).toBe("org");
  });

  test("passes live_state through (including the labels.generate sugar)", () => {
    const s = parseScenario(
      {
        name: "g",
        settings: {},
        live_state: { labels: { generate: { count: 150, prefix: "gen", color: "ededed" } } },
        expect: { exit_code: 0 },
      },
      "g.yml",
    );
    expect(s.live_state?.labels).toEqual({
      generate: { count: 150, prefix: "gen", color: "ededed" },
    });
  });

  test("token_permissions is a partial mask", () => {
    const s = parseScenario(
      { name: "m", settings: {}, token_permissions: { issues: "read" }, expect: { exit_code: 0 } },
      "m.yml",
    );
    expect(s.token_permissions).toEqual({ issues: "read" });
  });

  test("inputs.required_sections is a comma-separated string", () => {
    const s = parseScenario(
      {
        name: "r",
        settings: {},
        inputs: { mode: "apply", required_sections: "labels,rulesets" },
        expect: { exit_code: 0 },
      },
      "r.yml",
    );
    expect(s.inputs?.required_sections).toBe("labels,rulesets");
  });

  test("rejects an unknown top-level key and names the file", () => {
    expect(() =>
      parseScenario({ name: "x", settings: {}, expect: { exit_code: 0 }, bogus: 1 }, "bad.yml"),
    ).toThrow(/bad\.yml/);
  });

  test("rejects an unsupported denial_style, naming the field", () => {
    expect(() =>
      parseScenario(
        { name: "x", settings: {}, denial_style: 500, expect: { exit_code: 0 } },
        "d.yml",
      ),
    ).toThrow(/denial_style/);
  });

  test("accepts an allowed-set exit_code, rejects an empty one", () => {
    // The array form carries the fuzz oracle's allowed exit set; an empty set
    // would fail every exit code, so the schema refuses it at load time.
    const s = parseScenario({ name: "e", settings: {}, expect: { exit_code: [0, 1] } }, "e.yml");
    expect(s.expect.exit_code).toEqual([0, 1]);
    expect(() =>
      parseScenario({ name: "e", settings: {}, expect: { exit_code: [] } }, "e.yml"),
    ).toThrow(/exit_code/);
  });

  test("a scenario declaring neither settings nor settings_raw is rejected", () => {
    expect(() => parseScenario({ name: "x", expect: { exit_code: 0 } }, "d.yml")).toThrow(
      /one of `settings` or `settings_raw` is required/,
    );
  });

  test("rejects a repo that sets both `settings` and `settings_raw`", () => {
    // The two are mutually exclusive (both define settings.yml); setting both is
    // a loud failure, not a silent preference.
    expect(() =>
      parseScenario(
        {
          name: "x",
          settings: {},
          expect: { exit_code: 0 },
          repos: {
            "e2e-owner/svc-a": { settings: { labels: [] }, settings_raw: "labels: [oops" },
          },
        },
        "both.yml",
      ),
    ).toThrow(/only one of `settings` or `settings_raw`/);
  });

  test("rejects a top-level scenario that sets both `settings` and `settings_raw`", () => {
    expect(() =>
      parseScenario(
        { name: "x", settings: {}, settings_raw: "labels: [oops", expect: { exit_code: 0 } },
        "both.yml",
      ),
    ).toThrow(/only one of `settings` or `settings_raw`/);
  });

  test("accepts a single-repo scenario with only settings_raw, kept verbatim", () => {
    const s = parseScenario(
      { name: "x", settings_raw: "labels: [oops, unclosed", expect: { exit_code: 0 } },
      "raw.yml",
    );
    expect(s.settings_raw).toBe("labels: [oops, unclosed");
    expect(s.settings).toBeUndefined();
  });

  test("rejects a top-level settings_raw on a multi-repo scenario", () => {
    // The single-repo settings file is never read in multi mode, so a top-level
    // settings_raw there would be silently dead configuration.
    expect(() =>
      parseScenario(
        {
          name: "x",
          settings_raw: "labels: [oops",
          repos: { "e2e-owner/svc-a": { settings: {} } },
          expect: { exit_code: 0 },
        },
        "multi-raw.yml",
      ),
    ).toThrow(/single-repo only/);
  });

  test("accepts the numeric denial styles", () => {
    const s = parseScenario(
      { name: "x", settings: {}, denial_style: 403, expect: { exit_code: 0 } },
      "d.yml",
    );
    expect(s.denial_style).toBe(403);
  });
});

describe("marker-label fixture pin (markerLabelFixtureMismatches)", () => {
  const driftedMarker = {
    name: MARKER_LABEL,
    color: "ffffff",
    description: MARKER_LABEL_CONFIG.description,
  };
  const canonicalMarker = { ...MARKER_LABEL_CONFIG };

  test("a drifted marker in DECLARED settings fails scenario load, naming the field", () => {
    expect(() =>
      parseScenario(
        { name: "m", settings: { labels: [driftedMarker] }, expect: { exit_code: 0 } },
        "m.yml",
      ),
    ).toThrow(/settings\.labels\[0\]\.color/);
  });

  test("a drifted marker in a multi-repo target's settings is flagged with its slug path", () => {
    const scenarioFor = (marker: Record<string, unknown>) =>
      parseScenario(
        {
          name: "m",
          settings: {},
          repos: { "e2e-owner/svc-a": { settings: { labels: [marker] } } },
          expect: { exit_code: 0 },
        },
        "m.yml",
      );
    expect(markerLabelFixtureMismatches(scenarioFor(canonicalMarker))).toEqual([]);
    expect(() => scenarioFor(driftedMarker)).toThrow(
      /repos\.e2e-owner\/svc-a\.settings\.labels\[0\]\.color/,
    );
  });

  test("a drifted marker in live_state LOADS - seeding stale marker state is legitimate", () => {
    // The pin covers declared fixtures only: a future scenario testing that
    // the report path repairs a mangled live marker must stay expressible.
    const s = parseScenario(
      {
        name: "m",
        settings: {},
        live_state: { labels: [driftedMarker] },
        expect: { exit_code: 0 },
      },
      "m.yml",
    );
    expect(markerLabelFixtureMismatches(s)).toEqual([]);
  });

  test("non-marker labels and field-less marker references are never compared", () => {
    const s = parseScenario(
      {
        name: "m",
        settings: { labels: [{ name: "bug", color: "ffffff" }, { name: MARKER_LABEL }] },
        expect: { exit_code: 0 },
      },
      "m.yml",
    );
    expect(markerLabelFixtureMismatches(s)).toEqual([]);
  });
});

describe("denial semantics", () => {
  test("covers every section exactly once", () => {
    expect(Object.keys(DENIAL_SEMANTICS).sort()).toEqual([...SECTION_KEYS].sort() as string[]);
  });

  test("the six absent sections are exactly branches, check_suite_preferences, custom_properties, environments, pages, teams", () => {
    const absent: string[] = SECTION_KEYS.filter((k) => DENIAL_SEMANTICS[k] === "absent");
    expect(absent.sort()).toEqual(
      [
        "branches",
        "check_suite_preferences",
        "custom_properties",
        "environments",
        "pages",
        "teams",
      ].sort(),
    );
  });

  test("every other section is denied", () => {
    const denied: string[] = SECTION_KEYS.filter((k) => DENIAL_SEMANTICS[k] === "denied");
    expect(denied.sort()).toEqual(
      [
        "actions",
        "actions_variables",
        "actions_secrets",
        "agents_secrets",
        "agents_variables",
        "dependabot_secrets",
        "codespaces_secrets",
        "autolinks",
        "code_scanning_default_setup",
        "code_quality_setup",
        "collaborators",
        "deploy_keys",
        "interaction_limits",
        "labels",
        "milestones",
        "repository",
        "rulesets",
        "webhooks",
        "workflows",
        "secret_scanning_custom_patterns",
      ].sort(),
    );
  });
});
