import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import { validateSettingsDoc } from "../../src/engine/orchestrate.js";
import { SECTION_KEYS, type SectionKey } from "../../src/schema.js";
import { allEndpoints, sectionShape } from "../../src/sections/registry.js";
import { silentIo } from "../io-fake.js";
import type { LiveWitnessKind } from "./gen-support.js";
import {
  ARTIFACT_TEST_RECIPIENT,
  canariesOf,
  genDiscoveryScenario,
  genInvalidSettings,
  genLiveWitness,
  genMultiScenario,
  genScenario,
  genSettings,
  INVALID_SETTINGS_CASES,
  NON_MAPPING_YAML,
  ORG_GATED_SECTIONS,
  SECTION_PRIMARY_READ,
  UNPARSEABLE_YAML,
  validateAgainstPublishedSchema,
  WITNESS_SECTIONS,
} from "./generators.js";
import { predictDiscovery } from "./oracle.js";
import { Rng } from "./prng.js";
import { parseScenario } from "./schema.js";

describe("three-way drift detection", () => {
  test("every generated section doc passes schema, validateSettingsDoc, and its zod shape", () => {
    const offenders: string[] = [];
    for (const key of SECTION_KEYS) {
      const shape = sectionShape(key);
      for (let i = 0; i < 200; i++) {
        const value = genSettings(new Rng(i * 7 + key.length), key);
        const doc = { [key]: value };
        // 1. Published JSON schema (ajv).
        try {
          validateAgainstPublishedSchema(doc);
        } catch (error) {
          offenders.push(
            `${key} seed ${i}: published schema rejected the doc: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        // 2. The action's own doc validator (unknown-key check + more).
        const verdict = validateSettingsDoc(doc, "fuzz", new Set(), silentIo());
        if ("error" in verdict) {
          offenders.push(
            `${key} seed ${i}: validateSettingsDoc rejected the doc: ${verdict.error}`,
          );
        }
        // 3. The section's zod shape parses the raw value.
        const parsed = shape.safeParse(value);
        if (!parsed.success) {
          offenders.push(
            `${key} seed ${i}: zod shape rejected the generated value ${JSON.stringify(value)}: ${JSON.stringify(parsed.error.issues)}`,
          );
        }
      }
    }
    expect(
      offenders,
      `generated section doc(s) drifting from schema, validator, or shape:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  test("validateAgainstPublishedSchema rejects a section with the wrong type", () => {
    // The published schema is permissive about unknown top-level keys (the
    // action rejects those at runtime), but it enforces each section's type.
    expect(() => validateAgainstPublishedSchema({ labels: "not-an-array" })).toThrow();
  });
});

describe("generator couplings and pools", () => {
  test("actions keeps selected_actions coupled to allowed_actions selected", () => {
    for (let i = 0; i < 200; i++) {
      const actions = genSettings(new Rng(i), "actions") as Record<string, unknown>;
      if (actions.selected_actions !== undefined) {
        expect(actions.allowed_actions).toBe("selected");
      }
    }
  });

  test("branches protection payloads only use known keys, wildcards only translated ones", () => {
    const allowed = new Set([
      "required_status_checks",
      "enforce_admins",
      "required_pull_request_reviews",
      "restrictions",
      "required_signatures",
      "required_linear_history",
      "force_push_bypassers",
      "required_deployments",
    ]);
    // Wildcard entries reconcile through GraphQL, whose translation table has
    // no `restrictions` (the shape rejects it there); the generator must
    // never draw it onto one.
    const wildcardForbidden = new Set(["restrictions", "required_signatures"]);
    let signatureDraws = 0;
    let wildcardDraws = 0;
    let bypasserDraws = 0;
    let deploymentDraws = 0;
    for (let i = 0; i < 200; i++) {
      const branches = genSettings(new Rng(i), "branches") as Array<{
        name: string;
        protection: Record<string, unknown> | null;
      }>;
      for (const branch of branches) {
        const wildcard = /[*?[]/.test(branch.name);
        if (wildcard) {
          wildcardDraws++;
        }
        if (branch.protection) {
          for (const key of Object.keys(branch.protection)) {
            expect(
              allowed.has(key),
              `seed ${i} branch "${branch.name}": generator drew unknown protection key "${key}"; add it to the allowed set or fix genSettings(branches)`,
            ).toBe(true);
            if (wildcard) {
              expect(
                wildcardForbidden.has(key),
                `seed ${i} wildcard branch "${branch.name}": protection key "${key}" has no GraphQL translation, so a wildcard rule cannot carry it`,
              ).toBe(false);
            }
          }
          if ("required_signatures" in branch.protection) {
            expect(typeof branch.protection.required_signatures).toBe("boolean");
            signatureDraws++;
          }
          if ("force_push_bypassers" in branch.protection) {
            bypasserDraws++;
          }
          if ("required_deployments" in branch.protection) {
            deploymentDraws++;
          }
        }
      }
    }
    // Each minority draw must actually fire across seeds, or its path would
    // go unfuzzed without anything failing.
    expect(signatureDraws).toBeGreaterThan(0);
    expect(wildcardDraws).toBeGreaterThan(0);
    expect(bypasserDraws).toBeGreaterThan(0);
    expect(deploymentDraws).toBeGreaterThan(0);
  });

  test("milestones due_on, when present, is a fixed ISO date (deterministic)", () => {
    const pool = new Set(["2026-01-15T00:00:00Z", "2026-06-30T00:00:00Z", "2026-12-31T00:00:00Z"]);
    for (let i = 0; i < 200; i++) {
      const milestones = genSettings(new Rng(i), "milestones") as Array<{ due_on?: string }>;
      for (const m of milestones) {
        if (m.due_on !== undefined) {
          expect(
            pool.has(m.due_on),
            `seed ${i}: milestone due_on "${m.due_on}" is not from the fixed ISO date pool`,
          ).toBe(true);
        }
      }
    }
  });

  test("labels never collide on name identities", () => {
    for (let i = 0; i < 200; i++) {
      const labels = genSettings(new Rng(i), "labels") as Array<{ name: string }>;
      const names = labels.map((l) => l.name.toLowerCase());
      expect(new Set(names).size).toBe(names.length);
    }
  });

  test("hostile names surface across seeds", () => {
    let hostile = 0;
    for (let i = 0; i < 100; i++) {
      const json = JSON.stringify(genSettings(new Rng(i), "labels"));
      if (/pipe|quote|percent|space|unicode|éñ|slash|hash/.test(json)) {
        hostile++;
      }
    }
    expect(hostile).toBeGreaterThan(0);
  });

  test("the knobbed non-witness sections emit both forms, every policy included", () => {
    // The witness sections stay plain (the oracle refines their predictions
    // from the witness alone); the other knobbed sections must draw the plain
    // array, the bare wrapper, and both explicit policies across seeds.
    for (const key of ["collaborators", "rulesets", "webhooks"] as const) {
      let plain = 0;
      const wrapped = new Map<string, number>();
      for (let i = 0; i < 400; i++) {
        const value = genSettings(new Rng(i), key);
        if (Array.isArray(value)) {
          plain++;
          continue;
        }
        const wrapper = value as { undeclared?: string; entries: unknown[] };
        expect(Array.isArray(wrapper.entries)).toBe(true);
        const policy = wrapper.undeclared ?? "(omitted)";
        wrapped.set(policy, (wrapped.get(policy) ?? 0) + 1);
      }
      expect(plain).toBeGreaterThan(0);
      for (const policy of ["keep", "delete", "(omitted)"]) {
        expect(wrapped.get(policy) ?? 0, `${key} never drew the ${policy} form`).toBeGreaterThan(0);
      }
    }
  });

  test("the witness sections never emit the wrapped form", () => {
    for (const key of WITNESS_SECTIONS) {
      for (let i = 0; i < 400; i++) {
        expect(Array.isArray(genSettings(new Rng(i), key))).toBe(true);
      }
    }
  });
});

describe("genLiveWitness", () => {
  type Label = { name: string; color?: string; description?: string | null; new_name?: string };
  type Milestone = { title: string; description?: string | null; state?: string; due_on?: string };

  test("matching labels mirror every field the labels handler diffs", () => {
    for (let i = 0; i < 200; i++) {
      const declared = genSettings(new Rng(i), "labels") as Label[];
      const witness = genLiveWitness(new Rng(i + 500), "labels", declared, "matching");
      expect(witness.kind).toBe("matching");
      const live = witness.state.labels as Label[];
      expect(live.length).toBe(declared.length);
      declared.forEach((label, j) => {
        // The name is compared verbatim (a case change would be rename drift);
        // color and description are diffed only when declared, so declared
        // values must be mirrored verbatim.
        expect(live[j]?.name).toBe(label.new_name ?? label.name);
        if (label.color !== undefined) {
          expect(live[j]?.color).toBe(label.color);
        }
        if (label.description !== undefined) {
          expect(live[j]?.description).toBe(label.description);
        }
      });
    }
  });

  test("witnesses seed the FINAL post-rename state for new_name labels", () => {
    // The handler resolves new_name to a final name and treats any other live
    // name as rename drift, so a matching witness must seed the label AT the
    // final name - seeding the source name would make the oracle predict clean
    // while the engine PATCHes a rename.
    const declared: Label[] = [
      { name: "bug", new_name: "defect", color: "d73a4a", description: "broken" },
      { name: "keep", description: "kept" },
    ];
    const matching = genLiveWitness(new Rng(1), "labels", declared, "matching");
    const matchingLive = matching.state.labels as Label[];
    expect(matchingLive[0]?.name).toBe("defect");
    expect(matchingLive[0]?.color).toBe("d73a4a");
    expect(matchingLive[0]?.description).toBe("broken");
    expect(matchingLive[1]?.name).toBe("keep");
    // drift-update diverges in exactly one field measured against the
    // POST-rename state; the name candidate flips the final name's case.
    for (let i = 0; i < 50; i++) {
      const drift = genLiveWitness(new Rng(i), "labels", declared, "drift-update");
      expect(drift.kind).toBe("drift-update");
      const live = drift.state.labels as Label[];
      let diverged = 0;
      for (const [j, label] of declared.entries()) {
        const entry = live[j] as Label;
        const finalName = label.new_name ?? label.name;
        if (entry.name !== finalName) {
          expect(entry.name.toLowerCase()).toBe(finalName.toLowerCase());
          diverged++;
        }
        if (label.color !== undefined && entry.color !== label.color) {
          diverged++;
        }
        if (label.description !== undefined && entry.description !== label.description) {
          diverged++;
        }
      }
      expect(diverged).toBe(1);
    }
    // extra-undeclared keeps the matching (post-rename) base under the extra.
    const extra = genLiveWitness(new Rng(2), "labels", declared, "extra-undeclared");
    expect((extra.state.labels as Label[])[0]?.name).toBe("defect");
  });

  test("matching witnesses mirror passthrough fields verbatim", () => {
    // Both handlers diff passthrough fields (labels via the extra-keys
    // subsetDiff, milestones via the whole-declaration subsetDiff), so a
    // witness built from a hardcoded field list would silently read as drift.
    const labels = [{ name: "a", tone: "warm" }];
    const labelWitness = genLiveWitness(new Rng(1), "labels", labels, "matching");
    expect((labelWitness.state.labels as Array<{ tone?: string }>)[0]?.tone).toBe("warm");
    const milestones = [{ title: "v1", due_on: "2026-01-15T00:00:00Z", closed_issues: 0 }];
    const milestoneWitness = genLiveWitness(new Rng(1), "milestones", milestones, "matching");
    const liveMilestone = (milestoneWitness.state.milestones as Array<Record<string, unknown>>)[0];
    expect(liveMilestone?.due_on).toBe("2026-01-15T00:00:00Z");
    expect(liveMilestone?.closed_issues).toBe(0);
  });

  test("labels drift-update perturbs exactly one declared field (or the name's case)", () => {
    for (let i = 0; i < 200; i++) {
      const declared = genSettings(new Rng(i), "labels") as Label[];
      const witness = genLiveWitness(new Rng(i + 500), "labels", declared, "drift-update");
      expect(witness.kind).toBe("drift-update");
      const live = witness.state.labels as Label[];
      expect(live.length).toBe(declared.length);
      let drifted = 0;
      declared.forEach((label, j) => {
        const entry = live[j] as Label;
        const finalName = label.new_name ?? label.name;
        const renamed = entry.name !== finalName;
        if (renamed) {
          // The flipped name must keep its case-insensitive key, so the handler
          // still matches the label and reads the divergence as rename drift.
          expect(entry.name.toLowerCase()).toBe(finalName.toLowerCase());
        }
        const colorDrift = label.color !== undefined && entry.color !== label.color;
        const descriptionDrift =
          label.description !== undefined && entry.description !== label.description;
        if (renamed || colorDrift || descriptionDrift) {
          drifted++;
        }
      });
      expect(drifted).toBe(1);
    }
  });

  test("labels extra-undeclared adds exactly one undeclared label over a matching base", () => {
    for (let i = 0; i < 200; i++) {
      const declared = genSettings(new Rng(i), "labels") as Label[];
      const witness = genLiveWitness(new Rng(i + 500), "labels", declared, "extra-undeclared");
      expect(witness.kind).toBe("extra-undeclared");
      const live = witness.state.labels as Label[];
      expect(live.length).toBe(declared.length + 1);
      const extra = live[live.length - 1] as Label;
      // The extra label matches no declared identity (case-insensitively), so
      // the handler must classify it as undeclared: delete in apply, drift in
      // check.
      expect(declared.some((l) => l.name.toLowerCase() === extra.name.toLowerCase())).toBe(false);
    }
  });

  test("matching milestones mirror every declared field, due_on included", () => {
    for (let i = 0; i < 200; i++) {
      const declared = genSettings(new Rng(i), "milestones") as Milestone[];
      const witness = genLiveWitness(new Rng(i + 500), "milestones", declared, "matching");
      expect(witness.kind).toBe("matching");
      const live = witness.state.milestones as Milestone[];
      expect(live.length).toBe(declared.length);
      declared.forEach((milestone, j) => {
        const entry = live[j] as Milestone;
        expect(entry.title).toBe(milestone.title);
        // subsetDiff compares every DECLARED field verbatim; due_on omitted
        // from a "matching" witness would read as drift.
        if (milestone.state !== undefined) {
          expect(entry.state).toBe(milestone.state);
        }
        if (milestone.description !== undefined) {
          expect(entry.description).toBe(milestone.description);
        }
        if (milestone.due_on !== undefined) {
          expect(entry.due_on).toBe(milestone.due_on);
        }
      });
    }
  });

  test("milestones drift-update perturbs one declared field, or degrades to matching", () => {
    let drifts = 0;
    for (let i = 0; i < 200; i++) {
      const declared = genSettings(new Rng(i), "milestones") as Milestone[];
      const witness = genLiveWitness(new Rng(i + 500), "milestones", declared, "drift-update");
      const live = witness.state.milestones as Milestone[];
      expect(live.length).toBe(declared.length);
      let diverged = 0;
      declared.forEach((milestone, j) => {
        const entry = live[j] as Milestone;
        expect(entry.title).toBe(milestone.title);
        for (const field of ["description", "state", "due_on"] as const) {
          if (milestone[field] !== undefined && entry[field] !== milestone[field]) {
            diverged++;
          }
        }
      });
      if (witness.kind === "drift-update") {
        expect(diverged).toBe(1);
        drifts++;
      } else {
        // The fallback: no milestone declares a perturbable field, so nothing
        // can legitimately diverge and the witness says "matching".
        expect(witness.kind).toBe("matching");
        expect(diverged).toBe(0);
      }
    }
    expect(drifts).toBeGreaterThan(0);
  });

  test("milestones reject the labels-only extra-undeclared kind", () => {
    expect(() =>
      genLiveWitness(new Rng(1), "milestones", [{ title: "v1" }], "extra-undeclared"),
    ).toThrow();
  });

  test("witness sentinels stay disjoint from the generator pools", () => {
    for (let i = 0; i < 300; i++) {
      const labels = genSettings(new Rng(i), "labels") as Label[];
      for (const label of labels) {
        expect(label.color).not.toBe("123456");
        expect(label.description).not.toBe("witness-drift");
        expect(label.name.toLowerCase()).not.toBe("zz-undeclared-witness");
        expect((label.new_name ?? label.name).toLowerCase()).not.toBe("zz-undeclared-witness");
      }
      const milestones = genSettings(new Rng(i), "milestones") as Milestone[];
      for (const milestone of milestones) {
        expect(milestone.description).not.toBe("witness-drift");
      }
    }
  });

  test("a sentinel collision fails loudly instead of degrading the witness", () => {
    // "77" has no letters, so it is not case-flippable and the perturbation
    // picker has exactly one candidate - the collision is guaranteed to fire.
    expect(() =>
      genLiveWitness(new Rng(1), "labels", [{ name: "77", color: "123456" }], "drift-update"),
    ).toThrow(/sentinel/);
    expect(() =>
      genLiveWitness(
        new Rng(1),
        "labels",
        [{ name: "77", description: "witness-drift" }],
        "drift-update",
      ),
    ).toThrow(/sentinel/);
    expect(() =>
      genLiveWitness(new Rng(1), "labels", [{ name: "zz-undeclared-witness" }], "extra-undeclared"),
    ).toThrow(/sentinel/);
    expect(() =>
      genLiveWitness(
        new Rng(1),
        "milestones",
        [{ title: "v1", description: "witness-drift" }],
        "drift-update",
      ),
    ).toThrow(/sentinel/);
  });
});

describe("SECTION_PRIMARY_READ", () => {
  test("every entry names a real GET endpoint of its own section", () => {
    // The fault fuzz aims at these keys and asserts the fault FIRED, so a key
    // that drifts from the endpoint registry would fail every fault iteration
    // - this test catches it at unit speed instead.
    const known = allEndpoints();
    for (const [section, key] of Object.entries(SECTION_PRIMARY_READ)) {
      const endpoint = known[key];
      if (endpoint === undefined) {
        throw new Error(`SECTION_PRIMARY_READ[${section}] names unknown endpoint "${key}"`);
      }
      expect(key.startsWith(`${section}.`)).toBe(true);
      // A fault target must be the section's READ: faulting a write would
      // depend on live state ever driving a write, which is not guaranteed.
      expect(endpoint.route.startsWith("GET ")).toBe(true);
    }
  });
});

describe("genInvalidSettings", () => {
  test("every catalog case is rejected and the error names its token", () => {
    for (const { name, build } of INVALID_SETTINGS_CASES) {
      for (let i = 0; i < 25; i++) {
        const { doc, offendingToken } = build(new Rng(i * 13 + 1));
        const verdict = validateSettingsDoc(doc, "settings.yml", new Set(), silentIo());
        if (!("error" in verdict)) {
          throw new Error(`case "${name}" produced a doc the validator accepts`);
        }
        if (!verdict.error.includes(offendingToken)) {
          throw new Error(
            `case "${name}" token "${offendingToken}" missing from error: ${verdict.error}`,
          );
        }
      }
    }
  });

  test("draws every catalog case over seeds", () => {
    const drawn = new Set<string>();
    for (let i = 0; i < 400; i++) {
      drawn.add(genInvalidSettings(new Rng(i)).name);
    }
    const catalog = INVALID_SETTINGS_CASES.map((c) => c.name);
    // Two-way: no duplicate case names, and the drawn set equals the catalog
    // exactly (an unexpected or never-drawn name both fail).
    expect(new Set(catalog).size).toBe(catalog.length);
    expect([...drawn].sort()).toEqual([...catalog].sort());
  });

  test("the raw pools fail the way their names promise", () => {
    for (const raw of UNPARSEABLE_YAML) {
      expect(() => parseYaml(raw)).toThrow();
    }
    for (const raw of NON_MAPPING_YAML) {
      const parsed: unknown = parseYaml(raw);
      const isMapping = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
      expect(isMapping).toBe(false);
    }
  });
});

describe("genScenario", () => {
  const KNOWN_MASK_KEYS = new Set([
    "administration",
    "issues",
    "environments",
    "actions",
    "pages",
    "code_scanning_alerts",
    "contents",
    "variables",
    "webhooks",
    "secrets",
    "dependabot_secrets",
    "codespaces_secrets",
    "custom_properties",
    "secret_scanning_alerts",
    "agent_secrets",
    "agent_variables",
    "checks",
    "org_members",
  ]);

  test("produces internally consistent, schema-valid scenarios with sound meta", () => {
    for (let i = 0; i < 200; i++) {
      const { scenario, meta } = genScenario(new Rng(i));
      expect(() => validateAgainstPublishedSchema(scenario.settings)).not.toThrow();
      const declared = new Set(Object.keys(scenario.settings ?? {}) as SectionKey[]);
      for (const section of meta.requiredSections) {
        expect(
          declared.has(section),
          `seed ${i}: required section "${section}" is not declared in the generated settings`,
        ).toBe(true);
      }
      for (const key of Object.keys(meta.mask)) {
        expect(
          KNOWN_MASK_KEYS.has(key),
          `seed ${i}: generated mask carries unknown key "${key}"`,
        ).toBe(true);
      }
      expect([...meta.sections].sort()).toEqual([...declared].sort());
      expect(meta.sections.length).toBeGreaterThan(0);
      expect([403, 404, "fine_grained"]).toContain(meta.denialStyle);
      // An allowlist, when rolled, is a STRICT nonempty subset of the
      // declared sections (so the excluded outcome is always reachable) and
      // rides the inputs verbatim.
      if (meta.onlySections !== undefined) {
        expect(meta.onlySections.length).toBeGreaterThan(0);
        expect(meta.onlySections.length).toBeLessThan(meta.sections.length);
        for (const key of meta.onlySections) {
          expect(declared.has(key)).toBe(true);
        }
        expect(scenario.inputs?.sections).toBe(meta.onlySections.join(","));
        // Input validation rejects a required section the allowlist excludes,
        // so the generator must never pair the two.
        for (const key of meta.requiredSections) {
          expect(
            meta.onlySections.includes(key),
            `seed ${i}: required section "${key}" is excluded by the generated allowlist`,
          ).toBe(true);
        }
      }
    }
  });

  test("honors the sections option", () => {
    for (let i = 0; i < 30; i++) {
      const { scenario, meta } = genScenario(new Rng(i), { sections: ["labels"] });
      expect(Object.keys(scenario.settings ?? {})).toEqual(["labels"]);
      expect(meta.sections).toEqual(["labels"]);
    }
  });

  test("liveKinds records the seeded witness per section, and every kind surfaces", () => {
    const seen: Record<LiveWitnessKind, number> = {
      matching: 0,
      "drift-update": 0,
      "extra-undeclared": 0,
    };
    for (let i = 0; i < 300; i++) {
      const { scenario, meta } = genScenario(new Rng(i));
      for (const key of WITNESS_SECTIONS) {
        const kind = meta.liveKinds?.[key];
        if (kind === undefined) {
          // No witness: the family keeps absent live state (the create path).
          expect(scenario.live_state?.[key]).toBeUndefined();
          continue;
        }
        seen[kind]++;
        // A recorded witness implies the section is declared and its live
        // state family is seeded.
        expect(meta.sections).toContain(key);
        expect(Array.isArray(scenario.live_state?.[key])).toBe(true);
      }
    }
    expect(seen.matching).toBeGreaterThan(0);
    expect(seen["drift-update"]).toBeGreaterThan(0);
    expect(seen["extra-undeclared"]).toBeGreaterThan(0);
  });

  test("declared branches and workflows are present in live_state so they converge", () => {
    // branches (protection PUT) and workflows (enable/disable) can configure but
    // not create their resource; a declared name absent from live_state would
    // permanently drift with a skip note. Every declared LITERAL branch name /
    // workflow path must appear in the seeded live_state; a wildcard entry is
    // a RULE (creatable through GraphQL), so it must never be seeded as a git
    // branch. Declared required-deployment environments must exist live, or
    // the mock's silent-drop mimicry would fail a fully-granted apply.
    for (let i = 0; i < 200; i++) {
      const { scenario } = genScenario(new Rng(i));
      const branches = scenario.settings?.branches as
        | Array<{ name: string; protection: Record<string, unknown> | null }>
        | undefined;
      if (branches) {
        const live = new Set((scenario.live_state?.branches as string[] | undefined) ?? []);
        const liveEnvironments = scenario.live_state?.environments ?? {};
        for (const b of branches) {
          if (/[*?[]/.test(b.name)) {
            expect(
              live.has(b.name),
              `seed ${i}: wildcard branch "${b.name}" is a rule and must never be seeded as a git branch in live_state.branches`,
            ).toBe(false);
          } else {
            expect(
              live.has(b.name),
              `seed ${i}: declared branch "${b.name}" is not seeded in live_state.branches, so the scenario would permanently drift`,
            ).toBe(true);
          }
          const deployments = b.protection?.required_deployments as
            | { environments: string[] }
            | null
            | undefined;
          for (const env of deployments?.environments ?? []) {
            expect(
              Object.keys(liveEnvironments),
              `seed ${i}: branch "${b.name}" requires deployment environment "${env}" that live_state.environments never seeds`,
            ).toContain(env);
          }
        }
      }
      const workflows = scenario.settings?.workflows as Array<{ path: string }> | undefined;
      if (workflows) {
        const livePaths = new Set(
          ((scenario.live_state?.workflows as Array<{ path: string }> | undefined) ?? []).map(
            (w) => w.path,
          ),
        );
        for (const w of workflows) {
          expect(
            livePaths.has(w.path),
            `seed ${i}: declared workflow "${w.path}" is not seeded in live_state.workflows, so the scenario would permanently drift`,
          ).toBe(true);
        }
      }
    }
  });
});

describe("genMultiScenario", () => {
  test("builds 2 to 5 valid targets with exactly one skipped", () => {
    for (let i = 0; i < 100; i++) {
      const { scenario, meta } = genMultiScenario(new Rng(i));
      expect(() => parseScenario(scenario, `m-${i}`)).not.toThrow();
      expect(meta.repos.length).toBeGreaterThanOrEqual(2);
      expect(meta.repos.length).toBeLessThanOrEqual(5);
      // Exactly one missing-settings target per scenario (a raw-invalid one
      // is a separate kind and may or may not exist).
      const skipped = meta.repos.filter((r) => r.target.kind === "missing");
      expect(skipped.length).toBe(1);
    }
  });

  test("a raw-settings target serves settings_raw, opts out of nothing, and plants no canaries", () => {
    let sawUnparseable = 0;
    let sawNonMapping = 0;
    for (let i = 0; i < 400; i++) {
      const { scenario, meta } = genMultiScenario(new Rng(i));
      for (const repo of meta.repos) {
        if (repo.target.kind !== "raw-invalid") {
          continue;
        }
        if (repo.target.raw === "unparseable") {
          sawUnparseable++;
        } else {
          sawNonMapping++;
        }
        const spec = scenario.repos?.[repo.slug] as {
          settings?: unknown;
          settings_raw?: string;
        };
        expect(
          typeof spec.settings_raw,
          `seed ${i}: raw-invalid target ${repo.slug} serves no settings_raw string`,
        ).toBe("string");
        expect(
          spec.settings,
          `seed ${i}: raw-invalid target ${repo.slug} also carries a settings object`,
        ).toBeUndefined();
        // The raw pool entry matches its kind: unparseable bodies throw in
        // the yaml parser, non-mapping ones parse to a non-mapping.
        if (repo.target.raw === "unparseable") {
          expect(() => parseYaml(spec.settings_raw as string)).toThrow();
        } else {
          const parsed: unknown = parseYaml(spec.settings_raw as string);
          expect(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)).toBe(
            false,
          );
        }
        // Never the milestones opt-out target (there is no mapping to null a
        // section in) and never the guaranteed leak-canary target.
        expect(meta.milestonesOptOutSlug).not.toBe(repo.slug);
        expect(canariesOf(repo)).toEqual([]);
      }
    }
    expect(sawUnparseable).toBeGreaterThan(0);
    expect(sawNonMapping).toBeGreaterThan(0);
  });

  test("defaults file declares milestones; a target sometimes nulls it (the opt-out)", () => {
    // The null-section opt-out lives on a TARGET (nulling a section the defaults
    // declare), never in the defaults file itself - a defaults file with a null
    // section fails the action's schema validation. So the defaults file always
    // declares milestones as a real array, and some targets set milestones: null.
    let targetOptOut = 0;
    for (let i = 0; i < 100; i++) {
      const { scenario } = genMultiScenario(new Rng(i));
      expect(Array.isArray(scenario.defaults_file?.milestones)).toBe(true);
      for (const spec of Object.values(scenario.repos ?? {})) {
        const settings = (spec as { settings: Record<string, unknown> | null }).settings;
        if (settings && settings.milestones === null) {
          targetOptOut++;
        }
      }
    }
    expect(targetOptOut).toBeGreaterThan(0);
  });

  test("the redaction flag follows the mechanical rule per target", () => {
    // redacted iff policy=redact AND slug != selfSlug AND (private/internal OR
    // probe-denied). Re-derive it independently from the recorded facts and
    // require it matches what the generator stamped on each target.
    let sawRedacted = false;
    let sawShown = false;
    for (let i = 0; i < 200; i++) {
      const { scenario, meta } = genMultiScenario(new Rng(i));
      const redact = meta.privateRepos === "redact";
      if (redact) {
        sawRedacted = true;
      } else {
        sawShown = true;
      }
      for (const repo of meta.repos) {
        const expected =
          redact &&
          repo.slug !== meta.selfSlug &&
          (repo.visibility !== "public" || repo.probeDenied);
        expect(
          repo.redaction.kind === "redacted",
          `seed ${i}: target ${repo.slug} (visibility ${repo.visibility}, probeDenied ${repo.probeDenied}, policy ${meta.privateRepos}) stamped redaction "${repo.redaction.kind}" but the mechanical rule says ${expected ? "redacted" : "shown"}`,
        ).toBe(expected);
      }
      // The action input echoes the policy the meta records.
      expect(scenario.inputs?.private_repos).toBe(meta.privateRepos);
    }
    // Both policies are exercised across the seed range.
    expect(sawRedacted).toBe(true);
    expect(sawShown).toBe(true);
  });

  test("private_report is only a delivering channel under redact, and the input echoes the meta", () => {
    // The config rejects a delivering channel (issue or artifact) + private-repos:
    // show, so the generator picks them only under redact. The artifact channel
    // also forwards a valid report-public-key; the other channels forward none.
    // Every channel is exercised across the seed range.
    let sawIssue = false;
    let sawArtifact = false;
    let sawNone = false;
    for (let i = 0; i < 300; i++) {
      const { scenario, meta } = genMultiScenario(new Rng(i));
      if (meta.privateReport === "issue") {
        sawIssue = true;
        expect(meta.privateRepos).toBe("redact");
        expect(scenario.inputs?.private_report).toBe("issue");
        // The issue channel needs no age recipient.
        expect(scenario.inputs?.report_public_key).toBeUndefined();
      } else if (meta.privateReport === "artifact") {
        sawArtifact = true;
        expect(meta.privateRepos).toBe("redact");
        expect(scenario.inputs?.private_report).toBe("artifact");
        // The artifact channel MUST carry a valid recipient, or the config rejects
        // the run before it starts (a vacuous fuzz iteration).
        expect(scenario.inputs?.report_public_key).toBe(ARTIFACT_TEST_RECIPIENT);
      } else {
        sawNone = true;
        // `none` is the default, so the input is left unset - and no key either.
        expect(scenario.inputs?.private_report).toBeUndefined();
        expect(scenario.inputs?.report_public_key).toBeUndefined();
      }
    }
    expect(sawIssue).toBe(true);
    expect(sawArtifact).toBe(true);
    expect(sawNone).toBe(true);
  });

  test("a redact run always has at least one redacted target (non-vacuous leak check)", () => {
    // The generator forces one non-missing target private under redact, so the
    // forbidden set is never empty and the leak invariant is never vacuous.
    for (let i = 0; i < 300; i++) {
      const { meta } = genMultiScenario(new Rng(i));
      if (meta.privateRepos !== "redact") {
        continue;
      }
      expect(meta.repos.some((r) => r.redaction.kind === "redacted")).toBe(true);
    }
  });

  test("the forced-private target is fully granted so its canary provably flows", () => {
    // Under apply + fail a single denied section read preflight-aborts the whole
    // target and renders nothing, so the forced-private leak target clears its
    // mask (every resource back to the write default). This guarantees the canary
    // label's name reaches the detail output the counterfactual relies on. Other
    // private targets keep random masks, so at LEAST one redacted target must be
    // fully granted (the forced one).
    for (let i = 0; i < 300; i++) {
      const { scenario, meta } = genMultiScenario(new Rng(i));
      if (meta.privateRepos !== "redact") {
        continue;
      }
      const fullyGrantedRedacted = meta.repos.some((r) => {
        if (r.redaction.kind !== "redacted" || r.redaction.canaries.length === 0) {
          return false;
        }
        const spec = scenario.repos?.[r.slug] as { permissions?: Record<string, string> };
        return Object.keys(spec.permissions ?? {}).length === 0;
      });
      expect(fullyGrantedRedacted).toBe(true);
    }
  });

  test("redacted targets carry unique canaries planted into their settings and live state", () => {
    let sawCanary = false;
    for (let i = 0; i < 200; i++) {
      const { scenario, meta } = genMultiScenario(new Rng(i));
      for (const repo of meta.repos) {
        if (repo.redaction.kind !== "redacted") {
          // A shown target carries no redaction facts - and so no canaries.
          continue;
        }
        const canaries = repo.redaction.canaries;
        if (canaries.length === 0) {
          // Only a normal target has surfaces to plant into: a redacted
          // missing-settings or raw-invalid target legitimately has none.
          expect(repo.target.kind).not.toBe("normal");
          continue;
        }
        sawCanary = true;
        const spec = scenario.repos?.[repo.slug] as {
          settings: Record<string, unknown> | null;
          live_state?: {
            labels?: Array<{ name?: string; description?: string }>;
            repo?: { description?: string };
          };
        };
        const nameCanary = canaries.find((c) => c.endsWith("-name"));
        const declaredDescCanary = canaries.find((c) => c.endsWith("-declared"));
        const liveDescCanary = canaries.find((c) => c.endsWith("-live"));
        const repoCanary = canaries.find((c) => c.endsWith("-repo"));
        // The canary label is declared and mirrored in live by NAME, but with a
        // DIFFERENT description, so it drifts (check) / updates (apply) - the name
        // and description flow into the detail a suppression regression would leak.
        const declared = spec.settings?.labels as
          | Array<{ name?: string; description?: string }>
          | undefined;
        const declaredCanary = declared?.find((l) => l.name === nameCanary);
        const liveCanary = spec.live_state?.labels?.find((l) => l.name === nameCanary);
        expect(declaredCanary?.description).toBe(declaredDescCanary);
        expect(liveCanary?.description).toBe(liveDescCanary);
        expect(declaredDescCanary).not.toBe(liveDescCanary); // guarantees drift
        expect(spec.live_state?.repo?.description).toBe(repoCanary);
        // The labels section must be predicted so the oracle expects the canary.
        expect(repo.target.kind).toBe("normal");
        if (repo.target.kind === "normal") {
          expect(repo.target.meta.sections).toContain("labels");
        }
      }
    }
    expect(sawCanary).toBe(true);
  });
});

describe("genDiscoveryScenario", () => {
  test("every pool carries at least one non-public repo (non-vacuous leak check)", () => {
    // Discovery always runs under redact; an all-public pool would hand the
    // leak invariant an empty forbidden set, so the generator forces one
    // non-public repo - the same guard genMultiScenario's forced-private
    // target provides.
    for (let i = 0; i < 300; i++) {
      const { meta } = genDiscoveryScenario(new Rng(i));
      expect(meta.privateRepos).toBe("redact");
      expect(meta.pool.some((r) => (r.visibility ?? "public") !== "public")).toBe(true);
    }
  });
});

describe("seed determinism (byte-equal JSON)", () => {
  // Two draws from one seed must serialize byte-identically, or a --seed
  // replay diverges from the failing run. The multi and discovery cases
  // project .scenario - the part a seeded replay re-executes.
  const cases: Array<{ name: string; draw: () => unknown }> = [
    { name: "genInvalidSettings", draw: () => genInvalidSettings(new Rng(5)) },
    { name: "genScenario", draw: () => genScenario(new Rng(42)) },
    { name: "genMultiScenario", draw: () => genMultiScenario(new Rng(9)).scenario },
    { name: "genDiscoveryScenario", draw: () => genDiscoveryScenario(new Rng(31)).scenario },
  ];
  test.each(cases)("$name is deterministic for a seed", ({ draw }) => {
    expect(JSON.stringify(draw())).toBe(JSON.stringify(draw()));
  });
});

describe("battery forces (constructed eligibility, never rejection-sampled)", () => {
  test("issue-report force always yields the delivering issue channel", () => {
    for (let i = 0; i < 200; i++) {
      const { meta } = genMultiScenario(new Rng(i), "issue-report");
      expect(meta.privateRepos).toBe("redact");
      expect(meta.privateReport).toBe("issue");
    }
  });

  test("idempotence-eligible force pins apply, none-channel, no raw, empty masks", () => {
    for (let i = 0; i < 200; i++) {
      const { scenario, meta } = genMultiScenario(new Rng(i), "idempotence-eligible");
      expect(meta.mode).toBe("apply");
      expect(meta.privateReport).toBe("none");
      // The global mask is cleared too: a globally denied teams section under
      // fail policy would preflight-abort and block the fixpoint proof.
      expect(scenario.token_permissions).toBeUndefined();
      expect(meta.repos.some((r) => r.target.kind === "raw-invalid")).toBe(false);
      for (const repo of meta.repos) {
        if (repo.target.kind === "normal") {
          expect(Object.keys(repo.target.meta.mask)).toEqual([]);
        }
      }
    }
  });

  test("plain-first-target force keeps index 0 fault-victim-eligible", () => {
    for (let i = 0; i < 200; i++) {
      const { meta } = genMultiScenario(new Rng(i), "plain-first-target");
      expect(meta.privateRepos).toBe("show");
      const first = meta.repos[0];
      if (first === undefined) {
        throw new Error("genMultiScenario built no repos");
      }
      expect(first.target.kind).not.toBe("raw-invalid");
      expect(canariesOf(first)).toEqual([]);
    }
  });

  test("converges force always yields a non-empty kept set", () => {
    for (let i = 0; i < 200; i++) {
      const { scenario, meta } = genDiscoveryScenario(new Rng(i), "converges");
      expect(predictDiscovery(meta.pool, meta.filters).length).toBeGreaterThan(0);
      // No filter inputs ride along under the force.
      expect(scenario.discovery?.inputs).toEqual({});
    }
  });
});

describe("dead-corner knobs", () => {
  test("code scanning declares each optional field within its schema enum, runner_label only when labeled", () => {
    let sawThreat = 0;
    let sawLabeled = 0;
    for (let i = 0; i < 300; i++) {
      const cfg = genSettings(new Rng(i), "code_scanning_default_setup") as Record<string, unknown>;
      if (cfg.threat_model !== undefined) {
        sawThreat++;
        expect(["remote", "remote_and_local"]).toContain(cfg.threat_model as string);
      }
      if (cfg.runner_type !== undefined) {
        expect(["standard", "labeled"]).toContain(cfg.runner_type as string);
      }
      if (cfg.runner_label !== undefined) {
        sawLabeled++;
        expect(cfg.runner_type).toBe("labeled");
      }
      if (cfg.runner_type === "labeled") {
        expect(cfg.runner_label).toBe("e2e-runner");
      }
    }
    expect(sawThreat).toBeGreaterThan(0);
    expect(sawLabeled).toBeGreaterThan(0);
  });

  test("every denial style surfaces across seeds, 404 included", () => {
    const seen = new Set<string | number>();
    for (let i = 0; i < 300; i++) {
      seen.add(genScenario(new Rng(i)).meta.denialStyle);
    }
    expect([...seen].sort()).toEqual([403, 404, "fine_grained"].sort());
  });

  test("the excluded outcome is reachable: allowlists surface across seeds", () => {
    let sawAllowlist = 0;
    for (let i = 0; i < 300; i++) {
      const { meta } = genScenario(new Rng(i));
      if (meta.onlySections !== undefined) {
        sawAllowlist++;
      }
    }
    expect(sawAllowlist).toBeGreaterThan(0);
  });

  test("the multi global mask varies ONLY org_members, and rides token_permissions", () => {
    let sawGlobal = 0;
    for (let i = 0; i < 300; i++) {
      const { scenario, meta } = genMultiScenario(new Rng(i));
      const global = scenario.token_permissions;
      if (global !== undefined) {
        sawGlobal++;
        expect(Object.keys(global)).toEqual(["org_members"]);
        // Every normal target's oracle meta carries the SAME global mask as
        // orgMask, so mock and oracle grade one effective mask.
        for (const repo of meta.repos) {
          if (repo.target.kind === "normal") {
            expect(repo.target.meta.orgMask).toEqual(global);
          }
        }
      }
    }
    expect(sawGlobal).toBeGreaterThan(0);
  });

  test("a globally denied org gate strips org-gated sections from the forced-private canary target", () => {
    // The canary target's design guarantees (never preflight-aborts, report
    // always delivers) assume its sections are fully granted; an org-gated
    // section (teams) under org_members: none is denied whatever the per-slug
    // mask says, so it is dropped there (regression: fuzz seed 795 -
    // preflight abort ate the canary and the counterfactual read as vacuous).
    // Only the FORCED target carries the guarantee: an unforced roll can
    // produce another redacted empty-mask target that legitimately keeps
    // teams, so the pin addresses the recorded forcedPrivateSlug exactly.
    expect(ORG_GATED_SECTIONS.has("teams")).toBe(true);
    let sawShape = 0;
    for (let i = 0; i < 600; i++) {
      const { scenario, meta } = genMultiScenario(new Rng(i));
      if (scenario.token_permissions?.org_members !== "none") {
        continue;
      }
      const forced = meta.repos.find((repo) => repo.slug === meta.forcedPrivateSlug);
      if (forced === undefined || forced.target.kind !== "normal") {
        continue;
      }
      sawShape++;
      for (const key of forced.target.meta.sections) {
        expect(ORG_GATED_SECTIONS.has(key)).toBe(false);
      }
    }
    expect(sawShape).toBeGreaterThan(0);
  });

  test("a GHES base prefix surfaces occasionally on both generators", () => {
    let single = 0;
    let multi = 0;
    for (let i = 0; i < 300; i++) {
      if (genScenario(new Rng(i)).scenario.base_prefix === "/api/v3") {
        single++;
      }
      if (genMultiScenario(new Rng(i)).scenario.base_prefix === "/api/v3") {
        multi++;
      }
    }
    expect(single).toBeGreaterThan(0);
    expect(multi).toBeGreaterThan(0);
  });
});
