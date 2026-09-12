import { setupSection } from "../shared/setup-section.js";

export const codeScanningDefaultSetupSection = setupSection({
  key: "code_scanning_default_setup",
  permission: { repo: ["administration", "code_scanning_alerts"] },
  grantCaveat:
    "a 403 on this endpoint can also mean GitHub Advanced Security (code security) is not enabled on the repository, or the repository is archived",
  noun: "code scanning default setup",
});
