/**
 * The actions_secrets e2e mock fragment, minted by the shared secrets-family factory in
 * test/e2e/mock/support.ts.
 */

import {
  repoSecretsRestHandlers,
  type SectionRestHandlers,
} from "../../../test/e2e/mock/support.js";

export const actionsSecretsMockHandlers: SectionRestHandlers<"actions_secrets"> =
  repoSecretsRestHandlers("actions_secrets");
