/**
 * The plan-returning section contract: a section READS through a typed port
 * and returns the operations that would converge the repository, and the
 * engine decides what to do with them - render them as drift in check mode,
 * execute them in apply mode. A section cannot write on its own: the read
 * port binds only the roles that READ on the wire (GET routes and GraphQL
 * queries - an accessGrade override changes what GitHub gates, not what the
 * request does), and a planned operation can only name a write role, so
 * "check mode issued a write" is unrepresentable instead of guarded.
 */

import type { RepoRef } from "../../discovery/targets.js";
import type { ApiError, GithubClient } from "../../github/api.js";
import type { SectionKey } from "../../schema.js";
import { type EndpointDecl, endpointMethod, type PathParams } from "./endpoints.js";
import type {
  GraphqlOpDecl,
  GraphqlPaginatedReadDecl,
  GraphqlTolerableError,
  GraphqlVariablesOf,
} from "./graphql.js";
import type { EndpointDict, GraphqlDict, SectionContext, SectionMeta } from "./module.js";
import {
  call,
  callGraphql,
  listAll,
  listAllEnveloped,
  listGraphqlConnection,
  type OptsArg,
  probeAbsent,
  tryCall,
  tryCallGraphql,
} from "./requests.js";

/**
 * JSON-plain request data: what a payload thunk may produce and what the
 * transport serializes verbatim. `undefined` values are allowed inside
 * objects because JSON drops them (a declared optional field the settings
 * file omits).
 */
type PlainData =
  | string
  | number
  | boolean
  | null
  | readonly PlainData[]
  | { readonly [key: string]: PlainData | undefined };

/**
 * What an operation may compute at EXECUTION time and never at plan time:
 * the plaintext behind a whole-value `$NAME` secret reference. The engine
 * resolves and masks every declared secret up front (after the preflight
 * barrier, before the first mutation), so a lookup here only ever reads an
 * already-resolved name; check mode never constructs one at all.
 */
export interface ExecTools {
  resolveSecret(reference: string): string;
}

/** The roles of a REST dictionary whose route reads on the wire (a GET). */
type ReadRole<E extends EndpointDict> = {
  [R in keyof E & string]: E[R]["route"] extends `GET ${string}` ? R : never;
}[keyof E & string];

/** The roles of a REST dictionary whose route writes on the wire. */
type WriteRole<E extends EndpointDict> = Exclude<keyof E & string, ReadRole<E>>;

/** The roles of a GraphQL dictionary declared `kind: "read"`. */
type GraphqlReadRole<G extends GraphqlDict> = {
  [R in keyof G & string]: G[R] extends { readonly kind: "read" } ? R : never;
}[keyof G & string];

/** The roles of a GraphQL dictionary declared `kind: "write"`. */
type GraphqlWriteRole<G extends GraphqlDict> = Exclude<keyof G & string, GraphqlReadRole<G>>;

/**
 * The request helpers bound to ONE read endpoint: the same helpers a run()
 * handler calls with a declaration, minus the declaration argument (the
 * role already named it) and minus any payload (a GET carries none).
 */
interface BoundRead<E extends EndpointDecl> {
  /** GET that must succeed; every error classifies through throwFor. */
  call(
    ...args: OptsArg<E, { query?: Readonly<Record<string, string>>; describe?: string }>
  ): Promise<unknown>;
  /** GET whose declared >= 400 statuses come back as `{ error }`. */
  tryCall(
    ...args: OptsArg<
      E,
      {
        query?: Readonly<Record<string, string>>;
        tolerate?: readonly (keyof E["statuses"] & number)[];
        describe?: string;
      }
    >
  ): Promise<{ data: unknown } | { error: ApiError }>;
  /** GET whose declared >= 400 statuses read as `{ missing: true }`. */
  probeAbsent(
    ...args: OptsArg<
      E,
      {
        query?: Readonly<Record<string, string>>;
        tolerate?: readonly (keyof E["statuses"] & number)[];
        accept?: string;
        describe?: string;
      }
    >
  ): Promise<{ data: unknown } | { missing: true }>;
  /** Every page of a bare-array list. */
  listAll(...args: OptsArg<E, { query?: Readonly<Record<string, string>> }>): Promise<unknown[]>;
  /** Every page of a `{total_count, <key>: []}` enveloped list. */
  listAllEnveloped(
    envelopeKey: string,
    ...args: OptsArg<E, { query?: Readonly<Record<string, string>> }>
  ): Promise<unknown[]>;
}

/** The GraphQL request helpers bound to ONE read operation. */
type BoundGraphqlRead<O extends GraphqlOpDecl> = {
  call(
    variables: Readonly<GraphqlVariablesOf<O>>,
    opts?: { describe?: string },
  ): Promise<Record<string, unknown>>;
  tryCall(
    variables: Readonly<GraphqlVariablesOf<O>>,
    opts?: {
      tolerate?: readonly (keyof O["outcomes"] & GraphqlTolerableError)[];
      describe?: string;
    },
  ): Promise<{ data: Record<string, unknown> } | { error: ApiError }>;
} & (O extends GraphqlPaginatedReadDecl
  ? {
      /** Every node of the declared connection (the loop owns `$cursor`). */
      listConnection(
        variables: Readonly<GraphqlVariablesOf<O>> & { cursor?: never },
      ): Promise<{ items: unknown[] } | { error: ApiError }>;
    }
  : { listConnection?: never });

/**
 * A section's read port: one bound helper set per READ role, REST and
 * GraphQL alike. Write roles are absent from the type, so a plan() body that
 * reaches for `ctx.read.<writeRole>` does not compile - the reads a section
 * may issue are exactly its declared GETs and GraphQL queries. A REST role
 * declaring a `primaryRead` posture exposes only the helpers that honor it.
 */
type BoundReads<E extends EndpointDict, G extends GraphqlDict> = {
  readonly [R in ReadRole<E>]: ReadPort<E[R]>;
} & {
  readonly [R in GraphqlReadRole<G>]: BoundGraphqlRead<G[R]>;
};

/**
 * The helpers a read role exposes, narrowed by its declared `primaryRead`
 * posture so the declaration and the request that honors it cannot part:
 * a "denied" primary read (a 404 must classify as PermissionDenied) offers
 * only the throwing helpers, an "absent" one (a 404 means the resource does
 * not exist) only the tolerant ones. A role without the declaration keeps
 * every helper.
 */
type ReadPort<E extends EndpointDecl> = E extends { readonly primaryRead: { notFound: "denied" } }
  ? Pick<BoundRead<E>, "call" | "listAll" | "listAllEnveloped">
  : E extends { readonly primaryRead: { notFound: "absent" } }
    ? Pick<BoundRead<E>, "probeAbsent" | "tryCall">
    : BoundRead<E>;

/** What a plan() body sees: the target and its typed read port. Nothing else. */
export interface PlanContext<
  E extends EndpointDict = EndpointDict,
  G extends GraphqlDict = GraphqlDict,
> {
  /** The target repository, parsed once at the boundary (see RepoRef). */
  readonly repo: RepoRef;
  readonly read: BoundReads<E, G>;
}

/**
 * The facets every planned operation carries, whichever role it names. `D`
 * is the drift type its arm demands: an ordinary operation must justify
 * itself with at least one drift line (see DriftFor), so "check reported
 * clean while apply mutated" is unrepresentable.
 */
interface PlannedOpBase<D extends readonly string[] = readonly string[]> {
  /**
   * The drift lines this operation resolves, in the check-mode prose
   * ("labels[bug]: color d73a4a != live ffffff; apply will update it").
   * Check mode renders them; apply mode renders `change` instead.
   */
  readonly drift: D;
  /** The change line apply renders once the operation succeeds. */
  readonly change: string;
}

/**
 * The drift an operation on this endpoint must carry: none is legal only
 * for an alwaysRewrite endpoint (the sealed secret PUTs, whose values
 * cannot be read back, so their rewrite is unconditional by contract and
 * check has nothing to report). Every other write exists because live
 * state diverged, and that divergence is exactly what check mode must
 * print.
 */
type DriftFor<E extends EndpointDecl> = E extends { readonly alwaysRewrite: true }
  ? readonly string[]
  : readonly [string, ...string[]];

/**
 * The params facet of a REST operation, required exactly when the route
 * has path params beyond owner/repo - the OptsArg rule, applied per role.
 */
type RestParams<R extends string> = [PathParams<R>] extends [never]
  ? { readonly params?: undefined }
  : { readonly params: Readonly<Record<PathParams<R>, string>> };

/** A planned REST write under one specific role of a literal dictionary. */
type PlannedRestOp<E extends EndpointDict, R extends WriteRole<E>> = PlannedOpBase<DriftFor<E[R]>> &
  RestParams<E[R]["route"]> & {
    readonly role: R;
    readonly query?: Readonly<Record<string, string>>;
    /**
     * The request body, or a thunk sealing it at execution time from the
     * resolved secrets - the ONLY place a plan may touch a secret, and only
     * once the engine has resolved and masked every reference.
     */
    readonly payload?: PlainData | ((exec: ExecTools) => PlainData);
    readonly variables?: never;
  };

/**
 * A planned GraphQL mutation under one specific role of a literal
 * dictionary. Always drift-bearing: alwaysRewrite is a REST endpoint
 * declaration, so no GraphQL mutation is unconditional by contract.
 */
type PlannedGraphqlOp<G extends GraphqlDict, R extends GraphqlWriteRole<G>> = PlannedOpBase<
  readonly [string, ...string[]]
> & {
  readonly role: R;
  readonly variables:
    | Readonly<GraphqlVariablesOf<G[R]>>
    | ((exec: ExecTools) => Readonly<GraphqlVariablesOf<G[R]>>);
  readonly params?: never;
  readonly query?: never;
  readonly payload?: never;
};

/**
 * The erased view the engine executes: every literal operation is assignable
 * to it, and the executor resolves `role` against the section's declarations
 * at runtime (REST first, then GraphQL; the registry asserts the two role
 * spaces are disjoint).
 */
interface ErasedPlannedOp extends PlannedOpBase {
  readonly role: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly payload?: PlainData | ((exec: ExecTools) => PlainData);
  readonly variables?:
    | Readonly<Record<string, unknown>>
    | ((exec: ExecTools) => Readonly<Record<string, unknown>>);
}

/**
 * One operation a plan asks the engine to execute. Against a section's
 * LITERAL dictionaries (the `as const` ENDPOINTS a module passes to
 * SectionModule) the type is exact: `role` must be a declared WRITE role, a
 * REST op's `params` carry exactly the route's path params, and a GraphQL
 * op's `variables` match its declaration. The GraphQL arm exists only for a
 * LITERAL `G`: under the wide default (a REST-only section, or one that
 * forgot to pass `typeof GRAPHQL`) it collapses to never, so no role outside
 * the REST dictionary is plannable. Against the erased dictionaries (the
 * engine's view) the whole type widens to ErasedPlannedOp.
 */
export type PlannedOp<
  E extends EndpointDict = EndpointDict,
  G extends GraphqlDict = GraphqlDict,
> = string extends keyof E
  ? ErasedPlannedOp
  :
      | { [R in WriteRole<E>]: PlannedRestOp<E, R> }[WriteRole<E>]
      | (string extends keyof G
          ? never
          : { [R in GraphqlWriteRole<G>]: PlannedGraphqlOp<G, R> }[GraphqlWriteRole<G>]);

/**
 * What plan() returns, parametrized on the operation type so a plan over a
 * section's literal dictionaries erases to the engine's view structurally
 * (`PlannedOp<E, G>` is assignable to ErasedPlannedOp). `ops` run in order
 * in apply mode and render their drift in check mode. `notes` are
 * mode-neutral (unmanaged resources left alone, skips) and render in both
 * modes. `drift` holds the op-less drift lines - a finding no operation can
 * fix (a declared workflow whose file does not exist) - which check mode
 * reports as drift and apply mode surfaces as notes, so it is never silent.
 */
export interface SectionPlan<Op extends PlannedOpBase = ErasedPlannedOp> {
  ops: Op[];
  notes: string[];
  drift: string[];
}

/** The check-mode drift list of a plan: every op's drift, then the op-less lines. */
export function planDrift(plan: SectionPlan): string[] {
  return [...plan.ops.flatMap((op) => op.drift), ...plan.drift];
}

/**
 * A frozen deep copy of a declaration, taken at bind time. The bound helpers
 * close over the copy, so a declaration object mutated after binding (its
 * route or kind rewritten to a write) cannot change what a read issues.
 */
function snapshot<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(snapshot)) as unknown as T;
  }
  if (typeof value === "object" && value !== null) {
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item)])),
    ) as T;
  }
  return value;
}

/**
 * Bind a section's READ roles to the request helpers over one client and
 * target. Only GET endpoints and GraphQL queries are bound, so the returned
 * port cannot issue a write however it is called - the runtime twin of the
 * BoundReads type. The single cast at the end is the construction boundary:
 * the record is built by iterating the declarations the type was derived
 * from.
 */
function boundReads<E extends EndpointDict, G extends GraphqlDict>(
  meta: SectionMeta<SectionKey, E, G>,
  api: GithubClient,
  repo: RepoRef,
): BoundReads<E, G> {
  // The helpers take a SectionContext; reads are the check arm's whole
  // capability, so that is the arm they get.
  const ctx: SectionContext = { api, repo, check: true };
  const port: Record<string, BoundRead<EndpointDecl> | BoundGraphqlRead<GraphqlOpDecl>> = {};
  for (const [role, declaration] of Object.entries(meta.endpoints)) {
    if (endpointMethod(declaration.route) !== "GET") {
      continue;
    }
    const endpoint = snapshot(declaration);
    const bound: BoundRead<EndpointDecl> = {
      call: (...args) => call(ctx, meta, endpoint, ...args),
      tryCall: (...args) => tryCall(ctx, meta, endpoint, ...args),
      probeAbsent: (...args) => probeAbsent(ctx, meta, endpoint, ...args),
      listAll: (...args) => listAll(ctx, meta, endpoint, ...args),
      listAllEnveloped: (envelopeKey, ...args) =>
        listAllEnveloped(ctx, meta, endpoint, envelopeKey, ...args),
    };
    port[role] = bound;
  }
  for (const [role, declaration] of Object.entries(meta.graphql ?? {})) {
    if (declaration.kind !== "read") {
      continue;
    }
    const op = snapshot(declaration);
    const bound: BoundGraphqlRead<GraphqlOpDecl> = {
      call: (variables, opts) => callGraphql(ctx, meta, op, variables, opts),
      tryCall: (variables, opts) => tryCallGraphql(ctx, meta, op, variables, opts),
      ...(op.connection === undefined
        ? {}
        : {
            listConnection: (variables: Readonly<Record<string, unknown>> & { cursor?: never }) =>
              listGraphqlConnection(ctx, meta, op, variables),
          }),
    };
    port[role] = bound;
  }
  return Object.freeze(port) as BoundReads<E, G>;
}

/**
 * The context a plan() body receives for one target. `E` and `G` infer from
 * the module itself, so the port is typed by the declarations it is built
 * from - a caller cannot ask for a port the section never declared.
 */
export function planContext<E extends EndpointDict, G extends GraphqlDict>(
  meta: SectionMeta<SectionKey, E, G>,
  api: GithubClient,
  repo: RepoRef,
): PlanContext<E, G> {
  return { repo, read: boundReads(meta, api, repo) };
}
