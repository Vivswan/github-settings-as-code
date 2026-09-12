import { codespacesSecretsSection } from "../../../src/sections/codespaces_secrets/index.js";
import { secretsRow } from "./families.js";

export const row = secretsRow(codespacesSecretsSection, "codespaces", "codespaces_secrets");
