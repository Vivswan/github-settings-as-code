import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints: "deploy keys list/create/delete",
    notes:
      "matched by title; the declared material is a PUBLIC key; immutable upstream, so changed entries are replaced",
  },
};
