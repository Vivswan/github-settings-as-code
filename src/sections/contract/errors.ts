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

/**
 * What ends a section's work, as a value. `message` is the whole line the loops report; `kind` is read for policy
 * alone (a denial's partial-success handling in engine/orchestrate.ts), never to rebuild prose.
 *
 *   request kinds (failureFor and the request helpers): rate-limit, rejected, server-error, unauthorized,
 *                  validation, transport, malformed
 *   duplicate kinds (the identity checks): declared-duplicate, live-duplicate
 *   live-shape     -> GitHub's answer parsed but cannot be reconciled (an item without an id, a repeated rule type)
 *   refused        -> the section declines to proceed: the settings file conflicts with live state, an actor cannot
 *                     be resolved, a write would drop live values the file omits
 *   unverified     -> a write landed but its echo disagrees with what was set
 *   thrown         -> an exception escaped a section: the client's own throw on an unmarked request, or a BUG
 *                     invariant; the loops report its message like any other failure
 */
export type SectionFailure =
  | {
      readonly kind: PlainFailureKind;
      readonly message: string;
    }
  | {
      readonly kind: "permission-denied";
      readonly section: string;
      readonly detail: string;
      /** The HTTP status that raised the denial, for the redacted view's safe code. */
      readonly status: number;
      readonly message: string;
    };

/** Every kind but the denial, whose value carries more than a message. */
export type PlainFailureKind =
  | "rate-limit"
  | "rejected"
  | "server-error"
  | "unauthorized"
  | "validation"
  | "transport"
  | "malformed"
  | "declared-duplicate"
  | "live-duplicate"
  | "live-shape"
  | "refused"
  | "unverified"
  | "thrown";

/** A failure of any plain kind; `message` is the whole line, section key first. */
export function sectionFailure(kind: PlainFailureKind, message: string): SectionFailure {
  return { kind, message };
}

/** The value form of an exception a section loop caught; the message is the error's own. */
export function thrown(error: unknown): SectionFailure {
  return { kind: "thrown", message: error instanceof Error ? error.message : String(error) };
}

function permissionDenied(section: string, detail: string, status: number): SectionFailure {
  return { kind: "permission-denied", section, detail, status, message: `${section}: ${detail}` };
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

export function failureFor(
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
): SectionFailure {
  // The operation label says WHAT was being done in settings-file terms; the raw method/path keeps the request identifiable.
  //   creating ruleset "x" failed - POST /repos/...: 422 ...
  //   the token was denied POST /repos/... (creating ruleset "x"): 403 ...
  const request = `${method} ${path}`;
  const outcome = `${error.status} ${error.message}`;
  const cause = `${context?.operation ? `${context.operation} failed - ` : ""}${request}: ${outcome}`;
  const denied = `${request}${context?.operation ? ` (${context.operation})` : ""}: ${outcome}`;
  if (isRateLimitError(error)) {
    // Secondary rate limits arrive as 403 and must not read as missing permissions.
    return {
      kind: "rate-limit",
      message: `${section.key}: ${cause}. The API rate limit was hit; re-run the workflow after the limit resets, or use a token with a higher rate limit`,
    };
  }
  const op = context?.op;
  // Ahead of the permission branch: the status is a denial's, the message is not.
  const rejection = op !== undefined && "route" in op ? definitiveRejection(op, error) : undefined;
  if (rejection !== undefined) {
    return { kind: "rejected", message: `${section.key}: ${cause}. ${sentence(rejection.advice)}` };
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
    return permissionDenied(
      section.key,
      `the token was denied ${denied}${alsoMissing}. To fix, ${grant}${denialHint}`,
      error.status,
    );
  }
  if (error.status >= 500) {
    return {
      kind: "server-error",
      message: `${section.key}: ${cause}. GitHub returned a server error; re-run the workflow, and retry later if it persists`,
    };
  }
  if (error.status === 401) {
    return {
      kind: "unauthorized",
      message: `${section.key}: ${cause}. The token was rejected as invalid or expired; update the token input (or the secret it reads) with a valid, unexpired PAT`,
    };
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
  return {
    kind: "validation",
    message: `${section.key}: ${cause}. The API rejected the request; fix the "${section.key}" values in the settings file to satisfy the message above${hint}${docs}`,
  };
}
