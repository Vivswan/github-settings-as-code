/**
 * agents_variables mock fragment: the section's e2e handlers, minted by the
 * shared variables-family factory (support.ts) and registered in
 * test/e2e/mock/sections.ts. Imports only the test-tree leaf seams - the
 * src -> test inversion is deliberate; the bundle entry is src/main.ts, so
 * this file never reaches lib/index.js. The Copilot agents variable store
 * mirrors actions_variables exactly: same GET shape, same uppercase-stored
 * names, same page cap read from the endpoint declaration.
 */

import {
  repoVariablesRestHandlers,
  type SectionRestHandlers,
} from "../../../test/e2e/mock/support.js";
import { agentsVariablesSection } from "./index.js";

export const agentsVariablesMockHandlers: SectionRestHandlers<"agents_variables"> =
  repoVariablesRestHandlers(agentsVariablesSection);
