import type { ApiError } from "../../github/api.js";
import { isPermissionError, isRateLimitError } from "../../github/api.js";
import { definitiveRejection, type HintableStatus } from "./endpoints.js";
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
 * Graded by the SECTION's need so the fix costs one round trip: apply-mode preflight probes with reads,
 * so read-level advice on a permission the section also writes with (the OIDC GET/PUT pair) would pass
 * preflight and fail on the write. A permission the section only reads with still advises read.
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

/** Outcome and rejection prose is lowercase (it doubles as the declaration's description); in a message it starts a sentence. */
function sentence(clause: string): string {
  return clause.charAt(0).toUpperCase() + clause.slice(1);
}

export function throwFor(
  section: SectionMeta,
  method: string,
  path: string,
  error: ApiError,
  context?: {
    operation?: string;
    /**
     * Supplies the hints and denial hint and resolves the EFFECTIVE permission: an override renders its
     * own grant advice, and a public operation ("none") cannot be a missing-grant failure, so its 403/404
     * takes the generic branch; a GraphQL failure renders `GRAPHQL <opName>` in the method/path slot.
     */
    op?: FailingOp;
  },
): never {
  // The operation label says WHAT was being done in settings-file terms; the raw method/path keeps the request identifiable.
  //   creating ruleset "x" failed - POST /repos/...: 422 ...
  const operation = context?.operation ? `${context.operation} failed - ` : "";
  const cause = `${operation}${method} ${path}: ${error.status} ${error.message}`;
  if (isRateLimitError(error)) {
    // Secondary rate limits arrive as 403 and must not read as missing permissions.
    throw new Error(
      `${section.key}: ${cause}. The API rate limit was hit; re-run the workflow after the limit resets, or use a token with a higher rate limit`,
    );
  }
  const op = context?.op;
  // Ahead of the permission branch: the status is a denial's, the message is not.
  const rejection = op !== undefined && "route" in op ? definitiveRejection(op, error) : undefined;
  if (rejection !== undefined) {
    throw new Error(`${section.key}: ${cause}. ${sentence(rejection.advice)}`);
  }
  const effective = op ? endpointPermission(section, op) : undefined;
  if (isPermissionError(error) && effective !== "none") {
    const alsoMissing =
      error.status === 404 ? " (a 404 here can also mean the resource does not exist)" : "";
    const denialHint = context?.op?.denialHint ? `. Note: ${context.op.denialHint}` : "";
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
  // A GraphQL rejection carries error types, not a status; its declared outcomes stand in for status-keyed hints.
  const advice =
    op === undefined
      ? undefined
      : "outcomes" in op
        ? toleratedGraphqlErrors(op)
            .filter((type) => error.graphqlTypes?.includes(type))
            .map((type) => op.outcomes[type])
            .filter((outcome): outcome is string => outcome !== undefined)
            .map(sentence)
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
