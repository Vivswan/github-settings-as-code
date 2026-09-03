import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints: "dependabot secrets list + public-key + sealed PUT + delete",
    notes: "as `actions_secrets`, over the Dependabot secret store",
  },
};
