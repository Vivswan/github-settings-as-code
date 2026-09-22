/**
 * The actions_variables e2e mock fragment, minted by the shared variables-family factory in
 * test/e2e/mock/support.ts.
 */

import { actionsVariablesSection } from "../../../src/sections/actions_variables/index.js";
import { repoVariablesRestHandlers, type SectionRestHandlers } from "../../e2e/mock/support.js";

export const actionsVariablesMockHandlers: SectionRestHandlers<"actions_variables"> =
  repoVariablesRestHandlers(actionsVariablesSection);
