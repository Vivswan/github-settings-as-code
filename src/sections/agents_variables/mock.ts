/**
 * The agents_variables e2e mock fragment, minted by the shared variables-family factory in
 * test/e2e/mock/support.ts.
 */

import {
  repoVariablesRestHandlers,
  type SectionRestHandlers,
} from "../../../test/e2e/mock/support.js";
import { agentsVariablesSection } from "./index.js";

export const agentsVariablesMockHandlers: SectionRestHandlers<"agents_variables"> =
  repoVariablesRestHandlers(agentsVariablesSection);
