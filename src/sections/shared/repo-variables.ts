/**
 * GitHub's two repo-scoped variable families (Actions, Copilot agents) expose the same four endpoints under
 * a different path segment and differ only in PAT resource and noun, so each section module is ONE
 * repoVariablesSection() call.
 *
 *   environments section -> plans its nested variables through ./variables-engine.ts too, one scope per environment
 */

import { ok, type Result } from "neverthrow";
import type { z } from "zod";
import type { MustBeNever, UndeclaredPolicyList } from "../../types.js";
import { ActionsVariableConfig } from "../actions_variables/schema.js";
import { AgentsVariableConfig } from "../agents_variables/schema.js";
import type { SectionFailure } from "../contract/errors.js";
import {
  type DeclaredIssue,
  defaultUndeclaredPolicy,
  type GraphqlDict,
  type KeyedListLayering,
  keyedBy,
  loosen,
  type SectionSnapshot,
  undeclaredPolicy,
  type ValidatedInput,
} from "../contract/module.js";
import type { PatResource } from "../contract/permissions.js";
import type {
  KeyErasedPlan,
  PlanContext,
  PlannedOp,
  SectionPlan,
  SnapshotContext,
} from "../contract/plan.js";
import { knobbed } from "./schema-helpers.js";
import { knobbedSnapshot, projectOntoSchema } from "./snapshot-helpers.js";
import {
  duplicateVariableNameIssues,
  LiveVariable,
  liveVariablesByKey,
  planVariables,
  type VariableEntry,
  type VariablesPlanScope,
  variableKey,
  variableOps,
} from "./variables-engine.js";

export type RepoVariablesKey = "actions_variables" | "agents_variables";

/**
 * The factory derives the routes from THIS map, so a key paired with the other family's segment (which
 * the mock would faithfully serve, hiding the swap) is unrepresentable; the `satisfies` pins each VALUE
 * to the segment its own KEY spells.
 */
const VARIABLES_SEGMENTS = {
  actions_variables: "actions",
  agents_variables: "agents",
} as const satisfies { [K in RepoVariablesKey]: SegmentOfVariablesKey<K> };

/**
 * The factory derives the runtime shape from THIS map, so a key paired with the other family's config
 * (structurally identical, invisible to every gate) is unrepresentable.
 */
const VARIABLES_ENTRIES = {
  actions_variables: ActionsVariableConfig,
  agents_variables: AgentsVariableConfig,
} as const satisfies Record<RepoVariablesKey, z.ZodType<VariableEntry>>;

type SegmentOfVariablesKey<K extends RepoVariablesKey> = K extends `${infer S}_variables`
  ? S
  : never;

type VariablesSegment<K extends RepoVariablesKey = RepoVariablesKey> =
  (typeof VARIABLES_SEGMENTS)[K];

/**
 * Routes as LITERAL types, so the registry's SectionEndpointKey union, the typed mock fragments, and
 * USED_PATHS see exactly what a hand-written dictionary would declare. A type alias, not an interface,
 * so it keeps the implicit index signature EndpointDict expects.
 */
type RepoVariablesEndpoints<P extends VariablesSegment> = {
  readonly list: {
    readonly route: `GET /repos/{owner}/{repo}/${P}/variables`;
    readonly statuses: { readonly 200: string };
    readonly pageSize: number;
    readonly primaryRead: { readonly notFound: "denied" };
  };
  readonly create: {
    readonly route: `POST /repos/{owner}/{repo}/${P}/variables`;
    readonly statuses: { readonly 201: string };
  };
  readonly update: {
    readonly route: `PATCH /repos/{owner}/{repo}/${P}/variables/{name}`;
    readonly statuses: { readonly 204: string };
  };
  readonly remove: {
    readonly route: `DELETE /repos/{owner}/{repo}/${P}/variables/{name}`;
    readonly statuses: { readonly 204: string };
  };
};

/**
 * One family's plan() over exactly its own dictionary and declared value (the
 * registry's exactness lockstep); indexed by K so the generic factory can
 * assign its one SharedPlan to it.
 */
type RepoVariablesPlan<K extends RepoVariablesKey> = {
  [F in RepoVariablesKey]: (
    ctx: PlanContext<RepoVariablesEndpoints<VariablesSegment<F>>, GraphqlDict, F>,
    declared: ValidatedInput<F>,
  ) => Promise<
    Result<SectionPlan<PlannedOp<RepoVariablesEndpoints<VariablesSegment<F>>>>, SectionFailure>
  >;
}[K];

/** Every family's routes as one dictionary; see repo-secrets.ts for why the plan is written over it. */
type WideEndpoints = RepoVariablesEndpoints<VariablesSegment>;

type WideDeclared = VariableEntry[] | UndeclaredPolicyList<VariableEntry>;

type WideContext = PlanContext<WideEndpoints>;

type WidePlanned = Promise<Result<SectionPlan<PlannedOp<WideEndpoints>>, SectionFailure>>;

/** The shared implementation's signature at family F (the brand names the family); the lockstep below compares it to the family's own. */
type SharedPlanAt<F extends RepoVariablesKey> = (
  ctx: WideContext,
  declared: ValidatedInput<F>,
) => WidePlanned;

/** The one implementation: SharedPlanAt, generic over the family it is called as. */
type SharedPlan = <F extends RepoVariablesKey>(
  ...args: Parameters<SharedPlanAt<F>>
) => ReturnType<SharedPlanAt<F>>;

/** What every family's snapshot reads back: one shape, since the two entry slices are identical. */
type WideSnapshot = {
  value: UndeclaredPolicyList<{ name: string; value: string }> | undefined;
  notes: string[];
};

type Invariant<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type _SharedPlanIsEveryFamilyPlan = MustBeNever<
  {
    [K in RepoVariablesKey]: Invariant<
      SharedPlanAt<K>,
      KeyErasedPlan<RepoVariablesPlan<K>>
    > extends true
      ? never
      : K;
  }[RepoVariablesKey]
>;

/** The module shape repoVariablesSection() mints (SectionModule<K> at the registry). */
export interface RepoVariablesSectionModule<K extends RepoVariablesKey> {
  readonly key: K;
  readonly undeclaredDefault: "delete";
  readonly permission: { readonly repo: readonly [PatResource] };
  readonly endpoints: RepoVariablesEndpoints<VariablesSegment<K>>;
  readonly shape: z.ZodType;
  readonly layering: KeyedListLayering;
  readonly validate: (declared: WideDeclared) => readonly DeclaredIssue[];
  readonly plan: RepoVariablesPlan<K>;
  readonly snapshot: (
    ctx: SnapshotContext<RepoVariablesEndpoints<VariablesSegment<K>>, GraphqlDict, K>,
  ) => Promise<Result<SectionSnapshot<K>, SectionFailure>>;
}

/**
 * Delete-undeclared-by-default: variables are readable, recreatable configuration; the wrapped
 * `_undeclared: keep` form softens deletion to notes. A family supplies only its key, PAT resource, and noun.
 */
export function repoVariablesSection<K extends RepoVariablesKey>(family: {
  key: K;
  /** The fine-grained-PAT Repository permission gating the family. */
  resource: PatResource;
  /** The output noun ("Actions variable", "Copilot agents variable"). */
  noun: string;
}): RepoVariablesSectionModule<K> {
  const { key, resource, noun } = family;
  const pathSegment: VariablesSegment<K> = VARIABLES_SEGMENTS[key];
  const endpoints: RepoVariablesEndpoints<VariablesSegment<K>> = {
    list: {
      route: `GET /repos/{owner}/{repo}/${pathSegment}/variables`,
      statuses: { 200: `the ${noun}s list` },
      // GitHub caps this list's per_page at 30; asking for more is silently clamped and would truncate the walk to one page.
      pageSize: 30,
      // A fine-grained token conceals a denied list as 404; reading it as "no variables" would be wrong, so it is a denial.
      primaryRead: { notFound: "denied" },
    },
    create: {
      route: `POST /repos/{owner}/{repo}/${pathSegment}/variables`,
      statuses: { 201: "variable created" },
    },
    update: {
      route: `PATCH /repos/{owner}/{repo}/${pathSegment}/variables/{name}`,
      statuses: { 204: "variable updated" },
    },
    remove: {
      route: `DELETE /repos/{owner}/{repo}/${pathSegment}/variables/{name}`,
      statuses: { 204: "variable deleted" },
    },
  };

  const plan: SharedPlan = async (ctx, declared) => {
    const defaultPolicy = defaultUndeclaredPolicy(section);
    const wideDeclared: WideDeclared = declared;
    const { policy, entries } = undeclaredPolicy(wideDeclared, defaultPolicy);
    // Built where the routes are known, so params typecheck ({name} on update/remove).
    type Op = PlannedOp<WideEndpoints>;
    const scope: VariablesPlanScope<
      Extract<Op, { role: "create" }>,
      Extract<Op, { role: "update" }>,
      Extract<Op, { role: "remove" }>
    > = {
      label: key,
      noun,
      list: () => ctx.read.list.listAllEnveloped("variables", LiveVariable),
      ...variableOps({ create: "create", update: "update", remove: "remove" }, undefined),
    };
    return planVariables(section, scope, { entries, policy, defaultPolicy });
  };

  const snapshot = async (
    ctx: SnapshotContext<WideEndpoints>,
  ): Promise<Result<WideSnapshot, SectionFailure>> =>
    ctx.read.list.listAllEnveloped("variables", LiveVariable).andThen((live) => {
      if (live.length === 0) {
        return ok<WideSnapshot, SectionFailure>({ value: undefined, notes: [] });
      }
      return liveVariablesByKey(section, noun, live).map((byKey) => {
        const entries = [...byKey.values()].map((variable) =>
          projectOntoSchema(VARIABLES_ENTRIES[key], variable),
        );
        return { value: knobbedSnapshot(section, entries), notes: [] };
      });
    });

  const section: RepoVariablesSectionModule<K> = {
    key,
    undeclaredDefault: "delete",
    permission: { repo: [resource] },
    endpoints,
    shape: loosen(knobbed(VARIABLES_ENTRIES[key])),
    layering: keyedBy("name", { fold: variableKey }),
    validate: (declared) => duplicateVariableNameIssues(declared, "variable"),
    plan,
    // The family's port is the wide port at one segment; the cast is that boundary.
    snapshot: (ctx) => snapshot(ctx as SnapshotContext<WideEndpoints, GraphqlDict, K>),
  };
  return section;
}
