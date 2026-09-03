import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints: "labels CRUD",
    notes: "upsert by name (rename via `new_name`); the delete-by-default is Probot parity",
  },
};
