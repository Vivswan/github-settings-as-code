/**
 * dependabot_secrets mock fragment: the section's e2e handlers, registered in
 * test/e2e/mock/sections.ts. Imports only the test-tree leaf seams
 * (support.ts, secrets.ts) - the src -> test inversion is deliberate; the
 * bundle entry is src/main.ts, so this file never reaches lib/index.js. The
 * sealed-secret semantics live on the shared helpers (sealedSecretPut/
 * secretsList/secretRemove in support.ts).
 */

import { MOCK_SECRETS_KEY_ID, MOCK_SECRETS_PUBLIC_KEY } from "../../../test/e2e/mock/secrets.js";
import {
  ok,
  type SectionRestHandlers,
  sealedSecretPut,
  secretRemove,
  secretsList,
} from "../../../test/e2e/mock/support.js";

export const dependabotSecretsMockHandlers: SectionRestHandlers<"dependabot_secrets"> = {
  "dependabot_secrets.list": ({ state, query }) => secretsList(state.dependabot_secrets, query),
  "dependabot_secrets.publicKey": () =>
    ok({ key_id: MOCK_SECRETS_KEY_ID, key: MOCK_SECRETS_PUBLIC_KEY }),
  "dependabot_secrets.put": ({ state, param, body }) =>
    sealedSecretPut(
      state,
      state.dependabot_secrets,
      state.dependabot_secret_digests,
      param("secret_name"),
      body,
    ),
  "dependabot_secrets.remove": ({ state, param }) =>
    secretRemove(state.dependabot_secrets, state.dependabot_secret_digests, param("secret_name")),
};
