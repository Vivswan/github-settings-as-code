import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints:
      "actions permissions + selected-actions + workflow token + access level + artifact/log retention + cache limits + OIDC subject claim + fork PR policies",
    notes:
      "keys with their own sub-endpoint route there; everything else rides the base permissions PUT verbatim",
  },
};
