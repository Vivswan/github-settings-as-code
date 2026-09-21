/**
 * Everything here is a pure function of an Rng, so a failing fuzz iteration replays from its seed. Every settings
 * document a section generator draws is also validated against lib/settings.schema.json, so a generator drifting from
 * the published schema fails the run instead of fuzzing a shape the schema rejects.
 */

import { Ajv, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import settingsSchema from "../../lib/settings.schema.json" with { type: "json" };
import { validateSettingsDoc } from "../../src/engine/orchestrate.js";
import { SectionSelection } from "../../src/engine/section-selection.js";
import { silentIo } from "../../src/io.js";
import {
  LIST_SECTIONS,
  type ListSection,
  SECTION_KEYS,
  type SectionKey,
  type SettingsFile,
  UNDECLARED_POLICY_SECTIONS,
} from "../../src/schema.js";
import { genActions } from "../../src/sections/actions/generators.js";
import { autolinksWitness, genAutolinks } from "../../src/sections/autolinks/generators.js";
import {
  FUZZ_DEPLOYMENT_ENVIRONMENTS,
  genBranches,
} from "../../src/sections/branches/generators.js";
import { isWildcardPattern } from "../../src/sections/branches/index.js";
import { genCheckSuitePreferences } from "../../src/sections/check_suite_preferences/generators.js";
import { genCodeQuality } from "../../src/sections/code_quality_setup/generators.js";
import { genCodeScanning } from "../../src/sections/code_scanning_default_setup/generators.js";
import {
  genCollaborators,
  genInvitationsState,
} from "../../src/sections/collaborators/generators.js";
import { endpointMethod } from "../../src/sections/contract/endpoints.js";
import { genCustomProperties } from "../../src/sections/custom_properties/generators.js";
import { deployKeysWitness, genDeployKeys } from "../../src/sections/deploy_keys/generators.js";
import { genEnvironments } from "../../src/sections/environments/generators.js";
import { genInteractionLimits } from "../../src/sections/interaction_limits/generators.js";
import { genLabels, labelsWitness } from "../../src/sections/labels/generators.js";
import { genMilestones, milestonesWitness } from "../../src/sections/milestones/generators.js";
import { genPages } from "../../src/sections/pages/generators.js";
import { allEndpoints, allGraphqlOps, SECTIONS } from "../../src/sections/registry.js";
import { genRepository } from "../../src/sections/repository/generators.js";
import { genRulesets, PULL_REQUEST_PARAMETERS } from "../../src/sections/rulesets/generators.js";
import { compileFailure } from "../../src/sections/secret_scanning_custom_patterns/compilable-form.js";
import { genSecretScanningPatterns } from "../../src/sections/secret_scanning_custom_patterns/generators.js";
import { MAX_VARIABLE_VALUE_BYTES } from "../../src/sections/shared/schema-helpers.js";
import { genTeams } from "../../src/sections/teams/generators.js";
import { genWebhooks } from "../../src/sections/webhooks/generators.js";
import { genWorkflows } from "../../src/sections/workflows/generators.js";
import type { MustBeNever } from "../../src/types.js";
import { ADMIN_SLUG } from "./constants.js";
import {
  DEFAULT_LAYERING_DIRECTIVE,
  E2E_SECRET_ENV,
  type EntriesForm,
  entriesOf,
  type Json,
  LAYERING_DIRECTIVES,
  LAYERING_KEY,
  type LayeringDirective,
  type LiveWitness,
  type LiveWitnessKind,
  maybeWrapUndeclared,
  REMOVE_KEY,
  UNDECLARED_KEY,
  UNDECLARED_POLICIES,
  type UndeclaredPolicyWord,
} from "./gen-support.js";
import type { LiveState } from "./mock/state.js";
import type { Rng } from "./prng.js";
import {
  type DenialStyle,
  type MaskGrade,
  type MaskKey,
  type MultiRepo,
  type OwnerKind,
  MASK_KEYS as SCHEMA_MASK_KEYS,
  type Scenario,
} from "./schema.js";

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
const SECRET_LIST_SECTIONS = [
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

/**
 * A target's own settings.yml refuses `$NAME` references (src/flows/multi.ts: target provenance never reads the
 * operator's environment), so a multi target never declares one; the secret sections go outright, since their values are always references.
 */
function stripSecretReferences(settings: Json): void {
  const webhooks = settings.webhooks;
  if (webhooks !== undefined && webhooks !== null) {
    for (const entry of entriesOf(webhooks)) {
      const config = entry.config as Json | undefined;
      if (config !== undefined) {
        delete config.secret;
      }
    }
  }
  for (const key of SECRET_LIST_SECTIONS) {
    delete settings[key];
  }
  if (Array.isArray(settings.environments)) {
    for (const entry of settings.environments as Json[]) {
      delete entry.secrets;
    }
  }
}

/**
 * The nested keys' endpoints carry PER-ENDPOINT permission overrides (src/sections/environments/endpoints.ts) that the
 * section-level oracle cannot grade, so a mask constraining either resource would mispredict them.
 *   Actions "none" or Administration below "write"  -> both keys stripped; the curated environment-*-denied scenarios pin the denied paths
 *   fully granted                                    -> kept, so the convergence and idempotence proofs still exercise them
 */
function suppressMaskedEnvironmentOverrides(
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
function suppressMaskedCustomProperties(
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

/**
 * A personal account's repository takes pull, push, admin and 422s the rest (mock/state.ts, grantablePermission), and
 * the runtime cannot refuse a triage or maintain there at parse: the owner is unknown until the repository read. So a
 * generated file never declares one on a personal account; maintain folds to push, GitHub's own default. A post-draw
 * rewrite, not a different draw, so the main stream and every recorded seed stay stable.
 */
function personalizeCollaborators(settings: Json, ownerKind: OwnerKind): void {
  if (ownerKind !== "user" || settings.collaborators === undefined) {
    return;
  }
  for (const entry of entriesOf(settings.collaborators)) {
    if (entry.permission === "maintain") {
      entry.permission = "push";
    }
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

// --- Invalid-settings catalog (input-mode fuzz) -----------------------------

/**
 * Only violations validateSettingsDoc GENUINELY rejects belong here; values the loose shapes accept by design would
 * assert failures the contract does not promise, so they stay out.
 *   offendingToken  -> must appear in the rejection error: a section path ("labels[2].name"), an unknown key, or a wording fragment
 *   stays out       -> unknown nested keys under a loose shape, un-modeled enums, arbitrary types on loose keys,
 *                      `pages: null`
 */
export interface InvalidSettingsCase {
  doc: Json;
  offendingToken: string;
}

const RECORD_SECTIONS = [
  "repository",
  "actions",
  "check_suite_preferences",
  "code_scanning_default_setup",
  "code_quality_setup",
] as const satisfies readonly SectionKey[];

/** pages and interaction_limits are nullable objects with their own catalog cases; a section unclassified here fails typecheck. */
type CoveredSection =
  | ListSection
  | (typeof RECORD_SECTIONS)[number]
  | "pages"
  | "interaction_limits";
type _UnclassifiedSection = MustBeNever<Exclude<SectionKey, CoveredSection>>;

/** The required field each array section's item shape enforces: a string, except webhooks' `config` object. */
const NATURAL_KEYS: Record<ListSection, string> = {
  labels: "name",
  rulesets: "name",
  branches: "name",
  environments: "name",
  autolinks: "key_prefix",
  actions_secrets: "name",
  dependabot_secrets: "name",
  codespaces_secrets: "name",
  agents_secrets: "name",
  workflows: "path",
  collaborators: "username",
  teams: "name",
  milestones: "title",
  actions_variables: "name",
  agents_variables: "name",
  // webhooks' natural key is the nested config.url, but the required
  // entry-level field the shape enforces is `config` itself.
  webhooks: "config",
  custom_properties: "property_name",
  deploy_keys: "title",
  secret_scanning_custom_patterns: "name",
};

/** The sections whose entry `name` is a GitHub secret or variable name (the environments section nests the same two lists). */
const GITHUB_NAMED_SECTIONS = [
  ...SECRET_LIST_SECTIONS,
  "actions_variables",
  "agents_variables",
] as const satisfies readonly ListSection[];

/** A hyphen, a leading digit, and the reserved prefix in both cases; `github_token` folds to GITHUB_TOKEN once uppercased. */
const REFUSED_GITHUB_NAMES = ["my-secret", "2_TOKEN", "GITHUB_TOKEN", "github_token"] as const;

/** Entries come back by reference, so a case's mutation lands inside whichever form was drawn; itemToken spells that form's validator path. */
function validItems(
  rng: Rng,
  key: ListSection,
): { value: EntriesForm; entries: Json[]; index: number; itemToken: string } {
  const value = genSettings(rng.fork("valid"), key) as EntriesForm;
  const entries = entriesOf(value);
  const index = rng.int(entries.length);
  const itemToken = Array.isArray(value) ? `${key}[${index}]` : `${key}.entries[${index}]`;
  return { value, entries, index, itemToken };
}

export const INVALID_SETTINGS_CASES: ReadonlyArray<{
  name: string;
  build: (rng: Rng) => InvalidSettingsCase;
}> = [
  {
    name: "unknown-top-level-key",
    build: (rng) => {
      const typo = rng.pick(["labelz", "label", "milestone", "repositories", "branch"]);
      return {
        doc: { labels: genSettings(rng.fork("labels"), "labels") as Json, [typo]: [] },
        offendingToken: typo,
      };
    },
  },
  {
    name: "unknown-underscore-key",
    build: (rng) => {
      // The underscore is the two directives' and nothing else's: a note or a misspelled directive is rejected, never dropped.
      const key = rng.pick(["_notes", "_owner", "_layerin", "_undeclared"]);
      return {
        doc: { labels: genSettings(rng.fork("labels"), "labels") as Json, [key]: "x" },
        offendingToken: key,
      };
    },
  },
  {
    name: "array-section-wrong-type",
    build: (rng) => {
      const key = rng.pick(LIST_SECTIONS);
      return { doc: { [key]: rng.pick([{ not: "an array" }, "oops", 7]) }, offendingToken: key };
    },
  },
  {
    name: "record-section-wrong-type",
    build: (rng) => {
      const key = rng.pick(RECORD_SECTIONS);
      return { doc: { [key]: rng.pick(["oops", 7, [1], null] as const) }, offendingToken: key };
    },
  },
  {
    // Parse refuses an id no GitHub App has or GitHub rejects; otherwise the PATCH would report it late and on every run.
    // The pair GitHub collapses is what nothing reads back, since the section has no read endpoint.
    name: "check-suite-app-id-not-positive-integer",
    build: (rng) => ({
      doc: {
        check_suite_preferences: {
          auto_trigger_checks: [{ app_id: rng.pick([0, -15368, 15368.5] as const), setting: true }],
        },
      },
      offendingToken: "check_suite_preferences.auto_trigger_checks[0].app_id",
    }),
  },
  {
    name: "check-suite-duplicate-app-id",
    build: (rng) => {
      const app_id = rng.pick([15368, 29310] as const);
      return {
        doc: {
          check_suite_preferences: {
            auto_trigger_checks: [
              { app_id, setting: rng.bool() },
              { app_id: 62410, setting: true },
              { app_id, setting: rng.bool() },
            ],
          },
        },
        offendingToken: `check_suite_preferences.auto_trigger_checks[2].app_id: repeats app_id ${app_id} from auto_trigger_checks[0]`,
      };
    },
  },
  {
    name: "pages-wrong-type",
    build: (rng) => ({
      doc: { pages: rng.pick(["gh-pages", [1]] as const) },
      offendingToken: "pages",
    }),
  },
  {
    // null is NOT in the pick list: it is a valid declared value (clear).
    name: "interaction-limits-wrong-type",
    build: (rng) => ({
      doc: { interaction_limits: rng.pick(["oops", 7, [1]] as const) },
      offendingToken: "interaction_limits",
    }),
  },
  {
    name: "interaction-limits-refused-at-parse",
    build: (rng) => {
      // What the PUT would 422, or what GitHub reports but never accepts, fails at parse; the token is the key each issue names.
      const cases: ReadonlyArray<readonly [Json, string]> = [
        [{ expiry: "one_week" }, "interaction_limits.limit"],
        [{ limit: 7 }, "interaction_limits.limit"],
        [{ limit: "collaborators" }, "interaction_limits.limit"],
        [{ limit: "existing_users", expiry: "two_weeks" }, "interaction_limits.expiry"],
        [
          { limit: "existing_users", expires_at: "2027-01-01T00:00:00Z" },
          'Unrecognized key: "expires_at"',
        ],
        [{ limit: "existing_users", origin: "repository" }, 'Unrecognized key: "origin"'],
        [
          {
            pull_request_creation_cap: {
              enabled: true,
              max_open_pull_requests: rng.pick([0, -1, 2.5, 1001]),
            },
          },
          "interaction_limits.pull_request_creation_cap.max_open_pull_requests",
        ],
      ];
      const [doc, offendingToken] = rng.pick(cases);
      return { doc: { interaction_limits: doc }, offendingToken };
    },
  },
  {
    name: "scalar-item",
    build: (rng) => {
      const key = rng.pick(LIST_SECTIONS);
      const { value, entries, index, itemToken } = validItems(rng, key);
      (entries as unknown[])[index] = "oops";
      return { doc: { [key]: value }, offendingToken: itemToken };
    },
  },
  {
    name: "missing-natural-key",
    build: (rng) => {
      const key = rng.pick(LIST_SECTIONS);
      const { value, entries, index, itemToken } = validItems(rng, key);
      delete (entries[index] as Json)[NATURAL_KEYS[key]];
      return { doc: { [key]: value }, offendingToken: `${itemToken}.${NATURAL_KEYS[key]}` };
    },
  },
  {
    name: "non-string-natural-key",
    build: (rng) => {
      const key = rng.pick(LIST_SECTIONS);
      const { value, entries, index, itemToken } = validItems(rng, key);
      (entries[index] as Json)[NATURAL_KEYS[key]] = 42;
      return { doc: { [key]: value }, offendingToken: `${itemToken}.${NATURAL_KEYS[key]}` };
    },
  },
  {
    name: "secret-or-variable-name-refused",
    build: (rng) => {
      const key = rng.pick(GITHUB_NAMED_SECTIONS);
      const { value, entries, index, itemToken } = validItems(rng, key);
      (entries[index] as Json).name = rng.pick(REFUSED_GITHUB_NAMES);
      return { doc: { [key]: value }, offendingToken: `${itemToken}.name` };
    },
  },
  {
    name: "environment-nested-name-refused",
    build: (rng) => {
      const list = rng.pick(["variables", "secrets"] as const);
      const value = list === "secrets" ? "$E2E_SECRET_A" : "debug";
      const entry = { name: rng.pick(REFUSED_GITHUB_NAMES), value };
      return {
        doc: { environments: [{ name: "prod", [list]: [entry] }] },
        offendingToken: `environments[0].${list}[0].name`,
      };
    },
  },
  {
    name: "variable-value-over-cap",
    build: (rng) => {
      const key = rng.pick(["actions_variables", "agents_variables"] as const);
      const { value, entries, index, itemToken } = validItems(rng, key);
      (entries[index] as Json).value = "x".repeat(MAX_VARIABLE_VALUE_BYTES + 1);
      return { doc: { [key]: value }, offendingToken: `${itemToken}.value` };
    },
  },
  {
    name: "labels-new-name-not-a-string",
    build: (rng) => {
      const { value, entries, index, itemToken } = validItems(rng, "labels");
      (entries[index] as Json).new_name = 7;
      return { doc: { labels: value }, offendingToken: `${itemToken}.new_name` };
    },
  },
  {
    // "write" converges on an existing Write collaborator and 422s on a new one; "Push" and "" 422 on both.
    name: "collaborators-permission-not-grantable",
    build: (rng) => {
      const { value, entries, index, itemToken } = validItems(rng, "collaborators");
      (entries[index] as Json).permission = rng.pick([
        "read",
        "write",
        "Write",
        "Push",
        "ADMIN",
        "",
        "push\n",
      ]);
      return { doc: { collaborators: value }, offendingToken: `${itemToken}.permission` };
    },
  },
  {
    // A display name is the team_slug in the API path: the probe 404s and check reports "no access".
    name: "teams-name-not-a-slug",
    build: (rng) => {
      const { value, entries, index, itemToken } = validItems(rng, "teams");
      (entries[index] as Json).name = rng.pick(["Core Team", "core/team", "@core", " core", ""]);
      return { doc: { teams: value }, offendingToken: `${itemToken}.name` };
    },
  },
  {
    name: "branches-protection-missing",
    build: (rng) => {
      // protection is REQUIRED (nullable, not optional) on every branch entry.
      const { value, entries, index, itemToken } = validItems(rng, "branches");
      delete (entries[index] as Json).protection;
      return { doc: { branches: value }, offendingToken: `${itemToken}.protection` };
    },
  },
  {
    name: "branches-checks-unknown-key",
    build: (rng) => {
      // A check item is GitHub's closed {context, app_id} shape; the entry is made literal, since a
      // wildcard rule refuses `checks` itself ahead of the item.
      const { value, entries, index, itemToken } = validItems(rng, "branches");
      const entry = entries[index] as Json;
      entry.name = "main";
      entry.protection = {
        required_status_checks: {
          strict: true,
          checks: [{ context: "ci", [rng.pick(["app", "app_slug", "name"])]: "ci-bot" }],
        },
      };
      return {
        doc: { branches: value },
        offendingToken: `${itemToken}.protection.required_status_checks.checks[0]`,
      };
    },
  },
  {
    name: "workflows-state-enum",
    build: (rng) => {
      const { value, entries, index, itemToken } = validItems(rng, "workflows");
      (entries[index] as Json).state = rng.pick(["paused", "enabled", "on"]);
      return { doc: { workflows: value }, offendingToken: `${itemToken}.state` };
    },
  },
  {
    name: "rulesets-include-not-a-list",
    build: (rng) => {
      // The classic missing "-" typo the rulesets shape exists to catch.
      const { value, entries, index, itemToken } = validItems(rng, "rulesets");
      (entries[index] as Json).conditions = { ref_name: { include: "main" } };
      return {
        doc: { rulesets: value },
        offendingToken: `${itemToken}.conditions.ref_name.include`,
      };
    },
  },
  {
    name: "rulesets-enforcement-enum",
    build: (rng) => {
      const { value, entries, index, itemToken } = validItems(rng, "rulesets");
      (entries[index] as Json).enforcement = rng.pick(["enabled", "Active", "on"]);
      return { doc: { rulesets: value }, offendingToken: `${itemToken}.enforcement` };
    },
  },
  {
    name: "rulesets-ref-token-typo",
    build: (rng) => {
      // normalizeRefName passes every "~" value through, so a typo'd token would reach GitHub as written.
      const { value, entries, index, itemToken } = validItems(rng, "rulesets");
      (entries[index] as Json).conditions = {
        ref_name: { include: [rng.pick(["~all", "~MAIN", "~default_branch", "release~1"])] },
      };
      return {
        doc: { rulesets: value },
        offendingToken: `${itemToken}.conditions.ref_name.include[0]`,
      };
    },
  },
  {
    name: "rulesets-ref-pattern-illegal-character",
    build: (rng) => {
      // A character git refuses in a ref name; the pattern would reach GitHub prefixed and come back as a 422.
      const { value, entries, index, itemToken } = validItems(rng, "rulesets");
      (entries[index] as Json).conditions = {
        ref_name: {
          exclude: [
            rng.pick([
              "release^2",
              "a:b",
              "back\\slash",
              "hot fix",
              "a..b",
              "main@{1}",
              "tab\tbed",
            ]),
          ],
        },
      };
      return {
        doc: { rulesets: value },
        offendingToken: `${itemToken}.conditions.ref_name.exclude[0]`,
      };
    },
  },
  {
    name: "rulesets-bypass-actor-without-id",
    build: (rng) => {
      const { value, entries, index, itemToken } = validItems(rng, "rulesets");
      (entries[index] as Json).bypass_actors = [
        { actor_type: rng.pick(["Team", "User", "RepositoryRole", "Integration"]) },
      ];
      return { doc: { rulesets: value }, offendingToken: `${itemToken}.bypass_actors[0].actor_id` };
    },
  },
  {
    name: "rulesets-known-rule-parameter-case",
    build: (rng) => {
      // The casing GitHub sets on a KNOWN rule type is refused at parse; an unknown type still passes through to GitHub's own 422.
      const { value, entries, index, itemToken } = validItems(rng, "rulesets");
      (entries[index] as Json).rules = [
        rng.pick([
          { type: "branch_name_pattern", parameters: { operator: "startsWith", pattern: "feat/" } },
          {
            type: "pull_request",
            parameters: { ...PULL_REQUEST_PARAMETERS, allowed_merge_methods: ["SQUASH"] },
          },
          {
            type: "merge_queue",
            parameters: {
              check_response_timeout_minutes: 60,
              grouping_strategy: "ALLGREEN",
              max_entries_to_build: 5,
              max_entries_to_merge: 5,
              merge_method: "squash",
              min_entries_to_merge: 1,
              min_entries_to_merge_wait_minutes: 5,
            },
          },
        ]),
      ];
      return { doc: { rulesets: value }, offendingToken: `${itemToken}.rules[0]: parameters.` };
    },
  },
  {
    // The wrapper is this action's own strict vocabulary, so a typo'd wrapper key must fail upfront, named.
    name: "wrapper-unknown-key",
    build: (rng) => {
      const key = rng.pick(UNDECLARED_POLICY_SECTIONS);
      const typo = rng.pick(["entires", "entry", "items"]);
      return {
        doc: { [key]: { [typo]: entriesOf(genSettings(rng.fork("valid"), key)) } },
        offendingToken: typo,
      };
    },
  },
  {
    name: "wrapper-bad-policy",
    build: (rng) => {
      const key = rng.pick(UNDECLARED_POLICY_SECTIONS);
      const entries = entriesOf(genSettings(rng.fork("valid"), key));
      return {
        doc: { [key]: { [UNDECLARED_KEY]: rng.pick(["detele", "kep", true]), entries } },
        offendingToken: `${key}.${UNDECLARED_KEY}`,
      };
    },
  },
  {
    name: "secret-scanning-pattern-uncompilable",
    build: (rng) => {
      // Each field is a regex GitHub compiles as Hyperscan; the schema refuses what no dialect parses,
      // and the oracle here is the section's own check, so a pool value the check accepts fails the draw loudly.
      const { value, entries, index, itemToken } = validItems(
        rng,
        "secret_scanning_custom_patterns",
      );
      const field = rng.pick([
        "pattern",
        "start_delimiter",
        "end_delimiter",
        "must_match",
        "must_not_match",
      ]);
      // The last two are PCRE refusals a flagless RegExp alone would take: a quantified anchor, a group name declared twice.
      const broken = rng.pick([
        "([a-z",
        "*token",
        "key_[0-9]{6}\\",
        "(?P<t>key_[0-9",
        "\\A+",
        "(?<t>x)|(?<t>y)",
      ]);
      if (compileFailure(broken) === undefined) {
        throw new Error(
          `the refused draw ${JSON.stringify(broken)} passes the syntax check; pick another`,
        );
      }
      const entry = entries[index] as Json;
      const listField = field === "must_match" || field === "must_not_match";
      entry[field] = listField ? ["[0-9]", broken] : broken;
      return {
        doc: { secret_scanning_custom_patterns: value },
        offendingToken: `${itemToken}.${field}${listField ? "[1]" : ""}`,
      };
    },
  },
  {
    name: "pages-source-not-an-object",
    build: () => ({
      doc: { pages: { source: "main" } },
      offendingToken: "pages.source",
    }),
  },
  {
    name: "pages-source-branch-missing",
    build: () => ({
      doc: { pages: { source: { path: "/" } } },
      offendingToken: "pages.source.branch",
    }),
  },
  {
    // Each is a value GitHub 422s at apply time; the parser refuses it first, naming the field.
    name: "webhooks-value-github-refuses",
    build: (rng) => {
      const { value, entries, index, itemToken } = validItems(rng, "webhooks");
      const hook = entries[index] as Json;
      const config = hook.config as Json;
      const [field, mutate] = rng.pick<[string, () => void]>([
        ["events[0]", () => (hook.events = ["pushes"])],
        [
          "config.content_type",
          () => (config.content_type = rng.pick(["JSON", "application/json"])),
        ],
        ["config.insecure_ssl", () => (config.insecure_ssl = rng.pick([true, 2, "yes"]))],
        ["config.url", () => (config.url = rng.pick(["hooks.example.com/ci", "not a url"]))],
      ]);
      mutate();
      return { doc: { webhooks: value }, offendingToken: `${itemToken}.${field}` };
    },
  },
];

/** Tagged with the case name, so failures are labeled and coverage checks can prove every case is drawn. */
export function genInvalidSettings(rng: Rng): InvalidSettingsCase & { name: string } {
  const { name, build } = rng.pick(INVALID_SETTINGS_CASES);
  return { name, ...build(rng) };
}

/**
 * Bodies the yaml package GENUINELY throws on. Single-repo they hit the "cannot read settings ... valid YAML" path
 * (src/flows/single.ts), multi-repo the "cannot parse <slug>" target gate (src/flows/multi.ts); both fire before any section runs.
 */
export const UNPARSEABLE_YAML = [
  "labels: [oops, unclosed",
  "{",
  "a: b\n  c: d",
  'key: "unterminated',
  "a: [1, 2\nb: 3",
] as const;

/**
 * Bodies that parse but not to a mapping, so they fail validateSettingsDoc's top-level "must be a YAML mapping" check
 * instead of the parser; in multi mode the same wording fires with the slug as the source label.
 */
export const NON_MAPPING_YAML = ["- a\n- b", "just a string"] as const;

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

// --- Fault-target catalog (fault-mode fuzz) ---------------------------------

/**
 * The one read each section issues in BOTH modes under the batteries' document (SECTION_FAULT_FIXTURE for the key-gated
 * ones), so a fault aimed there fires for certain; UNFAULTABLE_SECTIONS have none.
 */
export const SECTION_PRIMARY_READ = {
  repository: "repository.get",
  labels: "labels.list",
  branches: "branches.getProtection",
  environments: "environments.probe",
  actions: "actions.getWorkflow",
  interaction_limits: "interaction_limits.get",
  rulesets: "rulesets.list",
  autolinks: "autolinks.list",
  workflows: "workflows.list",
  collaborators: "collaborators.list",
  teams: "teams.org",
  milestones: "milestones.list",
  pages: "pages.get",
  code_scanning_default_setup: "code_scanning_default_setup.get",
  code_quality_setup: "code_quality_setup.get",
  actions_variables: "actions_variables.list",
  actions_secrets: "actions_secrets.list",
  dependabot_secrets: "dependabot_secrets.list",
  codespaces_secrets: "codespaces_secrets.list",
  agents_secrets: "agents_secrets.list",
  agents_variables: "agents_variables.list",
  webhooks: "webhooks.list",
  // Runs right after the org probe in both modes; the fault batteries pin owner_kind: "org", so the probe never diverts it.
  custom_properties: "custom_properties.list",
  deploy_keys: "deploy_keys.list",
  secret_scanning_custom_patterns: "secret_scanning_custom_patterns.list",
} as const satisfies Partial<Record<SectionKey, string>>;

export type FaultableSection = keyof typeof SECTION_PRIMARY_READ;

/**
 * The batteries' document for a section whose reads are each gated on a declared key, so its primary read fires for
 * certain; a section absent here reads unconditionally, so its document stays random.
 */
export const SECTION_FAULT_FIXTURE: {
  readonly [K in FaultableSection]?: NonNullable<SettingsFile[K]>;
} = {
  actions: { default_workflow_permissions: "read" },
  // A literal entry: a wildcard-only document reconciles through GraphQL alone.
  branches: [{ name: "main", protection: { enforce_admins: true } }],
  interaction_limits: { limit: "collaborators_only", expiry: "one_week" },
};

/** Sections whose reads all stay COLD in a trigger-avoiding apply (check-only reads, or keys the battery omits); the negative battery proves it. */
export const UNFAULTABLE_SECTIONS = [
  "check_suite_preferences",
] as const satisfies readonly SectionKey[];
export type UnfaultableSection = (typeof UNFAULTABLE_SECTIONS)[number];

type FaultClassified = FaultableSection | UnfaultableSection;
type _UnclassifiedFaultSection = MustBeNever<Exclude<SectionKey, FaultClassified>>;
type _DoublyClassifiedFaultSection = MustBeNever<Extract<FaultableSection, UnfaultableSection>>;

/**
 * MAXIMAL on purpose: each entry declares every key it can without reaching a read, so the battery's claim is "a
 * full-width apply issues no read", not "a tiny apply stays quiet". The battery arms one-shot faults on every GET the
 * section declares (unfaultableReadKeys) and requires none to fire.
 */
export const UNFAULTABLE_APPLY_SETTINGS: {
  [K in UnfaultableSection]: NonNullable<SettingsFile[K]>;
} = {
  // The strongest member: the section declares NO read endpoint, so the battery has nothing to arm and the exemption holds by construction.
  check_suite_preferences: {
    auto_trigger_checks: [{ app_id: 15368, setting: false }],
  },
};

/**
 * Derived from the registry declarations, the same source the mock routes and USED_PATHS derive from, so the battery
 * cannot arm a stale hand-copied key while the section reads somewhere else.
 */
export function unfaultableReadKeys(section: UnfaultableSection): string[] {
  return [
    ...Object.entries(allEndpoints())
      .filter(([key, ep]) => key.startsWith(`${section}.`) && endpointMethod(ep.route) === "GET")
      .map(([key]) => key),
    ...Object.entries(allGraphqlOps())
      .filter(([key, op]) => key.startsWith(`${section}.`) && op.kind === "read")
      .map(([key]) => key),
  ].sort();
}

let validator: ValidateFunction | undefined;

function settingsValidator(): ValidateFunction {
  if (!validator) {
    const ajv = new Ajv({ strict: false, allErrors: true });
    const add = (addFormats as unknown as { default?: typeof addFormats }).default ?? addFormats;
    (add as typeof addFormats)(ajv);
    validator = ajv.compile(settingsSchema);
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

export interface GenScenarioOptions {
  /** Restrict generation to these sections (a smoke or PR-diff subset). */
  sections?: SectionKey[];
}

/**
 * Derived from the registry's `permission` declarations, the source the oracle's sectionGrade and the mock's gate read
 * too, so a future org-gated section inherits the forced-private strip without a hand edit.
 */
export const ORG_GATED_SECTIONS: ReadonlySet<SectionKey> = new Set(
  SECTIONS.filter((section) => section.permission.org === "members").map((section) => section.key),
);

const MASK_KEYS: readonly MaskKey[] = SCHEMA_MASK_KEYS;

/** The generation facts the oracle predicts from, so it never re-parses the scenario. */
export interface ScenarioMeta {
  sections: SectionKey[];
  mask: Partial<Record<MaskKey, MaskGrade>>;
  mode: "apply" | "check";
  policy: "fail" | "warn";
  ownerKind: OwnerKind;
  denialStyle: DenialStyle;
  requiredSections: SectionKey[];
  /**
   * The `sections` allowlist the run was generated under; undefined means every declared section runs. orchestrate.ts
   * reports a declared-but-not-allowlisted section as "excluded" BEFORE its handler runs, so the oracle folds exclusion
   * ahead of grades and witnesses.
   */
  onlySections?: SectionKey[];
  /** The witness seeded per WITNESS_SECTIONS member; a section without an entry has no witness and keeps the loose prediction. */
  liveKinds?: Partial<Record<SectionKey, LiveWitnessKind>>;
  /**
   * The GLOBAL token mask, which differs from `mask` (the effective per-slug mask) only in multi-repo mode: the mock
   * grades teams' org gate against its org_members (mock/routes.ts), so the oracle does too. Undefined single-repo,
   * where the effective mask IS the global one.
   */
  orgMask?: Partial<Record<MaskKey, MaskGrade>>;
}

export function genScenario(
  rng: Rng,
  options: GenScenarioOptions = {},
): { scenario: Scenario; meta: ScenarioMeta } {
  const pool =
    options.sections !== undefined && options.sections.length > 0 ? options.sections : SECTION_KEYS;
  const chosen = pool.filter(() => rng.bool(0.5));
  if (chosen.length === 0) {
    chosen.push(rng.pick(pool));
  }

  const settings: Json = {};
  for (const key of chosen) {
    settings[key] = genSettings(rng.fork(`settings:${key}`), key);
  }
  validateAgainstPublishedSchema(settings);

  const presence = presenceLiveState(settings) ?? {};

  // Witnesses pin the exact outcome; without them a false-negative drift detector would pass every iteration.
  // A quarter of the time the section keeps absent live state, so the create path stays covered.
  const liveKinds: Partial<Record<SectionKey, LiveWitnessKind>> = {};
  const witnessState: LiveState = {};
  for (const key of WITNESS_SECTIONS) {
    if (!chosen.includes(key)) {
      continue;
    }
    const witnessRng = rng.fork(`witness:${key}`);
    if (witnessRng.bool(0.25)) {
      continue;
    }
    const kind = witnessRng.pick(WITNESS_KINDS[key]);
    const witness = genLiveWitness(witnessRng, key, settings[key], kind);
    liveKinds[key] = witness.kind;
    Object.assign(witnessState, witness.state);
  }

  // A forked stream, so recorded seeds keep reproducing. No liveKinds entry: the oracle keeps the loose collaborators
  // prediction; the value is the convergence and idempotence gates walking the PATCH, cancel, and expired-re-invite paths.
  const invitationsRng = rng.fork("invitations");
  if (chosen.includes("collaborators") && invitationsRng.bool(0.5)) {
    const invitations = genInvitationsState(invitationsRng, entriesOf(settings.collaborators));
    if (invitations.length > 0) {
      witnessState.invitations = invitations;
    }
  }

  const combinedLive: LiveState = { ...presence, ...witnessState };
  const liveState = Object.keys(combinedLive).length > 0 ? combinedLive : undefined;

  const mask: Partial<Record<MaskKey, MaskGrade>> = {};
  for (const resource of MASK_KEYS) {
    if (rng.bool(0.4)) {
      mask[resource] = rng.pick(["none", "read", "write"] as const);
    }
  }
  suppressMaskedEnvironmentOverrides(settings, mask);
  suppressMaskedCustomProperties(settings, mask, chosen);

  const mode = rng.pick(["apply", "check"] as const);
  const policy = rng.pick(["fail", "warn"] as const);
  const ownerKind: OwnerKind = rng.pick(["org", "user"] as const);
  personalizeCollaborators(settings, ownerKind);
  // 404 answers every denial with Not Found, but the client still classifies a 404 on a write as a permission denial
  // (src/github/api.ts), so its outcome classes equal fine_grained's for every operation generated today; 403 discriminates.
  const denialStyle: DenialStyle = rng.pick(["fine_grained", 403, 404] as const);
  const requiredDraw = chosen.filter(() => rng.bool(0.25));
  // A strict nonempty subset of the declared sections, so the EXCLUDED outcome is always reachable.
  // A forked stream, so the main-stream sequence and every recorded seed stay stable.
  const allowRng = rng.fork("input-sections");
  let onlySections: SectionKey[] | undefined;
  if (chosen.length >= 2 && allowRng.bool(0.2)) {
    const subset = chosen.filter(() => allowRng.bool(0.6));
    onlySections =
      subset.length === 0
        ? [allowRng.pick(chosen)]
        : subset.length === chosen.length
          ? subset.slice(1)
          : subset;
  }
  // Input validation rejects a required section the allowlist excludes, so required sections are filtered to the
  // allowed set. A post-draw filter, not a different draw, so the main stream stays stable.
  const requiredSections =
    onlySections === undefined
      ? requiredDraw
      : requiredDraw.filter((key) => onlySections.includes(key));

  const secretEnv = scenarioSecretEnv(settings);

  const scenario: Scenario = {
    name: `fuzz-${rng.seed}`,
    tiers: ["mock"],
    settings,
    inputs: {
      mode,
      on_missing_permission: policy,
      ...(requiredSections.length > 0 ? { required_sections: requiredSections.join(",") } : {}),
      ...(onlySections !== undefined ? { sections: onlySections.join(",") } : {}),
    },
    ...(secretEnv === undefined ? {} : { env: secretEnv }),
    token_permissions: Object.keys(mask).length > 0 ? mask : undefined,
    denial_style: denialStyle,
    owner_kind: ownerKind,
    // A GHES-style prefix the mock requires on every request, proving the client joins base URLs without dropping or
    // doubling the path (the curated ghes-prefix scenario pins it). A forked draw.
    ...(rng.fork("base-prefix").bool(0.15) ? { base_prefix: "/api/v3" } : {}),
    ...(liveState ? { live_state: liveState } : {}),
    // A placeholder; the oracle fills expect after generation.
    expect: { exit_code: 0 },
  };
  const meta: ScenarioMeta = {
    sections: chosen,
    mask,
    mode,
    policy,
    ownerKind,
    denialStyle,
    requiredSections,
    onlySections,
    liveKinds,
  };
  return { scenario, meta };
}

/** Both raw kinds fail the target before any section runs. */
export type MultiRepoTarget =
  | { kind: "normal"; meta: ScenarioMeta }
  | { kind: "missing" }
  | { kind: "raw-invalid"; raw: "unparseable" | "non-mapping" };

export interface MultiRepoMeta {
  slug: string;
  /** "missing" has no settings file: the action applies the defaults document to it, or skips it when the scenario has none. */
  target: MultiRepoTarget;
  visibility: "public" | "private" | "internal";
  /**
   * True when mask.administration is "none": the visibility probe is denied, the resolver reads "unknown", and
   * redaction fails closed whatever the planted visibility (src/flows/multi.ts).
   */
  probeDenied: boolean;
  /**
   * Redacted iff the policy is redact, the slug is not the self slug, and the target is private/internal or probe-denied.
   *   placeholder  -> the repos-result key planRedaction assigns, numbered per redacted target in target order
   *   canaries     -> unique strings planted in the target's private surfaces; none may appear in a public surface
   */
  redaction: { kind: "shown" } | { kind: "redacted"; placeholder: string; canaries: string[] };
}

export function displayKeyOf(meta: MultiRepoMeta): string {
  return meta.redaction.kind === "redacted" ? meta.redaction.placeholder : meta.slug;
}

export function canariesOf(meta: MultiRepoMeta): string[] {
  return meta.redaction.kind === "redacted" ? meta.redaction.canaries : [];
}

/** Mirrors planRedaction's format (src/flows/redact.ts); a change there must land here. */
export function redactionPlaceholder(ordinal: number): string {
  return `private repository #${ordinal}`;
}

export interface MultiScenarioMeta {
  repos: MultiRepoMeta[];
  mode: "apply" | "check";
  policy: "fail" | "warn";
  privateRepos: "redact" | "show";
  /**
   * The `private-report` channel; only `issue` or `artifact` under redact (the config rejects a
   * delivering channel + show). `issue-on-failure` is absent: the oracle does not predict its
   * per-target needsAttention writes, so the curated multi-report-issue-on-failure-* scenarios pin it.
   */
  privateReport: "none" | "issue" | "artifact";
  /** GITHUB_REPOSITORY: a target whose slug equals it is never redacted. */
  selfSlug: string;
  /**
   * The GLOBAL token mask (scenario token_permissions), varied only on org_members. The idempotence eligibility
   * predicate reads it: a globally denied org gate answers a declared teams section no access and denies its grants even when
   * every per-target mask is empty.
   */
  globalMask: Partial<Record<MaskKey, MaskGrade>>;
  /**
   * The forced-private canary target under redact; undefined under show. Tests address THAT target, since an unforced
   * roll can also produce a redacted target.
   */
  forcedPrivateSlug?: string;
  /**
   * A core-route fault the fuzz iteration injected; generation never sets this. `fatal` means the FIRST target's
   * settings fetch dies, whatever its kind would otherwise report; a non-fatal fault is retried away and changes no prediction.
   *   targets run in generation order -> the probes hit the repository route, consuming none of the fault
   *   -> the hook fires before the missing-file 404 and the permission gate
   */
  coreFault?: { key: "core.contentsGet"; fatal: boolean };
  /**
   * The ScenarioMeta a fileless target runs under: the defaults document's sections with an empty per-slug mask.
   * Present exactly when the scenario has a defaults_file; absent, a fileless target is skipped.
   */
  defaults?: ScenarioMeta;
}

/**
 * Forces pin the rolls a directed battery needs, so its entry EXISTS for every master seed: rejection sampling with any
 * fixed fork budget has miss seeds, each a spurious CI failure. A forced path may consume a different draw sequence
 * than the unforced one; that is safe because forced generation is deterministic per (seed, force) and every battery replay reapplies its force.
 *
 * "issue-report"          -> redact + the issue channel, the report-fault battery's precondition
 * "idempotence-eligible"  -> apply, non-delivering channel, no raw target, every normal mask empty (multiIdempotenceEligible)
 * "plain-first-target"    -> show (no canaries) and the raw target kept off index 0, the contents-fault victim guard
 */
export type MultiBatteryForce = "issue-report" | "idempotence-eligible" | "plain-first-target";

export function genMultiScenario(
  rng: Rng,
  force?: MultiBatteryForce,
): { scenario: Scenario; meta: MultiScenarioMeta } {
  const count = rng.int(4) + 2;
  const rolledMode = rng.pick(["apply", "check"] as const);
  const mode = force === "idempotence-eligible" ? "apply" : rolledMode;
  const policy = rng.pick(["fail", "warn"] as const);
  const denialStyle: DenialStyle = rng.pick(["fine_grained", 403] as const);
  const rolledPrivateRepos = rng.pick(["redact", "show"] as const);
  const privateRepos =
    force === "issue-report"
      ? "redact"
      : force === "plain-first-target"
        ? "show"
        : rolledPrivateRepos;
  const rolledReport =
    privateRepos === "redact" ? rng.pick(["none", "issue", "artifact"] as const) : "none";
  const privateReport =
    force === "issue-report" ? "issue" : force === "idempotence-eligible" ? "none" : rolledReport;
  const selfSlug = ADMIN_SLUG;
  // Varied ONLY on org_members: the mock grades org routes against the global mask and repo routes against the per-slug
  // overlay (mock/routes.ts), so any other global entry would have mock and oracle grading different masks. The
  // idempotence force clears it: a globally denied org gate leaves a declared teams section granting on every apply, which is no fixpoint.
  const globalMaskRng = rng.fork("global-mask");
  const globalMask: Partial<Record<MaskKey, MaskGrade>> = {};
  if (globalMaskRng.bool(0.3) && force !== "idempotence-eligible") {
    globalMask.org_members = globalMaskRng.pick(["none", "read", "write"] as const);
  }
  const missingIndex = rng.int(count);

  const repos: Record<string, MultiRepo> = {};
  const repoMetas: MultiRepoMeta[] = [];
  // Under redact ONE non-missing target is forced private, or a run where every target rolled public would give an
  // empty forbidden set and a vacuous leak check. count >= 2 guarantees a non-missing index exists.
  const forcedPrivateIndex =
    privateRepos === "redact"
      ? (missingIndex + 1 + rng.int(count - 1)) % count // any non-missing index
      : -1;
  // Incremented per redacted target in target order: the exact numbering planRedaction assigns (self and public skipped).
  let redactedOrdinal = 0;
  const redactionFor = (redacted: boolean, canaries: string[] = []): MultiRepoMeta["redaction"] => {
    if (!redacted) {
      return { kind: "shown" };
    }
    redactedOrdinal += 1;
    return { kind: "redacted", placeholder: redactionPlaceholder(redactedOrdinal), canaries };
  };
  // Never the missing target (its gate is the contents 404) and never the forced-private one (its canary flow must
  // stay guaranteed for the leak counterfactual).
  const rawCandidates = Array.from({ length: count }, (_, i) => i).filter(
    (i) =>
      i !== missingIndex &&
      i !== forcedPrivateIndex &&
      // The contents-fault battery's victim is always index 0; keep the raw target off it by construction.
      (force !== "plain-first-target" || i !== 0),
  );
  const rolledRawIndex = rawCandidates.length > 0 && rng.bool(0.2) ? rng.pick(rawCandidates) : -1;
  const rawIndex = force === "idempotence-eligible" ? -1 : rolledRawIndex;
  const rawKind = rawIndex >= 0 ? rng.pick(["unparseable", "non-mapping"] as const) : undefined;
  for (let i = 0; i < count; i++) {
    const slug = `e2e-owner/repo-${i}`;
    // Roughly half non-public, so the redaction path is exercised.
    const visibility =
      i === forcedPrivateIndex
        ? rng.pick(["private", "internal"] as const)
        : rng.pick(["public", "public", "private", "internal"] as const);
    if (i === missingIndex) {
      // A fileless target is still probed, so it can still be redacted.
      const probeDenied = false;
      const redacted =
        privateRepos === "redact" && slug !== selfSlug && (visibility !== "public" || probeDenied);
      const repoSpec: MultiRepo = { settings: null };
      if (visibility !== "public") {
        repoSpec.live_state = { repo: { private: true, visibility } };
      }
      repos[slug] = repoSpec;
      repoMetas.push({
        slug,
        target: { kind: "missing" },
        visibility,
        probeDenied,
        redaction: redactionFor(redacted),
      });
      continue;
    }
    if (i === rawIndex && rawKind !== undefined) {
      // Fully granted (no mask), so the contents read succeeds and the parse or top-level-mapping gate, not a permission gate, is what fires.
      const raw =
        rawKind === "unparseable" ? rng.pick(UNPARSEABLE_YAML) : rng.pick(NON_MAPPING_YAML);
      const probeDenied = false;
      const redacted =
        privateRepos === "redact" && slug !== selfSlug && (visibility !== "public" || probeDenied);
      const repoSpec: MultiRepo = { settings_raw: raw };
      if (visibility !== "public") {
        repoSpec.live_state = { repo: { private: true, visibility } };
      }
      repos[slug] = repoSpec;
      repoMetas.push({
        slug,
        target: { kind: "raw-invalid", raw: rawKind },
        visibility,
        probeDenied,
        redaction: redactionFor(redacted),
      });
      continue;
    }
    const child = rng.fork(`repo:${i}`);
    // The secret sections are excluded at the draw: their values are ALWAYS $NAME references, which a target-fetched
    // settings.yml refuses (stripSecretReferences below backstops the webhook secret field and the nested environments secrets).
    const pool = SECTION_KEYS.filter(
      (key) => !(SECRET_LIST_SECTIONS as readonly SectionKey[]).includes(key),
    );
    let sections = pool.filter(() => child.bool(0.5));
    if (sections.length === 0) {
      sections.push(child.pick(pool));
    }
    // The forced-private target's guarantees (never preflight-aborts, always delivers) assume every declared section
    // is fully granted; a globally denied org gate denies org-gated reads whatever the per-slug mask says, so it drops
    // them. The OTHER targets keep them covered.
    if (i === forcedPrivateIndex && globalMask.org_members === "none") {
      sections = sections.filter((key) => !ORG_GATED_SECTIONS.has(key));
      if (sections.length === 0) {
        // A new draw, so it forks off the child stream: the child's downstream draws stay unshifted.
        sections.push(
          child.fork("canary-refill").pick(pool.filter((key) => !ORG_GATED_SECTIONS.has(key))),
        );
      }
    }
    const settings: Json = {};
    for (const key of sections) {
      settings[key] = genSettings(child.fork(`settings:${key}`), key);
    }
    stripSecretReferences(settings);
    const mask: Partial<Record<MaskKey, MaskGrade>> = {};
    for (const resource of MASK_KEYS) {
      if (child.bool(0.3)) {
        mask[resource] = child.pick(["none", "read", "write"] as const);
      }
    }
    // The forced-private target must be a REAL leak test: under apply + fail one denied read preflight-aborts the target
    // and nothing, canary included, is rendered, so its mask is cleared. The idempotence force clears every normal
    // target's mask, since the apply-idempotence gate requires fully-granted targets.
    if (i === forcedPrivateIndex || force === "idempotence-eligible") {
      for (const resource of MASK_KEYS) {
        delete mask[resource];
      }
    }
    suppressMaskedEnvironmentOverrides(settings, mask);
    suppressMaskedCustomProperties(settings, mask, sections);
    const probeDenied = mask.administration === "none";
    const redacted =
      privateRepos === "redact" && slug !== selfSlug && (visibility !== "public" || probeDenied);

    const live: LiveState = presenceLiveState(settings) ?? {};
    if (visibility !== "public") {
      live.repo = { ...(live.repo ?? {}), private: true, visibility };
    }

    // Canaries catch a detail-SUPPRESSION regression, not just a slug leak; a name-matched label keeps the outcome
    // class the labels grade already predicts. Redaction must hide every surface below.
    //   label name (declared = live)      -> the apply change detail
    //   descriptions (declared != live)   -> the check drift detail
    //   repo canary                       -> the live repo description
    const canaries: string[] = [];
    if (redacted) {
      const nameCanary = `CANARY-${rng.seed}-${i}-name`;
      const declaredDescCanary = `CANARY-${rng.seed}-${i}-declared`;
      const liveDescCanary = `CANARY-${rng.seed}-${i}-live`;
      const repoCanary = `CANARY-${rng.seed}-${i}-repo`;
      canaries.push(nameCanary, declaredDescCanary, liveDescCanary, repoCanary);
      const declaredLabels = settings.labels === undefined ? [] : entriesOf(settings.labels);
      declaredLabels.push({ name: nameCanary, color: "abcdef", description: declaredDescCanary });
      if (settings.labels === undefined) {
        settings.labels = declaredLabels;
      }
      const liveLabels = Array.isArray(live.labels) ? (live.labels as Json[]) : [];
      liveLabels.push({ name: nameCanary, color: "abcdef", description: liveDescCanary });
      live.labels = liveLabels;
      live.repo = { ...(live.repo ?? {}), description: repoCanary };
      // The canary rides in on the labels section, so the oracle must predict it.
      if (!sections.includes("labels")) {
        sections.push("labels");
      }
    }
    validateAgainstPublishedSchema(settings);

    const hasLive = Object.keys(live).length > 0;
    repos[slug] = {
      settings,
      ...(hasLive ? { live_state: live } : {}),
      ...(Object.keys(mask).length > 0 ? { permissions: mask } : {}),
    };
    repoMetas.push({
      slug,
      visibility,
      probeDenied,
      redaction: redactionFor(redacted, canaries),
      target: {
        kind: "normal",
        meta: {
          sections,
          mask,
          mode,
          policy,
          ownerKind: "org",
          denialStyle,
          requiredSections: [],
          orgMask: globalMask,
        },
      },
    });
  }

  // Applied WHOLE to the fileless target and never merged into a target with its own file, so the fileless target's
  // meta is exactly the defaults' sections under the default write mask and every other target's meta stays its own.
  const defaultsFile: Json = {
    labels: [{ name: "shared-default", color: "cccccc" }],
    milestones: [{ title: "shared-milestone", state: "open" }],
  };
  const defaults: ScenarioMeta = {
    sections: Object.keys(defaultsFile) as SectionKey[],
    mask: {},
    mode,
    policy,
    ownerKind: "org",
    denialStyle,
    requiredSections: [],
    orgMask: globalMask,
  };

  const scenario: Scenario = {
    name: `fuzz-multi-${rng.seed}`,
    tiers: ["mock"],
    settings: {},
    inputs: {
      mode,
      on_missing_permission: policy,
      private_repos: privateRepos,
      ...(privateReport !== "none" ? { private_report: privateReport } : {}),
      // The config rejects the artifact channel without a recipient, and a recipient with any other channel.
      ...(privateReport === "artifact" ? { report_public_key: ARTIFACT_TEST_RECIPIENT } : {}),
    },
    denial_style: denialStyle,
    owner_kind: "org",
    ...(Object.keys(globalMask).length > 0 ? { token_permissions: globalMask } : {}),
    // A GHES-style prefix, as in genScenario.
    ...(rng.fork("base-prefix").bool(0.15) ? { base_prefix: "/api/v3" } : {}),
    repos,
    defaults_file: defaultsFile,
    expect: { exit_code: 0 },
  };
  return {
    scenario,
    meta: {
      repos: repoMetas,
      mode,
      policy,
      privateRepos,
      privateReport,
      selfSlug,
      globalMask,
      ...(forcedPrivateIndex >= 0
        ? { forcedPrivateSlug: `e2e-owner/repo-${forcedPrivateIndex}` }
        : {}),
      defaults,
    },
  };
}

export interface DiscoveryScenarioMeta {
  pool: Array<{
    slug: string;
    archived?: boolean;
    fork?: boolean;
    visibility?: string;
    topics?: string[];
  }>;
  filters: {
    visibility?: string;
    archived?: string;
    forks?: string;
    topics?: string;
    exclude?: string;
  };
  /**
   * Always redact: discovery targets are the one surface with TRUE non-disclosure (their names come only from the
   * private /user/repos listing, never the operator's config), so the fuzzer checks a kept private/internal repo is
   * keyed by a placeholder and its slug leaks nowhere.
   */
  privateRepos: "redact" | "show";
}

/**
 * Each pool repo carries one label, so a kept repo applies. The meta echoes the pool and filters, so predictDiscovery
 * computes the kept set INDEPENDENTLY and the fuzz asserts the action discovered exactly those.
 */
export function genDiscoveryScenario(
  rng: Rng,
  /**
   * Battery construction: "converges" pins pool repo 0 non-archived with no filters, so the convergence battery entry
   * exists for every master seed instead of being rejection-sampled. Deterministic per (seed, force); replays reapply it.
   */
  force?: "converges",
): {
  scenario: Scenario;
  meta: DiscoveryScenarioMeta;
} {
  const count = rng.int(5) + 4;
  const TOPIC_POOL = ["platform", "infra", "legacy", "misc"];
  // One pool repo forced non-public, or an all-public pool would hand the leak invariant an empty forbidden set.
  const forcedPrivateIndex = rng.int(count);
  const pool: DiscoveryScenarioMeta["pool"] = [];
  for (let i = 0; i < count; i++) {
    const repo: DiscoveryScenarioMeta["pool"][number] = { slug: `e2e-owner/disc-${i}` };
    if (rng.bool(0.3) && !(force === "converges" && i === 0)) {
      repo.archived = true;
    }
    if (rng.bool(0.3)) {
      repo.fork = true;
    }
    repo.visibility =
      i === forcedPrivateIndex
        ? rng.pick(["private", "internal"] as const)
        : rng.pick(["public", "private", "internal"]);
    if (rng.bool(0.6)) {
      repo.topics = [rng.pick(TOPIC_POOL)];
    }
    pool.push(repo);
  }

  const rolledFilters: DiscoveryScenarioMeta["filters"] = {};
  if (rng.bool(0.4)) {
    rolledFilters.visibility = rng.pick(["all", "public", "private", "internal"]);
  }
  if (rng.bool(0.4)) {
    rolledFilters.archived = rng.pick(["skip", "include", "only"]);
  }
  if (rng.bool(0.4)) {
    rolledFilters.forks = rng.pick(["include", "exclude", "only"]);
  }
  if (rng.bool(0.4)) {
    rolledFilters.topics = rng.pick(TOPIC_POOL);
  }
  if (rng.bool(0.3)) {
    rolledFilters.exclude = `disc-${rng.int(count)}`;
  }
  const filters: DiscoveryScenarioMeta["filters"] = force === "converges" ? {} : rolledFilters;

  const repos: Record<string, MultiRepo> = {};
  for (const repo of pool) {
    repos[repo.slug] = {
      settings: { labels: [{ name: "managed", color: "00ff00" }] },
    };
  }

  const inputs: Record<string, string> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) {
      inputs[key] = value;
    }
  }

  const privateRepos = "redact" as const;
  const scenario: Scenario = {
    name: `fuzz-discovery-${rng.seed}`,
    tiers: ["mock"],
    settings: {},
    inputs: { mode: "apply", on_missing_permission: "warn", private_repos: privateRepos },
    denial_style: "fine_grained",
    owner_kind: "org",
    discovery: { pool, inputs },
    repos,
    token_permissions: { issues: "write", contents: "read" },
    expect: { exit_code: 0 },
  };
  return { scenario, meta: { pool, filters, privateRepos } };
}

// --- Layered merge scenarios (mode: render fuzz) -----------------------------

/** `name` is the file name the runner writes and the action's refusals and notices report. */
export interface MergeLayer {
  name: string;
  doc: Json;
}

/**
 * Each is refused with a message naming the layer: at the layer boundary, by the layer's own validation (null-section),
 * or by the fold (remove-unmatched). A reference cycle cannot be spelled in scenario JSON, so it is not generated.
 *
 * duplicate-rule-type / duplicate-label      -> two entries of one keyed list sharing a key (rules by type, labels by case-folded name)
 * bad-wrapper-layering / bad-file-layering   -> a directive value outside replace|shallow|deep (the retired `merge` among them)
 * bad-file-undeclared                        -> a top-level `_undeclared` outside keep|delete (null among them: the knob has no empty state)
 * remove-under-replace                       -> a `_remove: true` entry in a list whose effective directive is replace
 * remove-unmatched                           -> a `_remove: true` entry no lower layer declares a key for
 * remove-with-fields                         -> a `_remove: true` entry carrying a field beside its key
 * null-section                               -> a whole-section null on a section whose value null is not
 */
export const MERGE_REFUSAL_KINDS = [
  "duplicate-rule-type",
  "duplicate-label",
  "bad-wrapper-layering",
  "bad-file-layering",
  "bad-file-undeclared",
  "remove-under-replace",
  "remove-unmatched",
  "remove-with-fields",
  "null-section",
] as const;
type MergeRefusalKind = (typeof MERGE_REFUSAL_KINDS)[number];

/**
 * Read off the FINAL layer documents by mergeFeaturesOf, never off the draws (a later mutation can undo one), so the
 * fuzz histogram and the generator tests count shapes the run actually saw. A refused stack asserts no document, so it
 * counts for "refused" alone.
 */
export const MERGE_FEATURES = [
  /** A section declared non-null by a layer while the fold already holds it. */
  "override",
  /** Labels declared under an effective shallow or deep layering while the fold holds labels. */
  "union-labels",
  /** Rulesets declared under an effective shallow or deep layering while the fold holds rulesets. */
  "union-rulesets",
  /** Environments declared under an effective shallow or deep layering while the fold holds environments: a plain-list union, its nested lists with it under deep. */
  "union-environments",
  /** A plain-list section (environments, branches, workflows) drawn in its `{_layering, entries}` wrapper form. */
  "wrapper-layered",
  /** A unioned label whose name differs only by case from the spelling the fold holds. */
  "label-case-fold",
  /** A unioned label pairing with a held label through a rename: one of the two claims the other's name as its rename target or current name. */
  "label-rename-union",
  /** A unioned ruleset re-declaring a held rule type with different parameters, so the swap (shallow) or the field merge (deep) is observable. */
  "rule-parameters",
  /** A top-level null on a section whose value null is (NULLABLE_SECTIONS), held below or not: the fold writes it. */
  "null-section",
  /** A null inside a mapping section, at a key the schema admits null for (a passthrough key, a nullable field). */
  "null-nested",
  /** A null field inside a keyed entry (a branch's `protection: null`). */
  "null-entry-field",
  /** A `_remove: true` label dropping a held label. */
  "remove-entry",
  /** A `_remove: true` rule dropping a held rule type inside a deep-merged ruleset. */
  "remove-nested",
  "wrapper-undeclared",
  /** A layer's top-level `_undeclared`: the fold's fallback policy for every list without its own. */
  "file-undeclared",
  "run-undeclared-keep",
  "run-undeclared-delete",
  "run-undeclared-default",
  "wrapper-layering-replace",
  "wrapper-layering-shallow",
  "wrapper-layering-deep",
  "file-layering",
  "run-layering-replace",
  "run-layering-shallow",
  "run-layering-deep",
  "run-layering-default",
  "empty-layer",
  "refused",
] as const;
type MergeFeature = (typeof MERGE_FEATURES)[number];

/**
 * The layers exactly as the runner files them (lowest first, settings.yml last). `refusal` names the one layer built
 * to be refused, so tests check the oracle's own boundary read against the generator's intent.
 */
export interface MergeScenarioMeta {
  layers: MergeLayer[];
  layering: LayeringDirective;
  /** The run's `undeclared` input, unset unless the scenario set it. */
  undeclared?: UndeclaredPolicyWord | undefined;
  refusal?: { layer: string; kind: MergeRefusalKind };
  features: MergeFeature[];
}

/**
 * Constructed, never rejection-sampled, so every battery entry exists for every master seed. The valid force gives
 * every mapping section ONE contribution, so no cross-field rule can trip on a merge of two.
 */
export type MergeForce =
  | { kind: "valid"; layering: LayeringDirective }
  | { kind: "refused"; refusal: MergeRefusalKind };

/** The sections whose top-level null is the section's value; on every other section a whole-section null fails validation. */
const NULLABLE_SECTIONS = ["pages", "interaction_limits"] as const satisfies readonly SectionKey[];

function isNullValued(key: string): boolean {
  return (NULLABLE_SECTIONS as readonly string[]).includes(key);
}

function isKnobbedSection(key: string): key is (typeof UNDECLARED_POLICY_SECTIONS)[number] {
  return (UNDECLARED_POLICY_SECTIONS as readonly string[]).includes(key);
}

function isListSectionKey(key: string): key is ListSection {
  return (LIST_SECTIONS as readonly string[]).includes(key);
}

/** The nested keyed lists of a list section's entry, in the harness's own words (the oracle spells the keys). */
const NESTED_LIST_FIELDS: Readonly<Partial<Record<ListSection, readonly string[]>>> = {
  rulesets: ["rules"],
  environments: [
    "variables",
    "secrets",
    "deployment_branch_policies",
    "deployment_protection_rules",
    "reviewers",
  ],
};

function isLayeringDirective(value: unknown): value is LayeringDirective {
  return (LAYERING_DIRECTIVES as readonly unknown[]).includes(value);
}

function isPlainMapping(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A layer as its standalone validation sees it, in the harness's own words: the document minus the directives the
 * fold consumes, `_layering` (top and wrapper), the top-level `_undeclared`, and every entry carrying `_remove` (top
 * and nested, in either form, any value: the fold judges the marker). Every value stays, null included: a null a key
 * does not admit is the layer's own validation error.
 */
export function standaloneViewOf(doc: Json): Json {
  const withoutRemovals = (entries: readonly unknown[], nested: readonly string[]): unknown[] =>
    entries
      .filter((entry) => !(isPlainMapping(entry) && entry[REMOVE_KEY] !== undefined))
      .map((entry) => (isPlainMapping(entry) ? withoutNested(entry, nested) : entry));
  const withoutNested = (entry: Json, nested: readonly string[]): Json => {
    const out: Json = { ...entry };
    for (const field of nested) {
      const value = entry[field];
      if (Array.isArray(value)) {
        out[field] = withoutRemovals(value, NESTED_OF_NESTED[field] ?? []);
      } else if (isPlainMapping(value) && Array.isArray(value.entries)) {
        const { entries, ...knobs } = value;
        out[field] = { ...knobs, entries: withoutRemovals(entries, NESTED_OF_NESTED[field] ?? []) };
      }
    }
    return out;
  };
  const { [LAYERING_KEY]: _file, [UNDECLARED_KEY]: _policy, ...out } = doc;
  for (const [key, value] of Object.entries(out)) {
    if (!isListSectionKey(key)) {
      continue;
    }
    const nested = NESTED_LIST_FIELDS[key] ?? [];
    if (Array.isArray(value)) {
      out[key] = withoutRemovals(value, nested);
    } else if (isPlainMapping(value) && Array.isArray(value.entries)) {
      const { entries, [LAYERING_KEY]: _wrapper, ...knobs } = value;
      out[key] = { ...knobs, entries: withoutRemovals(entries, nested) };
    }
  }
  return out;
}

/** No nested keyed list nests another today; the table exists so the walk above stays total when one does. */
const NESTED_OF_NESTED: Readonly<Partial<Record<string, readonly string[]>>> = {};

/**
 * The published schema cannot spell the cross-field rules the zod shapes refine (interaction_limits needs one of its
 * limits, selected_actions is refused beside an allowed_actions other than selected), so null placements are probed
 * through the action's own validator.
 */
function standaloneValid(doc: Json): boolean {
  return !(
    "error" in validateSettingsDoc(standaloneViewOf(doc), "layer", SectionSelection.ALL, silentIo())
  );
}

/** The runner's file name for layer `index` of `count`: settings.yml is always the top. */
function mergeLayerName(index: number, count: number): string {
  return index === count - 1 ? "settings.yml" : `layer-${index}.yml`;
}

/** Every nested key path through a mapping section's plain mappings; lists are data to the merge, so the walk never enters one, nor a list section's wrapper. */
function nestedMappingPaths(doc: Json): string[][] {
  const paths: string[][] = [];
  const walk = (value: unknown, path: string[]): void => {
    if (!isPlainMapping(value)) {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (child === null) {
        continue;
      }
      paths.push([...path, key]);
      walk(child, [...path, key]);
    }
  };
  for (const [key, value] of Object.entries(doc)) {
    if (!isListSectionKey(key) && key !== LAYERING_KEY) {
      walk(value, [key]);
    }
  }
  return paths;
}

function setPath(doc: Json, path: readonly string[], value: unknown): void {
  let node: Json = doc;
  for (const key of path.slice(0, -1)) {
    const next = node[key];
    if (!isPlainMapping(next)) {
      node[key] = {};
    }
    node = node[key] as Json;
  }
  node[path[path.length - 1] as string] = value;
}

/** The layer with a null written at `path`, as the validator will see it: the null is a value it must admit. */
function withNullAt(doc: Json, path: readonly string[]): Json {
  const out = structuredClone(doc);
  setPath(out, path, null);
  return out;
}

function rulesetEntries(doc: Json): Json[] {
  const value = doc.rulesets;
  return value === undefined || value === null ? [] : entriesOf(value);
}

/** Returns the entry list by reference (an empty plain list when absent), so a mutation appends into whichever form the layer drew. */
function ensureEntries(doc: Json, key: SectionKey): Json[] {
  const value = doc[key];
  if (value === undefined || value === null) {
    const entries: Json[] = [];
    doc[key] = entries;
    return entries;
  }
  return entriesOf(value);
}

/** `merge` is the directive's retired spelling: it fails as any unknown value does. */
const BAD_LAYERING_VALUES = ["merge", "DEEP", "union", "both", 1] as const;

/** Outside keep|delete; null among them, since the knob has no empty state and the fold refuses it like any other value. */
const BAD_UNDECLARED_VALUES = ["remove", "KEEP", "kep", true, null] as const;

interface LayerDraft {
  doc: Json;
  fileDirective: LayeringDirective | undefined;
  wrapperDirectives: Partial<Record<SectionKey, LayeringDirective>>;
}

/** Spelled as the entry spells them, so one claims function serves the layer's entries and the held ones. */
interface LabelIdentity {
  name: string;
  new_name?: string;
}

/**
 * What the fold holds of the keyed sections after the layers so far: labels with their spellings, and per ruleset name
 * its rules by type as JSON, so a parameters difference shows.
 */
interface HeldKeyed {
  labels: LabelIdentity[];
  rulesets: Map<string, Map<string, string>>;
}

function labelIdentity(entry: Json): LabelIdentity | undefined {
  if (typeof entry.name !== "string") {
    return undefined;
  }
  return typeof entry.new_name === "string"
    ? { name: entry.name, new_name: entry.new_name }
    : { name: entry.name };
}

/** A label's claims, case-folded: its name and its rename target. Two labels are one resource when their claims intersect. */
function labelClaims(label: LabelIdentity): string[] {
  const names = label.new_name === undefined ? [label.name] : [label.name, label.new_name];
  return [...new Set(names.map((name) => name.toLowerCase()))];
}

function claimsIntersect(a: readonly string[], b: readonly string[]): boolean {
  return a.some((claim) => b.includes(claim));
}

/** Every held label a layer's entry would pair with in a union (a rename can claim two). */
function heldLabelsFor(held: HeldKeyed, entry: Json): LabelIdentity[] {
  const identity = labelIdentity(entry);
  if (identity === undefined) {
    return [];
  }
  const claims = labelClaims(identity);
  return held.labels.filter((label) => claimsIntersect(labelClaims(label), claims));
}

/**
 * `effective` is the section's directive at this layer, or "replace" when the fold holds nothing yet: under replace
 * the held identities start over, under shallow a same-key entry swaps whole (its rules with it), under deep the
 * rules union by type. A removal drops what it names.
 */
function advanceHeld(
  held: HeldKeyed,
  key: "labels" | "rulesets",
  value: unknown,
  effective: LayeringDirective,
): void {
  const unite = effective !== "replace";
  if (value === null || !unite) {
    if (key === "labels") {
      held.labels = [];
    } else {
      held.rulesets.clear();
    }
    if (value === null) {
      return;
    }
  }
  for (const entry of entriesOf(value)) {
    if (typeof entry.name !== "string") {
      continue;
    }
    const removal = entry[REMOVE_KEY] === true;
    if (key === "labels") {
      const identity = labelIdentity(entry) as LabelIdentity;
      const claims = labelClaims(identity);
      held.labels = held.labels.filter((label) => !claimsIntersect(labelClaims(label), claims));
      if (!removal) {
        held.labels.push(identity);
      }
      continue;
    }
    if (removal) {
      held.rulesets.delete(entry.name);
      continue;
    }
    // Under deep the pair merges, so the held rules carry over; under shallow the entry swaps whole, so they start over.
    const rules =
      effective === "deep"
        ? (held.rulesets.get(entry.name) ?? new Map<string, string>())
        : new Map<string, string>();
    for (const rule of Array.isArray(entry.rules) ? entry.rules : []) {
      if (!isPlainMapping(rule) || typeof rule.type !== "string") {
        continue;
      }
      if (rule[REMOVE_KEY] === true) {
        rules.delete(rule.type);
      } else {
        rules.set(rule.type, JSON.stringify(rule));
      }
    }
    held.rulesets.set(entry.name, rules);
  }
}

function wrapperDirective(value: unknown): unknown {
  return Array.isArray(value) || !isPlainMapping(value) ? undefined : value[LAYERING_KEY];
}

function hasNestedNull(value: Json): boolean {
  return Object.values(value).some(
    (child) => child === null || (isPlainMapping(child) && hasNestedNull(child)),
  );
}

/** The same walk over presence, directives, and held identities the fold performs, reduced to the shapes each layer adds. */
export function mergeFeaturesOf(
  layers: readonly MergeLayer[],
  runInput: LayeringDirective | undefined,
  refused: boolean,
  runUndeclared: UndeclaredPolicyWord | undefined = undefined,
): MergeFeature[] {
  const features = new Set<MergeFeature>();
  if (refused) {
    features.add("refused");
    return MERGE_FEATURES.filter((feature) => features.has(feature));
  }
  features.add(runInput === undefined ? "run-layering-default" : `run-layering-${runInput}`);
  features.add(
    runUndeclared === undefined ? "run-undeclared-default" : `run-undeclared-${runUndeclared}`,
  );
  const run = runInput ?? DEFAULT_LAYERING_DIRECTIVE;
  const present = new Set<string>();
  const held: HeldKeyed = { labels: [], rulesets: new Map() };
  for (const layer of layers) {
    const doc = layer.doc;
    const fileDirective = doc[LAYERING_KEY];
    if (fileDirective !== undefined) {
      features.add("file-layering");
    }
    if (doc[UNDECLARED_KEY] !== undefined) {
      features.add("file-undeclared");
    }
    const keys = Object.keys(doc).filter((key) => key !== LAYERING_KEY && key !== UNDECLARED_KEY);
    if (keys.length === 0) {
      features.add("empty-layer");
    }
    for (const key of keys) {
      const value = doc[key];
      if (value === null) {
        // The fold writes `key: null` as the section's value (only a null-valued section passes validation with one),
        // so the section stays held and a later declaration over it is an override, not a first declaration.
        features.add("null-section");
        present.add(key);
        if (key === "labels" || key === "rulesets") {
          advanceHeld(held, key, null, "replace");
        }
        continue;
      }
      if (present.has(key)) {
        features.add("override");
      }
      if (isListSectionKey(key)) {
        if (!Array.isArray(value)) {
          const wrapper = value as Json;
          if (wrapper[UNDECLARED_KEY] !== undefined) {
            features.add("wrapper-undeclared");
          }
          if (!isKnobbedSection(key)) {
            features.add("wrapper-layered");
          }
          const directive = wrapper[LAYERING_KEY];
          if (isLayeringDirective(directive)) {
            features.add(`wrapper-layering-${directive}`);
          }
        }
        if (key === "environments") {
          const effective = wrapperDirective(value) ?? fileDirective ?? run;
          if (present.has(key) && effective !== "replace") {
            features.add("union-environments");
          }
        }
        if (key === "labels" || key === "rulesets") {
          const wrapper = wrapperDirective(value);
          const effective: LayeringDirective =
            (isLayeringDirective(wrapper) ? wrapper : undefined) ??
            (isLayeringDirective(fileDirective) ? fileDirective : undefined) ??
            run;
          const unite = present.has(key) && effective !== "replace";
          if (unite) {
            features.add(key === "labels" ? "union-labels" : "union-rulesets");
            for (const entry of entriesOf(value)) {
              if (typeof entry.name !== "string") {
                continue;
              }
              if (entry[REMOVE_KEY] === true) {
                features.add("remove-entry");
                continue;
              }
              if (key === "labels") {
                const paired = heldLabelsFor(held, entry);
                if (paired.length === 0) {
                  continue;
                }
                const spellings = paired.flatMap((label) =>
                  label.new_name === undefined ? [label.name] : [label.name, label.new_name],
                );
                const name = entry.name;
                if (spellings.some((s) => s !== name && s.toLowerCase() === name.toLowerCase())) {
                  features.add("label-case-fold");
                }
                if (
                  entry.new_name !== undefined ||
                  paired.some((label) => label.new_name !== undefined)
                ) {
                  features.add("label-rename-union");
                }
                continue;
              }
              const heldRules = held.rulesets.get(entry.name);
              for (const rule of Array.isArray(entry.rules) ? entry.rules : []) {
                if (!isPlainMapping(rule) || typeof rule.type !== "string") {
                  continue;
                }
                if (rule[REMOVE_KEY] === true) {
                  features.add("remove-nested");
                  continue;
                }
                const below = heldRules?.get(rule.type);
                if (below !== undefined && below !== JSON.stringify(rule)) {
                  features.add("rule-parameters");
                }
              }
            }
          }
          advanceHeld(held, key, value, unite ? effective : "replace");
        }
        for (const entry of entriesOf(value)) {
          if (Object.values(entry).some((field) => field === null)) {
            features.add("null-entry-field");
          }
        }
      } else if (isPlainMapping(value) && hasNestedNull(value)) {
        features.add("null-nested");
      }
      present.add(key);
    }
  }
  return MERGE_FEATURES.filter((feature) => features.has(feature));
}

/**
 * Every admitted layer is valid on its own by construction; the folded document is what the oracle predicts, and it is
 * not always a merged one.
 *   nested null placement              -> probed through the action's validator with the null written into this layer
 *   top-level null                     -> only on a section whose value null is, so it needs no probe
 *   the refused layer                  -> rewritten after the check, invalid by design
 *   two valid mapping sections merged  -> can trip a cross-field rule; the valid force gives every mapping section one contribution
 */
export function genMergeScenario(
  rng: Rng,
  options: GenScenarioOptions & { force?: MergeForce } = {},
): { scenario: Scenario; meta: MergeScenarioMeta } {
  const pool =
    options.sections !== undefined && options.sections.length > 0 ? options.sections : SECTION_KEYS;
  const count = rng.int(4) + 2;
  const force = options.force;

  const rolledLayering = rng.pick([...LAYERING_DIRECTIVES, undefined]);
  const runLayering: LayeringDirective | undefined =
    force?.kind === "valid" ? force.layering : rolledLayering;
  const effectiveRunLayering: LayeringDirective = runLayering ?? DEFAULT_LAYERING_DIRECTIVE;
  const runUndeclared = rng.fork("run-undeclared").pick([...UNDECLARED_POLICIES, undefined]);

  const rolledRefusal = rng.bool(0.2)
    ? { index: rng.int(count), kind: rng.pick(MERGE_REFUSAL_KINDS) }
    : undefined;
  const refusal =
    force === undefined
      ? rolledRefusal
      : force.kind === "refused"
        ? { index: rng.fork("refused-index").int(count), kind: force.refusal }
        : undefined;

  const layers: MergeLayer[] = [];
  const drafts: LayerDraft[] = [];
  /** The top-level sections the fold holds (declared non-null) after the layers so far. */
  const present = new Set<SectionKey>();
  /** The non-knobbed sections the fold holds as mappings: under the valid force, declared once. */
  const heldMappings = new Set<SectionKey>();
  const held: HeldKeyed = { labels: [], rulesets: new Map() };

  for (let i = 0; i < count; i++) {
    const layerRng = rng.fork(`layer:${i}`);
    const name = mergeLayerName(i, count);
    const layerPool = force?.kind === "valid" ? pool.filter((key) => !heldMappings.has(key)) : pool;
    const draft = drawLayer(layerRng, layerPool);
    const lower = drafts[i - 1];
    if (lower !== undefined) {
      renameLabelsIntoHeld(layerRng.fork("rename"), draft, held, effectiveRunLayering, present);
      respellLabels(layerRng.fork("case"), draft, held, effectiveRunLayering, present);
      placeNulls(layerRng.fork("nulls"), draft, lower, present, pool);
      placeRemovals(layerRng.fork("removals"), draft, held, effectiveRunLayering, present);
    }
    if (!standaloneValid(draft.doc)) {
      // Every placement above is probed, so an invalid layer here is a hole in the probes, not a scenario to run.
      throw new Error(
        `BUG: merge layer ${name} fails its standalone validation: ${JSON.stringify(draft.doc)}`,
      );
    }
    if (refusal !== undefined && refusal.index === i) {
      refuseLayer(layerRng.fork("refusal"), draft, refusal.kind);
    }
    for (const [key, value] of Object.entries(draft.doc)) {
      if (key === LAYERING_KEY || key === UNDECLARED_KEY) {
        continue;
      }
      const section = key as SectionKey;
      if (key === "labels" || key === "rulesets") {
        advanceHeld(
          held,
          key,
          value,
          present.has(section) ? effectiveLayering(draft, key, effectiveRunLayering) : "replace",
        );
      }
      if (value === null) {
        present.delete(section);
        heldMappings.delete(section);
        continue;
      }
      present.add(section);
      if (!isListSectionKey(key) && isPlainMapping(value)) {
        heldMappings.add(section);
      } else {
        heldMappings.delete(section);
      }
    }
    drafts.push(draft);
    layers.push({ name, doc: draft.doc });
  }

  const top = layers[count - 1] as MergeLayer;
  const scenario: Scenario = {
    name: `fuzz-merge-${rng.seed}`,
    tiers: ["mock"],
    settings: top.doc,
    settings_layers: layers.slice(0, -1).map((layer) => layer.doc),
    inputs: {
      mode: "render",
      ...(runLayering === undefined ? {} : { layering: runLayering }),
      ...(runUndeclared === undefined ? {} : { undeclared: runUndeclared }),
    },
    denial_style: "fine_grained",
    owner_kind: "org",
    expect: { exit_code: 0 },
  };
  return {
    scenario,
    meta: {
      layers,
      layering: effectiveRunLayering,
      undeclared: runUndeclared,
      ...(refusal === undefined
        ? {}
        : { refusal: { layer: mergeLayerName(refusal.index, count), kind: refusal.kind } }),
      features: mergeFeaturesOf(layers, runLayering, refusal !== undefined, runUndeclared),
    },
  };
}

/** The list sections are favored, so unions happen. */
function drawLayer(rng: Rng, pool: readonly SectionKey[]): LayerDraft {
  const chosen = rng.bool(0.08)
    ? []
    : pool.filter((key) => rng.bool(isListSectionKey(key) ? 0.6 : 0.3));
  const doc: Json = {};
  for (const key of chosen) {
    doc[key] = genSettings(rng.fork(`settings:${key}`), key);
  }
  const parameterRng = rng.fork("rule-parameters");
  for (const entry of rulesetEntries(doc)) {
    for (const rule of Array.isArray(entry.rules) ? entry.rules : []) {
      // Only a rule drawn bare takes the marker: a typed rule's parameters are what the schema requires of it.
      if (isPlainMapping(rule) && rule.parameters === undefined && parameterRng.bool(0.4)) {
        rule.parameters = { strict: parameterRng.bool() };
      }
    }
  }
  const fileDirective = rng.bool(0.2) ? rng.pick(LAYERING_DIRECTIVES) : undefined;
  if (fileDirective !== undefined) {
    doc[LAYERING_KEY] = fileDirective;
  }
  if (rng.bool(0.2)) {
    doc[UNDECLARED_KEY] = rng.pick(UNDECLARED_POLICIES);
  }
  const wrapperDirectives: LayerDraft["wrapperDirectives"] = {};
  for (const key of chosen) {
    if (!isListSectionKey(key)) {
      continue;
    }
    const entries = entriesOf(doc[key]);
    if (!rng.bool(0.4)) {
      doc[key] = entries;
      continue;
    }
    // A plain list's wrapper takes the directive alone; only a knobbed one carries the policy.
    const wrapper: Json = { entries };
    if (isKnobbedSection(key) && rng.bool(0.5)) {
      wrapper[UNDECLARED_KEY] = rng.pick(["keep", "delete"] as const);
    }
    const directive: LayeringDirective | undefined = rng.bool(0.5)
      ? rng.pick(LAYERING_DIRECTIVES)
      : undefined;
    if (directive !== undefined) {
      wrapper[LAYERING_KEY] = directive;
      wrapperDirectives[key] = directive;
    }
    doc[key] = wrapper;
  }
  validateAgainstPublishedSchema(doc);
  return { doc, fileDirective, wrapperDirectives };
}

/**
 * Respell a unioned label in the other case, so the union's case-folded matching is what keeps the list from growing.
 * A name without letters has no other case and is left alone.
 */
function respellLabels(
  rng: Rng,
  draft: LayerDraft,
  held: HeldKeyed,
  run: LayeringDirective,
  present: ReadonlySet<SectionKey>,
): void {
  const value = draft.doc.labels;
  if (
    value === undefined ||
    value === null ||
    !present.has("labels") ||
    effectiveLayering(draft, "labels", run) === "replace"
  ) {
    return;
  }
  for (const entry of entriesOf(value)) {
    if (typeof entry.name !== "string" || heldLabelsFor(held, entry).length === 0) {
      continue;
    }
    const flipped =
      entry.name === entry.name.toUpperCase() ? entry.name.toLowerCase() : entry.name.toUpperCase();
    if (flipped !== entry.name && rng.bool(0.5)) {
      entry.name = flipped;
    }
  }
}

function unionsLabels(
  draft: LayerDraft,
  run: LayeringDirective,
  present: ReadonlySet<SectionKey>,
): boolean {
  const value = draft.doc.labels;
  return (
    value !== undefined &&
    value !== null &&
    present.has("labels") &&
    effectiveLayering(draft, "labels", run) !== "replace"
  );
}

/**
 * Point one of the layer's labels at a held rename target, so the union pairs the two through the alias and the merged
 * document carries one label where a name-only match would keep two. The retargeted entry keeps its claims disjoint
 * from its siblings, as the boundary demands of every layer.
 */
function renameLabelsIntoHeld(
  rng: Rng,
  draft: LayerDraft,
  held: HeldKeyed,
  run: LayeringDirective,
  present: ReadonlySet<SectionKey>,
): void {
  const renamed = held.labels.flatMap((label) =>
    label.new_name === undefined ? [] : [label.new_name],
  );
  if (!unionsLabels(draft, run, present) || renamed.length === 0 || !rng.bool(0.7)) {
    return;
  }
  const entries = entriesOf(draft.doc.labels);
  const target = rng.pick(renamed);
  const claimsOf = (entry: Json): string[] => {
    const identity = labelIdentity(entry);
    return identity === undefined ? [] : labelClaims(identity);
  };
  const candidates = entries.filter((entry) => {
    if (typeof entry.name !== "string") {
      return false;
    }
    const siblings = entries.filter((other) => other !== entry).flatMap(claimsOf);
    return !claimsIntersect(claimsOf({ ...entry, name: target }), siblings);
  });
  if (candidates.length > 0) {
    rng.pick(candidates).name = target;
  }
}

function effectiveLayering(
  draft: LayerDraft,
  key: SectionKey,
  run: LayeringDirective,
): LayeringDirective {
  return draft.wrapperDirectives[key] ?? draft.fileDirective ?? run;
}

/**
 * Every null placed here is one the schema admits, so the layer stays valid on its own:
 *   a whole section         -> only where null is the section's value (pages, interaction limits), held below or not
 *   a nested mapping key    -> a key the lower layer declares, probed through the action's validator with the null
 *                              written into this document (a passthrough key, or a nullable field) and into the lower
 *                              declaration, which is what the fold makes of the pair: a cross-field rule the null
 *                              trips only beside the lower fields (runner_type: labeled with runner_label: null) is
 *                              caught here, not read as an invalid fold
 *   a keyed entry's field   -> a held branch's `protection: null`, the entry schema's own nullable field
 */
function placeNulls(
  rng: Rng,
  draft: LayerDraft,
  lower: LayerDraft,
  present: ReadonlySet<SectionKey>,
  pool: readonly SectionKey[],
): void {
  if (!rng.bool(0.6)) {
    return;
  }
  const doc = draft.doc;
  const attempts = rng.int(2) + 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const roll = rng.int(3);
    if (roll === 0) {
      const candidates = pool.filter((key) => isNullValued(key) && doc[key] === undefined);
      if (candidates.length > 0) {
        doc[rng.pick(candidates)] = null;
      }
      continue;
    }
    if (roll === 1) {
      // Only a null the schema admits at that path (a passthrough key, a nullable field) keeps the layer valid, and
      // only one the lower declaration admits beside its other fields keeps the fold valid.
      const candidates = nestedMappingPaths(lower.doc).filter((path) => {
        const top = path[0] as string;
        return (
          doc[top] !== null &&
          !isKnobbedSection(top) &&
          standaloneValid(withNullAt(doc, path)) &&
          standaloneValid(withNullAt(lower.doc, path))
        );
      });
      if (candidates.length > 0) {
        setPath(doc, rng.pick(candidates), null);
      }
      continue;
    }
    if (!present.has("branches") || doc.branches === null) {
      continue;
    }
    const claimed = new Set(entriesOf(doc.branches ?? []).map((entry) => entry.name));
    const candidates = entriesOf(lower.doc.branches ?? []).flatMap((entry) =>
      typeof entry.name === "string" && !claimed.has(entry.name) ? [entry.name] : [],
    );
    if (candidates.length > 0) {
      ensureEntries(doc, "branches").push({ name: rng.pick(candidates), protection: null });
    }
  }
}

/**
 * A removal names a held key: a label the fold holds (dropped under shallow or deep), or a rule type inside a held
 * ruleset (dropped only when deep merges the pair). The removal never shares a claim with a sibling entry, as the
 * boundary demands of every layer.
 */
function placeRemovals(
  rng: Rng,
  draft: LayerDraft,
  held: HeldKeyed,
  run: LayeringDirective,
  present: ReadonlySet<SectionKey>,
): void {
  if (!rng.bool(0.45)) {
    return;
  }
  const doc = draft.doc;
  if (rng.bool(0.6) && unionsLabels(draft, run, present) && held.labels.length > 0) {
    const entries = entriesOf(doc.labels);
    const claimedHere = entries.flatMap((entry) => {
      const identity = labelIdentity(entry);
      return identity === undefined ? [] : labelClaims(identity);
    });
    const candidates = held.labels.filter(
      (label) => !claimsIntersect(labelClaims(label), claimedHere),
    );
    if (candidates.length > 0) {
      const target = rng.pick(candidates);
      const spelled = rng.bool(0.5) ? target.name.toUpperCase() : target.name;
      entries.push({ name: spelled, [REMOVE_KEY]: true });
    }
    return;
  }
  if (
    doc.rulesets === undefined ||
    doc.rulesets === null ||
    !present.has("rulesets") ||
    effectiveLayering(draft, "rulesets", run) !== "deep"
  ) {
    return;
  }
  const candidates = [...held.rulesets.entries()].flatMap(([name, rules]) =>
    [...rules.keys()].map((type) => ({ name, type })),
  );
  if (candidates.length === 0) {
    return;
  }
  const { name, type } = rng.pick(candidates);
  const entries = ensureEntries(doc, "rulesets");
  const own = entries.find((entry) => entry.name === name);
  const rules = own === undefined ? [] : Array.isArray(own.rules) ? (own.rules as Json[]) : [];
  if (rules.some((rule) => isPlainMapping(rule) && rule.type === type)) {
    return;
  }
  rules.push({ type, [REMOVE_KEY]: true });
  if (own === undefined) {
    entries.push({ name, rules });
  } else {
    own.rules = rules;
  }
}

/** When the layer lacks the section a kind needs, one is created, outside the pool if need be: the refusal is the point of the layer. */
function refuseLayer(rng: Rng, draft: LayerDraft, kind: MergeRefusalKind): void {
  const doc = draft.doc;
  switch (kind) {
    case "duplicate-rule-type": {
      const entries = ensureEntries(doc, "rulesets");
      const entry = entries[0] ?? { name: "dup-rules", target: "branch" };
      if (entries.length === 0) {
        entries.push(entry);
      }
      const type = rng.pick(["deletion", "non_fast_forward", "required_signatures"]);
      entry.rules = [{ type }, { type }];
      return;
    }
    case "duplicate-label": {
      const entries = ensureEntries(doc, "labels");
      const entry = entries[0] ?? { name: "bug", color: "d73a4a" };
      if (entries.length === 0) {
        entries.push(entry);
      }
      const name = String(entry.name);
      const flipped = name.toUpperCase();
      entries.push({ name: rng.bool(0.5) && flipped !== name ? flipped : name });
      return;
    }
    case "bad-wrapper-layering": {
      const declared = LIST_SECTIONS.filter((key) => doc[key] !== undefined && doc[key] !== null);
      const key = declared.length > 0 ? rng.pick(declared) : "labels";
      const entries = ensureEntries(doc, key);
      doc[key] = { entries, [LAYERING_KEY]: rng.pick(BAD_LAYERING_VALUES) };
      return;
    }
    case "bad-file-layering": {
      doc[LAYERING_KEY] = rng.pick(BAD_LAYERING_VALUES);
      return;
    }
    case "bad-file-undeclared": {
      doc[UNDECLARED_KEY] = rng.pick(BAD_UNDECLARED_VALUES);
      return;
    }
    case "remove-under-replace": {
      const entries = ensureEntries(doc, "labels");
      doc.labels = {
        entries: [...entries, { name: "zz-removed", [REMOVE_KEY]: true }],
        [LAYERING_KEY]: "replace",
      };
      return;
    }
    case "remove-unmatched": {
      // A name outside every generator pool, so no lower layer can hold it; a wrapper directive keeps replace away.
      const entries = ensureEntries(doc, "labels");
      doc.labels = {
        entries: [...entries, { name: "zz-unmatched", [REMOVE_KEY]: true }],
        [LAYERING_KEY]: "deep",
      };
      return;
    }
    case "remove-with-fields": {
      const entries = ensureEntries(doc, "labels");
      entries.push({ name: "zz-removed", [REMOVE_KEY]: true, color: "ffffff" });
      return;
    }
    case "null-section": {
      const declared = SECTION_KEYS.filter((key) => !isNullValued(key) && doc[key] !== undefined);
      doc[declared.length > 0 ? rng.pick(declared) : "labels"] = null;
      return;
    }
    default: {
      const never: never = kind;
      throw new Error(`unknown merge refusal kind ${String(never)}`);
    }
  }
}
