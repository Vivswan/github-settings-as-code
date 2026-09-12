/**
 * A section cannot write on its own: the read port binds only the roles that READ on the wire (GET routes
 * and GraphQL queries; an accessGrade override changes what GitHub gates, not what the request does), and a
 * planned operation can only name a write role, so "check mode issued a write" is unrepresentable.
 */

import type { RepoRef } from "../../discovery/targets.js";
import type { ApiError, GithubClient } from "../../github/api.js";
import type { SectionKey } from "../../schema.js";
import {
  type DeclaredErrorStatus,
  type EndpointDecl,
  endpointMethod,
  type PathParams,
} from "./endpoints.js";
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
 * What a payload thunk may produce and the transport serializes verbatim. `undefined` is allowed inside
 * objects because JSON drops it (a declared optional the file omits).
 */
export type PlainData =
  | string
  | number
  | boolean
  | null
  | readonly PlainData[]
  | { readonly [key: string]: PlainData | undefined };

/**
 * The loose schemas type a declared value `unknown`, and YAML can spell what JSON cannot (an alias cycle,
 * a tagged scalar), so this ONE walk proves plainness instead of a cast per section.
 */
export function plainData(value: unknown): PlainData {
  const render = (path: readonly (string | number)[]): string =>
    path.length === 0
      ? "(root)"
      : path
          .map((segment, index) => {
            if (typeof segment === "number") {
              return `[${segment}]`;
            }
            const bare = /^[A-Za-z_$][\w$]*$/.test(segment);
            return bare ? `${index === 0 ? "" : "."}${segment}` : `[${JSON.stringify(segment)}]`;
          })
          .join("");
  const reject = (path: readonly (string | number)[], reason: string): never => {
    throw new Error(
      `BUG: a planned payload carries a value JSON cannot carry at ${render(path)}: ${reason}; request data must be plain`,
    );
  };
  // A YAML alias to an ancestor parses to a cycle, which JSON cannot carry (a shared alias to a sibling is fine and is visited twice).
  const ancestors = new Set<object>();
  const plain = (node: unknown, path: readonly (string | number)[]): void => {
    if (node === undefined || node === null || typeof node === "string") {
      return; // an undefined object field is dropped by JSON, as a declared optional the file omits
    }
    if (typeof node === "boolean") {
      return;
    }
    if (typeof node === "number") {
      if (!Number.isFinite(node)) {
        reject(path, "a non-finite number, which JSON would turn into null");
      }
      return;
    }
    if (typeof node !== "object") {
      reject(path, `a ${typeof node}`);
    }
    if (ancestors.has(node)) {
      reject(path, "a reference back to one of its own containers (a cycle)");
    }
    if (Object.getOwnPropertySymbols(node).length > 0) {
      reject(path, "a symbol-keyed property, which JSON drops");
    }
    ancestors.add(node);
    if (Array.isArray(node)) {
      if (Object.getPrototypeOf(node) !== Array.prototype) {
        reject(path, "a list of a subclass, which JSON serializes as a plain list");
      }
      const indices = new Set(Array.from(node.keys(), String));
      if (Object.getOwnPropertyNames(node).some((n) => n !== "length" && !indices.has(n))) {
        reject(path, "a list carrying named properties, which JSON drops");
      }
      if (Object.keys(node).length !== node.length) {
        reject(path, "a list with a hole or a non-enumerable item, which JSON reads as null");
      }
      for (const [index, item] of node.entries()) {
        if (item === undefined) {
          reject([...path, index], "an undefined list item, which JSON would turn into null");
        }
        plain(item, [...path, index]);
      }
    } else {
      const proto = Object.getPrototypeOf(node);
      if (proto !== Object.prototype && proto !== null) {
        reject(path, "a non-plain object");
      }
      for (const [key, item] of Object.entries(node)) {
        plain(item, [...path, key]);
      }
    }
    ancestors.delete(node);
  };
  if (value === undefined) {
    reject([], "undefined, which has no JSON form");
  }
  plain(value, []);
  return value as PlainData;
}

/**
 * The plaintext behind a `$NAME` reference is resolved and masked up front, so check mode never sees one.
 * Only a thunk holds this token, which the port's execution-phase reads demand.
 */
export interface ExecTools {
  resolveSecret(reference: string): string;
}

/** A plan() body has no ExecTools token, so an execution-phase read does not compile there; a thunk passes the one it received. */
type Gated<T> = {
  readonly [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (exec: ExecTools, ...args: A) => R
    : T[K];
};

/** The runtime shape of Gated; the token is discarded, so the gate is the type alone. */
function gated<T extends object>(bound: T): Gated<T> {
  return Object.fromEntries(
    Object.entries(bound).map(([name, helper]) => [
      name,
      typeof helper === "function"
        ? (_exec: ExecTools, ...args: unknown[]) => helper(...args)
        : helper,
    ]),
  ) as Gated<T>;
}

type ReadRole<E extends EndpointDict> = {
  [R in keyof E & string]: E[R]["route"] extends `GET ${string}` ? R : never;
}[keyof E & string];

type WriteRole<E extends EndpointDict> = Exclude<keyof E & string, ReadRole<E>>;

type GraphqlReadRole<G extends GraphqlDict> = {
  [R in keyof G & string]: G[R] extends { readonly kind: "read" } ? R : never;
}[keyof G & string];

type GraphqlWriteRole<G extends GraphqlDict> = Exclude<keyof G & string, GraphqlReadRole<G>>;

/** The request helpers (./requests.ts) bound to ONE read endpoint, minus the declaration argument and any payload. */
interface BoundRead<E extends EndpointDecl> {
  call(
    ...args: OptsArg<E, { query?: Readonly<Record<string, string>>; describe?: string }>
  ): Promise<unknown>;
  tryCall(
    ...args: OptsArg<
      E,
      {
        query?: Readonly<Record<string, string>>;
        tolerate?: readonly DeclaredErrorStatus<E>[];
        describe?: string;
      }
    >
  ): Promise<{ data: unknown } | { error: ApiError }>;
  probeAbsent(
    ...args: OptsArg<
      E,
      {
        query?: Readonly<Record<string, string>>;
        tolerate?: readonly DeclaredErrorStatus<E>[];
        accept?: string;
        describe?: string;
      }
    >
  ): Promise<{ data: unknown } | { missing: true }>;
  listAll(...args: OptsArg<E, { query?: Readonly<Record<string, string>> }>): Promise<unknown[]>;
  listAllEnveloped(
    envelopeKey: string,
    ...args: OptsArg<E, { query?: Readonly<Record<string, string>> }>
  ): Promise<unknown[]>;
}

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
 * Write roles are absent from the type, so `ctx.read.<writeRole>` does not compile. A role with a
 * `primaryRead` posture exposes only the helpers that honor it; a `phase: "execution"` role exposes them Gated.
 */
type BoundReads<E extends EndpointDict, G extends GraphqlDict> = {
  readonly [R in ReadRole<E>]: ReadPort<E[R]>;
} & {
  readonly [R in GraphqlReadRole<G>]: GraphqlReadPort<G[R]>;
};

type GraphqlReadPort<O extends GraphqlOpDecl> = O extends { readonly phase: "execution" }
  ? Gated<BoundGraphqlRead<O>>
  : BoundGraphqlRead<O>;

/**
 * Only the helpers that honor the declaration's posture are exposed, so a handler cannot bypass an
 * advisory, denied, or absent posture by picking another helper.
 */
type ReadPort<E extends EndpointDecl> = E extends { readonly phase: "execution" }
  ? Gated<PlanReadPort<E>>
  : PlanReadPort<E>;

type PlanReadPort<E extends EndpointDecl> = E extends { readonly advisory: true }
  ? Pick<BoundRead<E>, "tryCall">
  : E extends { readonly primaryRead: { notFound: "denied" } }
    ? Pick<BoundRead<E>, "call" | "listAll" | "listAllEnveloped">
    : E extends { readonly primaryRead: { notFound: "absent" } }
      ? Pick<BoundRead<E>, "probeAbsent" | "tryCall">
      : BoundRead<E>;

export interface PlanContext<
  E extends EndpointDict = EndpointDict,
  G extends GraphqlDict = GraphqlDict,
> {
  /** The target repository, parsed once at the boundary (see RepoRef). */
  readonly repo: RepoRef;
  readonly read: BoundReads<E, G>;
}

/**
 * `D` is the drift type its arm demands: an ordinary operation must justify itself with at least one
 * drift line (DriftFor), so "check reported clean while apply mutated" is unrepresentable.
 */
export interface PlannedOpBase<D extends Justification = Justification> {
  /**
   * Check mode renders these; apply renders `change`.
   *   labels[bug]: color d73a4a != live ffffff; apply will update it
   */
  readonly drift: D;
  /**
   * A thunk when the line depends on what the server echoed (one line or several, never none); a throw
   * is the verification failure.
   */
  readonly change: string | ((response: unknown) => string | readonly [string, ...string[]]);
  /** The operation in settings-file terms ("arming the interaction limit"), for the failure prose; the `describe` the request helpers take. */
  readonly describe?: string;
  /**
   * For a server-assigned value (a created environment's node id) a later operation's thunk reads from
   * where the hook stores it. It must not render; a throw fails the operation.
   */
  readonly capture?: (response: unknown) => void;
  /**
   * Execution-time reads before the request is sealed and issued (bypass actors' node ids, pinned ahead
   * of the first write so a bad input fails while live state is untouched). A throw fails the operation
   * with its request never sent.
   */
  readonly before?: Late<void>;
}

/**
 * Occupies the drift slot, rendered as a check-mode note beside the drift lines the op does resolve;
 * admitted only on an endpoint declaring `unverifiable: true` (DriftFor).
 */
export interface Unverifiable {
  readonly unverifiable: string;
  readonly lines: readonly string[];
}

export type Justification = readonly string[] | Unverifiable;

export function driftOf(op: Pick<PlannedOpBase, "drift">): readonly string[] {
  return "unverifiable" in op.drift ? op.drift.lines : op.drift;
}

/** The ONLY place a plan may touch a secret; async so it can read a value an earlier operation created. */
export type Late<T> = (exec: ExecTools) => T | Promise<T>;

/**
 * A tolerated status means the operation did not apply: a note in place of its change line, or a
 * failure carrying the section's own advice where throwFor's generic text would mislead.
 */
export type ToleratedOutcome =
  | { readonly note: string; readonly failure?: never }
  | { readonly failure: string; readonly note?: never };

/** `statuses` defaults to the endpoint's tolerable set and may name only those, so an undeclared tolerance cannot compile. */
export interface Tolerance<E extends EndpointDecl> {
  readonly statuses?: readonly [DeclaredErrorStatus<E>, ...DeclaredErrorStatus<E>[]];
  readonly outcome: (error: ApiError) => ToleratedOutcome;
}

export function hasDrift(lines: readonly string[]): lines is readonly [string, ...string[]] {
  return lines.length > 0;
}

/**
 * Empty drift is legal only on an alwaysRewrite write (it recurs by declaration) or inside an Unverifiable
 * facet; everywhere else "check reported clean while apply mutated" stays unrepresentable.
 */
type DriftFor<E extends EndpointDecl> =
  | (E extends { readonly alwaysRewrite: true }
      ? readonly string[]
      : readonly [string, ...string[]])
  | (E extends { readonly unverifiable: true } ? Unverifiable : never);

/** Required exactly when the route has path params beyond owner/repo (the OptsArg rule, per role). */
type RestParams<R extends string> = [PathParams<R>] extends [never]
  ? { readonly params?: undefined }
  : { readonly params: Readonly<Record<PathParams<R>, string>> };

type PlannedRestOp<E extends EndpointDict, R extends WriteRole<E>> = PlannedOpBase<DriftFor<E[R]>> &
  RestParams<E[R]["route"]> & {
    readonly role: R;
    readonly query?: Readonly<Record<string, string>>;
    readonly payload?: PlainData | Late<PlainData>;
    readonly tolerate?: Tolerance<E[R]>;
    readonly variables?: never;
  };

/**
 * A planned GraphQL mutation under one specific role of a literal dictionary. Always
 * drift-bearing: alwaysRewrite is a REST endpoint declaration and no GraphQL mutation writes
 * a value it cannot read back, so none is unconditional by contract.
 */
type PlannedGraphqlOp<G extends GraphqlDict, R extends GraphqlWriteRole<G>> = PlannedOpBase<
  readonly [string, ...string[]]
> & {
  readonly role: R;
  readonly variables: Readonly<GraphqlVariablesOf<G[R]>> | Late<Readonly<GraphqlVariablesOf<G[R]>>>;
  readonly params?: never;
  readonly query?: never;
  readonly payload?: never;
  /** Tolerance is by HTTP status, which a GraphQL rejection has none of. */
  readonly tolerate?: never;
};

/**
 * The view the engine executes; it resolves `role` against the section's declarations at runtime
 * (REST first, then GraphQL; ../registry.ts asserts the two role spaces are disjoint).
 */
interface ErasedPlannedOp extends PlannedOpBase {
  readonly role: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly payload?: PlainData | Late<PlainData>;
  readonly tolerate?: {
    readonly statuses?: readonly number[];
    readonly outcome: (error: ApiError) => ToleratedOutcome;
  };
  readonly variables?: Readonly<Record<string, unknown>> | Late<Readonly<Record<string, unknown>>>;
}

/**
 * Against a section's LITERAL dictionaries the type is exact: `role` must be a declared WRITE role, a REST
 * op's `params` carry exactly the route's path params, a GraphQL op's `variables` match its declaration.
 *
 *   wide default `G` (REST-only, or a forgotten `typeof GRAPHQL`)  -> the GraphQL arm collapses to never
 *   erased dictionaries (the engine's view)                         -> widens to ErasedPlannedOp
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
 * `ops` run in order in apply mode and render their drift in check mode; `notes` render in both modes.
 * `drift` holds the op-less lines, a finding no operation can fix (a declared workflow whose file does
 * not exist): check mode reports it as drift, apply surfaces it as notes, so it is never silent.
 */
export interface SectionPlan<Op extends PlannedOpBase = ErasedPlannedOp> {
  ops: Op[];
  notes: string[];
  drift: string[];
}

export function planDrift(plan: SectionPlan): string[] {
  return [...plan.ops.flatMap(driftOf), ...plan.drift];
}

export function planCheckNotes(plan: SectionPlan): string[] {
  return [
    ...plan.ops.flatMap((op) => ("unverifiable" in op.drift ? [op.drift.unverifiable] : [])),
    ...plan.notes,
  ];
}

/**
 * The bound helpers close over a frozen copy, so a declaration mutated after binding (its route
 * rewritten to a write) cannot change what a read issues.
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
 * Only GETs and GraphQL queries are bound, so the port cannot issue a write however it is called: the
 * runtime twin of BoundReads. The cast at the end is the construction boundary.
 */
function boundReads<E extends EndpointDict, G extends GraphqlDict>(
  meta: SectionMeta<SectionKey, E, G>,
  api: GithubClient,
  repo: RepoRef,
): BoundReads<E, G> {
  // Reads are the check arm's whole capability, so that is the arm the helpers get.
  const ctx: SectionContext = { api, repo, check: true };
  const port: Record<string, object> = {};
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
    port[role] = endpoint.phase === "execution" ? gated(bound) : bound;
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
    port[role] = op.phase === "execution" ? gated(bound) : bound;
  }
  return Object.freeze(port) as BoundReads<E, G>;
}

/** `E` and `G` infer from the module, so a caller cannot ask for a port the section never declared. */
export function planContext<E extends EndpointDict, G extends GraphqlDict>(
  meta: SectionMeta<SectionKey, E, G>,
  api: GithubClient,
  repo: RepoRef,
): PlanContext<E, G> {
  return { repo, read: boundReads(meta, api, repo) };
}
