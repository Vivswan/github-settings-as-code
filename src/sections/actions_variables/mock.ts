/**
 * actions_variables mock fragment: the section's e2e handlers, minted by the
 * shared variables-family factory (support.ts) and registered in
 * test/e2e/mock/sections.ts. Imports only the test-tree leaf seams - the
 * src -> test inversion is deliberate; the bundle entry is src/main.ts, so
 * this file never reaches lib/index.js.
 */

import {
  repoVariablesRestHandlers,
  type SectionRestHandlers,
} from "../../../test/e2e/mock/support.js";
import { actionsVariablesSection } from "./index.js";

export const actionsVariablesMockHandlers: SectionRestHandlers<"actions_variables"> =
  repoVariablesRestHandlers(actionsVariablesSection);
