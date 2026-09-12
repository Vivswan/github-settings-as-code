import {
  type ApiError,
  isRateLimitError,
  type RequestMark,
  SECRET_RESPONSE_WITHHELD,
  SECRET_TRANSPORT_WITHHELD,
  transportFailure,
  withheld,
} from "../../github/api.js";
import { paginate } from "../../github/paginate.js";
import {
  type DeclaredErrorStatus,
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
 * A rest tuple, not an optional object param: that is what makes omitting the whole argument a compile
 * error for a route that needs params (the `[never]` trick alone cannot forbid an omitted argument).
 * `Extra` carries per-helper extras (query/payload/tolerate/accept).
 */
export type OptsArg<E extends EndpointDecl, Extra> = [PathParams<E["route"]>] extends [never]
  ? [opts?: { params?: undefined } & Extra]
  : [opts: { params: Readonly<Record<PathParams<E["route"]>, string>> } & Extra];

/**
 * A request the executor marked as carrying a resolved secret has its failure rebuilt HERE, on the engine's side of
 * the client port, so the guarantee holds for a library caller's own GithubClient: such a client's 422 body echoing a
 * webhook secret would otherwise render through throwFor into outcomes[].detail and a delivered report. A throw is
 * replaced too, since a transport error is free text that can quote the request body.
 *
 * The rate-limit classification is read from the message BEFORE the rebuild drops it: the port carries no headers,
 * so a client may signal a limit only that way, and a limit misread as a denial is a silently skipped section under
 * on-missing-permission: warn, where a denial misread as a limit still fails the run loudly.
 */
async function issue<D>(
  label: string,
  carriesSecret: boolean,
  send: (mark: RequestMark | undefined) => Promise<{ data: D } | { error: ApiError }>,
): Promise<{ data: D } | { error: ApiError }> {
  if (!carriesSecret) {
    return send(undefined);
  }
  let result: { data: D } | { error: ApiError };
  try {
    result = await send({ carriesSecret: true });
  } catch {
    throw transportFailure(label, SECRET_TRANSPORT_WITHHELD, "the GitHub API");
  }
  if (!("error" in result)) {
    return result;
  }
  const classified = isRateLimitError(result.error)
    ? { ...result.error, rateLimited: true as const }
    : result.error;
  return { error: withheld(classified, SECRET_RESPONSE_WITHHELD) };
}

/**
 * Permission failures become PermissionDenied (the orchestrator's partial-success policy handles them); everything
 * else is a hard error carrying the API's message. `payload?: never` (here and on tryCall) is what makes a payload
 * reach the wire only through the erased executor cores, whose `carriesSecret` is required: an optional-absent key
 * alone would still admit a widened variable, which excess-property checks do not see.
 */
export async function call<E extends EndpointDecl>(
  ctx: SectionContext,
  section: SectionMeta,
  endpoint: E,
  ...args: OptsArg<
    E,
    { query?: Readonly<Record<string, string>>; payload?: never; describe?: string }
  >
): Promise<unknown> {
  return callDeclared(ctx, section, endpoint, { ...args[0], carriesSecret: false });
}

/**
 * The erased core of call(): the plan executor reaches it with an endpoint resolved from a planned role,
 * whose params were typed when the plan was built; a handler calls call(), where the route type checks the params.
 */
export async function callDeclared(
  ctx: SectionContext,
  section: SectionMeta,
  endpoint: EndpointDecl,
  opts: {
    params?: Readonly<Record<string, string>>;
    query?: Readonly<Record<string, string>>;
    payload?: unknown;
    carriesSecret: boolean;
    describe?: string;
  },
): Promise<unknown> {
  const method = endpointMethod(endpoint.route);
  const path = expand(endpoint, ctx, opts.params, opts.query);
  const result = await issue(`${method} ${path}`, opts.carriesSecret, (mark) =>
    ctx.api.tryRequest(method, path, opts.payload, mark),
  );
  if ("error" in result) {
    throwFor(section, method, path, result.error, {
      operation: opts.describe,
      op: endpoint,
    });
  }
  return result.data;
}

/** Tolerated statuses come back as { error }; an explicit `tolerate` only ever tolerates FEWER than declared. */
export async function tryCall<E extends EndpointDecl>(
  ctx: SectionContext,
  section: SectionMeta,
  endpoint: E,
  ...args: OptsArg<
    E,
    {
      query?: Readonly<Record<string, string>>;
      payload?: never;
      tolerate?: readonly DeclaredErrorStatus<E>[];
      describe?: string;
    }
  >
): Promise<{ data: unknown } | { error: ApiError }> {
  const opts = args[0];
  return tryCallDeclared(ctx, section, endpoint, {
    ...opts,
    carriesSecret: false,
    tolerated: declaredTolerance(endpoint, opts?.tolerate),
  });
}

/**
 * An explicit list may only name declared tolerable statuses (the erased executor could spell another,
 * so this boundary refuses it); advisory tolerates all.
 */
export function declaredTolerance(
  endpoint: EndpointDecl,
  explicit?: readonly number[],
): (status: number) => boolean {
  if (explicit !== undefined) {
    const declared = toleratedStatuses(endpoint);
    const undeclared = explicit.filter((status) => !declared.includes(status));
    if (undeclared.length > 0) {
      throw new Error(
        `BUG: ${endpoint.route} was asked to tolerate status(es) ${undeclared.join(", ")}, which it does not declare as a tolerable error status; a tolerance may only name declared 4xx statuses other than 401 and 429`,
      );
    }
    return (status) => explicit.includes(status);
  }
  if (endpoint.advisory === true) {
    return () => true;
  }
  const declared = toleratedStatuses(endpoint);
  return (status) => declared.includes(status);
}

/** The erased core of tryCall(). A rate limit is a transport failure whatever status carries it: never tolerated. */
export async function tryCallDeclared(
  ctx: SectionContext,
  section: SectionMeta,
  endpoint: EndpointDecl,
  opts: {
    params?: Readonly<Record<string, string>>;
    query?: Readonly<Record<string, string>>;
    payload?: unknown;
    carriesSecret: boolean;
    tolerated: (status: number) => boolean;
    describe?: string;
  },
): Promise<{ data: unknown } | { error: ApiError }> {
  const method = endpointMethod(endpoint.route);
  const path = expand(endpoint, ctx, opts.params, opts.query);
  const result = await issue(`${method} ${path}`, opts.carriesSecret, (mark) =>
    ctx.api.tryRequest(method, path, opts.payload, mark),
  );
  if (
    "error" in result &&
    (isRateLimitError(result.error) || !opts.tolerated(result.error.status))
  ) {
    throwFor(section, method, path, result.error, {
      operation: opts.describe,
      op: endpoint,
    });
  }
  return result;
}

/**
 * The shared idiom behind "does this branch/site/environment/toggle exist" probes: tolerated statuses
 * read as { missing: true }. Pass `tolerate` only to tolerate FEWER than declared.
 */
export async function probeAbsent<E extends EndpointDecl>(
  ctx: SectionContext,
  section: SectionMeta,
  endpoint: E,
  ...args: OptsArg<
    E,
    {
      query?: Readonly<Record<string, string>>;
      tolerate?: readonly DeclaredErrorStatus<E>[];
      accept?: string;
      describe?: string;
    }
  >
): Promise<{ data: unknown } | { missing: true }> {
  const options = args[0];
  const path = expand(endpoint, ctx, options?.params, options?.query);
  const tolerated = declaredTolerance(endpoint, options?.tolerate);
  const result = await ctx.api.tryRequest("GET", path, undefined, { accept: options?.accept });
  if ("error" in result) {
    // A rate-limited 403 is not an absent resource (the tryCallDeclared rule).
    if (!isRateLimitError(result.error) && tolerated(result.error.status)) {
      return { missing: true };
    }
    throwFor(section, "GET", path, result.error, {
      operation: options?.describe,
      op: endpoint,
    });
  }
  return { data: result.data };
}

/** `extract` adapts the response shape (bare array, or a {total_count, <key>: []} envelope). */
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

/** For endpoints wrapping the list in an envelope (GET /actions/workflows returns {total_count, workflows: []}). */
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

/** The GraphQL sibling of call(); the failing request renders as `GRAPHQL <opName>` where a REST error shows method and path. */
export async function callGraphql<O extends GraphqlOpDecl>(
  ctx: SectionContext,
  section: SectionMeta,
  op: O,
  variables: Readonly<GraphqlVariablesOf<O>>,
  opts?: { describe?: string; carriesSecret?: boolean },
): Promise<Record<string, unknown>> {
  const result = await issue(`GRAPHQL ${op.name}`, opts?.carriesSecret === true, (mark) =>
    ctx.api.tryGraphql(op, variables, ctx.repo.slug, mark),
  );
  if ("error" in result) {
    throwFor(section, "GRAPHQL", op.name, result.error, { operation: opts?.describe, op });
  }
  return result.data;
}

/**
 * EVERY observed type must be declared: the HTTP status is a lossy fold (a mixed [FORBIDDEN, UNPROCESSABLE]
 * response and a pure FORBIDDEN both land on 403), so only the full type set says what happened. An
 * untyped or HTTP-level failure is never tolerable.
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
 * Tolerated error types come back as { error }; the set defaults to the declared outcomes, and an explicit
 * `tolerate` only tolerates FEWER. Tolerance reads the OBSERVED GraphQL types (graphqlErrorTolerated),
 * never the folded HTTP status.
 */
export async function tryCallGraphql<O extends GraphqlOpDecl>(
  ctx: SectionContext,
  section: SectionMeta,
  op: O,
  variables: Readonly<GraphqlVariablesOf<O>>,
  opts?: {
    // graphqlOp preserves the literal `outcomes` keys, so a tolerate naming an undeclared type does not compile.
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
 * The cursor loop lives here so paging cannot drift between sections. Declared error outcomes come back
 * as { error } only on the FIRST page: absence describes the whole resource, and a tolerated type
 * mid-walk means the connection vanished under the loop.
 */
export async function listGraphqlConnection<O extends GraphqlPaginatedReadDecl>(
  ctx: SectionContext,
  section: SectionMeta,
  op: O,
  // The `cursor?: never` pin: the loop owns the variable, so a call site supplying its own does not compile.
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
      // hasNextPage without a fresh endCursor would loop forever.
      throw new Error(
        `${section.key}: GRAPHQL ${op.name} reported hasNextPage without a new endCursor at "${path.join(".")}", so the pagination cannot advance. The operation's query must select pageInfo{hasNextPage, endCursor}`,
      );
    }
    cursor = endCursor;
  }
}

/**
 * Shared by the declared-side and live-side duplicate rejections, so both name a collision the same way.
 */
export function collidingPairs<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  describe: (item: T) => string,
): string[] {
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
  return collisions;
}

/**
 * Two entries resolving to one natural key would fight each other on every run. Every collision is
 * collected and reported once (each against the first entry under its key), so N duplicates cost one run to discover.
 */
export function rejectDuplicates<T>(
  section: SectionMeta,
  items: readonly T[],
  keyOf: (item: T) => string,
  describe: (item: T) => string,
): void {
  const collisions = collidingPairs(items, keyOf, describe);
  if (collisions.length > 0) {
    throw new Error(
      `${section.key}: the settings file declares entries that name the same ${section.key} entry: ${collisions.join("; ")}. Keep exactly one entry per resource`,
    );
  }
}
