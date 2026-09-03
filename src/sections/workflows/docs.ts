import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints: "Actions workflows list, enable/disable",
    notes: "`{path, state: active or disabled}`; bare file names match `.github/workflows/`",
  },
};
