import { actionsSecretsSection } from "../../../src/sections/actions_secrets/index.js";
import { secretsRow } from "../snapshot-row-families.js";

export const row = secretsRow(actionsSecretsSection, "actions", "actions_secrets");
