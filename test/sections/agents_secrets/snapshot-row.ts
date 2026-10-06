import { agentsSecretsSection } from "../../../src/sections/agents_secrets/index.js";
import { secretsRow } from "../snapshot-row-families.js";

export const row = secretsRow(agentsSecretsSection, "agents", "agents_secrets");
