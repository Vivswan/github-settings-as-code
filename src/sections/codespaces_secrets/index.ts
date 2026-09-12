/**
 * `codespaces_secrets:` section: repository Codespaces secrets through the shared secrets engine
 * (shared/repo-secrets.ts). The fine-grained "Codespaces secrets" permission gates every endpoint
 * here at WRITE on real GitHub, reads included, so both GETs declare accessGrade "write" and a
 * read-only grant fails the list exactly like a missing one.
 */

import { repoSecretsSection } from "../shared/repo-secrets.js";

export const codespacesSecretsSection = repoSecretsSection({
  key: "codespaces_secrets",
  resource: "codespaces_secrets",
  noun: "Codespaces secret",
  accessGrade: "write",
});
