// This family's own facts only; the shared skeleton and the engine pins live in test/sections/.

import { pinSecretFamily } from "../../../test/sections/secret-family.js";
import { dependabotSecretsSection } from "./index.js";

pinSecretFamily({
  section: dependabotSecretsSection,
  segment: "dependabot",
  keyId: "dep-key",
  noun: "Dependabot secret",
  secretName: "REGISTRY_TOKEN",
});
