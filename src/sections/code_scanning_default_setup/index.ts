/**
 * `code_scanning_default_setup:` section: code scanning's default setup through the shared setup factory
 * (shared/setup-section.ts), which PATCHes the declared keys verbatim. Either of two PAT permissions grants it, and
 * a 403 can also mean code security is not enabled on the repository, so the grant advice carries that caveat.
 */

import { setupSection } from "../shared/setup-section.js";

export const codeScanningDefaultSetupSection = setupSection({
  key: "code_scanning_default_setup",
  permission: { repo: ["administration", "code_scanning_alerts"] },
  grantCaveat:
    "a 403 on this endpoint can also mean GitHub Advanced Security (code security) is not enabled on the repository, or the repository is archived",
  noun: "code scanning default setup",
});
