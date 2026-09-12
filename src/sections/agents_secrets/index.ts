import { repoSecretsSection } from "../shared/repo-secrets.js";

export const agentsSecretsSection = repoSecretsSection({
  key: "agents_secrets",
  resource: "agent_secrets",
  noun: "Copilot agents secret",
});
