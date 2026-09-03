import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints: "code-quality setup",
    notes:
      "`state`, `languages`, runner and AI-findings options; a 202 means GitHub rolls the change out in a configuration run; needs code quality available on the repository",
  },
};
