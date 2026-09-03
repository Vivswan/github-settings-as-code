import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints: "repo rulesets CRUD",
    notes:
      "branch, tag, and push targets; short ref names auto-prefixed (`staging` -> `refs/heads/staging`); deletion stays an explicit opt-in",
  },
};
