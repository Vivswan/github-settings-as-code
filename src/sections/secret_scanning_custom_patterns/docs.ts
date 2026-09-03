import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints:
      "secret-scanning custom patterns: paginated list + bulk POST + PATCH by id + bulk DELETE",
    notes:
      "matched by name (immutable upstream); `state` and `push_protection_enabled` are not declarable; deletes always resolve alerts",
  },
};
