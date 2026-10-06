import { dependabotSecretsSection } from "../../../src/sections/dependabot_secrets/index.js";
import { secretsRow } from "../snapshot-row-families.js";

export const row = secretsRow(dependabotSecretsSection, "dependabot", "dependabot_secrets");
