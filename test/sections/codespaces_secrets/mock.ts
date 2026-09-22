/**
 * The codespaces_secrets e2e mock fragment, minted by the shared secrets-family factory in
 * test/e2e/mock/support.ts.
 */

import { repoSecretsRestHandlers, type SectionRestHandlers } from "../../e2e/mock/support.js";

export const codespacesSecretsMockHandlers: SectionRestHandlers<"codespaces_secrets"> =
  repoSecretsRestHandlers("codespaces_secrets");
