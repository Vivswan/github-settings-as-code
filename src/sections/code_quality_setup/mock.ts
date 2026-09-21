/**
 * code_quality_setup mock fragment, minted by the setup-family factory in test/e2e/mock/support.ts
 * and registered in test/e2e/mock/sections.ts.
 */

import { type SectionRestHandlers, setupRestHandlers } from "../../../test/e2e/mock/support.js";

export const codeQualitySetupMockHandlers: SectionRestHandlers<"code_quality_setup"> =
  setupRestHandlers("code_quality_setup");
