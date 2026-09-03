import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints: "hooks CRUD + hook config sub-endpoint",
    notes:
      "one hook per `config.url`, the natural key; `config.secret` takes a `$NAME` reference and is re-sent every run",
  },
};
