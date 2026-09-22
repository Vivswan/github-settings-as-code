/**
 * The agents_variables e2e mock fragment, minted by the shared variables-family factory in
 * test/e2e/mock/support.ts.
 */

import { agentsVariablesSection } from "../../../../src/sections/agents_variables/index.js";
import { repoVariablesRestHandlers, type SectionRestHandlers } from "../../../e2e/mock/support.js";

export const agentsVariablesMockHandlers: SectionRestHandlers<"agents_variables"> =
  repoVariablesRestHandlers(agentsVariablesSection);
