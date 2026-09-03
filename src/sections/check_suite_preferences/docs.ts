import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints: "check-suites preferences PATCH (no read endpoint exists upstream)",
    notes:
      "per-app `auto_trigger_checks` toggles; write-only: check mode cannot verify them (one note, zero requests) and apply re-asserts them every run; the token owner must be a repository administrator",
  },
};
