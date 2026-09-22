/**
 * The agents_secrets e2e mock fragment, minted by the shared secrets-family factory in
 * test/e2e/mock/support.ts.
 */

import { repoSecretsRestHandlers, type SectionRestHandlers } from "../../e2e/mock/support.js";

export const agentsSecretsMockHandlers: SectionRestHandlers<"agents_secrets"> =
  repoSecretsRestHandlers("agents_secrets");
