/**
 * The `branches:` REST endpoint dictionary, apart from index.ts because graphql-ops.ts derives its plan context from
 * it too, and the one definitive rejection the section declares: a protection call on a missing branch, whose body
 * no denial spells.
 */

import type { DefinitiveRejection, EndpointDecl } from "../contract/endpoints.js";

/** GitHub's one body for a protection call on a missing branch; no denial spells it (a fine-grained read says "Not Found", a write "Resource not accessible"), so the match is definitive at the PUT here and at index.ts's advisory probe. */
export const MISSING_BRANCH: DefinitiveRejection = {
  status: 404,
  message: "Branch not found",
  advice:
    "the declared branch does not exist on the repo, so its protection cannot be applied; create the branch, or remove it from the settings file",
};

/** The REST endpoint dictionary both index.ts and graphql-ops.ts derive their plan context type from. */
export const ENDPOINTS = {
  // A fine-grained 404 reads as "unprotected", so a denied token surfaces on the first write, not here.
  getProtection: {
    route: "GET /repos/{owner}/{repo}/branches/{branch}/protection",
    statuses: { 200: "the branch protection", 404: "the branch is unprotected or does not exist" },
    primaryRead: { notFound: "absent" },
  },
  putProtection: {
    route: "PUT /repos/{owner}/{repo}/branches/{branch}/protection",
    statuses: { 200: "protection replaced" },
    // Reached for a missing branch only when the advisory probe below was denied.
    rejections: [MISSING_BRANCH],
    // A malformed shape is refused when the file is parsed, so the hint names causes the parser does not refuse.
    hints: {
      422:
        "Usually one of the causes the settings file's own checks do not refuse: users or teams " +
        'under "restrictions" or "dismissal_restrictions" on a repository a personal account ' +
        "owns, more than 100 actors across the actor lists, or " +
        '"required_linear_history" where the repository allows neither squash nor rebase merging',
    },
  },
  removeProtection: {
    route: "DELETE /repos/{owner}/{repo}/branches/{branch}/protection",
    statuses: { 204: "protection removed" },
  },
  // required_signatures lives on its own sub-resource (the protection PUT silently drops the key),
  // so the declared boolean applies through these two calls when it drifts, and again after any planned PUT.
  sigPost: {
    route: "POST /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures",
    statuses: { 200: "signed commits now required" },
  },
  sigDelete: {
    route: "DELETE /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures",
    statuses: { 204: "signed-commit requirement removed" },
  },
  // The snapshot's entry point: every branch a classic rule or a ruleset protects.
  // Contents-gated like the probe below (the same branch family).
  listProtected: {
    route: "GET /repos/{owner}/{repo}/branches",
    statuses: { 200: "the protected branches" },
    permission: { repo: ["contents"] },
  },
  // Advisory: tells a missing branch from an unprotected one after the protection 404. A token
  // without Contents is denied as a 404 "Not Found" too, so only MISSING_BRANCH changes the finding;
  // without Contents a missing branch surfaces at the PUT instead, which is why Contents stays out
  // of the section's grant prose.
  branchProbe: {
    route: "GET /repos/{owner}/{repo}/branches/{branch}",
    statuses: { 200: "the branch exists", 404: "no such branch" },
    permission: { repo: ["contents"] },
    advisory: true,
  },
  // Apps resolve by slug through this PUBLIC endpoint: the GraphQL schema has no app-by-slug lookup
  // (marketplaceListing covers only listed Apps). Caveat: for Apps created before GitHub's global-id
  // migration the REST node_id may still be the legacy format, which the mutation accepts with a
  // deprecation warning in the response extensions; user and team ids resolve through GraphQL.
  appLookup: {
    route: "GET /apps/{app_slug}",
    statuses: { 200: "the GitHub App", 404: "no App with this slug" },
    permission: "none",
    phase: "execution",
  },
} as const satisfies Record<string, EndpointDecl>;
