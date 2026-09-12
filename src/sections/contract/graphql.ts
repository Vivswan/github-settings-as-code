import type { SectionPermission } from "./permissions.js";

/** GitHub's errors[] entry `type` values, as far as this system models them; the e2e validator's known-type check reads the array. */
export const GRAPHQL_ERROR_TYPES = [
  "FORBIDDEN",
  "INSUFFICIENT_SCOPES",
  "NOT_FOUND",
  "RATE_LIMITED",
  "UNPROCESSABLE",
] as const;

/**
 * RATE_LIMITED is absent on purpose (throttling is a transport concern every operation handles alike),
 * as is INSUFFICIENT_SCOPES (a wrong token; the transport folds it into the 403 class).
 */
const GRAPHQL_TOLERABLE_ERRORS = ["FORBIDDEN", "NOT_FOUND", "UNPROCESSABLE"] as const;

export type GraphqlTolerableError = (typeof GRAPHQL_TOLERABLE_ERRORS)[number];

/**
 * `path` leads from the data root to the connection field (["repository", "branchProtectionRules"]),
 * which must select `nodes { ... }` and `pageInfo { hasNextPage endCursor }`; GraphqlPaginatedReadDecl's
 * query type enforces the `$cursor` variable.
 */
interface GraphqlConnectionDecl {
  readonly path: readonly [string, ...string[]];
}

/**
 * `_variables` is type-only (never set at runtime; covariant, so a concretely typed declaration still
 * erases to the metadata consumers' default) and lets the request helpers type-check call-site variables.
 */
interface GraphqlOpCommon<V extends Record<string, unknown>> {
  /**
   * The wire dispatch key (operationName on every call), globally unique across sections
   * (allGraphqlOps asserts it): the mock and the coverage tripwire address the operation by it without parsing the query.
   */
  readonly name: string;
  /**
   * As EndpointDecl.statuses: "ok" documents the success meaning, and each
   * declared error type is a TOLERATED outcome (tryCallGraphql returns it as
   * { error } instead of throwing).
   */
  readonly outcomes: Readonly<{ ok: string } & Partial<Record<GraphqlTolerableError, string>>>;
  /** As EndpointDecl.permission: "none" means public, omitted means the section's own. */
  readonly permission?: SectionPermission | "none";
  /** Read only by the e2e mock, which exempts advisory reads from its denial barrier; the GraphQL helpers tolerate by declared outcomes alone. */
  readonly advisory?: boolean;
  /**
   * Appended to the PermissionDenied message for an operation whose
   * FORBIDDEN/NOT_FOUND can mean something other than a missing token grant.
   * One sentence, no trailing period.
   */
  readonly denialHint?: string;
  /** GraphQL rejections carry no HTTP status for a hint to key on; the `never` makes declaring one a compile error (see FailingOp). */
  readonly hints?: never;
  /** Type-only marker for `V`; never set at runtime. */
  readonly _variables?: V;
}

/**
 * `kind` is declared, NEVER derived from the POST every GraphQL call shares: it drives the preflight
 * read-only guard, the mock's permission gate, and the fuzz oracle, and the union pins each kind to its
 * operation type, so a mutation declared "read" does not compile. A repo-addressed READ takes $owner/$repo
 * (the mock routes multi-repo reads by them); a mutation addresses its target by node id.
 */
export type GraphqlOpDecl<V extends Record<string, unknown> = Record<string, unknown>> =
  | (GraphqlOpCommon<V> & {
      readonly kind: "read";
      readonly query: `query ${string}`;
      readonly connection?: undefined;
      /** As EndpointDecl.phase: a read only a thunk may issue, at execution. */
      readonly phase?: "execution";
    })
  | GraphqlPaginatedReadDecl<V>
  | (GraphqlOpCommon<V> & {
      readonly kind: "write";
      readonly query: `mutation ${string}`;
      /** Pagination is a read concern. */
      readonly connection?: never;
      readonly phase?: never;
    });

/**
 * A read declaring `connection` MUST take the $cursor variable listGraphqlConnection's loop owns (the
 * template type refuses a cursorless query) and callers must never supply `cursor` (the `?: never` pin).
 * Annotate connection ops with THIS type so the pairing is checked at the declaration.
 */
export type GraphqlPaginatedReadDecl<V extends Record<string, unknown> = Record<string, unknown>> =
  GraphqlOpCommon<V & { cursor?: never }> & {
    readonly kind: "read";
    readonly query: `query ${string}$cursor${string}`;
    readonly connection: GraphqlConnectionDecl;
    readonly phase?: "execution";
  };

/**
 * `V` is spelled explicitly while `const O` infers the LITERAL declaration, so the exact `outcomes` keys
 * and the query's template shape survive instead of widening. That literal type is what lets
 * tryCallGraphql's `tolerate` reject undeclared outcome types at compile time and checks a connection op's $cursor.
 */
export function graphqlOp<V extends Record<string, unknown>>() {
  return <const O extends GraphqlOpDecl<V>>(op: O): O & { readonly _variables?: V } => op;
}

/**
 * Recovered from the `op` argument alone: inferring from the variables argument would let a typo'd call
 * site WIDEN the shape instead of failing. A declaration reached through a widened dictionary
 * (`section.graphql.role`) erases to the permissive default, so helpers must be fed the consts.
 */
export type GraphqlVariablesOf<O extends GraphqlOpDecl> = O extends {
  readonly _variables?: infer V;
}
  ? Extract<V, Record<string, unknown>>
  : Record<string, unknown>;

/** The tolerated outcomes, as toleratedStatuses reads an EndpointDecl; tryCallGraphql defaults to this set. */
export function toleratedGraphqlErrors(op: GraphqlOpDecl): GraphqlTolerableError[] {
  return GRAPHQL_TOLERABLE_ERRORS.filter((type) => op.outcomes[type] !== undefined);
}
