import { repoSecretsSection } from "../shared/repo-secrets.js";

export const actionsSecretsSection = repoSecretsSection({
  key: "actions_secrets",
  resource: "secrets",
  noun: "Actions secret",
});
