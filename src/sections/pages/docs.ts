import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints: "POST/PUT/DELETE pages",
    notes:
      "`build_type: workflow` or `legacy` + source, `cname`, `https_enforced`, `public` (GHEC site visibility); `pages: null` disables the site",
  },
};
