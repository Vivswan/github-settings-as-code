/**
 * codespaces_secrets mock fragment: the section's e2e handlers, minted by the
 * shared secrets-family factory (support.ts, where the sealed-secret
 * semantics live) and registered in test/e2e/mock/sections.ts. Imports only
 * the test-tree leaf seams - the src -> test inversion is deliberate; the
 * bundle entry is src/main.ts, so this file never reaches lib/index.js.
 */

import {
  repoSecretsRestHandlers,
  type SectionRestHandlers,
} from "../../../test/e2e/mock/support.js";

export const codespacesSecretsMockHandlers: SectionRestHandlers<"codespaces_secrets"> =
  repoSecretsRestHandlers("codespaces_secrets");
