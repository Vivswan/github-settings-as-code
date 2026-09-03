import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints: "milestones",
    notes:
      "upsert by title; deleting a milestone detaches it from every issue carrying it, which is why keep is the default",
  },
};
