/**
 * The codespaces_secrets e2e mock fragment, minted by the shared secrets-family factory in
 * test/e2e/mock/support.ts. It imports the test-tree seams on purpose: the bundle entry is
 * src/main.ts, so this file never reaches lib/index.js.
 */

import {
  repoSecretsRestHandlers,
  type SectionRestHandlers,
} from "../../../test/e2e/mock/support.js";

export const codespacesSecretsMockHandlers: SectionRestHandlers<"codespaces_secrets"> =
  repoSecretsRestHandlers("codespaces_secrets");
