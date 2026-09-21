/**
 * The dependabot_secrets e2e mock fragment, minted by the shared secrets-family factory in
 * test/e2e/mock/support.ts.
 */

import {
  repoSecretsRestHandlers,
  type SectionRestHandlers,
} from "../../../test/e2e/mock/support.js";

export const dependabotSecretsMockHandlers: SectionRestHandlers<"dependabot_secrets"> =
  repoSecretsRestHandlers("dependabot_secrets");
