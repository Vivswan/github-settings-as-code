import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints: "actions secrets list + public-key + sealed PUT + delete",
    notes:
      "`{name, value: $NAME}` sealed writes, re-sent every apply; existence-only checks, values unrecoverable",
  },
};
