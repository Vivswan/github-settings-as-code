/**
 * The type-level SliceDerivation pin in src/schema.ts is structural, so a type-identical LOOKALIKE schema (a slice minus its refinements) would still
 * typecheck; this asserts OBJECT IDENTITY instead.
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
import { TeamConfig } from "../src/sections/teams/schema.js";
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
 * Keyed over SectionKey, so a new section fails to compile here until its expectation is declared.
 *
 *   slice    -> the property IS the slice export
 *   knob     -> knobbed(entry): identity holds on the entry element of both branches
 *   layered  -> layeredList(slice): identity holds on the list slice itself, as the bare branch and the wrapper's entries
 */
const EXPECTED: Record<
  SectionKey,
  | { kind: "slice"; slice: z.ZodType }
  | { kind: "knob"; entry: z.ZodType }
  | { kind: "layered"; slice: z.ZodType }
> = {
  repository: { kind: "slice", slice: RepositoryConfig },
  labels: { kind: "knob", entry: LabelConfig },
  rulesets: { kind: "knob", entry: RulesetConfig },
  environments: { kind: "layered", slice: EnvironmentsConfig },
  branches: { kind: "layered", slice: BranchesConfig },
  autolinks: { kind: "knob", entry: AutolinkConfig },
  actions: { kind: "slice", slice: ActionsConfig },
  actions_secrets: { kind: "knob", entry: ActionsSecretConfig },
  dependabot_secrets: { kind: "knob", entry: DependabotSecretConfig },
  codespaces_secrets: { kind: "knob", entry: CodespacesSecretConfig },
  agents_secrets: { kind: "knob", entry: AgentsSecretConfig },
  workflows: { kind: "layered", slice: WorkflowsConfig },
  check_suite_preferences: { kind: "slice", slice: CheckSuitePreferencesConfig },
  pages: { kind: "slice", slice: PagesConfig },
  code_scanning_default_setup: { kind: "slice", slice: CodeScanningDefaultSetupConfig },
  code_quality_setup: { kind: "slice", slice: CodeQualitySetupConfig },
  collaborators: { kind: "knob", entry: CollaboratorConfig },
  teams: { kind: "knob", entry: TeamConfig },
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
      // knobbed() and layeredList() build the inner union in root, so identity holds one level down.
      const innerDef = defOf(inner);
      expect(innerDef.type, `${key}: the wrapped property must wrap a union`).toBe("union");
      const options = innerDef.options ?? [];
      const list = options.find((option) => defOf(option).type === "array");
      const wrapper = options.find((option) => defOf(option).type === "object");
      expect(list !== undefined && wrapper !== undefined, `${key}: wrapper branches missing`).toBe(
        true,
      );
      const entries = defOf(wrapper as z.ZodType).shape?.entries as z.ZodType;
      if (expected.kind === "layered") {
        expect(
          list === expected.slice,
          `${key}: the plain-array branch is not the section's list slice instance`,
        ).toBe(true);
        expect(
          entries === expected.slice,
          `${key}: the wrapper's entries is not the section's list slice instance`,
        ).toBe(true);
        return;
      }
      expect(
        defOf(list as z.ZodType).element === expected.entry,
        `${key}: the plain-array branch's element is not the entry slice instance`,
      ).toBe(true);
      expect(
        defOf(entries).element === expected.entry,
        `${key}: the wrapper's entries element is not the entry slice instance`,
      ).toBe(true);
    });
  }
});
