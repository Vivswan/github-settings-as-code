/** Error classification: permission denials, rate limits, and rejection advice. */

import type { ApiError } from "../../github/api.js";
import { isPermissionError, isRateLimitError } from "../../github/api.js";
import type { HintableStatus } from "./endpoints.js";
import { toleratedGraphqlErrors } from "./graphql.js";
import {
  endpointPermission,
  type FailingOp,
  type SectionMeta,
  sectionGrant,
  sectionOperations,
} from "./module.js";
import { grantFor, type SectionPermission, samePermission } from "./permissions.js";

export class PermissionDenied extends Error {
  constructor(
    readonly section: string,
    readonly detail: string,
    /** The HTTP status that raised the denial, for the redacted view's safe code. */
    readonly status: number,
  ) {
    super(`${section}: ${detail}`);
  }
}

/**
 * The access level denial advice should ask for on an override permission:
 * "write" when ANY of the section's endpoints or GraphQL operations carrying
 * that same effective permission is write-graded, else "read". Grading by
 * the SECTION's need rather than the failing operation keeps the fix to one
 * round trip: the apply-mode preflight probes with reads, so a read-level
 * advice on a permission the section also writes with (the OIDC GET/PUT
 * pair) would have the user grant read, pass preflight, and then fail again
 * on the write. A permission the section only reads with (the branch-policy
 * list; its write siblings live on a different permission) still advises
 * read.
 */
export function overrideAdviceLevel(
  section: SectionMeta,
  effective: SectionPermission,
): "read" | "write" {
  return sectionOperations(section).some(
    (operation) => samePermission(operation.permission, effective) && operation.grade === "write",
  )
    ? "write"
    : "read";
}

export function throwFor(
  section: SectionMeta,
  method: string,
  path: string,
  error: ApiError,
  context?: {
    operation?: string;
    /**
     * The declaration behind the failing request - a REST EndpointDecl or a
     * GraphqlOpDecl (a GraphQL failure renders `GRAPHQL <opName>` in the
     * method/path slot). Supplies the status hints and denial hint, and
     * resolves the EFFECTIVE permission: an operation with a permission
     * override renders its own grant advice instead of the section's, and a
     * public operation ("none") cannot be a missing-grant failure at all, so
     * its 403/404 takes the generic branch.
     */
    op?: FailingOp;
  },
): never {
  // "creating ruleset "x" failed - POST /repos/...": the operation label says
  // WHAT was being done in settings-file terms; the raw method/path stays so
  // the failing request is still identifiable.
  const operation = context?.operation ? `${context.operation} failed - ` : "";
  const cause = `${operation}${method} ${path}: ${error.status} ${error.message}`;
  if (isRateLimitError(error)) {
    // Includes primary and secondary rate limits delivered as 403; those
    // must not be mistaken for missing permissions.
    throw new Error(
      `${section.key}: ${cause}. The API rate limit was hit; re-run the workflow after the limit resets, or use a token with a higher rate limit`,
    );
  }
  const effective = context?.op ? endpointPermission(section, context.op) : undefined;
  if (isPermissionError(error) && effective !== "none") {
    const alsoMissing =
      error.status === 404 ? " (a 404 here can also mean the resource does not exist)" : "";
    // An operation whose 403/404 is AMBIGUOUS (it can mean something other
    // than a missing grant) says so here, right where the user reads the
    // grant advice.
    const denialHint = context?.op?.denialHint ? `. Note: ${context.op.denialHint}` : "";
    // The section's caveated grant stays the default; only an override naming a structurally
    // DIFFERENT permission re-derives the advice, at the level the SECTION needs on it.
    const grant =
      effective !== undefined && !samePermission(effective, section.permission)
        ? grantFor(effective, undefined, overrideAdviceLevel(section, effective))
        : sectionGrant(section);
    throw new PermissionDenied(
      section.key,
      `the token was denied ${cause}${alsoMissing}. To fix, ${grant}${denialHint}`,
      error.status,
    );
  }
  if (error.status >= 500) {
    throw new Error(
      `${section.key}: ${cause}. GitHub returned a server error; re-run the workflow, and retry later if it persists`,
    );
  }
  if (error.status === 401) {
    throw new Error(
      `${section.key}: ${cause}. The token was rejected as invalid or expired; update the token input (or the secret it reads) with a valid, unexpired PAT`,
    );
  }
  // A GraphQL rejection carries error types instead of a status; the op's
  // declared outcome for each observed type is the same kind of advice as a
  // status-keyed REST hint.
  const op = context?.op;
  const advice =
    op === undefined
      ? undefined
      : "outcomes" in op
        ? toleratedGraphqlErrors(op)
            .filter((type) => error.graphqlTypes?.includes(type))
            .map((type) => op.outcomes[type])
            .filter((outcome): outcome is string => outcome !== undefined)
            // Outcome prose is written lowercase (it doubles as a declaration
            // description); as a sentence after the advice it starts a new one.
            .map((outcome) => outcome.charAt(0).toUpperCase() + outcome.slice(1))
            .join(". ")
        : op.hints?.[error.status as HintableStatus];
  const hint = advice ? `. ${advice}` : "";
  const docs = error.documentationUrl
    ? `. The fields and values this endpoint accepts are documented at ${error.documentationUrl}`
    : "";
  throw new Error(
    `${section.key}: ${cause}. The API rejected the request; fix the "${section.key}" values in the settings file to satisfy the message above${hint}${docs}`,
  );
}
