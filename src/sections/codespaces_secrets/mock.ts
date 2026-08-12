/**
 * codespaces_secrets mock fragment: the section's e2e handlers, registered in
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

export const codespacesSecretsMockHandlers: SectionRestHandlers<"codespaces_secrets"> = {
  "codespaces_secrets.list": ({ state, query }) => secretsList(state.codespaces_secrets, query),
  "codespaces_secrets.publicKey": () =>
    ok({ key_id: MOCK_SECRETS_KEY_ID, key: MOCK_SECRETS_PUBLIC_KEY }),
  "codespaces_secrets.put": ({ state, param, body }) =>
    sealedSecretPut(
      state,
      state.codespaces_secrets,
      state.codespaces_secret_digests,
      param("secret_name"),
      body,
    ),
  "codespaces_secrets.remove": ({ state, param }) =>
    secretRemove(state.codespaces_secrets, state.codespaces_secret_digests, param("secret_name")),
};
