/** GraphQL operation declarations, the siblings of the REST endpoint declarations. */

import type { SectionPermission } from "./permissions.js";

/**
 * The GraphQL error classes GitHub delivers in an errors[] entry's `type`
 * field, as far as this system models them. The runtime array feeds the e2e
 * validator's known-type check.
 */
export const GRAPHQL_ERROR_TYPES = [
  "FORBIDDEN",
  "INSUFFICIENT_SCOPES",
  "NOT_FOUND",
  "RATE_LIMITED",
  "UNPROCESSABLE",
] as const;

/**
 * The subset of GraphQL error types a section may DECLARE as tolerated
 * outcomes. RATE_LIMITED is deliberately absent (throttling is a transport
 * concern every operation handles identically, never a per-operation
 * outcome), as is INSUFFICIENT_SCOPES (a wrong token, which no section
 * outcome can tolerate; the transport folds it into the 403 class).
 */
const GRAPHQL_TOLERABLE_ERRORS = ["FORBIDDEN", "NOT_FOUND", "UNPROCESSABLE"] as const;

export type GraphqlTolerableError = (typeof GRAPHQL_TOLERABLE_ERRORS)[number];

/**
 * The connection a paginated read walks: `path` leads from the data root to
 * the connection field (e.g. ["repository", "branchProtectionRules"]), which
 * must select `nodes { ... }` and `pageInfo { hasNextPage endCursor }`, and
 * the query must declare a `$cursor` variable feeding the connection's
 * `after` argument (GraphqlPaginatedReadDecl's query type enforces the
 * variable at the declaration).
 */
interface GraphqlConnectionDecl {
  readonly path: readonly [string, ...string[]];
}

/**
 * The facets shared by both kinds of GraphQL operation; see GraphqlOpDecl.
 * `V` is the operation's variables shape, carried by the type-only
 * `_variables` marker (never set at runtime; covariant, so a concretely
 * typed declaration still erases to the metadata consumers' default) so the
 * request helpers type-check call-site variables against the declaration.
 */
interface GraphqlOpCommon<V extends Record<string, unknown>> {
  readonly name: string;
  readonly outcomes: Readonly<{ ok: string } & Partial<Record<GraphqlTolerableError, string>>>;
  /**
   * Overrides the section's permission for this one operation, exactly like
   * EndpointDecl.permission: "none" means public, omitted means the section's
   * own permission applies.
   */
  readonly permission?: SectionPermission | "none";
  /**
   * True for an advisory READ whose non-404 failures are tolerated, mirroring
   * EndpointDecl.advisory (the e2e mock derives its denial-barrier exemption
   * from it).
   */
  readonly advisory?: boolean;
  /**
   * Appended to the PermissionDenied message for an operation whose
   * FORBIDDEN/NOT_FOUND can mean something other than a missing token grant.
   * One sentence, no trailing period.
   */
  readonly denialHint?: string;
  /**
   * Never present: GraphQL rejections carry no HTTP status for a hint to key
   * on, and the `never` makes declaring one a compile error instead of a
   * silently ignored field (see FailingOp).
   */
  readonly hints?: never;
  /** Type-only marker for `V`; never set at runtime. */
  readonly _variables?: V;
}

/**
 * One GraphQL operation a section may issue, the sibling of EndpointDecl.
 * Extends the transport-level GraphqlOp structurally, so a declaration passes
 * straight to GithubClient.tryGraphql.
 *
 * `name` is the wire dispatch key - the operationName sent with every call,
 * globally unique across sections (allGraphqlOps asserts it), which is what
 * lets the mock, the coverage tripwire, and the scenario expectations address
 * the operation without parsing the query. `kind` is declared explicitly and
 * NEVER derived from the POST method every GraphQL call shares: it drives the
 * preflight read-only guard, the mock's permission gate, and the fuzz oracle -
 * and the union pins each kind to its operation type (`query ...` /
 * `mutation ...`), so a mutation declared "read" does not compile. The query
 * is a single named operation whose name equals `name`; a repo-addressed READ
 * must take $owner/$repo variables (the mock routes multi-repo reads by
 * them), and a mutation addresses its target through self-describing node
 * ids. `outcomes` mirrors EndpointDecl.statuses: "ok" documents the success
 * meaning, and each declared error type is a TOLERATED outcome
 * (tryCallGraphql returns it as { error } instead of throwing). Only a read
 * may declare a `connection` (pagination is a read concern), and the
 * paginated arm's query type requires the $cursor variable the loop feeds -
 * a connection op that cannot page does not compile.
 *
 * Declare each operation with the graphqlOp constructor
 * (`const OP = graphqlOp<{owner: string; repo: string}>()({...})`): the
 * curried call carries `V` (via the type-only `_variables` marker) while the
 * `const` type parameter preserves the LITERAL declaration - the query's
 * template shape and the exact `outcomes` keys - so a call site with missing
 * or misnamed variables, or a tolerate naming an undeclared outcome, fails
 * to compile. A declaration reached through a widened dictionary
 * (`section.graphql.role`) erases `V` to the permissive default - the same
 * erasure a widened EndpointDecl record applies to its statuses - so helpers
 * must be fed the consts, not dictionary lookups.
 */
export type GraphqlOpDecl<V extends Record<string, unknown> = Record<string, unknown>> =
  | (GraphqlOpCommon<V> & {
      readonly kind: "read";
      readonly query: `query ${string}`;
      readonly connection?: undefined;
    })
  | GraphqlPaginatedReadDecl<V>
  | (GraphqlOpCommon<V> & {
      readonly kind: "write";
      readonly query: `mutation ${string}`;
      readonly connection?: never;
    });

/**
 * The paginated arm of GraphqlOpDecl: a read declaring a `connection` MUST
 * take the $cursor variable listGraphqlConnection's loop owns (the template
 * type makes a cursorless paginated query uncompilable), and its callers
 * must never supply their own `cursor` (the `?: never` pin on V). Connection
 * ops annotate with THIS type, so the compiler checks the pairing at the
 * declaration.
 */
export type GraphqlPaginatedReadDecl<V extends Record<string, unknown> = Record<string, unknown>> =
  GraphqlOpCommon<V & { cursor?: never }> & {
    readonly kind: "read";
    readonly query: `query ${string}$cursor${string}`;
    readonly connection: GraphqlConnectionDecl;
  };

/**
 * The curried declaration constructor for GraphQL operations: `V` is spelled
 * explicitly while `const O` infers the LITERAL declaration type, so the
 * exact `outcomes` keys and the query's template shape survive into the
 * declared const instead of widening to the Partial record an annotated
 * const erases to. That literal type is what lets tryCallGraphql's
 * `tolerate` reject undeclared outcome types at compile time (the REST
 * `as const satisfies` symmetry) and what checks a connection op's $cursor
 * at its declaration.
 */
export function graphqlOp<V extends Record<string, unknown>>() {
  return <const O extends GraphqlOpDecl<V>>(op: O): O & { readonly _variables?: V } => op;
}

/**
 * The variables shape a declaration carries (via the `_variables` marker),
 * recovered from the concrete declaration type so the request helpers infer
 * it from the `op` argument alone - inferring from the variables argument
 * would let a typo'd call site WIDEN the shape instead of failing.
 */
export type GraphqlVariablesOf<O extends GraphqlOpDecl> = O extends {
  readonly _variables?: infer V;
}
  ? Extract<V, Record<string, unknown>>
  : Record<string, unknown>;

/**
 * The declared error types of a GraphQL operation - its tolerated outcomes,
 * exactly as toleratedStatuses reads an EndpointDecl's tolerable statuses.
 * The declaration is the single source; tryCallGraphql defaults to this set.
 */
export function toleratedGraphqlErrors(op: GraphqlOpDecl): GraphqlTolerableError[] {
  return GRAPHQL_TOLERABLE_ERRORS.filter((type) => op.outcomes[type] !== undefined);
}
