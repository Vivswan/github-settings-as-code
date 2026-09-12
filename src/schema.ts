/**
 * The settings document composed from the per-section slices (src/sections/<key>/schema.ts); this file adds only the
 * document-level wrappers (the undeclared knob, .optional()), so an org/user document can compose its own from the same
 * slices. Only DECLARED keys are ever applied or compared. The sections in PROBOT_PARITY_KEYS keep the Probot Settings
 * app's plain-array form so an existing Probot config applies to them unchanged; every other section is an addition.
 *
 * descriptions                            -> the docs files (src/schema.docs.yml, each <key>.docs.yml)
 * refine checks                           -> runtime-only, invisible to toJSONSchema, and they survive loosen()
 * z.object (the default)                  -> published OPEN; loosen() makes it a passthrough looseObject at runtime
 * z.strictObject                          -> additionalProperties: false, and loosen() keeps it strict (the wrapper, nested shapes)
 * z.looseObject                           -> where the config type carries an index signature, so the inferred type keeps it
 * runtime checks reading UNDECLARED keys  -> see them only through loosen()'s passthrough clone; the authored strip parse never runs at runtime
 */

import { z } from "zod";
import { ActionsConfig } from "./sections/actions/schema.js";
import { ActionsSecretConfig } from "./sections/actions_secrets/schema.js";
import { ActionsVariableConfig } from "./sections/actions_variables/schema.js";
import { AgentsSecretConfig } from "./sections/agents_secrets/schema.js";
import { AgentsVariableConfig } from "./sections/agents_variables/schema.js";
import { AutolinkConfig } from "./sections/autolinks/schema.js";
import { BranchesConfig } from "./sections/branches/schema.js";
import { CheckSuitePreferencesConfig } from "./sections/check_suite_preferences/schema.js";
import { CodeQualitySetupConfig } from "./sections/code_quality_setup/schema.js";
import { CodeScanningDefaultSetupConfig } from "./sections/code_scanning_default_setup/schema.js";
import { CodespacesSecretConfig } from "./sections/codespaces_secrets/schema.js";
import { CollaboratorConfig } from "./sections/collaborators/schema.js";
import { CustomPropertyConfig } from "./sections/custom_properties/schema.js";
import { DependabotSecretConfig } from "./sections/dependabot_secrets/schema.js";
import { DeployKeyConfig } from "./sections/deploy_keys/schema.js";
import { EnvironmentsConfig } from "./sections/environments/schema.js";
import { InteractionLimitsConfig } from "./sections/interaction_limits/schema.js";
import { LabelConfig } from "./sections/labels/schema.js";
import { MilestoneConfig } from "./sections/milestones/schema.js";
import { PagesConfig } from "./sections/pages/schema.js";
import { RepositoryConfig } from "./sections/repository/schema.js";
import { RulesetConfig } from "./sections/rulesets/schema.js";
import { SecretScanningPatternConfig } from "./sections/secret_scanning_custom_patterns/schema.js";
import { knobbed, LayeringSchema } from "./sections/shared/schema-helpers.js";
import { TeamsConfig } from "./sections/teams/schema.js";
import { WebhookConfig } from "./sections/webhooks/schema.js";
import { WorkflowsConfig } from "./sections/workflows/schema.js";
import type { MustBeNever } from "./types.js";

// --- The settings document ----------------------------------------------------

export const SettingsFile = z
  .object({
    repository: RepositoryConfig.optional(),
    labels: knobbed(LabelConfig).optional(),
    rulesets: knobbed(RulesetConfig).optional(),
    branches: BranchesConfig.optional(),
    environments: EnvironmentsConfig.optional(),
    autolinks: knobbed(AutolinkConfig).optional(),
    actions: ActionsConfig.optional(),
    actions_secrets: knobbed(ActionsSecretConfig).optional(),
    dependabot_secrets: knobbed(DependabotSecretConfig).optional(),
    codespaces_secrets: knobbed(CodespacesSecretConfig).optional(),
    agents_secrets: knobbed(AgentsSecretConfig).optional(),
    workflows: WorkflowsConfig.optional(),
    check_suite_preferences: CheckSuitePreferencesConfig.optional(),
    pages: PagesConfig.optional(),
    code_scanning_default_setup: CodeScanningDefaultSetupConfig.optional(),
    code_quality_setup: CodeQualitySetupConfig.optional(),
    collaborators: knobbed(CollaboratorConfig).optional(),
    teams: TeamsConfig.optional(),
    milestones: knobbed(MilestoneConfig).optional(),
    interaction_limits: InteractionLimitsConfig.optional(),
    actions_variables: knobbed(ActionsVariableConfig).optional(),
    agents_variables: knobbed(AgentsVariableConfig).optional(),
    webhooks: knobbed(WebhookConfig).optional(),
    custom_properties: knobbed(CustomPropertyConfig).optional(),
    deploy_keys: knobbed(DeployKeyConfig).optional(),
    secret_scanning_custom_patterns: knobbed(SecretScanningPatternConfig).optional(),
    // The one non-section key: the merge's document-level directive (engine/layers.ts); the apply path never reads it.
    _layering: LayeringSchema.optional(),
  })
  .meta({ id: "SettingsFile" });
export type SettingsFile = z.infer<typeof SettingsFile>;

/** Every recognized top-level section, in execution order. */
export const SECTION_KEYS = [
  "repository",
  "labels",
  "rulesets",
  // environments before branches on purpose: branches' required_deployments names deployment environments, and GitHub
  // silently drops names that do not exist, so environments declared in the same file must land first.
  "environments",
  "branches",
  "autolinks",
  "actions",
  "actions_secrets",
  "dependabot_secrets",
  "codespaces_secrets",
  "agents_secrets",
  "workflows",
  "check_suite_preferences",
  "pages",
  "code_scanning_default_setup",
  "code_quality_setup",
  "collaborators",
  "teams",
  "milestones",
  "interaction_limits",
  "actions_variables",
  "agents_variables",
  "webhooks",
  "custom_properties",
  "deploy_keys",
  // Last on purpose, so the patterns run against a repository whose scanning the repository section already enabled.
  // Not enough for ONE apply under the default fail policy: enable scanning first, or bootstrap under
  // on-missing-permission: warn.
  //   preflight probes every declared section read-only -> the patterns list 404s (scanning still off) -> the run aborts before any write
  "secret_scanning_custom_patterns",
] as const satisfies readonly (keyof SettingsFile)[];

export type SectionKey = (typeof SECTION_KEYS)[number];

export const UNDECLARED_POLICY_SECTIONS = [
  "labels",
  "rulesets",
  "autolinks",
  "actions_secrets",
  "dependabot_secrets",
  "codespaces_secrets",
  "agents_secrets",
  "collaborators",
  "milestones",
  "actions_variables",
  "agents_variables",
  "webhooks",
  "custom_properties",
  "deploy_keys",
  "secret_scanning_custom_patterns",
] as const satisfies readonly SectionKey[];

export type UndeclaredPolicySection = (typeof UNDECLARED_POLICY_SECTIONS)[number];

/** Both branches are required, the plain array AND the wrapper, so a section whose config merely carries `entries` is not knobbed by accident. */
type KnobbedByType = {
  [K in SectionKey]: [Extract<NonNullable<SettingsFile[K]>, readonly unknown[]>] extends [never]
    ? never
    : [Extract<NonNullable<SettingsFile[K]>, { entries: readonly unknown[] }>] extends [never]
      ? never
      : K;
}[SectionKey];
type _KnobListComplete = MustBeNever<
  Exclude<KnobbedByType, (typeof UNDECLARED_POLICY_SECTIONS)[number]>
>;
type _KnobListSound = MustBeNever<
  Exclude<(typeof UNDECLARED_POLICY_SECTIONS)[number], KnobbedByType>
>;

/** Sections whose plain form (no wrapper) matches the Probot Settings app schema; docs/start/migrating-from-probot.md is pinned against this list. */
export const PROBOT_PARITY_KEYS = [
  "repository",
  "labels",
  "branches",
  "collaborators",
  "teams",
  "milestones",
] as const satisfies readonly SectionKey[];

/**
 * Directives to the merge, not sections: declared on the document so the published schema types them.
 * validateSectionShapes copies only SECTION_KEYS, so none of them reaches the apply path.
 */
export const DOCUMENT_DIRECTIVE_KEYS = [
  "_layering",
] as const satisfies readonly (keyof SettingsFile)[];
type DocumentDirectiveKey = (typeof DOCUMENT_DIRECTIVE_KEYS)[number];

type _UnlistedSection = MustBeNever<Exclude<keyof SettingsFile, SectionKey | DocumentDirectiveKey>>;
type _DirectiveNotASection = MustBeNever<Extract<DocumentDirectiveKey, SectionKey>>;

// --- Slice-composition pins -----------------------------------------------------

/**
 * Each property's schema before .optional(): the slice verbatim, or the undeclared knob over the entry slice. A
 * whole-section slice export is named <Key>Config, matching the <Entry>Config entry schemas; a new section fails to
 * compile until its derivation is declared here.
 */
type SliceDerivation = {
  repository: typeof RepositoryConfig;
  labels: ReturnType<typeof knobbed<typeof LabelConfig>>;
  rulesets: ReturnType<typeof knobbed<typeof RulesetConfig>>;
  environments: typeof EnvironmentsConfig;
  branches: typeof BranchesConfig;
  autolinks: ReturnType<typeof knobbed<typeof AutolinkConfig>>;
  actions: typeof ActionsConfig;
  actions_secrets: ReturnType<typeof knobbed<typeof ActionsSecretConfig>>;
  dependabot_secrets: ReturnType<typeof knobbed<typeof DependabotSecretConfig>>;
  codespaces_secrets: ReturnType<typeof knobbed<typeof CodespacesSecretConfig>>;
  agents_secrets: ReturnType<typeof knobbed<typeof AgentsSecretConfig>>;
  workflows: typeof WorkflowsConfig;
  check_suite_preferences: typeof CheckSuitePreferencesConfig;
  pages: typeof PagesConfig;
  code_scanning_default_setup: typeof CodeScanningDefaultSetupConfig;
  code_quality_setup: typeof CodeQualitySetupConfig;
  collaborators: ReturnType<typeof knobbed<typeof CollaboratorConfig>>;
  teams: typeof TeamsConfig;
  milestones: ReturnType<typeof knobbed<typeof MilestoneConfig>>;
  interaction_limits: typeof InteractionLimitsConfig;
  actions_variables: ReturnType<typeof knobbed<typeof ActionsVariableConfig>>;
  agents_variables: ReturnType<typeof knobbed<typeof AgentsVariableConfig>>;
  webhooks: ReturnType<typeof knobbed<typeof WebhookConfig>>;
  custom_properties: ReturnType<typeof knobbed<typeof CustomPropertyConfig>>;
  deploy_keys: ReturnType<typeof knobbed<typeof DeployKeyConfig>>;
  secret_scanning_custom_patterns: ReturnType<typeof knobbed<typeof SecretScanningPatternConfig>>;
};

type SectionNotComposedFromItsSlice = {
  [K in SectionKey]: (typeof SettingsFile.shape)[K] extends z.ZodOptional<SliceDerivation[K]>
    ? never
    : K;
}[SectionKey];

/**
 * Compile-time lockstep, STRUCTURAL only: zod types refinements as `this`, so a lookalike rebuilt without a slice's
 * superRefine still matches. test/schema-slices.test.ts closes that hole by asserting object identity per key.
 */
type _EverySectionComposedFromItsSlice = MustBeNever<SectionNotComposedFromItsSlice>;

type _SliceDerivationKeysReal = MustBeNever<Exclude<keyof SliceDerivation, SectionKey>>;
