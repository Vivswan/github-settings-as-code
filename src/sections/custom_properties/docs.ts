import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints: "GET/PATCH properties/values; probes GET /orgs/{owner}",
    notes:
      "values of org-defined properties (definitions are org-scoped); org repos only, skipped with a notice on personal accounts; `value: null` unsets",
  },
};
