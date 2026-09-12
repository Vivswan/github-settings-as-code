/**
 * The actions_variables e2e mock fragment, minted by the shared variables-family factory in
 * test/e2e/mock/support.ts. It imports the test-tree seams on purpose: the bundle entry is
 * src/main.ts, so this file never reaches lib/index.js.
 */

import {
  repoVariablesRestHandlers,
  type SectionRestHandlers,
} from "../../../test/e2e/mock/support.js";
import { actionsVariablesSection } from "./index.js";

export const actionsVariablesMockHandlers: SectionRestHandlers<"actions_variables"> =
  repoVariablesRestHandlers(actionsVariablesSection);
