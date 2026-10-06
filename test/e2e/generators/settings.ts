/**
 * Everything here is a pure function of an Rng, so a failing fuzz iteration replays from its seed. Every settings
 * document a section generator draws is also validated against the built lib/settings.schema.json (`bun run fuzz`
 * builds it first), so a generator drifting from the published schema fails the run instead of fuzzing a shape the
 * schema rejects.
 */

import { Ajv, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import type { SectionKey } from "../../../src/schema.js";
import { isWildcardPattern } from "../../../src/sections/branches/index.js";
import { genActions } from "../../sections/actions/generators.js";
import { autolinksWitness, genAutolinks } from "../../sections/autolinks/generators.js";
import { FUZZ_DEPLOYMENT_ENVIRONMENTS, genBranches } from "../../sections/branches/generators.js";
import { genCheckSuitePreferences } from "../../sections/check_suite_preferences/generators.js";
import { genCodeQuality } from "../../sections/code_quality_setup/generators.js";
import { genCodeScanning } from "../../sections/code_scanning_default_setup/generators.js";
import { genCollaborators } from "../../sections/collaborators/generators.js";
import { genCustomProperties } from "../../sections/custom_properties/generators.js";
import { deployKeysWitness, genDeployKeys } from "../../sections/deploy_keys/generators.js";
import { genEnvironments } from "../../sections/environments/generators.js";
import { genInteractionLimits } from "../../sections/interaction_limits/generators.js";
import { genLabels, labelsWitness } from "../../sections/labels/generators.js";
import { genMilestones, milestonesWitness } from "../../sections/milestones/generators.js";
import { genPages } from "../../sections/pages/generators.js";
import { genRepository } from "../../sections/repository/generators.js";
import { genRulesets } from "../../sections/rulesets/generators.js";
import { genSecretScanningPatterns } from "../../sections/secret_scanning_custom_patterns/generators.js";
import { genTeams } from "../../sections/teams/generators.js";
import { genWebhooks } from "../../sections/webhooks/generators.js";
import { genWorkflows } from "../../sections/workflows/generators.js";
import { readSettingsSchema } from "../../settings-schema.js";
import {
  E2E_SECRET_ENV,
  type EntriesForm,
  entriesOf,
  type Json,
  type LiveWitness,
  type LiveWitnessKind,
  maybeWrapUndeclared,
} from "../gen-support.js";
import type { LiveState } from "../mock/state.js";
import type { Rng } from "../prng.js";
import { type MaskGrade, type MaskKey, MASK_KEYS as SCHEMA_MASK_KEYS } from "../schema.js";

/**
 * A fixed age recipient, so scenarios and the fuzzer share one hermetic key; runner.test.ts re-validates it against
 * src's parseRecipient so it cannot rot silently. The matching identity is never needed.
 *   the harness never decrypts  -> the upload fails with a safe warning (no runner token)
 *   what the run proves         -> a real key keeps the run green and leaks nothing
 */
export const ARTIFACT_TEST_RECIPIENT =
  "age1wshulnlu6mpa4rx54w6xs9kscqw7uqem3fh748xsrfyqusgmfv2qfca3qt";

/** References draw from E2E_SECRET_ENV, the pool scenarioSecretEnv() builds the child env from, so none names a variable the env lacks. */
function genSecretEntries(rng: Rng): EntriesForm {
  const names = Object.keys(E2E_SECRET_ENV);
  const count = rng.int(names.length) + 1;
  const entries = names.slice(0, count).map((name) => ({
    name,
    value: `$${name}`,
  })) as Json[];
  return maybeWrapUndeclared(rng, entries);
}

function genActionsVariables(rng: Rng): EntriesForm {
  const used = new Set<string>();
  const out: Json[] = [];
  const count = rng.int(3) + 1;
  for (let i = 0; i < count; i++) {
    // GitHub stores variable names uppercased, so a lowercased declared name exercises the case-insensitive match.
    let name = `${rng.pick(["DEPLOY_REGION", "BUILD_MODE", "LOG_LEVEL", "FEATURE_FLAG"])}_${i}`;
    if (rng.bool(0.3)) {
      name = name.toLowerCase();
    }
    if (used.has(name.toUpperCase())) {
      continue;
    }
    used.add(name.toUpperCase());
    out.push({ name, value: rng.pick(["us-east-1", "production", "debug", "on", "42"]) });
  }
  return maybeWrapUndeclared(rng, out);
}

/** The top-level sections whose entries are {name, value: $NAME} secret lists. */
export const SECRET_LIST_SECTIONS = [
  "actions_secrets",
  "dependabot_secrets",
  "codespaces_secrets",
  "agents_secrets",
] as const satisfies readonly SectionKey[];

export function scenarioSecretEnv(settings: Json): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  let found = false;
  const collect = (reference: unknown): void => {
    if (typeof reference !== "string") {
      return;
    }
    const name = reference.slice(1);
    const value = E2E_SECRET_ENV[name as keyof typeof E2E_SECRET_ENV];
    if (value === undefined) {
      throw new Error(`BUG: generated secret reference ${reference} is not in the fixed pool`);
    }
    env[name] = value;
    found = true;
  };
  if (settings.webhooks !== undefined && settings.webhooks !== null) {
    for (const entry of entriesOf(settings.webhooks)) {
      collect((entry.config as Json | undefined)?.secret);
    }
  }
  for (const key of SECRET_LIST_SECTIONS) {
    if (settings[key] !== undefined && settings[key] !== null) {
      for (const entry of entriesOf(settings[key])) {
        collect(entry.value);
      }
    }
  }
  if (Array.isArray(settings.environments)) {
    for (const entry of settings.environments as Json[]) {
      if (entry.secrets !== undefined && entry.secrets !== null) {
        for (const secret of entriesOf(entry.secrets)) {
          collect(secret.value);
        }
      }
    }
  }
  return found ? env : undefined;
}

export const MASK_KEYS: readonly MaskKey[] = SCHEMA_MASK_KEYS;

/**
 * The nested keys' endpoints carry PER-ENDPOINT permission overrides (src/sections/environments/endpoints.ts) that the
 * section-level oracle cannot grade, so a mask constraining either resource would mispredict them.
 *   Actions "none" or Administration below "write"  -> both keys stripped; the curated environment-*-denied scenarios pin the denied paths
 *   fully granted                                    -> kept, so the convergence and idempotence proofs still exercise them
 */
export function suppressMaskedEnvironmentOverrides(
  settings: Json,
  mask: Partial<Record<MaskKey, MaskGrade>>,
): void {
  const actionsDenied = (mask.actions ?? "write") === "none";
  const administrationBelowWrite = (mask.administration ?? "write") !== "write";
  if (!actionsDenied && !administrationBelowWrite) {
    return;
  }
  if (!Array.isArray(settings.environments)) {
    return;
  }
  for (const entry of settings.environments as Json[]) {
    delete entry.deployment_branch_policies;
    delete entry.deployment_protection_rules;
  }
}

/**
 * custom_properties' reads are permission-"none" (src/sections/custom_properties/index.ts), so a mask denying the
 * resource outright is ungradeable: the oracle's grade-none fold predicts a deniable read that cannot happen.
 *   "none", other sections declared  -> the section is stripped; the curated custom-properties-write-denied scenario pins the path
 *   "none", the only section         -> the mask softens to "read", so the document stays non-empty
 *   "read"                           -> kept: the reads pass and the PATCH is denied mid-apply, which the oracle grades
 * Stripping shortens the list later draws walk, but depends only on the seed's own mask roll, so a replay strips identically.
 */
export function suppressMaskedCustomProperties(
  settings: Json,
  mask: Partial<Record<MaskKey, MaskGrade>>,
  sections: SectionKey[],
): void {
  if ((mask.custom_properties ?? "write") !== "none" || settings.custom_properties === undefined) {
    return;
  }
  if (sections.length > 1) {
    delete settings.custom_properties;
    sections.splice(sections.indexOf("custom_properties"), 1);
  } else {
    mask.custom_properties = "read";
  }
}

const SETTINGS_GENERATORS: Record<SectionKey, (rng: Rng) => unknown> = {
  repository: genRepository,
  labels: genLabels,
  rulesets: genRulesets,
  branches: genBranches,
  environments: genEnvironments,
  autolinks: genAutolinks,
  actions: genActions,
  actions_secrets: genSecretEntries,
  dependabot_secrets: genSecretEntries,
  codespaces_secrets: genSecretEntries,
  agents_secrets: genSecretEntries,
  workflows: genWorkflows,
  check_suite_preferences: genCheckSuitePreferences,
  pages: genPages,
  code_scanning_default_setup: genCodeScanning,
  code_quality_setup: genCodeQuality,
  collaborators: genCollaborators,
  teams: genTeams,
  milestones: genMilestones,
  interaction_limits: genInteractionLimits,
  actions_variables: genActionsVariables,
  agents_variables: genActionsVariables,
  webhooks: genWebhooks,
  custom_properties: genCustomProperties,
  deploy_keys: genDeployKeys,
  secret_scanning_custom_patterns: genSecretScanningPatterns,
};

export function genSettings(rng: Rng, key: SectionKey): unknown {
  return SETTINGS_GENERATORS[key](rng);
}

/** repository has no witness yet: a matching one needs normalized topics, the enable_* toggles, and fixture-aware absent fields. */
export const WITNESS_SECTIONS = ["labels", "autolinks", "milestones", "deploy_keys"] as const;
export type WitnessSection = (typeof WITNESS_SECTIONS)[number];

/** The witness kinds each modeled section supports; extra-undeclared only where the default deletes. */
export const WITNESS_KINDS: Record<WitnessSection, readonly LiveWitnessKind[]> = {
  labels: ["matching", "drift-update", "extra-undeclared"],
  autolinks: ["matching", "drift-update", "extra-undeclared"],
  milestones: ["matching", "drift-update"],
  deploy_keys: ["matching", "drift-update"],
};

const WITNESS_BUILDERS: Record<
  WitnessSection,
  (rng: Rng, declared: Json[], kind: LiveWitnessKind) => LiveWitness
> = {
  labels: labelsWitness,
  autolinks: autolinksWitness,
  milestones: milestonesWitness,
  deploy_keys: deployKeysWitness,
};

/**
 * Live state with a KNOWN relation to the declared settings, so the oracle pins one outcome class instead of {clean, drift}.
 * The returned kind is the one that holds: drift-update falls back to matching when no entry is perturbable.
 */
export function genLiveWitness(
  rng: Rng,
  key: WitnessSection,
  settings: unknown,
  kind: LiveWitnessKind,
): LiveWitness {
  if (!WITNESS_KINDS[key].includes(kind)) {
    throw new Error(
      `genLiveWitness: ${key} does not support the "${kind}" witness (supported: ${WITNESS_KINDS[key].join(", ")}); add the kind to WITNESS_KINDS[${key}] and implement it in the section's witness builder`,
    );
  }
  // Witness sections draw the plain form only; the unwrap keeps this right if that ever moves.
  const declared = entriesOf(settings);
  return WITNESS_BUILDERS[key](rng, declared, kind);
}

/**
 * branches and workflows can be configured but not created, so a declared protection or workflow state whose resource
 * is absent live drifts forever on a skip note; seeding it lets a fully-granted apply converge. Exported for the fault
 * fuzz's single-section scenarios.
 */
export function presenceLiveState(settings: Json): LiveState | undefined {
  const live: LiveState = {};
  const branches = settings.branches as Json[] | undefined;
  if (Array.isArray(branches)) {
    // Only literal names: a wildcard pattern is a rule, never a git branch.
    const literal = branches.map((b) => String(b.name)).filter((name) => !isWildcardPattern(name));
    if (literal.length > 0) {
      live.branches = literal;
    }
    // GitHub silently drops an unknown environment from required_deployments (the mock mimics it), so every name the
    // generator can draw exists live, or a fully-granted apply's read-back would fail.
    if (branches.some((b) => (b.protection as Json | null)?.required_deployments !== undefined)) {
      live.environments = Object.fromEntries(
        FUZZ_DEPLOYMENT_ENVIRONMENTS.map((name) => [name, { name }]),
      );
    }
  }
  const workflows = settings.workflows as Json[] | undefined;
  if (Array.isArray(workflows)) {
    live.workflows = workflows.map((w, i) => ({
      id: i + 1,
      name: String(w.path),
      path: String(w.path),
      state: w.state === "disabled" ? "disabled_manually" : "active",
    }));
  }
  return live.branches || live.environments || live.workflows ? live : undefined;
}

let validator: ValidateFunction | undefined;

function settingsValidator(): ValidateFunction {
  if (!validator) {
    const ajv = new Ajv({ strict: false, allErrors: true });
    const add = (addFormats as unknown as { default?: typeof addFormats }).default ?? addFormats;
    (add as typeof addFormats)(ajv);
    validator = ajv.compile(readSettingsSchema());
  }
  return validator;
}

function valueAtPointer(doc: unknown, instancePath: string): unknown {
  let value = doc;
  for (const segment of instancePath.split("/").slice(1)) {
    if (typeof value !== "object" || value === null) {
      return undefined;
    }
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** One leg of the three-way drift check; generators.test.ts runs it beside validateSettingsDoc and each section's zod shape. */
export function validateAgainstPublishedSchema(doc: unknown): void {
  const validate = settingsValidator();
  if (!validate(doc)) {
    // The doc is ephemeral, so without the offending VALUE and the ajv params a drift means replaying the seed and dumping by hand.
    const errors = (validate.errors ?? [])
      .map((e) => {
        const params =
          Object.keys(e.params ?? {}).length > 0 ? `, ${JSON.stringify(e.params)}` : "";
        return `  ${e.instancePath || "(root)"} ${e.message} (got ${JSON.stringify(valueAtPointer(doc, e.instancePath))}${params})`;
      })
      .join("\n");
    throw new Error(`generated settings failed schema validation:\n${errors}`);
  }
}
