import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { MARKER_LABEL, MARKER_LABEL_CONFIG } from "../../src/report/issue-report.js";
import {
  ADMIN_OWNER,
  ADMIN_REPO,
  ADMIN_SLUG,
  E2E_TOKEN,
  TOKEN_USER_LOGIN,
  VIOLATION_PREFIX,
} from "./constants.js";
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

describe("harness identity constants", () => {
  test("no identity constant contains the inert token (leak-sweep disjointness)", () => {
    // The runner sweeps EVERY public surface for E2E_TOKEN as a substring; an
    // identity constant containing it (TOKEN_USER_LOGIN once nearly did, back
    // when the token was "e2e-token") would turn a legitimate rendering of
    // that fixture into a phantom token leak.
    const rendered = { ADMIN_OWNER, ADMIN_REPO, ADMIN_SLUG, TOKEN_USER_LOGIN, VIOLATION_PREFIX };
    for (const [name, value] of Object.entries(rendered)) {
      expect(`${name}="${value}"`.includes(E2E_TOKEN)).toBe(false);
    }
  });

  test("section mock fragments mint identity from state.slug, never the harness constants", async () => {
    // Served bodies must name the OWNING state's slug: the same bug (urls
    // minted from ADMIN_SLUG, served verbatim for multi-repo targets)
    // appeared independently in five fragments, so the class is banned at the
    // import boundary - a fragment always has the owning state in scope and
    // has no legitimate use for an identity constant.
    const root = join(import.meta.dir, "..", "..");
    const offenders: string[] = [];
    let fragments = 0;
    for await (const file of new Bun.Glob("src/sections/*/mock.ts").scan(root)) {
      fragments++;
      const text = await Bun.file(join(root, file)).text();
      if (/from "[^"]*\/test\/e2e\/constants\.js"/.test(text)) {
        offenders.push(file);
      }
    }
    // Non-vacuity: the glob must actually find the fragments it polices.
    expect(fragments).toBeGreaterThan(0);
    expect(offenders.sort()).toEqual([]);
  });
});
