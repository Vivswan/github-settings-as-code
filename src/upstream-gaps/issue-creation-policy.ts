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
