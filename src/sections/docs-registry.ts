// The single registration point for section documentation, mirroring registry.ts: the mapped type
// makes a missing docs.ts a compile error. Documentation only: nothing bundled from src/main.ts
// may import this file or any docs.ts (a unit test walks the import graph).

import type { SectionKey } from "../schema.js";
import { docs as actions } from "./actions/docs.js";
import { docs as actionsSecrets } from "./actions_secrets/docs.js";
import { docs as actionsVariables } from "./actions_variables/docs.js";
import { docs as agentsSecrets } from "./agents_secrets/docs.js";
import { docs as agentsVariables } from "./agents_variables/docs.js";
import { docs as autolinks } from "./autolinks/docs.js";
import { docs as branches } from "./branches/docs.js";
import { docs as checkSuitePreferences } from "./check_suite_preferences/docs.js";
import { docs as codeQualitySetup } from "./code_quality_setup/docs.js";
import { docs as codeScanningDefaultSetup } from "./code_scanning_default_setup/docs.js";
import { docs as codespacesSecrets } from "./codespaces_secrets/docs.js";
import { docs as collaborators } from "./collaborators/docs.js";
import type { SectionDocs } from "./contract/docs.js";
import { docs as customProperties } from "./custom_properties/docs.js";
import { docs as dependabotSecrets } from "./dependabot_secrets/docs.js";
import { docs as deployKeys } from "./deploy_keys/docs.js";
import { docs as environments } from "./environments/docs.js";
import { docs as interactionLimits } from "./interaction_limits/docs.js";
import { docs as labels } from "./labels/docs.js";
import { docs as milestones } from "./milestones/docs.js";
import { docs as pages } from "./pages/docs.js";
import { docs as repository } from "./repository/docs.js";
import { docs as rulesets } from "./rulesets/docs.js";
import { docs as secretScanningCustomPatterns } from "./secret_scanning_custom_patterns/docs.js";
import { docs as teams } from "./teams/docs.js";
import { docs as webhooks } from "./webhooks/docs.js";
import { docs as workflows } from "./workflows/docs.js";

export const DOCS: { [K in SectionKey]: SectionDocs } = {
  repository,
  labels,
  rulesets,
  environments,
  branches,
  autolinks,
  actions,
  actions_secrets: actionsSecrets,
  dependabot_secrets: dependabotSecrets,
  codespaces_secrets: codespacesSecrets,
  agents_secrets: agentsSecrets,
  workflows,
  check_suite_preferences: checkSuitePreferences,
  pages,
  code_scanning_default_setup: codeScanningDefaultSetup,
  code_quality_setup: codeQualitySetup,
  collaborators,
  teams,
  milestones,
  interaction_limits: interactionLimits,
  actions_variables: actionsVariables,
  agents_variables: agentsVariables,
  webhooks,
  custom_properties: customProperties,
  deploy_keys: deployKeys,
  secret_scanning_custom_patterns: secretScanningCustomPatterns,
};
