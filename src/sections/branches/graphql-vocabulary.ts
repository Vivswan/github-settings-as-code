/**
 * test/sections/graphql-queries.test.ts asserts the rules query selects every twin, and the e2e
 * mock imports these tables to project stored REST state into rule nodes, so the two views cannot drift.
 */

import type { MustBeNever } from "../../types.js";
import type { BooleanControl } from "./keys.js";
import type { BranchProtectionConfig } from "./schema.js";

export const GRAPHQL_BOOLEAN_TWINS = {
  enforce_admins: "isAdminEnforced",
  required_linear_history: "requiresLinearHistory",
  allow_force_pushes: "allowsForcePushes",
  allow_deletions: "allowsDeletions",
  block_creations: "blocksCreations",
  required_conversation_resolution: "requiresConversationResolution",
  lock_branch: "lockBranch",
  allow_fork_syncing: "lockAllowsFetchAndMerge",
  required_signatures: "requiresCommitSignatures",
} as const satisfies Record<BooleanControl, string>;

export const GRAPHQL_REVIEW_TWINS = {
  required_approving_review_count: "requiredApprovingReviewCount",
  require_code_owner_reviews: "requiresCodeOwnerReviews",
  dismiss_stale_reviews: "dismissesStaleReviews",
  require_last_push_approval: "requireLastPushApproval",
} as const;

export const GRAPHQL_STATUS_CHECK_TWINS = {
  strict: "requiresStrictStatusChecks",
  contexts: "requiredStatusCheckContexts",
} as const;

/**
 * The keys no REST protection endpoint carries: they ride the updateBranchProtectionRule mutation
 * alone. The ONE spelling; the routed types, the guard, the drift, and the snapshot derive from it.
 */
export const ROUTED_KEYS = [
  "force_push_bypassers",
  "required_deployments",
] as const satisfies readonly (keyof BranchProtectionConfig)[];

export type RoutedKey = (typeof ROUTED_KEYS)[number];

export const ROUTED_KEY_SET: ReadonlySet<string> = new Set(ROUTED_KEYS);

/** The keys the schema names beside the index signature (a looseObject's keyof is every string). */
export type ExplicitKeys<T> = keyof {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K];
};

/**
 * Every key the schema spells out is a routed key, the signatures toggle (its own REST sub-endpoint),
 * or a REST-carried control the schema types for its parse-time rules; a new explicit key fails here
 * until it is sorted into ROUTED_KEYS or named as REST-carried.
 */
export type RestCarriedKey =
  | "required_status_checks"
  | "required_pull_request_reviews"
  | "restrictions";

type _RoutedKeysCoverSchema = MustBeNever<
  Exclude<ExplicitKeys<BranchProtectionConfig>, RoutedKey | RestCarriedKey | "required_signatures">
>;

export const WILDCARD_KEYS = [
  ...Object.keys(GRAPHQL_BOOLEAN_TWINS),
  "required_status_checks",
  "required_pull_request_reviews",
  ...ROUTED_KEYS,
] as const;

export const WILDCARD_KEY_SET: ReadonlySet<string> = new Set(WILDCARD_KEYS);

/** A protection declaring at least one routed key (null counts: it turns required_deployments off). */
export type RoutedProtection = BranchProtectionConfig &
  { [K in RoutedKey]: { [P in K]: Exclude<BranchProtectionConfig[P], undefined> } }[RoutedKey];

/** A protection the REST PUT (plus the signatures sub-endpoint) carries whole. */
export type RestOnlyProtection = BranchProtectionConfig & { [K in RoutedKey]?: undefined };

/**
 * The guard's parameter is this union, not BranchProtectionConfig: a guard narrows its false branch
 * only against a union, and BranchProtectionConfig assigns to it, so the caller binds a protection to
 * this type once and both arms come out narrowed (index.ts classifies entries that way).
 */
export type SplitProtection = RestOnlyProtection | RoutedProtection;

export function hasRoutedGraphqlKeys(
  protection: SplitProtection | null,
): protection is RoutedProtection {
  return protection !== null && ROUTED_KEYS.some((key) => protection[key] !== undefined);
}
