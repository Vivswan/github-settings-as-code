/**
 * The actions_variables e2e mock fragment, minted by the shared variables-family factory in
 * test/e2e/mock/support.ts.
 */

import {
  repoVariablesRestHandlers,
  type SectionRestHandlers,
} from "../../../test/e2e/mock/support.js";
import { actionsVariablesSection } from "./index.js";

export const actionsVariablesMockHandlers: SectionRestHandlers<"actions_variables"> =
  repoVariablesRestHandlers(actionsVariablesSection);
