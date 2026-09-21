/**
 * A section cannot write on its own: the read port binds only the roles that READ on the wire (GET routes
 * and GraphQL queries; an accessGrade override changes what GitHub gates, not what the request does), and a
 * planned operation can only name a write role, so "check mode issued a write" is unrepresentable.
 */

import { ok, type Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import type { RepoRef } from "../../discovery/targets.js";
import type { ApiError, GitHubClient } from "../../github/api.js";
import type { SectionKey } from "../../schema.js";
import {
  type DeclaredErrorStatus,
  type EndpointDecl,
  endpointMethod,
  type PathParams,
} from "./endpoints.js";
import type { SectionFailure } from "./errors.js";
import type {
  GraphqlOpDecl,
  GraphqlPaginatedReadDecl,
  GraphqlTolerableError,
  GraphqlVariablesOf,
} from "./graphql.js";
import { parseLive } from "./live.js";
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
        reject(
          path,
          "a list whose enumerable keys fall short of its length: a hole, which JSON renders as null, or a non-enumerable item, which JSON keeps but Object.keys skips",
        );
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
 * Only a thunk holds this token, which the port's execution-phase reads demand. A resolve marks the
 * operation's request as secret-carrying (engine/execute.ts), so a plaintext is used inside the operation
 * that resolved it, never stashed for another.
 */
export interface ExecTools {
  resolveSecret(reference: string): string;
}

/** The runtime shape of the gated ports: the token is discarded, so the gate is the type alone. */
function gated<T extends object>(bound: T): object {
  return Object.fromEntries(
    Object.entries(bound).map(([name, helper]) => [
      name,
      typeof helper === "function"
        ? (_exec: ExecTools, ...args: unknown[]) => helper(...args)
        : helper,
    ]),
  );
}

type ReadRole<E extends EndpointDict> = {
  [R in keyof E & string]: E[R]["route"] extends `GET ${string}` ? R : never;
}[keyof E & string];

type WriteRole<E extends EndpointDict> = Exclude<keyof E & string, ReadRole<E>>;

type GraphqlReadRole<G extends GraphqlDict> = {
  [R in keyof G & string]: G[R] extends { readonly kind: "read" } ? R : never;
}[keyof G & string];

type GraphqlWriteRole<G extends GraphqlDict> = Exclude<keyof G & string, GraphqlReadRole<G>>;

// `payload?: never` on the request options, as on the helpers they forward to: a read never carries a body, and a
// body that did reach the wire this way would be unmarked (requests.ts).
type CallOpts<E extends EndpointDecl> = OptsArg<
  E,
  { query?: Readonly<Record<string, string>>; payload?: never; describe?: string }
>;

type TryCallOpts<E extends EndpointDecl> = OptsArg<
  E,
  {
    query?: Readonly<Record<string, string>>;
    payload?: never;
    tolerate?: readonly DeclaredErrorStatus<E>[];
    describe?: string;
  }
>;

type ProbeOpts<E extends EndpointDecl> = OptsArg<
  E,
  {
    query?: Readonly<Record<string, string>>;
    tolerate?: readonly DeclaredErrorStatus<E>[];
    accept?: string;
    describe?: string;
  }
>;

type ListOpts<E extends EndpointDecl> = OptsArg<
  E,
  { query?: Readonly<Record<string, string>>; describe?: string }
>;

/**
 * What every port helper resolves to: the parsed body, or the failure as a value. A ResultAsync awaits to a
 * Result and also yields inside `safeTry(async function* () {...})`, so a plan threads its reads with `yield*`.
 */
export type Read<T> = ResultAsync<T, SectionFailure>;

/**
 * The request helpers (./requests.ts) bound to ONE read endpoint, minus the declaration argument and any payload.
 * Every helper takes the zod schema of the body it returns and parses through parseLive (./live.ts) before the
 * section sees it, so an unparsed body is unrepresentable: a malformed answer is a loud "outside the documented
 * shape" failure naming the endpoint, never an undefined reaching a plan. The list helpers take the ITEM schema.
 */
interface BoundRead<E extends EndpointDecl> {
  call<T>(schema: z.ZodType<T>, ...args: CallOpts<E>): Read<T>;
  tryCall<T>(
    schema: z.ZodType<T>,
    ...args: TryCallOpts<E>
  ): Read<{ data: T } | { error: ApiError }>;
  probeAbsent<T>(
    schema: z.ZodType<T>,
    ...args: ProbeOpts<E>
  ): Read<{ data: T } | { missing: true }>;
  listAll<T>(item: z.ZodType<T>, ...args: ListOpts<E>): Read<T[]>;
  listAllEnveloped<T>(envelopeKey: string, item: z.ZodType<T>, ...args: ListOpts<E>): Read<T[]>;
}

/**
 * BoundRead behind the ExecTools token: a plan() body has no token, so an execution-phase read does not compile
 * there; a thunk passes the one it received. Spelled out rather than mapped from BoundRead, since a mapped type
 * erases the per-call schema generic.
 */
interface GatedBoundRead<E extends EndpointDecl> {
  call<T>(exec: ExecTools, schema: z.ZodType<T>, ...args: CallOpts<E>): Read<T>;
  tryCall<T>(
    exec: ExecTools,
    schema: z.ZodType<T>,
    ...args: TryCallOpts<E>
  ): Read<{ data: T } | { error: ApiError }>;
  probeAbsent<T>(
    exec: ExecTools,
    schema: z.ZodType<T>,
    ...args: ProbeOpts<E>
  ): Read<{ data: T } | { missing: true }>;
  listAll<T>(exec: ExecTools, item: z.ZodType<T>, ...args: ListOpts<E>): Read<T[]>;
  listAllEnveloped<T>(
    exec: ExecTools,
    envelopeKey: string,
    item: z.ZodType<T>,
    ...args: ListOpts<E>
  ): Read<T[]>;
}

type GraphqlTryOpts<O extends GraphqlOpDecl> = {
  tolerate?: readonly (keyof O["outcomes"] & GraphqlTolerableError)[];
  describe?: string;
};

type BoundGraphqlRead<O extends GraphqlOpDecl> = {
  call<T>(
    schema: z.ZodType<T>,
    variables: Readonly<GraphqlVariablesOf<O>>,
    opts?: { describe?: string },
  ): Read<T>;
  tryCall<T>(
    schema: z.ZodType<T>,
    variables: Readonly<GraphqlVariablesOf<O>>,
    opts?: GraphqlTryOpts<O>,
  ): Read<{ data: T } | { error: ApiError }>;
} & (O extends GraphqlPaginatedReadDecl
  ? {
      /** Every node of the declared connection (the loop owns `$cursor`), each parsed by the node schema. */
      listConnection<T>(
        node: z.ZodType<T>,
        variables: Readonly<GraphqlVariablesOf<O>> & { cursor?: never },
      ): Read<{ items: T[] } | { error: ApiError }>;
    }
  : { listConnection?: never });

/** BoundGraphqlRead behind the ExecTools token (the GatedBoundRead twin). */
type GatedBoundGraphqlRead<O extends GraphqlOpDecl> = {
  call<T>(
    exec: ExecTools,
    schema: z.ZodType<T>,
    variables: Readonly<GraphqlVariablesOf<O>>,
    opts?: { describe?: string },
  ): Read<T>;
  tryCall<T>(
    exec: ExecTools,
    schema: z.ZodType<T>,
    variables: Readonly<GraphqlVariablesOf<O>>,
    opts?: GraphqlTryOpts<O>,
  ): Read<{ data: T } | { error: ApiError }>;
} & (O extends GraphqlPaginatedReadDecl
  ? {
      listConnection<T>(
        exec: ExecTools,
        node: z.ZodType<T>,
        variables: Readonly<GraphqlVariablesOf<O>> & { cursor?: never },
      ): Read<{ items: T[] } | { error: ApiError }>;
    }
  : { listConnection?: never });

/**
 * Write roles are absent from the type, so `ctx.read.<writeRole>` does not compile. A role with a
 * `primaryRead` posture exposes only the helpers that honor it; a `phase: "execution"` role exposes them gated.
 */
type BoundReads<E extends EndpointDict, G extends GraphqlDict> = {
  readonly [R in ReadRole<E>]: ReadPort<E[R]>;
} & {
  readonly [R in GraphqlReadRole<G>]: GraphqlReadPort<G[R]>;
};

type GraphqlReadPort<O extends GraphqlOpDecl> = O extends { readonly phase: "execution" }
  ? GatedBoundGraphqlRead<O>
  : BoundGraphqlRead<O>;

/**
 * Only the helpers that honor the declaration's posture are exposed, so a handler cannot bypass an
 * advisory, denied, or absent posture by picking another helper.
 */
type ReadPort<E extends EndpointDecl> = E extends { readonly phase: "execution" }
  ? Pick<GatedBoundRead<E>, PosturedHelpers<E>>
  : Pick<BoundRead<E>, PosturedHelpers<E>>;

type PosturedHelpers<E extends EndpointDecl> = E extends { readonly advisory: true }
  ? "tryCall"
  : E extends { readonly primaryRead: { notFound: "denied" } }
    ? "call" | "listAll" | "listAllEnveloped"
    : E extends { readonly primaryRead: { notFound: "absent" } }
      ? "probeAbsent" | "tryCall"
      : keyof BoundRead<E>;

/**
 * `K` is the section the context was built for: a module's plan() takes PlanContext<_, _, K> over its own
 * key, so labels' plan() cannot be handed branches' context once both are erased to EndpointDict
 * (sectionModule() returns the erased module). The registry refuses the same mismatch at runtime.
 */
export interface PlanContext<
  E extends EndpointDict = EndpointDict,
  G extends GraphqlDict = GraphqlDict,
  K extends SectionKey = SectionKey,
> {
  readonly section: K;
  /** The target repository, parsed once at the boundary (see RepoRef). */
  readonly repo: RepoRef;
  readonly read: BoundReads<E, G>;
}

/**
 * A plan handler with its context's key brand erased: a shared handler serving several sections is
 * compared to each branded per-key signature through this (repo-secrets, repo-variables, setup-section).
 */
export type KeyErasedPlan<P> = P extends (
  ctx: PlanContext<infer E, infer G, infer _K>,
  declared: infer D,
) => infer R
  ? (ctx: PlanContext<E, G>, declared: D) => R
  : never;

/** The run's on-missing-permission input: how a read the token is denied classifies. */
export type OnMissingPermission = "fail" | "warn";

let mintPolicy: (input: OnMissingPermission) => DenialPolicy;

/**
 * The policy as a snapshot() sees it. Only snapshotContext() mints one: the constructor is private
 * and the class nominal, so a section cannot hand readOrNote a literal "warn" and turn a denial the
 * run should fail on into a note.
 */
export class DenialPolicy {
  private constructor(private readonly input: OnMissingPermission) {}

  static {
    mintPolicy = (input) => new DenialPolicy(input);
  }

  /** Under warn a denied sub-read is noted and left out; under fail it propagates. */
  get notesDenials(): boolean {
    return this.input === "warn";
  }
}

/**
 * What snapshot() reads through: the plan port plus the run's denial policy, so a helper over one
 * sub-read (readOrNote) classifies a denial where it happens instead of noting it under both.
 */
export interface SnapshotContext<
  E extends EndpointDict = EndpointDict,
  G extends GraphqlDict = GraphqlDict,
  K extends SectionKey = SectionKey,
> extends PlanContext<E, G, K> {
  readonly onMissingPermission: DenialPolicy;
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
   * A thunk when the line depends on what the server echoed (one line or several, never none); its failure
   * is the verification failure, reported beside the requests that landed.
   */
  readonly change: string | ((response: unknown) => Result<ChangeLines, SectionFailure>);
  /** The operation in settings-file terms ("arming the interaction limit"), for the failure prose; the `describe` the request helpers take. */
  readonly describe?: string;
  /**
   * For a server-assigned value (a created environment's node id) a later operation's thunk reads from
   * where the hook stores it. It must not render; its failure fails the operation.
   */
  readonly capture?: (response: unknown) => Result<void, SectionFailure>;
  /**
   * Execution-time reads before the request is sealed and issued (bypass actors' node ids, pinned ahead
   * of the first write so a bad input fails while live state is untouched). Its failure fails the
   * operation with its request never sent.
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

/** One change line or several, never none: a request that landed always renders. */
export type ChangeLines = string | readonly [string, ...string[]];

/**
 * The ONLY place a plan may touch a secret; async so it can read a value an earlier operation created. Its
 * failure is the operation's, with the request never sent.
 */
export type Late<T> = (
  exec: ExecTools,
) => Result<T, SectionFailure> | PromiseLike<Result<T, SectionFailure>>;

/**
 * A tolerated status means the operation did not apply: a note in place of its change line, or a
 * failure carrying the section's own advice where failureFor's generic text would mislead.
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
 * runtime twin of BoundReads. Each helper parses its answer through parseLive with the schema the call
 * supplied (`describe` names the resource in the failure), so no raw body leaves the port. The cast at
 * the end is the construction boundary.
 */
function boundReads<E extends EndpointDict, G extends GraphqlDict>(
  meta: SectionMeta<SectionKey, E, G>,
  api: GitHubClient,
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
    const parse = <T>(schema: z.ZodType<T>, data: unknown, describe?: string) =>
      parseLive(meta, endpoint, schema, data, describe);
    const bound: BoundRead<EndpointDecl> = {
      call: (schema, ...args) =>
        new ResultAsync(call(ctx, meta, endpoint, ...args)).andThen((data) =>
          parse(schema, data, args[0]?.describe),
        ),
      tryCall: (schema, ...args) =>
        new ResultAsync(tryCall(ctx, meta, endpoint, ...args)).andThen((result) =>
          "error" in result
            ? ok(result)
            : parse(schema, result.data, args[0]?.describe).map((data) => ({ data })),
        ),
      probeAbsent: (schema, ...args) =>
        new ResultAsync(probeAbsent(ctx, meta, endpoint, ...args)).andThen((result) =>
          "missing" in result
            ? ok(result)
            : parse(schema, result.data, args[0]?.describe).map((data) => ({ data })),
        ),
      listAll: (item, ...args) =>
        new ResultAsync(listAll(ctx, meta, endpoint, ...args)).andThen((items) =>
          parse(z.array(item), items, args[0]?.describe),
        ),
      listAllEnveloped: (envelopeKey, item, ...args) =>
        new ResultAsync(listAllEnveloped(ctx, meta, endpoint, envelopeKey, ...args)).andThen(
          (items) => parse(z.array(item), items, args[0]?.describe),
        ),
    };
    port[role] = endpoint.phase === "execution" ? gated(bound) : bound;
  }
  for (const [role, declaration] of Object.entries(meta.graphql ?? {})) {
    if (declaration.kind !== "read") {
      continue;
    }
    const op = snapshot(declaration);
    const parse = <T>(schema: z.ZodType<T>, data: unknown, describe?: string) =>
      parseLive(meta, op, schema, data, describe);
    const bound: BoundGraphqlRead<GraphqlOpDecl> = {
      call: (schema, variables, opts) =>
        new ResultAsync(callGraphql(ctx, meta, op, variables, opts)).andThen((data) =>
          parse(schema, data, opts?.describe),
        ),
      tryCall: (schema, variables, opts) =>
        new ResultAsync(tryCallGraphql(ctx, meta, op, variables, opts)).andThen((result) =>
          "error" in result
            ? ok(result)
            : parse(schema, result.data, opts?.describe).map((data) => ({ data })),
        ),
      ...(op.connection === undefined
        ? {}
        : {
            listConnection: <T>(
              node: z.ZodType<T>,
              variables: Readonly<Record<string, unknown>> & { cursor?: never },
            ) =>
              new ResultAsync(listGraphqlConnection(ctx, meta, op, variables)).andThen((result) =>
                "error" in result
                  ? ok(result)
                  : parse(z.array(node), result.items).map((items) => ({ items })),
              ),
          }),
    };
    port[role] = op.phase === "execution" ? gated(bound) : bound;
  }
  return Object.freeze(port) as BoundReads<E, G>;
}

/**
 * The client each context was minted over. A gate composed at the registry door (owner.ts) reads it
 * to share one probe across the sections of a run; the registry is private, so the port itself
 * stays the only thing a section body can reach.
 */
const clients = new WeakMap<PlanContext, GitHubClient>();

/** The client a context reads through; a context not minted by planContext() or snapshotContext() is a BUG. */
export function clientOf(ctx: PlanContext): GitHubClient {
  const api = clients.get(ctx);
  if (api === undefined) {
    throw new Error(
      `BUG: the ${ctx.section} context was not minted by planContext() or snapshotContext(), so no client is bound to it`,
    );
  }
  return api;
}

/** `K`, `E`, and `G` infer from the module, so a caller cannot ask for a port the section never declared. */
export function planContext<K extends SectionKey, E extends EndpointDict, G extends GraphqlDict>(
  meta: SectionMeta<K, E, G>,
  api: GitHubClient,
  repo: RepoRef,
): PlanContext<E, G, K> {
  const ctx: PlanContext<E, G, K> = { section: meta.key, repo, read: boundReads(meta, api, repo) };
  clients.set(ctx, api);
  return ctx;
}

export function snapshotContext<
  K extends SectionKey,
  E extends EndpointDict,
  G extends GraphqlDict,
>(
  meta: SectionMeta<K, E, G>,
  api: GitHubClient,
  repo: RepoRef,
  onMissingPermission: OnMissingPermission,
): SnapshotContext<E, G, K> {
  const ctx: SnapshotContext<E, G, K> = {
    ...planContext(meta, api, repo),
    onMissingPermission: mintPolicy(onMissingPermission),
  };
  clients.set(ctx, api);
  return ctx;
}
