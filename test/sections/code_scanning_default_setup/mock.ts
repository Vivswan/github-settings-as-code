/**
 * code_scanning_default_setup mock fragment, minted by the setup-family factory in
 * test/e2e/mock/support.ts and registered in test/e2e/mock/sections.ts.
 */

import { type SectionRestHandlers, setupRestHandlers } from "../../e2e/mock/support.js";

export const codeScanningDefaultSetupMockHandlers: SectionRestHandlers<"code_scanning_default_setup"> =
  setupRestHandlers("code_scanning_default_setup");
