/**
 * GitHub's two repo-scoped variable families (Actions, Copilot agents) expose the same four endpoints under
 * a different path segment and differ only in PAT resource and noun, so each section module is ONE
 * repoVariablesSection() call. A variable is readable: the plan compares values and the snapshot writes them.
 *
 *   environments section -> plans its nested variables through ./variables-engine.ts too, one scope per environment
 */

import type { Result } from "neverthrow";
import type { z } from "zod";
import type { MustBeNever } from "../../../types.js";
import { ActionsVariableConfig } from "../../actions_variables/schema.js";
import { AgentsVariableConfig } from "../../agents_variables/schema.js";
import type { DeclaredIssue } from "../../contract/declared.js";
import type { SectionFailure } from "../../contract/errors.js";
import { type KeyedListLayering, keyedBy } from "../../contract/keyed-list.js";
import type { GraphqlDict, SectionSnapshot } from "../../contract/module.js";
import type { PatResource } from "../../contract/permissions.js";
import type {
  KeyedPlan,
  PlanMisfits,
  PlannedOp,
  SnapshotContext,
  WidePlan,
} from "../../contract/plan.js";
import { knobbed, routed } from "../schema-helpers.js";
import { projectOntoSchema } from "../snapshot-helpers.js";
import {
  type Declared,
  type KeyedValuesFamily,
  knobbedEntries,
  snapshotOf,
} from "./keyed-values.js";
import { duplicateNameIssues, liveByName, upperKey } from "./named-scope.js";
import {
  LiveVariable,
  planVariables,
  type VariableEntry,
  type VariablesPlanScope,
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

type VariablesTable = {
  readonly [F in RepoVariablesKey]: RepoVariablesEndpoints<VariablesSegment<F>>;
};

type WideEndpoints = RepoVariablesEndpoints<VariablesSegment>;

/** One family's plan(), indexed by K so the generic factory can assign its one WidePlan to it. */
type RepoVariablesPlan<K extends RepoVariablesKey> = {
  [F in RepoVariablesKey]: KeyedPlan<F, VariablesTable[F]>;
}[K];

type _WidePlanIsEveryFamilyPlan = MustBeNever<
  PlanMisfits<RepoVariablesKey, WideEndpoints, VariablesTable>
>;

/** The module shape repoVariablesSection() mints (SectionModule<K> at the registry). */
export interface RepoVariablesSectionModule<K extends RepoVariablesKey> {
  readonly key: K;
  readonly undeclaredDefault: "delete";
  readonly permission: { readonly repo: readonly [PatResource] };
  readonly endpoints: RepoVariablesEndpoints<VariablesSegment<K>>;
  readonly shape: z.ZodType;
  readonly layering: KeyedListLayering;
  readonly validate: (declared: Declared<VariableEntry>) => readonly DeclaredIssue[];
  readonly plan: RepoVariablesPlan<K>;
  readonly snapshot: (
    ctx: SnapshotContext<RepoVariablesEndpoints<VariablesSegment<K>>, GraphqlDict, K>,
  ) => Promise<Result<SectionSnapshot<K>, SectionFailure>>;
}

/**
 * Delete-undeclared-by-default: variables are readable, recreatable configuration; the wrapped
 * `_undeclared: keep` form softens deletion to notes.
 */
export function repoVariablesSection<K extends RepoVariablesKey>(
  family: KeyedValuesFamily<K>,
): RepoVariablesSectionModule<K> {
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

  const meta = {
    key,
    undeclaredDefault: "delete" as const,
    permission: { repo: [resource] as const },
    endpoints,
    shape: routed(knobbed(VARIABLES_ENTRIES[key])),
    layering: keyedBy("name", { fold: upperKey }),
  };

  const plan: WidePlan<RepoVariablesKey, WideEndpoints> = async (ctx, declared) => {
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
    return planVariables(meta, scope, knobbedEntries<VariableEntry>(meta, declared));
  };

  const snapshot = snapshotOf<WideEndpoints, VariableEntry>(meta, (ctx) =>
    ctx.read.list
      .listAllEnveloped("variables", LiveVariable)
      .andThen((live) => liveByName(meta, noun, live))
      .map((byKey) => ({
        entries: [...byKey.values()].map((variable) =>
          projectOntoSchema(VARIABLES_ENTRIES[key], variable),
        ),
        notes: [],
      })),
  );

  return {
    ...meta,
    validate: (declared) => duplicateNameIssues(declared, "variable"),
    plan,
    // The family's port is the wide port at one segment; the cast is that boundary.
    snapshot: (ctx) => snapshot(ctx as SnapshotContext<WideEndpoints, GraphqlDict, K>),
  };
}
