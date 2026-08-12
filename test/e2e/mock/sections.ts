/**
 * The section handler fragments the mock's route pipeline aggregates. Each
 * settings section contributes exactly one fragment - its REST handlers plus,
 * when it declares GraphQL operations, its GraphQL handlers - registered in
 * the FRAGMENTS record below, whose mapped type is keyed by SectionKey: a
 * section without a fragment, a fragment under the wrong key, a missing
 * GraphQL half, or a GraphQL half on a REST-only section all fail to
 * compile. Together with the per-fragment key-union types
 * (SectionRestHandlers/SectionGraphqlHandlers) this makes the merged
 * handler tables complete by construction; the runtime asserts in
 * handlers.ts remain only as backstops. A per-section mock.ts deliberately
 * imports the test-tree seams (this file's siblings support.ts and state.ts,
 * never routes.ts); the bundle entry is src/main.ts, so mock fragments never
 * reach lib/index.js. The merge still asserts key uniqueness loudly, though
 * two fragments claiming the same endpoint can no longer be expressed: every
 * fragment's keys are prefixed with its own section key by type.
 */

import { SECTION_KEYS, type SectionKey } from "../../../src/schema.js";
import { actionsMockHandlers } from "../../../src/sections/actions/mock.js";
import { actionsSecretsMockHandlers } from "../../../src/sections/actions_secrets/mock.js";
import { actionsVariablesMockHandlers } from "../../../src/sections/actions_variables/mock.js";
import { agentsSecretsMockHandlers } from "../../../src/sections/agents_secrets/mock.js";
import { agentsVariablesMockHandlers } from "../../../src/sections/agents_variables/mock.js";
import { autolinksMockHandlers } from "../../../src/sections/autolinks/mock.js";
import {
  branchesMockGraphqlHandlers,
  branchesMockHandlers,
} from "../../../src/sections/branches/mock.js";
import { checkSuitePreferencesMockHandlers } from "../../../src/sections/check_suite_preferences/mock.js";
import { codeQualitySetupMockHandlers } from "../../../src/sections/code_quality_setup/mock.js";
import { codeScanningDefaultSetupMockHandlers } from "../../../src/sections/code_scanning_default_setup/mock.js";
import { codespacesSecretsMockHandlers } from "../../../src/sections/codespaces_secrets/mock.js";
import { collaboratorsMockHandlers } from "../../../src/sections/collaborators/mock.js";
import { customPropertiesMockHandlers } from "../../../src/sections/custom_properties/mock.js";
import { dependabotSecretsMockHandlers } from "../../../src/sections/dependabot_secrets/mock.js";
import { deployKeysMockHandlers } from "../../../src/sections/deploy_keys/mock.js";
import {
  environmentsMockGraphqlHandlers,
  environmentsMockHandlers,
} from "../../../src/sections/environments/mock.js";
import { interactionLimitsMockHandlers } from "../../../src/sections/interaction_limits/mock.js";
import { labelsMockHandlers } from "../../../src/sections/labels/mock.js";
import { milestonesMockHandlers } from "../../../src/sections/milestones/mock.js";
import { pagesMockHandlers } from "../../../src/sections/pages/mock.js";
import type { SectionGraphqlKey } from "../../../src/sections/registry.js";
import {
  repositoryMockGraphqlHandlers,
  repositoryMockHandlers,
} from "../../../src/sections/repository/mock.js";
import { rulesetsMockHandlers } from "../../../src/sections/rulesets/mock.js";
import { secretScanningCustomPatternsMockHandlers } from "../../../src/sections/secret_scanning_custom_patterns/mock.js";
import { teamsMockHandlers } from "../../../src/sections/teams/mock.js";
import { webhooksMockHandlers } from "../../../src/sections/webhooks/mock.js";
import { workflowsMockHandlers } from "../../../src/sections/workflows/mock.js";
import type {
  GraphqlHandler,
  Handler,
  SectionGraphqlHandlers,
  SectionRestHandlers,
} from "./support.js";

/**
 * One section's mock handlers: its REST fragment plus, exactly when the
 * section declares GraphQL operations, its GraphQL fragment. The conditional
 * makes both mispairings unrepresentable: a GraphQL-declaring section cannot
 * omit its GraphQL half, and a REST-only section cannot register one.
 */
type SectionMockFragment<K extends SectionKey> = [SectionGraphqlKey<K>] extends [never]
  ? { rest: SectionRestHandlers<K>; graphql?: never }
  : { rest: SectionRestHandlers<K>; graphql: SectionGraphqlHandlers<K> };

/**
 * The per-section fragments, one entry per SectionKey by mapped type. Reads
 * serve fixture-backed MockState; writes mutate it via the state.ts
 * transformers and reply with a body/status drawn ONLY from the endpoint's
 * declared statuses (a startup check proves every status a handler can
 * return is declared).
 */
const FRAGMENTS: { readonly [K in SectionKey]: SectionMockFragment<K> } = {
  repository: { rest: repositoryMockHandlers, graphql: repositoryMockGraphqlHandlers },
  labels: { rest: labelsMockHandlers },
  rulesets: { rest: rulesetsMockHandlers },
  environments: { rest: environmentsMockHandlers, graphql: environmentsMockGraphqlHandlers },
  branches: { rest: branchesMockHandlers, graphql: branchesMockGraphqlHandlers },
  autolinks: { rest: autolinksMockHandlers },
  actions: { rest: actionsMockHandlers },
  actions_secrets: { rest: actionsSecretsMockHandlers },
  dependabot_secrets: { rest: dependabotSecretsMockHandlers },
  codespaces_secrets: { rest: codespacesSecretsMockHandlers },
  agents_secrets: { rest: agentsSecretsMockHandlers },
  workflows: { rest: workflowsMockHandlers },
  check_suite_preferences: { rest: checkSuitePreferencesMockHandlers },
  pages: { rest: pagesMockHandlers },
  code_scanning_default_setup: { rest: codeScanningDefaultSetupMockHandlers },
  code_quality_setup: { rest: codeQualitySetupMockHandlers },
  collaborators: { rest: collaboratorsMockHandlers },
  teams: { rest: teamsMockHandlers },
  milestones: { rest: milestonesMockHandlers },
  interaction_limits: { rest: interactionLimitsMockHandlers },
  actions_variables: { rest: actionsVariablesMockHandlers },
  agents_variables: { rest: agentsVariablesMockHandlers },
  webhooks: { rest: webhooksMockHandlers },
  custom_properties: { rest: customPropertiesMockHandlers },
  deploy_keys: { rest: deployKeysMockHandlers },
  secret_scanning_custom_patterns: { rest: secretScanningCustomPatternsMockHandlers },
};

/**
 * Merge fragments into one handler table, failing loudly when two fragments
 * register the same "section.role" key. Unreachable by construction now -
 * every fragment's keys are prefixed with its own section key by type, so a
 * collision cannot be expressed - kept as the runtime backstop behind that
 * type-level claim.
 */
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

/** Every section's REST handlers, merged with the duplicate-key backstop. */
export function sectionHandlerFragments(): Record<string, Handler> {
  return mergeFragments(
    "REST",
    SECTION_KEYS.map((key) => FRAGMENTS[key].rest),
  );
}

/** Every section's GraphQL handlers, merged with the duplicate-key backstop. */
export function sectionGraphqlHandlerFragments(): Record<string, GraphqlHandler> {
  return mergeFragments(
    "GraphQL",
    SECTION_KEYS.flatMap((key) => {
      const graphql: Record<string, GraphqlHandler> | undefined = FRAGMENTS[key].graphql;
      return graphql ? [graphql] : [];
    }),
  );
}
