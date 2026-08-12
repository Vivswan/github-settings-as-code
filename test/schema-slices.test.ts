/**
 * Identity pins for the slice-first schema composition. The type-level
 * SliceDerivation pin in src/schema.ts is structural, so a property rebuilt
 * from a type-identical LOOKALIKE schema (dropping a slice's refinements,
 * say) would still typecheck; this test closes that hole by asserting OBJECT
 * IDENTITY: every SettingsFile property is `.optional()` over the section's
 * own slice export - or, for a knobbed section, over the undeclared knob
 * whose both branches carry the slice as their entry element. Each offender
 * fails by key name.
 */

import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import { SECTION_KEYS, type SectionKey, SettingsFile } from "../src/schema.js";
import { ActionsConfig } from "../src/sections/actions/schema.js";
import { ActionsSecretConfig } from "../src/sections/actions_secrets/schema.js";
import { ActionsVariableConfig } from "../src/sections/actions_variables/schema.js";
import { AgentsSecretConfig } from "../src/sections/agents_secrets/schema.js";
import { AgentsVariableConfig } from "../src/sections/agents_variables/schema.js";
import { AutolinkConfig } from "../src/sections/autolinks/schema.js";
import { BranchesConfig } from "../src/sections/branches/schema.js";
import { CheckSuitePreferencesConfig } from "../src/sections/check_suite_preferences/schema.js";
import { CodeQualitySetupConfig } from "../src/sections/code_quality_setup/schema.js";
import { CodeScanningDefaultSetupConfig } from "../src/sections/code_scanning_default_setup/schema.js";
import { CodespacesSecretConfig } from "../src/sections/codespaces_secrets/schema.js";
import { CollaboratorConfig } from "../src/sections/collaborators/schema.js";
import { CustomPropertyConfig } from "../src/sections/custom_properties/schema.js";
import { DependabotSecretConfig } from "../src/sections/dependabot_secrets/schema.js";
import { DeployKeyConfig } from "../src/sections/deploy_keys/schema.js";
import { EnvironmentsConfig } from "../src/sections/environments/schema.js";
import { InteractionLimitsConfig } from "../src/sections/interaction_limits/schema.js";
import { LabelConfig } from "../src/sections/labels/schema.js";
import { MilestoneConfig } from "../src/sections/milestones/schema.js";
import { PagesConfig } from "../src/sections/pages/schema.js";
import { RepositoryConfig } from "../src/sections/repository/schema.js";
import { RulesetConfig } from "../src/sections/rulesets/schema.js";
import { SecretScanningPatternConfig } from "../src/sections/secret_scanning_custom_patterns/schema.js";
import { TeamsConfig } from "../src/sections/teams/schema.js";
import { WebhookConfig } from "../src/sections/webhooks/schema.js";
import { WorkflowsConfig } from "../src/sections/workflows/schema.js";

/** The zod internals the unwrap below reads (the loosen() idiom). */
interface ZodDefView {
  type?: string;
  innerType?: z.ZodType;
  options?: readonly z.ZodType[];
  element?: z.ZodType;
  shape?: Record<string, z.ZodType>;
}

function defOf(schema: z.ZodType): ZodDefView {
  return (schema as unknown as { _zod: { def: ZodDefView } })._zod.def;
}

/**
 * What each property must be composed from: the slice instance itself, or
 * the knob over the entry slice. Keyed over SectionKey, so a new section
 * fails to compile here until its expectation is declared.
 */
const EXPECTED: Record<
  SectionKey,
  { kind: "slice"; slice: z.ZodType } | { kind: "knob"; entry: z.ZodType }
> = {
  repository: { kind: "slice", slice: RepositoryConfig },
  labels: { kind: "knob", entry: LabelConfig },
  rulesets: { kind: "knob", entry: RulesetConfig },
  environments: { kind: "slice", slice: EnvironmentsConfig },
  branches: { kind: "slice", slice: BranchesConfig },
  autolinks: { kind: "knob", entry: AutolinkConfig },
  actions: { kind: "slice", slice: ActionsConfig },
  actions_secrets: { kind: "knob", entry: ActionsSecretConfig },
  dependabot_secrets: { kind: "knob", entry: DependabotSecretConfig },
  codespaces_secrets: { kind: "knob", entry: CodespacesSecretConfig },
  agents_secrets: { kind: "knob", entry: AgentsSecretConfig },
  workflows: { kind: "slice", slice: WorkflowsConfig },
  check_suite_preferences: { kind: "slice", slice: CheckSuitePreferencesConfig },
  pages: { kind: "slice", slice: PagesConfig },
  code_scanning_default_setup: { kind: "slice", slice: CodeScanningDefaultSetupConfig },
  code_quality_setup: { kind: "slice", slice: CodeQualitySetupConfig },
  collaborators: { kind: "knob", entry: CollaboratorConfig },
  teams: { kind: "slice", slice: TeamsConfig },
  milestones: { kind: "knob", entry: MilestoneConfig },
  interaction_limits: { kind: "slice", slice: InteractionLimitsConfig },
  actions_variables: { kind: "knob", entry: ActionsVariableConfig },
  agents_variables: { kind: "knob", entry: AgentsVariableConfig },
  webhooks: { kind: "knob", entry: WebhookConfig },
  custom_properties: { kind: "knob", entry: CustomPropertyConfig },
  deploy_keys: { kind: "knob", entry: DeployKeyConfig },
  secret_scanning_custom_patterns: { kind: "knob", entry: SecretScanningPatternConfig },
};

describe("SettingsFile slice composition identity", () => {
  for (const key of SECTION_KEYS) {
    test(`${key} is composed from its section's slice export`, () => {
      const property = SettingsFile.shape[key] as z.ZodType;
      const propertyDef = defOf(property);
      expect(propertyDef.type, `${key}: the property must be .optional()`).toBe("optional");
      const inner = propertyDef.innerType as z.ZodType;
      const expected = EXPECTED[key];
      if (expected.kind === "slice") {
        expect(
          inner === expected.slice,
          `${key}: the property's inner schema is not the section's slice export instance`,
        ).toBe(true);
        return;
      }
      // A knobbed section: the inner union is built by knobbed() in root, so
      // identity holds one level down - both branches carry the entry slice.
      const innerDef = defOf(inner);
      expect(innerDef.type, `${key}: the knobbed property must wrap a union`).toBe("union");
      const options = innerDef.options ?? [];
      const list = options.find((option) => defOf(option).type === "array");
      const wrapper = options.find((option) => defOf(option).type === "object");
      expect(list !== undefined && wrapper !== undefined, `${key}: knob branches missing`).toBe(
        true,
      );
      expect(
        defOf(list as z.ZodType).element === expected.entry,
        `${key}: the plain-array branch's element is not the entry slice instance`,
      ).toBe(true);
      const entries = defOf(wrapper as z.ZodType).shape?.entries as z.ZodType;
      expect(
        defOf(entries).element === expected.entry,
        `${key}: the wrapper's entries element is not the entry slice instance`,
      ).toBe(true);
    });
  }
});
