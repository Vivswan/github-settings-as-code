/**
 * code_scanning_default_setup mock fragment, minted by the setup-family
 * factory in test/e2e/mock/support.ts and registered in test/e2e/mock/sections.ts.
 * The src -> test import is deliberate: src/main.ts never reaches this file.
 */

import { type SectionRestHandlers, setupRestHandlers } from "../../../test/e2e/mock/support.js";

export const codeScanningDefaultSetupMockHandlers: SectionRestHandlers<"code_scanning_default_setup"> =
  setupRestHandlers("code_scanning_default_setup");
