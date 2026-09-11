/**
 * `code_quality_setup:` section - the code quality setup configuration,
 * PATCHed verbatim by the shared setup factory (../shared/setup-section.ts).
 */

import { setupSection } from "../shared/setup-section.js";

export const codeQualitySetupSection = setupSection({
  key: "code_quality_setup",
  permission: { repo: ["administration"] },
  grantCaveat:
    "a 403 on this endpoint can also mean code quality is unavailable on the repository, or the repository is archived",
  noun: "code quality setup",
});
