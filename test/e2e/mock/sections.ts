/**
 * The section handler fragments the mock's route pipeline aggregates. Each
 * settings section contributes one REST fragment (and, when it declares
 * GraphQL operations, one GraphQL fragment): a record of "section.role" keys
 * to handlers. During the per-section directory migration the fragments of
 * every not-yet-moved section live in the two UNMOVED_* tables below; a moved
 * section carves its entries out into src/sections/<key>/mock.ts and adds one
 * import plus one FRAGMENTS entry here. A per-section mock.ts deliberately
 * imports the test-tree seams (this file's siblings support.ts and state.ts,
 * never routes.ts); the bundle entry is src/main.ts, so mock fragments never
 * reach lib/index.js. The merge asserts key uniqueness loudly, so two
 * fragments claiming the same endpoint fail at construction, and
 * assertHandlerCompleteness (routes.ts) keeps the merged table in lockstep
 * with the endpoint declarations exactly as before.
 */

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

import {
  repositoryMockGraphqlHandlers,
  repositoryMockHandlers,
} from "../../../src/sections/repository/mock.js";
import { rulesetsMockHandlers } from "../../../src/sections/rulesets/mock.js";
import { secretScanningCustomPatternsMockHandlers } from "../../../src/sections/secret_scanning_custom_patterns/mock.js";
import { teamsMockHandlers } from "../../../src/sections/teams/mock.js";
import { webhooksMockHandlers } from "../../../src/sections/webhooks/mock.js";
import { workflowsMockHandlers } from "../../../src/sections/workflows/mock.js";
import type { GraphqlHandler, Handler } from "./support.js";

// --- Per-endpoint handlers ------------------------------------------------
//
// One entry per "section.role" key in allEndpoints(). Reads serve
// fixture-backed MockState; writes mutate it via the state.ts transformers and
// reply with a body/status drawn ONLY from the endpoint's declared statuses
// (a startup check proves every status a handler can return is declared).

const UNMOVED_SECTION_HANDLERS: Record<string, Handler> = {
  // labels: moved to src/sections/labels/mock.ts
  // repository: moved to src/sections/repository/mock.ts
  // autolinks: moved to src/sections/autolinks/mock.ts
  // environments: moved to src/sections/environments/mock.ts
  // pages: moved to src/sections/pages/mock.ts
  // actions: moved to src/sections/actions/mock.ts
  // workflows: moved to src/sections/workflows/mock.ts
  // interaction_limits: moved to src/sections/interaction_limits/mock.ts
  // collaborators: moved to src/sections/collaborators/mock.ts
  // teams: moved to src/sections/teams/mock.ts
  // milestones: moved to src/sections/milestones/mock.ts
  // custom_properties: moved to src/sections/custom_properties/mock.ts
  // webhooks: moved to src/sections/webhooks/mock.ts
  // deploy_keys: moved to src/sections/deploy_keys/mock.ts
};

// --- GraphQL operations -----------------------------------------------------
//
// The GraphQL sibling of the REST handler table. Dispatch is by operationName
// (the globally-unique wire key allGraphqlOps() asserts), never by parsing the
// query text. A handler answers ONLY the two shapes GitHub's GraphQL endpoint
// can produce for a declared operation: a 200 with a data object, or a 200
// with data:null plus errors[] whose every type the operation DECLARES as a
// tolerated outcome - the status-subset guard's analog, enforced by the
// pipeline after every handler, and deliberately STRICTER than REST's
// undeclared->=400 realism allowance: an undeclared error type would drive
// tolerance semantics the declaration never promised.

/**
 * One entry per "section.role" key in allGraphqlOps(), exactly like HANDLERS.
 * The completeness assertion below keeps it in lockstep with the declarations.
 * The pin family models VERIFIED live GitHub position semantics: a new pin
 * appends at a monotonic counter, unpinning leaves a hole (no renumbering),
 * and only the reorder mutation renormalizes the list to contiguous 1..N.
 */
const UNMOVED_SECTION_GRAPHQL_HANDLERS: Record<string, GraphqlHandler> = {
  // environments: moved to src/sections/environments/mock.ts (the last
  // GraphQL-bearing section in this table; it empties as sections migrate)
};

/**
 * One section's mock handlers: its REST fragment plus, when the section
 * declares GraphQL operations, its GraphQL fragment - paired structurally so
 * a section registers once and cannot forget one half.
 */
interface SectionMockFragment {
  rest: Record<string, Handler>;
  graphql?: Record<string, GraphqlHandler>;
}

/**
 * The per-section fragments, in registration order: one entry per moved
 * section (imported from its src/sections/<key>/mock.ts) plus the UNMOVED_*
 * tables carrying every section not yet migrated.
 */
const FRAGMENTS: readonly SectionMockFragment[] = [
  { rest: actionsMockHandlers },
  { rest: actionsSecretsMockHandlers },
  { rest: actionsVariablesMockHandlers },
  { rest: agentsSecretsMockHandlers },
  { rest: agentsVariablesMockHandlers },
  { rest: autolinksMockHandlers },
  { rest: branchesMockHandlers, graphql: branchesMockGraphqlHandlers },
  { rest: checkSuitePreferencesMockHandlers },
  { rest: codeQualitySetupMockHandlers },
  { rest: codeScanningDefaultSetupMockHandlers },
  { rest: codespacesSecretsMockHandlers },
  { rest: collaboratorsMockHandlers },
  { rest: customPropertiesMockHandlers },
  { rest: dependabotSecretsMockHandlers },
  { rest: deployKeysMockHandlers },
  { rest: environmentsMockHandlers, graphql: environmentsMockGraphqlHandlers },
  { rest: interactionLimitsMockHandlers },
  { rest: labelsMockHandlers },
  { rest: milestonesMockHandlers },
  { rest: pagesMockHandlers },
  { rest: repositoryMockHandlers, graphql: repositoryMockGraphqlHandlers },
  { rest: rulesetsMockHandlers },
  { rest: secretScanningCustomPatternsMockHandlers },
  { rest: teamsMockHandlers },
  { rest: webhooksMockHandlers },
  { rest: workflowsMockHandlers },
  { rest: UNMOVED_SECTION_HANDLERS, graphql: UNMOVED_SECTION_GRAPHQL_HANDLERS },
];

/**
 * Merge fragments into one handler table, failing loudly when two fragments
 * register the same "section.role" key: a duplicate would let one section's
 * mock silently shadow another's, so it is a construction-time error naming
 * every offending key.
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

/** Every section's REST handlers, merged with the duplicate-key assert. */
export function sectionHandlerFragments(): Record<string, Handler> {
  return mergeFragments(
    "REST",
    FRAGMENTS.map((fragment) => fragment.rest),
  );
}

/** Every section's GraphQL handlers, merged with the duplicate-key assert. */
export function sectionGraphqlHandlerFragments(): Record<string, GraphqlHandler> {
  return mergeFragments(
    "GraphQL",
    FRAGMENTS.flatMap((fragment) => (fragment.graphql ? [fragment.graphql] : [])),
  );
}
