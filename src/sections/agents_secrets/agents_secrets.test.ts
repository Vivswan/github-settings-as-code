/**
 * agents_secrets section tests: one pinSecretFamily() call carrying this
 * family's own facts (routes, noun, keep-by-default); the shared skeleton
 * and the engine pins live in test/sections/. The factory and engine
 * behavior (reconciliation verbs, sealing, the resolver contract, hostile
 * values, key validation) stays pinned by the actions_secrets suite over
 * the same repoSecretsSection() factory.
 */

import { pinSecretFamily } from "../../../test/sections/secret-family.js";
import { agentsSecretsSection } from "./index.js";

pinSecretFamily({
  section: agentsSecretsSection,
  segment: "agents",
  keyId: "agents-key",
  noun: "Copilot agents secret",
  secretName: "MCP_TOKEN",
});
