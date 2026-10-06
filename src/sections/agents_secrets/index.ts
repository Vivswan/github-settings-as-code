import { repoSecretsSection } from "../shared/secrets-and-variables/repo-secrets.js";

export const agentsSecretsSection = repoSecretsSection({
  key: "agents_secrets",
  resource: "agent_secrets",
  noun: "Copilot agents secret",
});
