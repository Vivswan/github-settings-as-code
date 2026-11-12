/**
 * `agents_secrets:` section: Copilot agents repository secrets through the shared secrets engine
 * (shared/secrets-and-variables/repo-secrets.ts). GitHub never returns a secret's value, so check mode compares
 * names alone and every declared secret is sealed and sent again on each apply.
 */

import { repoSecretsSection } from "../shared/secrets-and-variables/repo-secrets.js";

export const agentsSecretsSection = repoSecretsSection({
  key: "agents_secrets",
  resource: "agent_secrets",
  noun: "Copilot agents secret",
});
