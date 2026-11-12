/**
 * `code_quality_setup:` section: the repository's code quality configuration through the shared setup factory
 * (shared/setup-section.ts), which PATCHes the declared keys verbatim. A 403 here is not always a missing grant
 * (the feature may be unavailable on the repository), so the grant advice carries that caveat.
 */

import { setupSection } from "../shared/setup-section.js";

export const codeQualitySetupSection = setupSection({
  key: "code_quality_setup",
  permission: { repo: ["administration"] },
  grantCaveat:
    "a 403 on this endpoint can also mean code quality is unavailable on the repository, or the repository is archived",
  noun: "code quality setup",
});
