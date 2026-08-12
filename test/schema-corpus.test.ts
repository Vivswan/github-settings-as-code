/**
 * Schema-vs-runtime semantic agreement over the real corpus: every settings
 * fragment the curated e2e scenarios declare, plus seeded generator output,
 * is validated BOTH by the published lib/settings.schema.json (through ajv,
 * exactly as the e2e generators compile it) and by the runtime's
 * validateSectionShapes - and the verdicts must agree. The published schema
 * and the zod source can then never drift apart silently: a schema too
 * strict rejects a document the action would apply, a schema too loose
 * blesses a document the run then fails on. The few deliberate
 * disagreements are enumerated in KNOWN_DIVERGENCES with their reasons;
 * anything else is a failure.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { parse } from "yaml";
import settingsSchema from "../lib/settings.schema.json" with { type: "json" };
import { validateSectionShapes } from "../src/engine/validate.js";
import { SECTION_KEYS } from "../src/schema.js";
import { genSettings } from "./e2e/generators.js";
import { Rng } from "./e2e/prng.js";

interface CorpusDoc {
  /** Where the fragment came from ("labels-apply-converges.yml settings"). */
  label: string;
  doc: Record<string, unknown>;
}

/** Every settings-document fragment in the curated scenarios: the top-level
 * settings, the multi-repo defaults file, and each per-repo settings. */
function scenarioDocs(): CorpusDoc[] {
  const root = join(import.meta.dir, "e2e", "scenarios");
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const nested of readdirSync(join(root, entry.name))) {
        files.push(join(entry.name, nested));
      }
    } else if (entry.name.endsWith(".yml")) {
      files.push(entry.name);
    }
  }
  const docs: CorpusDoc[] = [];
  const push = (label: string, value: unknown) => {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      docs.push({ label, doc: value as Record<string, unknown> });
    }
  };
  for (const file of files.sort()) {
    const scenario = parse(readFileSync(join(root, file), "utf8")) as Record<string, unknown>;
    push(`${file} settings`, scenario.settings);
    push(`${file} defaults_file`, scenario.defaults_file);
    const repos = scenario.repos as Record<string, { settings?: unknown }> | undefined;
    for (const [repo, entry] of Object.entries(repos ?? {})) {
      push(`${file} ${repo} settings`, entry?.settings);
    }
  }
  expect(docs.length).toBeGreaterThan(150);
  return docs;
}

/** Seeded generator output: one single-section document per section per seed,
 * always shape-valid by construction (the generators' own three-way drift
 * check pins that), so schema and runtime must BOTH accept every one. */
function generatedDocs(): CorpusDoc[] {
  const docs: CorpusDoc[] = [];
  for (const key of SECTION_KEYS) {
    for (let seed = 1; seed <= 5; seed++) {
      docs.push({
        label: `generated ${key} seed ${seed}`,
        doc: { [key]: genSettings(new Rng(seed), key) },
      });
    }
  }
  return docs;
}

/**
 * The enumerated schema-vs-runtime disagreements, each deliberate. Two kinds:
 * - "schema-looser": the runtime invariant is a zod superRefine or a
 *   closedSurface declaration, which JSON Schema cannot (or must not)
 *   express - the run still rejects the document upfront.
 * - "schema-stricter": would mean the published schema rejects documents the
 *   action applies; none are tolerated (the deferral enums, e.g. deployment
 *   branch-policy `type`, document upstream vocabulary the runtime
 *   deliberately leaves to GitHub - a corpus doc hitting one would surface
 *   here and needs a decision, not an allowlist entry).
 */
const KNOWN_DIVERGENCES: Record<string, string> = {
  "actions-selected-contradiction-rejected.yml settings":
    "schema-looser: the allowed_actions/selected_actions contradiction is a superRefine (cross-field), rejected at runtime upfront",
  "actions-selected-contradiction-rejected-check.yml settings":
    "schema-looser: same contradiction, check mode",
  "collaborators-unknown-key-rejected.yml settings":
    "schema-looser: collaborators is a closedSurface section; the shape stays open for passthrough parity and validateSectionShapes rejects the typo key",
  "environment-pins-cap-rejected.yml settings":
    "schema-looser: the at-most-10 pinned entries cap is a superRefine counting pinned: true across the array, which JSON Schema cannot count",
  "branches-wildcard-untranslatable-key-rejected.yml settings":
    "schema-looser: the wildcard-entry key sweep is a superRefine over the section's GraphQL translation tables (branches.ts); protection stays an open passthrough mapping in the schema",
};

describe("published schema agrees with the runtime over the corpus", () => {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const add = (addFormats as unknown as { default?: typeof addFormats }).default ?? addFormats;
  (add as typeof addFormats)(ajv);
  const validate: ValidateFunction = ajv.compile(settingsSchema);

  test("every scenario fragment and generated document gets one verdict", () => {
    const disagreements: string[] = [];
    const staleAllowlist = new Set(Object.keys(KNOWN_DIVERGENCES));
    for (const { label, doc } of [...scenarioDocs(), ...generatedDocs()]) {
      const schemaAccepts = validate(doc) === true;
      const runtimeAccepts = validateSectionShapes(doc, label) === null;
      if (schemaAccepts === runtimeAccepts) {
        continue;
      }
      if (KNOWN_DIVERGENCES[label] !== undefined) {
        staleAllowlist.delete(label);
        // A KNOWN divergence must stay schema-looser: the schema accepting
        // a runtime-rejected document costs one loud run; the reverse would
        // reject documents the action applies.
        expect(
          schemaAccepts,
          `${label}: expected the schema to be the looser side (${KNOWN_DIVERGENCES[label]})`,
        ).toBe(true);
        continue;
      }
      disagreements.push(
        `${label}: schema ${schemaAccepts ? "accepts" : "REJECTS"} but runtime ${runtimeAccepts ? "accepts" : "REJECTS"}${schemaAccepts ? "" : ` (${JSON.stringify(validate.errors?.slice(0, 2))})`}`,
      );
    }
    expect(disagreements, disagreements.join("\n")).toEqual([]);
    expect(
      [...staleAllowlist],
      "KNOWN_DIVERGENCES entries no corpus document witnesses - delete them",
    ).toEqual([]);
  });
});
