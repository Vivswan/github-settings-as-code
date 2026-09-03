import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints: "interaction-limits + pulls creation-cap/bypass-list",
    notes:
      "re-arms the self-expiring limit every apply run; `null` clears it (base limit only); a 409 (org/user-level limit overrides) becomes a note; the PR creation cap is persistent (PATCHed only on divergence, 405 where unavailable) and its bypass logins reconcile add/remove",
  },
};
