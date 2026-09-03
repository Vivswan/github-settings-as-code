/**
 * dependabot_secrets section tests: one pinSecretFamily() call carrying this
 * family's own facts (routes, noun, keep-by-default); the shared skeleton
 * and the engine pins live in test/sections/.
 */

import { pinSecretFamily } from "../../../test/sections/secret-family.js";
import { dependabotSecretsSection } from "./index.js";

pinSecretFamily({
  section: dependabotSecretsSection,
  segment: "dependabot",
  keyId: "dep-key",
  noun: "Dependabot secret",
  secretName: "REGISTRY_TOKEN",
});
