/**
 * The settings document composed from the per-section slices (src/sections/<key>/schema.ts); this file adds only the
 * document-level wrappers (the undeclared knob, the layered wrapper, .optional()), so an org/user document can compose
 * its own from the same
 * slices. Only DECLARED keys are ever applied or compared. The sections in PROBOT_PARITY_KEYS keep the Probot Settings
 * app's plain-array form so an existing Probot config applies to them unchanged; every other section is an addition.
 *
 * descriptions                            -> the docs files (docs/schema.docs.yml, each docs/sections/<key>.docs.yml)
 * refine checks                           -> runtime-only, invisible to toJSONSchema
 * open() (sections/shared/schema-helpers) -> published OPEN, closed in the type; the runtime keeps undeclared keys
 * z.object (the document root alone)      -> strip: an unknown top-level key is a document problem validateSettingsDoc
 *                                            (engine/orchestrate.ts) names, never a passthrough
 * z.strictObject                          -> additionalProperties: false, published and at runtime (the wrappers)
 * z.looseObject                           -> where the config type carries an index signature the inferred type keeps
 * a knobbed or layered list section       -> the union here; routed() (sections/shared/schema-helpers.ts) runs it
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
import {
  knobbed,
  LayeringSchema,
  layeredList,
  UndeclaredPolicySchema,
} from "./sections/shared/schema-helpers.js";
import { TeamConfig } from "./sections/teams/schema.js";
import { WebhookConfig } from "./sections/webhooks/schema.js";
import { WorkflowsConfig } from "./sections/workflows/schema.js";
import type { MustBeNever } from "./types.js";

// --- The settings document ----------------------------------------------------

/**
 * How a section's slice (src/sections/<key>/schema.ts) becomes its document property, before .optional():
 *
 *   slice    -> the slice verbatim
 *   knob     -> knobbed(entry): the `_undeclared` wrapper over the entry slice
 *   layered  -> layeredList(list): the `_layering` wrapper over the list slice
 */
type SectionSlice =
  | { readonly key: string; readonly kind: "slice" | "knob"; readonly slice: z.ZodType }
  | { readonly key: string; readonly kind: "layered"; readonly slice: z.ZodArray<z.ZodType> };

/**
 * The ONE table of sections and their slices: SettingsFile's shape is built from it, so a property is its section's
 * slice by construction. Its order is the published schema's property order; execution order is SECTION_KEYS.
 */
const SECTION_SLICES = [
  { key: "repository", kind: "slice", slice: RepositoryConfig },
  { key: "labels", kind: "knob", slice: LabelConfig },
  { key: "rulesets", kind: "knob", slice: RulesetConfig },
  { key: "branches", kind: "layered", slice: BranchesConfig },
  { key: "environments", kind: "layered", slice: EnvironmentsConfig },
  { key: "autolinks", kind: "knob", slice: AutolinkConfig },
  { key: "actions", kind: "slice", slice: ActionsConfig },
  { key: "actions_secrets", kind: "knob", slice: ActionsSecretConfig },
  { key: "dependabot_secrets", kind: "knob", slice: DependabotSecretConfig },
  { key: "codespaces_secrets", kind: "knob", slice: CodespacesSecretConfig },
  { key: "agents_secrets", kind: "knob", slice: AgentsSecretConfig },
  { key: "workflows", kind: "layered", slice: WorkflowsConfig },
  { key: "check_suite_preferences", kind: "slice", slice: CheckSuitePreferencesConfig },
  { key: "pages", kind: "slice", slice: PagesConfig },
  { key: "code_scanning_default_setup", kind: "slice", slice: CodeScanningDefaultSetupConfig },
  { key: "code_quality_setup", kind: "slice", slice: CodeQualitySetupConfig },
  { key: "collaborators", kind: "knob", slice: CollaboratorConfig },
  { key: "teams", kind: "knob", slice: TeamConfig },
  { key: "milestones", kind: "knob", slice: MilestoneConfig },
  { key: "interaction_limits", kind: "slice", slice: InteractionLimitsConfig },
  { key: "actions_variables", kind: "knob", slice: ActionsVariableConfig },
  { key: "agents_variables", kind: "knob", slice: AgentsVariableConfig },
  { key: "webhooks", kind: "knob", slice: WebhookConfig },
  { key: "custom_properties", kind: "knob", slice: CustomPropertyConfig },
  { key: "deploy_keys", kind: "knob", slice: DeployKeyConfig },
  { key: "secret_scanning_custom_patterns", kind: "knob", slice: SecretScanningPatternConfig },
] as const satisfies readonly SectionSlice[];

type Composed<E extends SectionSlice> = E extends {
  kind: "slice";
  slice: infer S extends z.ZodType;
}
  ? z.ZodOptional<S>
  : E extends { kind: "knob"; slice: infer S extends z.ZodType }
    ? z.ZodOptional<ReturnType<typeof knobbed<S>>>
    : E extends { kind: "layered"; slice: infer S extends z.ZodArray<z.ZodType> }
      ? z.ZodOptional<ReturnType<typeof layeredList<S>>>
      : never;

type SectionShape = {
  [E in (typeof SECTION_SLICES)[number] as E["key"]]: Composed<E>;
};

function composed(section: SectionSlice): z.ZodType {
  switch (section.kind) {
    case "slice":
      return section.slice.optional();
    case "knob":
      return knobbed(section.slice).optional();
    case "layered":
      return layeredList(section.slice).optional();
  }
}

// The one cast: SectionShape is Composed over the same table the entries come from.
const sectionShape = Object.fromEntries(
  SECTION_SLICES.map((section) => [section.key, composed(section)]),
) as SectionShape;

export const SettingsFile = z
  .object({
    ...sectionShape,
    // The non-section keys, the document's directives (engine/directives.ts): `_layering` steers the fold and never reaches
    // the apply path; `_undeclared` is resolved into every list's wrapper, after the fold or by the validator.
    _layering: LayeringSchema.optional(),
    _undeclared: UndeclaredPolicySchema.optional(),
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
  "teams",
  "milestones",
  "actions_variables",
  "agents_variables",
  "webhooks",
  "custom_properties",
  "deploy_keys",
  "secret_scanning_custom_patterns",
] as const satisfies readonly SectionKey[];

export type UndeclaredPolicySection = (typeof UNDECLARED_POLICY_SECTIONS)[number];

/**
 * Every list section, in execution order: the knobbed ones and the plain lists whose wrapper takes `_layering` alone.
 * The fold (engine/layers.ts) unions each by the key its module declares; ./sections/registry.ts requires that
 * declaration of every member, so a section added here without one fails to compile.
 */
export const LIST_SECTIONS = [
  "labels",
  "rulesets",
  "environments",
  "branches",
  "autolinks",
  "actions_secrets",
  "dependabot_secrets",
  "codespaces_secrets",
  "agents_secrets",
  "workflows",
  "collaborators",
  "teams",
  "milestones",
  "actions_variables",
  "agents_variables",
  "webhooks",
  "custom_properties",
  "deploy_keys",
  "secret_scanning_custom_patterns",
] as const satisfies readonly SectionKey[];

export type ListSection = (typeof LIST_SECTIONS)[number];

/** A list section outside the undeclared policy: its wrapper carries `_layering` only, and the fold writes the bare list. */
export type PlainListSection = Exclude<ListSection, UndeclaredPolicySection>;

/** The `{entries}` wrapper form of a section's value, or never where the section takes none. */
type WrapperOf<K extends SectionKey> = Extract<
  NonNullable<SettingsFile[K]>,
  { entries: readonly unknown[] }
>;

/**
 * Both branches are required, the plain array AND the wrapper, so a section whose config merely carries `entries`
 * is not a list section by accident.
 */
type ListByType = {
  [K in SectionKey]: [Extract<NonNullable<SettingsFile[K]>, readonly unknown[]>] extends [never]
    ? never
    : [WrapperOf<K>] extends [never]
      ? never
      : K;
}[SectionKey];
type _ListComplete = MustBeNever<Exclude<ListByType, ListSection>>;
type _ListSound = MustBeNever<Exclude<ListSection, ListByType>>;

/**
 * Knobbed: a list section whose wrapper takes the `_undeclared` policy. Read off the wrapper's keys, since a wrapper
 * without the key is assignable to one with it optional.
 */
type KnobbedByType = {
  [K in ListByType]: "_undeclared" extends keyof WrapperOf<K> ? K : never;
}[ListByType];
type _KnobListComplete = MustBeNever<
  Exclude<KnobbedByType, (typeof UNDECLARED_POLICY_SECTIONS)[number]>
>;
type _KnobListSound = MustBeNever<
  Exclude<(typeof UNDECLARED_POLICY_SECTIONS)[number], KnobbedByType>
>;

/**
 * Sections whose plain form (no wrapper) matches the Probot Settings app schema; docs/start/migrating-from-probot.md
 * is pinned against this list.
 */
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
  "_undeclared",
] as const satisfies readonly (keyof SettingsFile)[];
type DocumentDirectiveKey = (typeof DOCUMENT_DIRECTIVE_KEYS)[number];

type _UnlistedSection = MustBeNever<Exclude<keyof SettingsFile, SectionKey | DocumentDirectiveKey>>;
type _DirectiveNotASection = MustBeNever<Extract<DocumentDirectiveKey, SectionKey>>;
