import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints:
      "classic branch protection + required-signatures sub-endpoint + app-by-slug actor lookup + GraphQL BranchProtectionRules + BranchProtectionRepository + BranchProtectionActorUser + BranchProtectionActorTeam + CreateBranchProtectionRule + UpdateBranchProtectionRule + DeleteBranchProtectionRule",
    notes:
      "`protection: null` removes protection; the protection PUT drops `required_signatures`, so declare it on any branch already carrying it; `force_push_bypassers` (users, `org/team`, `app/slug`) and `required_deployments` ride the GraphQL rule mutation; wildcard entries (`release/*`) reconcile entirely through GraphQL with a fixed key set; add Contents: read so check mode can tell a missing branch from an unprotected one",
  },
};
