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
 * JSON-plain request data: what a payload thunk may produce and what the
 * transport serializes verbatim. `undefined` values are allowed inside
 * objects because JSON drops them (a declared optional field the settings
 * file omits).
 */
export type PlainData =
  | string
  | number
  | boolean
  | null
  | readonly PlainData[]
  | { readonly [key: string]: PlainData | undefined };

/**
 * A declared passthrough mapping as request data: parsed YAML is JSON-plain
 * by construction, but the loose schemas type it `unknown`, so this ONE walk
 * proves it instead of a cast per section. A non-JSON value is a bug.
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
  // The containers on the path from the root to the node being checked: a
  // YAML alias to an ancestor parses to a cycle, which JSON cannot carry
  // either (a shared alias to a sibling is fine and is visited twice).
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
      // Own names must be exactly the indices (enumerable) plus `length`.
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
 * What a thunk may compute at EXECUTION time only: the plaintext behind a
 * `$NAME` reference (resolved and masked up front, so check mode never sees
 * one). A thunk may also await the read-only port plan() closed over.
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
 * The request helpers (contract/requests.ts) bound to ONE read endpoint, minus the declaration
 * argument (the role already named it) and minus any payload (a GET carries none).
 */
interface BoundRead<E extends EndpointDecl> {
  /** GET that must succeed; every error classifies through throwFor. */
  call(
    ...args: OptsArg<E, { query?: Readonly<Record<string, string>>; describe?: string }>
  ): Promise<unknown>;
  /** GET whose declared tolerable statuses come back as `{ error }`. */
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
  /** GET whose declared tolerable statuses read as `{ missing: true }`. */
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
 * The helpers a read role exposes, narrowed by its declaration: an advisory
 * read (no failure may abort the section) offers only tryCall, a "denied"
 * primary read only the throwing helpers, an "absent" one only the tolerant.
 */
type ReadPort<E extends EndpointDecl> = E extends { readonly advisory: true }
  ? Pick<BoundRead<E>, "tryCall">
  : E extends { readonly primaryRead: { notFound: "denied" } }
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
interface PlannedOpBase<D extends Justification = Justification> {
  /**
   * The drift lines this operation resolves, in the check-mode prose
   * ("labels[bug]: color d73a4a != live ffffff; apply will update it"), or
   * an Unverifiable facet. Check mode renders them; apply mode renders `change`.
   */
  readonly drift: D;
  /**
   * What apply renders once the operation succeeds: the line itself, or a
   * thunk over the response (one line or several, never none) when the line
   * depends on what the server echoed; a throw is the verification failure.
   */
  readonly change: string | ((response: unknown) => string | readonly [string, ...string[]]);
  /**
   * The operation in settings-file terms ("arming the interaction limit"),
   * for the failure prose when the request is rejected - the `describe`
   * passed to the request helpers.
   */
  readonly describe?: string;
  /**
   * Receives the response body, for a server-assigned value (a created
   * environment's node id) a subsequent operation's thunk reads from where
   * the hook stores it. It must not render; a throw fails the operation.
   */
  readonly capture?: (response: unknown) => void;
}

/**
 * The reason check mode cannot verify a write (a secret GitHub never echoes back), rendered as a
 * check-mode note beside whatever drift lines the operation does resolve. It occupies the drift slot
 * and is admitted only on an endpoint declaring `unverifiable: true` (DriftFor).
 */
interface Unverifiable {
  readonly unverifiable: string;
  readonly lines: readonly string[];
}

/** What a planned operation offers check mode: its drift lines, or an unverifiable facet. */
type Justification = readonly string[] | Unverifiable;

/** The drift lines an operation resolves, whichever justification it carries. */
export function driftOf(op: Pick<PlannedOpBase, "drift">): readonly string[] {
  return "unverifiable" in op.drift ? op.drift.lines : op.drift;
}

/**
 * A request facet sealed at execution time, the ONLY place a plan may touch
 * a secret; async so it can read a value an earlier operation created.
 */
type Late<T> = (exec: ExecTools) => T | Promise<T>;

/**
 * What a tolerated status means for the operation that met it (it did not
 * apply): a note in place of its change line, or a failure carrying the
 * section's own advice where throwFor's generic text would mislead.
 */
export type ToleratedOutcome =
  | { readonly note: string; readonly failure?: never }
  | { readonly failure: string; readonly note?: never };

/**
 * The declared statuses a REST operation absorbs, and how each is reported.
 * `statuses` defaults to the endpoint's tolerable set; the non-empty tuple
 * may name only those, so an undeclared tolerance cannot compile.
 */
interface Tolerance<E extends EndpointDecl> {
  readonly statuses?: readonly [DeclaredErrorStatus<E>, ...DeclaredErrorStatus<E>[]];
  readonly outcome: (error: ApiError) => ToleratedOutcome;
}

/** The narrowing a plan performs on a computed drift list: non-empty means an operation is due. */
export function hasDrift(lines: readonly string[]): lines is readonly [string, ...string[]] {
  return lines.length > 0;
}

/**
 * The drift a REST operation must carry: none is legal only on an alwaysRewrite endpoint (a write
 * that recurs by declaration, so check has nothing to report), an Unverifiable facet only on an
 * endpoint declaring `unverifiable`; every other write exists because live state diverged.
 */
type DriftFor<E extends EndpointDecl> =
  | (E extends { readonly alwaysRewrite: true }
      ? readonly string[]
      : readonly [string, ...string[]])
  | (E extends { readonly unverifiable: true } ? Unverifiable : never);

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
    /** The request body, or a Late thunk sealing it at execution time. */
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
 * The erased view the engine executes: every literal operation is assignable
 * to it, and the executor resolves `role` against the section's declarations
 * at runtime (REST first, then GraphQL; the registry asserts the two role
 * spaces are disjoint).
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

/** The check-mode drift list of a plan: every op's drift lines, then the op-less lines. */
export function planDrift(plan: SectionPlan): string[] {
  return [...plan.ops.flatMap(driftOf), ...plan.drift];
}

/** The check-mode notes of a plan: every op's unverifiable reason, then the mode-neutral notes. */
export function planCheckNotes(plan: SectionPlan): string[] {
  return [
    ...plan.ops.flatMap((op) => ("unverifiable" in op.drift ? [op.drift.unverifiable] : [])),
    ...plan.notes,
  ];
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
