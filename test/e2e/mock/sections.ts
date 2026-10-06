/**
 * The mapped and section-prefixed key types make a missing, misplaced, or colliding fragment a compile error, so the
 * runtime asserts in handlers.ts are only backstops. A section's mock.ts imports the test-tree seams beside this file
 * (support.ts, state.ts, and their siblings), never routes.ts. A fragment that is one family-factory call is
 * written here as that call: a mock.ts holding only the call would be a pass-through file.
 */

import { SECTION_KEYS, type SectionKey } from "../../../src/schema.js";
import { actionsVariablesSection } from "../../../src/sections/actions_variables/index.js";
import { agentsVariablesSection } from "../../../src/sections/agents_variables/index.js";
import type { SectionGraphqlKey } from "../../../src/sections/registry.js";
import { actionsMockHandlers } from "../../sections/actions/mock.js";
import { autolinksMockHandlers } from "../../sections/autolinks/mock.js";
import { branchesMockGraphqlHandlers, branchesMockHandlers } from "../../sections/branches/mock.js";
import { checkSuitePreferencesMockHandlers } from "../../sections/check_suite_preferences/mock.js";
import { collaboratorsMockHandlers } from "../../sections/collaborators/mock.js";
import { customPropertiesMockHandlers } from "../../sections/custom_properties/mock.js";
import { deployKeysMockHandlers } from "../../sections/deploy_keys/mock.js";
import {
  environmentsMockGraphqlHandlers,
  environmentsMockHandlers,
} from "../../sections/environments/mock.js";
import { interactionLimitsMockHandlers } from "../../sections/interaction_limits/mock.js";
import { labelsMockHandlers } from "../../sections/labels/mock.js";
import { milestonesMockHandlers } from "../../sections/milestones/mock.js";
import { pagesMockHandlers } from "../../sections/pages/mock.js";
import {
  repositoryMockGraphqlHandlers,
  repositoryMockHandlers,
} from "../../sections/repository/mock.js";
import { rulesetsMockHandlers } from "../../sections/rulesets/mock.js";
import { secretScanningCustomPatternsMockHandlers } from "../../sections/secret_scanning_custom_patterns/mock.js";
import { teamsMockHandlers } from "../../sections/teams/mock.js";
import { webhooksMockHandlers } from "../../sections/webhooks/mock.js";
import { workflowsMockHandlers } from "../../sections/workflows/mock.js";
import {
  type GraphqlHandler,
  type Handler,
  repoSecretsRestHandlers,
  repoVariablesRestHandlers,
  type SectionGraphqlHandlers,
  type SectionRestHandlers,
  setupRestHandlers,
} from "./support.js";

type SectionMockFragment<K extends SectionKey> = [SectionGraphqlKey<K>] extends [never]
  ? { rest: SectionRestHandlers<K>; graphql?: never }
  : { rest: SectionRestHandlers<K>; graphql: SectionGraphqlHandlers<K> };

/** Writes answer only statuses the endpoint declares or an undeclared error; statusAllowed in routes.ts proves it on every request. */
const FRAGMENTS: { readonly [K in SectionKey]: SectionMockFragment<K> } = {
  repository: { rest: repositoryMockHandlers, graphql: repositoryMockGraphqlHandlers },
  labels: { rest: labelsMockHandlers },
  rulesets: { rest: rulesetsMockHandlers },
  environments: { rest: environmentsMockHandlers, graphql: environmentsMockGraphqlHandlers },
  branches: { rest: branchesMockHandlers, graphql: branchesMockGraphqlHandlers },
  autolinks: { rest: autolinksMockHandlers },
  actions: { rest: actionsMockHandlers },
  actions_secrets: { rest: repoSecretsRestHandlers("actions_secrets") },
  dependabot_secrets: { rest: repoSecretsRestHandlers("dependabot_secrets") },
  codespaces_secrets: { rest: repoSecretsRestHandlers("codespaces_secrets") },
  agents_secrets: { rest: repoSecretsRestHandlers("agents_secrets") },
  workflows: { rest: workflowsMockHandlers },
  check_suite_preferences: { rest: checkSuitePreferencesMockHandlers },
  pages: { rest: pagesMockHandlers },
  code_scanning_default_setup: { rest: setupRestHandlers("code_scanning_default_setup") },
  code_quality_setup: { rest: setupRestHandlers("code_quality_setup") },
  collaborators: { rest: collaboratorsMockHandlers },
  teams: { rest: teamsMockHandlers },
  milestones: { rest: milestonesMockHandlers },
  interaction_limits: { rest: interactionLimitsMockHandlers },
  actions_variables: { rest: repoVariablesRestHandlers(actionsVariablesSection) },
  agents_variables: { rest: repoVariablesRestHandlers(agentsVariablesSection) },
  webhooks: { rest: webhooksMockHandlers },
  custom_properties: { rest: customPropertiesMockHandlers },
  deploy_keys: { rest: deployKeysMockHandlers },
  secret_scanning_custom_patterns: { rest: secretScanningCustomPatternsMockHandlers },
};

/** Unreachable by construction (fragment keys are section-prefixed by type); kept as the runtime backstop behind that claim. */
function mergeFragments<H>(
  kind: "REST" | "GraphQL",
  fragments: ReadonlyArray<Record<string, H>>,
): Record<string, H> {
  const merged: Record<string, H> = {};
  const duplicates: string[] = [];
  for (const fragment of fragments) {
    for (const [key, handler] of Object.entries(fragment)) {
      if (key in merged) {
        duplicates.push(key);
      }
      merged[key] = handler;
    }
  }
  if (duplicates.length > 0) {
    throw new Error(
      `E2E MOCK: duplicate ${kind} handler key(s) across section fragments: [${duplicates.sort().join(", ")}]`,
    );
  }
  return merged;
}

/**
 * The one lookup behind both tables. The mapped type above makes a missing fragment a compile error; a test run
 * skips the compiler, so a section registered without one fails here by name instead of at `.rest` of undefined.
 */
function fragmentFor<K extends SectionKey>(key: K): SectionMockFragment<K> {
  const fragment: SectionMockFragment<K> | undefined = FRAGMENTS[key];
  if (fragment === undefined) {
    throw new Error(
      `E2E MOCK: section "${key}" is registered without a mock fragment; add ` +
        `\`${key}: { rest: <its mock.ts handlers or family-factory call> }\` to FRAGMENTS in test/e2e/mock/sections.ts`,
    );
  }
  return fragment;
}

export function sectionHandlerFragments(): Record<string, Handler> {
  return mergeFragments(
    "REST",
    SECTION_KEYS.map((key) => fragmentFor(key).rest),
  );
}

export function sectionGraphqlHandlerFragments(): Record<string, GraphqlHandler> {
  return mergeFragments(
    "GraphQL",
    SECTION_KEYS.flatMap((key) => {
      const graphql: Record<string, GraphqlHandler> | undefined = fragmentFor(key).graphql;
      return graphql ? [graphql] : [];
    }),
  );
}
