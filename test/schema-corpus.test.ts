import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { parse } from "yaml";
import { validateSectionShapes } from "../src/engine/validate.js";
import { SECTION_KEYS } from "../src/schema.js";
import { genSettings } from "./e2e/generators.js";
import { Rng } from "./e2e/prng.js";
import { collectYmlFiles, scenarioRoots } from "./e2e/schema.js";
import { ROOT } from "./root.js";
import { readSettingsSchema } from "./settings-schema.js";

interface CorpusDoc {
  /** Where the fragment came from ("labels-apply-converges.yml settings"). */
  label: string;
  doc: Record<string, unknown>;
}

/** The places a scenario carries a settings document; every kind must be witnessed by the corpus (scenarioDocs). */
const FRAGMENT_KINDS = [
  "settings",
  "defaults_file",
  "settings_layers[<i>]",
  "expect.snapshot",
  "expect.rendered",
  "repos.<slug>.settings",
  "repos.<slug>.expect.snapshot",
] as const;
type FragmentKind = (typeof FRAGMENT_KINDS)[number];

/** A curated fragment remembers its file and kind, so the loader guards derive from what was collected, not from side bookkeeping. */
interface ScenarioFragment extends CorpusDoc {
  file: string;
  kind: FragmentKind;
}

/**
 * The scenario roots, re-derived from the directories on disk (every `scenarios/` under a section
 * directory, plus the cross-section root) so a root that scenarioRoots() drops is caught.
 */
function independentScenarioRoots(): string[] {
  const sectionsDir = join(ROOT, "test", "sections");
  const sectionRoots = readdirSync(sectionsDir, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(sectionsDir, entry.name, "scenarios")),
    )
    .map((entry) => join(sectionsDir, entry.name, "scenarios"));
  return [join(ROOT, "test", "e2e", "scenarios"), ...sectionRoots].sort();
}

/** collectYmlFiles's walk, re-done with the platform's own recursive listing so a walker that stops descending is caught. */
function independentYmlListing(roots: readonly string[]): string[] {
  return roots
    .flatMap((root) =>
      (readdirSync(root, { recursive: true }) as string[])
        .filter((entry) => entry.endsWith(".yml"))
        .map((entry) => join(root, entry)),
    )
    .sort();
}

/**
 * Every settings fragment in the curated scenarios, walked by the same collectYmlFiles the scenario loader uses; each root is asserted non-empty so a
 * renamed directory fails here instead of shrinking the corpus.
 */
function scenarioDocs(): CorpusDoc[] {
  const roots = scenarioRoots();
  expect(
    [...roots].sort(),
    "scenarioRoots disagrees with the scenarios/ directories on disk",
  ).toEqual(independentScenarioRoots());
  const files: string[] = [];
  for (const root of roots) {
    const inRoot = collectYmlFiles(root);
    if (inRoot.length === 0) {
      throw new Error(`scenario root ${root} contributed no .yml files - renamed or emptied?`);
    }
    files.push(...inRoot);
  }
  files.sort();
  expect(files, "collectYmlFiles disagrees with the platform's own listing").toEqual(
    independentYmlListing(roots),
  );
  const docs: ScenarioFragment[] = [];
  // Labels key KNOWN_DIVERGENCES, so basenames must stay unique corpus-wide; nothing else pins that (the YAML name field is not in lockstep with the
  // filename).
  const seenBasenames = new Map<string, string>();
  for (const file of files) {
    const dup = seenBasenames.get(basename(file));
    if (dup !== undefined) {
      throw new Error(
        `duplicate scenario file basename across roots: ${dup} and ${file} - labels key KNOWN_DIVERGENCES, so basenames must stay unique`,
      );
    }
    seenBasenames.set(basename(file), file);
  }
  const rawTextScenarios = new Set<string>();
  for (const file of files) {
    const scenario = parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const name = basename(file);
    const push = (kind: FragmentKind, label: string, value: unknown) => {
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        docs.push({ label, doc: value as Record<string, unknown>, file, kind });
      }
    };
    push("settings", `${name} settings`, scenario.settings);
    push("defaults_file", `${name} defaults_file`, scenario.defaults_file);
    // Every layer is a settings file the run reads, and the pinned rendered document is what
    // mode: render writes for a later run to read, so both validators must accept each of them.
    const layers = scenario.settings_layers as unknown[] | undefined;
    for (const [i, layer] of (layers ?? []).entries()) {
      push("settings_layers[<i>]", `${name} settings_layers[${i}]`, layer);
    }
    // A pinned snapshot document is what mode: snapshot writes for a later
    // apply to read, so both validators must accept it like any settings file.
    const expected = scenario.expect as { snapshot?: unknown; rendered?: unknown } | undefined;
    push("expect.snapshot", `${name} expect.snapshot`, expected?.snapshot);
    push("expect.rendered", `${name} expect.rendered`, expected?.rendered);
    const repos = scenario.repos as
      | Record<string, { settings?: unknown; expect?: { snapshot?: unknown } }>
      | undefined;
    for (const [repo, entry] of Object.entries(repos ?? {})) {
      push("repos.<slug>.settings", `${name} ${repo} settings`, entry?.settings);
      push(
        "repos.<slug>.expect.snapshot",
        `${name} ${repo} expect.snapshot`,
        entry?.expect?.snapshot,
      );
    }
    if (typeof scenario.settings_raw === "string") {
      rawTextScenarios.add(file);
    }
  }
  // Derived from the collected fragments rather than a pinned count, so adding a scenario never edits this
  // file. The scenario schema requires `settings` unless the file carries `settings_raw` (test/e2e/schema.ts),
  // so every walked file contributed a fragment or is a raw-text scenario, and every kind has a witness.
  const contributing = new Set(docs.map((fragment) => fragment.file));
  const dropped = files.filter((file) => !contributing.has(file) && !rawTextScenarios.has(file));
  expect(dropped, "scenario files that yielded no fragment").toEqual([]);
  const kindsWitnessed = new Set(docs.map((fragment) => fragment.kind));
  expect([...kindsWitnessed].sort(), "fragment kinds no scenario witnesses").toEqual(
    [...FRAGMENT_KINDS].sort(),
  );
  return docs;
}

/** Seeded generator output, shape-valid by construction, so schema and runtime must BOTH accept every one. */
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
 * The deliberate schema-vs-runtime disagreements; anything else fails.
 *   schema-looser   -> a runtime invariant the schema does not carry (a cross-field superRefine, an open closedSurface); the run rejects upfront
 *   schema-stricter -> would reject documents the action applies; none are tolerated (a deferral enum hit needs a decision, not an entry)
 */
const KNOWN_DIVERGENCES: Record<string, string> = {
  "actions-selected-contradiction-rejected.yml settings":
    "schema-looser: the allowed_actions/selected_actions contradiction is a superRefine (cross-field), rejected at runtime upfront",
  "actions-selected-contradiction-rejected-check.yml settings":
    "schema-looser: same contradiction, check mode",
  "actions-retention-reported-field-rejected.yml settings":
    "schema-looser: the reported-only field sweep (a key the GET returns and the PUT does not take) is a superRefine " +
    "over open passthrough objects, rejected at runtime upfront",
  "collaborators-unknown-key-rejected.yml settings":
    "schema-looser: collaborators is a closedSurface section; the shape stays open for passthrough parity and validateSectionShapes rejects the typo key",
  "environment-pins-cap-rejected.yml settings":
    "schema-looser: the at-most-10 pinned entries cap is a superRefine counting pinned: true across the array, which JSON Schema cannot count",
  "branches-wildcard-untranslatable-key-rejected.yml settings":
    "schema-looser: the wildcard-entry key sweep is a superRefine over the section's GraphQL translation tables (branches.ts); protection stays an open passthrough mapping in the schema",
  "secret-scanning-patterns-uncompilable-regex-rejected.yml settings":
    "schema-looser: the regex fields' syntax check is a superRefine that first translates the PCRE-only forms Hyperscan accepts (compilable-form.ts), which no JSON Schema keyword does; " +
    "`format: regex` would be a flagless new RegExp that also rejects a `\\Z` anchor after another character, refusing a delimiter Hyperscan holds, so the fields stay plain strings in the schema",
  "branches-get-response-copied-rejected.yml settings":
    "schema-looser: the GET-only key sweep is a recursive superRefine over the passthrough protection mapping (branches/schema.ts), which JSON Schema cannot express; the published schema types the two structured controls but forbids no key",
  "repository-get-only-key-rejected.yml settings":
    "schema-looser: the GET-only key refusal is a superRefine over the repository passthrough mapping, which stays open in the schema for the PATCH fields GitHub adds later",
  "code-scanning-default-setup-get-only-key-rejected.yml settings":
    "schema-looser: the GET-only schedule/updated_at refusal is a superRefine reading the passthrough record (setup-schema.ts); the shape stays open for passthrough parity",
  "code-quality-setup-runner-label-without-labeled-rejected.yml settings":
    "schema-looser: the runner_type/runner_label pairing is a cross-field superRefine (setup-schema.ts), rejected at runtime upfront",
  "labels-duplicate-rejected-before-any-write.yml settings":
    "schema-looser: two entries folding to one label name are the section's validate hook (a file-only check over the whole list), which JSON Schema cannot express",
  "autolinks-overlapping-prefixes.yml settings":
    "schema-looser: one key_prefix beginning another is the autolinks section's validate hook (a file-only check over every pair in the list), which JSON Schema cannot express",
  "environment-duplicate-secret-rejected-before-any-write.yml settings":
    "schema-looser: two nested secrets folding to one name are the environments validate hook over the nested list, which JSON Schema cannot express",
  "actions-secrets-literal-value-rejected.yml settings":
    "schema-looser: a secret value that is not a whole-value $NAME reference is validateSecretRef over the section's secretValues (validate.ts), " +
    "whose verdict also turns on the document's provenance, which no schema keyword expresses; the zod shape, and so the schema generated from it, types the value as a plain string",
  "actions-secrets-excluded-literal-value-rejected.yml settings":
    "schema-looser: the same literal-value refusal, in a section the sections input excludes",
};

describe("published schema agrees with the runtime over the corpus", () => {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const add = (addFormats as unknown as { default?: typeof addFormats }).default ?? addFormats;
  (add as typeof addFormats)(ajv);
  const validate: ValidateFunction = ajv.compile(readSettingsSchema());

  test("every scenario fragment and generated document gets one verdict", () => {
    const disagreements: string[] = [];
    const staleAllowlist = new Set(Object.keys(KNOWN_DIVERGENCES));
    for (const { label, doc } of [...scenarioDocs(), ...generatedDocs()]) {
      const schemaAccepts = validate(doc) === true;
      const runtimeAccepts = !("error" in validateSectionShapes(doc, label));
      if (label.startsWith("generated ") && !(schemaAccepts && runtimeAccepts)) {
        // Shape-valid by construction, so a rejection by either side is a break in that validator, not a divergence to tolerate.
        disagreements.push(
          `${label}: a generated document must be accepted by both (schema ${schemaAccepts}, runtime ${runtimeAccepts})`,
        );
        continue;
      }
      if (schemaAccepts === runtimeAccepts) {
        continue;
      }
      if (KNOWN_DIVERGENCES[label] !== undefined) {
        staleAllowlist.delete(label);
        // A KNOWN divergence must stay schema-looser: the reverse would reject documents the action applies.
        expect(
          schemaAccepts,
          `${label}: expected the schema to be the looser side (${KNOWN_DIVERGENCES[label]})`,
        ).toBe(true);
        continue;
      }
      const schemaVerdict = schemaAccepts ? "accepts" : "REJECTS";
      const runtimeVerdict = runtimeAccepts ? "accepts" : "REJECTS";
      const errors = schemaAccepts ? "" : ` (${JSON.stringify(validate.errors?.slice(0, 2))})`;
      disagreements.push(
        `${label}: schema ${schemaVerdict} but runtime ${runtimeVerdict}${errors}`,
      );
    }
    expect(disagreements, disagreements.join("\n")).toEqual([]);
    expect(
      [...staleAllowlist],
      "KNOWN_DIVERGENCES entries no corpus document witnesses - delete them",
    ).toEqual([]);
  });
});
