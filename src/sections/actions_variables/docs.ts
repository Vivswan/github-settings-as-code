import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints: "Actions variables CRUD",
    notes:
      "plain-text variables upserted by name (case-insensitive); values read back in full, so check mode diffs them exactly",
  },
};
