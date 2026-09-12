/** The REST endpoint dictionary both index.ts and graphql-rules.ts derive their plan context type from. */

import type { EndpointDecl } from "../contract/endpoints.js";

// GitHub answers a protection PUT on a missing branch with 404 "Branch not found", the status a
// denied write shares, so the reading rides the denial advice.
const MISSING_BRANCH_HINT =
  'a 404 answering "Branch not found" means the declared branch does not exist on the repo; create the branch, or remove it from the settings file';

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
    denialHint: MISSING_BRANCH_HINT,
    hints: {
      422:
        'Usually a sub-object is missing a required half: "required_status_checks" needs both ' +
        '"strict" and "contexts", "required_pull_request_reviews" values must fit their ' +
        'documented shapes, and "restrictions" needs "users" and "teams" lists (or declare the ' +
        "whole key as null)",
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
  // Advisory: tells a missing branch from an unprotected one after the protection 404. A token
  // without Contents is denied as a 404 "Not Found" too, so only GitHub's "Branch not found" body
  // changes the finding (isMissingBranch in index.ts); without Contents a missing branch surfaces
  // at the PUT instead, which is why Contents stays out of the section's grant prose.
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
