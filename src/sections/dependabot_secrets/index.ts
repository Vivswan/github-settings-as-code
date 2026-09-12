import { repoSecretsSection } from "../shared/repo-secrets.js";

export const dependabotSecretsSection = repoSecretsSection({
  key: "dependabot_secrets",
  resource: "dependabot_secrets",
  noun: "Dependabot secret",
});
