// The factory and engine behavior stays pinned by the actions_secrets suite over the same repoSecretsSection() factory; this file pins only this
// family's own facts.

import { pinSecretFamily } from "../../../test/sections/secret-family.js";
import { agentsSecretsSection } from "./index.js";

pinSecretFamily({
  section: agentsSecretsSection,
  segment: "agents",
  keyId: "agents-key",
  noun: "Copilot agents secret",
  secretName: "MCP_TOKEN",
});
