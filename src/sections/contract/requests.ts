/** Declaration-driven request helpers: REST and GraphQL calls, probes, and page loops. */

import type { ApiError } from "../../github/api.js";
import { paginate } from "../../github/paginate.js";
import {
  type EndpointDecl,
  endpointMethod,
  expand,
  type PathParams,
  toleratedStatuses,
} from "./endpoints.js";
import { throwFor } from "./errors.js";
import {
  type GraphqlOpDecl,
  type GraphqlPaginatedReadDecl,
  type GraphqlTolerableError,
  type GraphqlVariablesOf,
  toleratedGraphqlErrors,
} from "./graphql.js";
import type { SectionContext, SectionMeta } from "./module.js";

/**
 * The trailing options argument for a request helper, whose optionality
 * depends on the route. When the route has no path params (owner/repo
 * aside), the options object is optional and `params` is forbidden. When
 * the route has params, the options object is REQUIRED and must carry
 * `params` with exactly the route's keys. Modeling this as a rest tuple
 * (not an optional object param) is what makes omitting the whole argument
 * a compile error for a route that needs params - the `[never]` trick alone
 * cannot forbid an omitted argument. `Extra` carries per-helper extras
 * (query/payload/tolerate/accept).
 */
export type OptsArg<E extends EndpointDecl, Extra> = [PathParams<E["route"]>] extends [never]
  ? [opts?: { params?: undefined } & Extra]
  : [opts: { params: Readonly<Record<PathParams<E["route"]>, string>> } & Extra];

/**
 * Call the API; convert permission failures into PermissionDenied (handled
 * by the orchestrator's partial-success policy), everything else into a
 * hard error carrying the API's message verbatim. The path is built from
 * the endpoint declaration, so a section can only ever call what it
 * declares, with exactly the params the route requires.
 */
export async function call<E extends EndpointDecl>(
  ctx: SectionContext,
  section: SectionMeta,
  endpoint: E,
  ...args: OptsArg<
    E,
    { query?: Readonly<Record<string, string>>; payload?: unknown; describe?: string }
  >
): Promise<unknown> {
  const opts = args[0];
  const method = endpointMethod(endpoint.route);
  const path = expand(endpoint, ctx, opts?.params, opts?.query);
  const result = await ctx.api.tryRequest(method, path, opts?.payload);
  if ("error" in result) {
    throwFor(section, method, path, result.error, {
      operation: opts?.describe,
      op: endpoint,
    });
  }
  return result.data;
}

/**
 * Like call(), but tolerated error statuses come back as { error } for the
 * caller to interpret (e.g. a 409 that means "drift" or "in progress", not
 * failure); every other error classifies through throwFor. Tolerated
 * statuses default to the endpoint's declared >= 400 statuses; pass an
 * explicit `tolerate` only to tolerate FEWER than declared.
 */
export async function tryCall<E extends EndpointDecl>(
  ctx: SectionContext,
  section: SectionMeta,
  endpoint: E,
  ...args: OptsArg<
    E,
    {
      query?: Readonly<Record<string, string>>;
      payload?: unknown;
      tolerate?: readonly (keyof E["statuses"] & number)[];
      describe?: string;
    }
  >
): Promise<{ data: unknown } | { error: ApiError }> {
  const opts = args[0];
  const method = endpointMethod(endpoint.route);
  const path = expand(endpoint, ctx, opts?.params, opts?.query);
  const tolerate: readonly number[] = opts?.tolerate ?? toleratedStatuses(endpoint);
  const result = await ctx.api.tryRequest(method, path, opts?.payload);
  if ("error" in result && !tolerate.includes(result.error.status)) {
    throwFor(section, method, path, result.error, {
      operation: opts?.describe,
      op: endpoint,
    });
  }
  return result;
}

/**
 * GET a resource whose absence is a normal state: tolerated statuses come
 * back as { missing: true }, every other error classifies through throwFor.
 * The shared idiom behind "does this branch/site/environment/toggle exist"
 * probes. Tolerated statuses default to the endpoint's declared >= 400
 * statuses; pass an explicit `tolerate` only to tolerate FEWER than declared.
 */
export async function probeAbsent<E extends EndpointDecl>(
  ctx: SectionContext,
  section: SectionMeta,
  endpoint: E,
  ...args: OptsArg<
    E,
    {
      query?: Readonly<Record<string, string>>;
      tolerate?: readonly (keyof E["statuses"] & number)[];
      accept?: string;
      describe?: string;
    }
  >
): Promise<{ data: unknown } | { missing: true }> {
  const options = args[0];
  const path = expand(endpoint, ctx, options?.params, options?.query);
  const tolerate: readonly number[] = options?.tolerate ?? toleratedStatuses(endpoint);
  const result = await ctx.api.tryRequest("GET", path, undefined, { accept: options?.accept });
  if ("error" in result) {
    if (tolerate.includes(result.error.status)) {
      return { missing: true };
    }
    throwFor(section, "GET", path, result.error, {
      operation: options?.describe,
      op: endpoint,
    });
  }
  return { data: result.data };
}

/**
 * Section-flavored pagination: delegate the page loop to github/paginate,
 * classify errors through throwFor; `extract` adapts the response shape
 * (bare array, or a {total_count, <key>: []} envelope).
 */
async function listPages(
  ctx: SectionContext,
  section: SectionMeta,
  endpoint: EndpointDecl,
  path: string,
  extract: (data: unknown) => unknown[] | null,
  shape: string,
): Promise<unknown[]> {
  const result = await paginate(ctx.api, path, extract, undefined, endpoint.pageSize);
  if ("error" in result) {
    throwFor(section, "GET", path, result.error, { op: endpoint });
  }
  if ("malformed" in result) {
    throw new Error(
      `${section.key}: GET ${path} returned a JSON value without ${shape}, so the response cannot be paginated. Check the "api-version" input against the GitHub REST docs for this endpoint`,
    );
  }
  return result.items;
}

/** GET every page of a bare-array list endpoint. */
export async function listAll<E extends EndpointDecl>(
  ctx: SectionContext,
  section: SectionMeta,
  endpoint: E,
  ...args: OptsArg<E, { query?: Readonly<Record<string, string>> }>
): Promise<unknown[]> {
  const opts = args[0];
  const path = expand(endpoint, ctx, opts?.params, opts?.query);
  return listPages(
    ctx,
    section,
    endpoint,
    path,
    (data) => (Array.isArray(data) ? data : null),
    "a list",
  );
}

/**
 * Like listAll, for endpoints that wrap the list in an envelope object
 * (e.g. GET /actions/workflows returns {total_count, workflows: []}).
 */
export async function listAllEnveloped<E extends EndpointDecl>(
  ctx: SectionContext,
  section: SectionMeta,
  endpoint: E,
  envelopeKey: string,
  ...args: OptsArg<E, { query?: Readonly<Record<string, string>> }>
): Promise<unknown[]> {
  const opts = args[0];
  const path = expand(endpoint, ctx, opts?.params, opts?.query);
  return listPages(
    ctx,
    section,
    endpoint,
    path,
    (data) => {
      const chunk = (data as Record<string, unknown> | null)?.[envelopeKey];
      return Array.isArray(chunk) ? chunk : null;
    },
    `a "${envelopeKey}" list`,
  );
}

/**
 * Issue a GraphQL operation; convert permission failures into
 * PermissionDenied, everything else into a hard error carrying the API's
 * message - the GraphQL sibling of call(). The failing request renders as
 * `GRAPHQL <opName>` where a REST error shows its method and path. The
 * variables are typed by the declaration's own `V`, so a call site cannot
 * omit or misname what the query expects.
 */
export async function callGraphql<O extends GraphqlOpDecl>(
  ctx: SectionContext,
  section: SectionMeta,
  op: O,
  variables: Readonly<GraphqlVariablesOf<O>>,
  opts?: { describe?: string },
): Promise<Record<string, unknown>> {
  const result = await ctx.api.tryGraphql(op, variables, ctx.repo.slug);
  if ("error" in result) {
    throwFor(section, "GRAPHQL", op.name, result.error, { operation: opts?.describe, op });
  }
  return result.data;
}

/**
 * Whether an ApiError is tolerable under a set of declared error types: it
 * must carry the transport's graphqlTypes (an untyped or HTTP-level failure
 * is never tolerable) and EVERY observed type must be declared - the HTTP
 * status is a lossy fold (a mixed [FORBIDDEN, UNPROCESSABLE] response and a
 * pure FORBIDDEN both land on 403), so only the full type set can say what
 * actually happened. RATE_LIMITED and INSUFFICIENT_SCOPES can never appear
 * in `tolerate` (the type excludes them), so both always classify through
 * throwFor.
 */
function graphqlErrorTolerated(
  error: ApiError,
  tolerate: readonly GraphqlTolerableError[],
): boolean {
  const observed = error.graphqlTypes;
  return (
    observed !== undefined &&
    observed.length > 0 &&
    observed.every((type) => (tolerate as readonly string[]).includes(type))
  );
}

/**
 * Like callGraphql, but tolerated error types come back as { error } for the
 * caller to interpret; every other error classifies through throwFor. The
 * tolerated set defaults to the operation's declared error outcomes; pass an
 * explicit `tolerate` only to tolerate FEWER than declared. Tolerance reads
 * the error's OBSERVED GraphQL types (see graphqlErrorTolerated), never the
 * folded HTTP status.
 */
export async function tryCallGraphql<O extends GraphqlOpDecl>(
  ctx: SectionContext,
  section: SectionMeta,
  op: O,
  variables: Readonly<GraphqlVariablesOf<O>>,
  opts?: {
    // The graphqlOp constructor preserves the literal `outcomes` keys, so
    // this keyof pins the DECLARED subset at compile time: a tolerate
    // naming an undeclared type does not compile (the REST
    // `as const satisfies` symmetry).
    tolerate?: readonly (keyof O["outcomes"] & GraphqlTolerableError)[];
    describe?: string;
  },
): Promise<{ data: Record<string, unknown> } | { error: ApiError }> {
  const tolerate: readonly GraphqlTolerableError[] = opts?.tolerate ?? toleratedGraphqlErrors(op);
  const result = await ctx.api.tryGraphql(op, variables, ctx.repo.slug);
  if ("error" in result) {
    if (!graphqlErrorTolerated(result.error, tolerate)) {
      throwFor(section, "GRAPHQL", op.name, result.error, { operation: opts?.describe, op });
    }
  }
  return result;
}

/**
 * Collect every node of a GraphQL connection, the sibling of listAll: the
 * cursor loop lives here so paging behavior cannot drift between sections.
 * The operation must declare its `connection` (the type requires it), whose
 * `path` walks from the data root to the connection field selecting
 * `nodes { ... }` and `pageInfo { hasNextPage endCursor }`; the loop owns the
 * `$cursor` variable, passing null first and the previous page's endCursor
 * after, so the caller's variables must not carry one. The operation's
 * DECLARED error outcomes are tolerated exactly as tryCallGraphql tolerates
 * them, coming back as { error } for the caller to interpret (the
 * environments pins read declares NOT_FOUND, so a fine-grained denial reads
 * as an absent resource - the probeAbsent posture) - but only on the FIRST
 * page: absence describes the whole resource, and a tolerated type arriving
 * mid-walk means the connection vanished under the loop, a broken walk that
 * classifies through throwFor like any other error. An operation declaring
 * no error outcomes always resolves { items }.
 */
export async function listGraphqlConnection<O extends GraphqlPaginatedReadDecl>(
  ctx: SectionContext,
  section: SectionMeta,
  op: O,
  // The `cursor?: never` pin makes a call site that supplies its own cursor
  // uncompilable - the loop below owns the variable; the paginated arm's
  // query type already proved $cursor exists at the declaration.
  variables: Readonly<GraphqlVariablesOf<O>> & { cursor?: never },
): Promise<{ items: unknown[] } | { error: ApiError }> {
  const path = op.connection.path;
  const items: unknown[] = [];
  let cursor: string | null = null;
  for (;;) {
    const result = await ctx.api.tryGraphql(op, { ...variables, cursor }, ctx.repo.slug);
    if ("error" in result) {
      if (cursor === null && graphqlErrorTolerated(result.error, toleratedGraphqlErrors(op))) {
        return result;
      }
      throwFor(section, "GRAPHQL", op.name, result.error, { op });
    }
    const connection = path.reduce<unknown>(
      (node, key) => (node as Record<string, unknown> | null)?.[key],
      result.data,
    ) as { nodes?: unknown; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } } | null;
    const nodes = connection?.nodes;
    const pageInfo = connection?.pageInfo;
    if (!Array.isArray(nodes) || typeof pageInfo?.hasNextPage !== "boolean") {
      throw new Error(
        `${section.key}: GRAPHQL ${op.name} returned a response without a "${path.join(".")}" connection carrying nodes and pageInfo{hasNextPage, endCursor}, so the list cannot be paginated. The operation's query must select both under that path`,
      );
    }
    items.push(...nodes);
    if (!pageInfo.hasNextPage) {
      return { items };
    }
    const endCursor = pageInfo.endCursor;
    if (typeof endCursor !== "string" || endCursor === cursor) {
      // hasNextPage without a fresh endCursor can only loop forever; treat it
      // as the same broken-connection shape as a missing pageInfo.
      throw new Error(
        `${section.key}: GRAPHQL ${op.name} reported hasNextPage without a new endCursor at "${path.join(".")}", so the pagination cannot advance. The operation's query must select pageInfo{hasNextPage, endCursor}`,
      );
    }
    cursor = endCursor;
  }
}

/**
 * Reject two declared entries that resolve to the same natural key; they
 * would fight each other on every run instead of converging. The sweep
 * collects EVERY colliding pair and fails once with the full list, so N
 * duplicates cost one run to discover, not N.
 */
export function rejectDuplicates<T>(
  section: SectionMeta,
  items: readonly T[],
  keyOf: (item: T) => string,
  describe: (item: T) => string,
): void {
  const seen = new Map<string, string>();
  const collisions: string[] = [];
  for (const item of items) {
    const key = keyOf(item);
    const first = seen.get(key);
    if (first !== undefined) {
      collisions.push(`"${first}" and "${describe(item)}"`);
      continue;
    }
    seen.set(key, describe(item));
  }
  if (collisions.length > 0) {
    throw new Error(
      `${section.key}: the settings file declares entries that name the same ${section.key} entry: ${collisions.join("; ")}. Keep exactly one entry per resource`,
    );
  }
}
