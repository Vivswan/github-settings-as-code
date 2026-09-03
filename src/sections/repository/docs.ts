import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints:
      "PATCH repo, PUT topics, vulnerability-alerts, automated-security-fixes, private-vulnerability-reporting, lfs, immutable-releases, GraphQL RepositoryFeatures + UpdateRepositoryFeatures",
    notes:
      "Probot repository payload plus `enable_*` feature toggles; `topics` as string or list; `enable_sponsorships` and `issue_creation_policy` (`all`/`collaborators_only`) route through GraphQL - REST has no surface for them; declared fields only, undeclared siblings untouched",
  },
};
