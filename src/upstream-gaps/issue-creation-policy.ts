/**
 * A graphql-schema gap: its SDL extends the pinned @octokit/graphql-schema release before the declared queries are
 * validated against it, so a query may select a field the package does not ship yet. No tripwire type can see a
 * schema, so the file is deleted by hand once graphql-js refuses the extension (./gap.ts).
 */

import { defineGraphqlSchemaGap } from "./gap.js";

/** GitHub shipped the repository issue-creation policy; the pinned @octokit/graphql-schema release predates it. */
export const GAP = defineGraphqlSchemaGap({
  sdl: `
    enum IssueCreationPolicy {
      ALL
      COLLABORATORS_ONLY
    }
    extend type Repository {
      issueCreationPolicy: IssueCreationPolicy
    }
    extend input UpdateRepositoryInput {
      issueCreationPolicy: IssueCreationPolicy
    }
  `,
});
