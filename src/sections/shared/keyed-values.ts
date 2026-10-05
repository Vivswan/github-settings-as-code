/**
 * The scaffolding the repo-scoped secret families (./repo-secrets.ts) and variable families (./repo-variables.ts)
 * share: what a section supplies, the undeclared-policy unwrap, the knobbed snapshot wrap, the wide plan every
 * family of a kind is served by, and the lockstep proving it is each family's own plan. What a value IS (sealed
 * and write-only, or readable and compared) stays in the family file: it decides the routes, the plan scope, and
 * the read-back, so those are written once per kind, not once per section.
 */

import type { Result } from "neverthrow";
import type { SectionKey, UndeclaredPolicySection } from "../../schema.js";
import type { UndeclaredPolicy, UndeclaredPolicyList } from "../../types.js";
import type { SectionFailure } from "../contract/errors.js";
import {
  defaultUndeclaredPolicy,
  type EndpointDict,
  type GraphqlDict,
  type SectionMeta,
  undeclaredPolicy,
  type ValidatedInput,
} from "../contract/module.js";
import type { PatResource } from "../contract/permissions.js";
import type {
  KeyErasedPlan,
  PlanContext,
  PlannedOp,
  Read,
  SectionPlan,
  SnapshotContext,
} from "../contract/plan.js";
import { knobbedSnapshot } from "./snapshot-helpers.js";

export interface KeyedValuesFamily<K extends SectionKey> {
  readonly key: K;
  /** The fine-grained-PAT Repository permission gating the family. */
  readonly resource: PatResource;
  /** The output noun for notes and change lines ("Actions secret", "Copilot agents variable"). */
  readonly noun: string;
}

export type Declared<Entry> = Entry[] | UndeclaredPolicyList<Entry>;

/** One family's plan() over exactly its own dictionary and declared value (the registry's exactness lockstep). */
export type FamilyPlan<K extends SectionKey, E extends EndpointDict> = (
  ctx: PlanContext<E, GraphqlDict, K>,
  declared: ValidatedInput<K>,
) => Promise<Result<SectionPlan<PlannedOp<E>>, SectionFailure>>;

/**
 * The plan a family file writes ONCE over its wide dictionary (every route the union over the kind's
 * segments): inside the generic factory the segment is unresolved, so the contract's role derivations only
 * resolve over this view. The brand on `declared` names the family it is called as.
 */
export type WidePlan<Keys extends SectionKey, Wide extends EndpointDict> = <F extends Keys>(
  ctx: PlanContext<Wide>,
  declared: ValidatedInput<F>,
) => Promise<Result<SectionPlan<PlannedOp<Wide>>, SectionFailure>>;

type WidePlanAt<F extends SectionKey, Wide extends EndpointDict> = (
  ctx: PlanContext<Wide>,
  declared: ValidatedInput<F>,
) => Promise<Result<SectionPlan<PlannedOp<Wide>>, SectionFailure>>;

type Invariant<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * The families whose own plan signature the wide plan is NOT, key brand aside: a family file pins it to
 * never, so a role the wide view carries and a family's dictionary does not (or the reverse) fails to compile
 * there instead of losing role checking silently.
 */
export type PlanMisfits<
  Keys extends SectionKey,
  Wide extends EndpointDict,
  Table extends { readonly [F in Keys]: Wide },
> = {
  [K in Keys]: Invariant<WidePlanAt<K, Wide>, KeyErasedPlan<FamilyPlan<K, Table[K]>>> extends true
    ? never
    : K;
}[Keys];

export function knobbedEntries<Entry>(
  meta: SectionMeta<UndeclaredPolicySection>,
  declared: Declared<Entry>,
): { entries: readonly Entry[]; policy: UndeclaredPolicy; defaultPolicy: UndeclaredPolicy } {
  const defaultPolicy = defaultUndeclaredPolicy(meta);
  return { ...undeclaredPolicy(declared, defaultPolicy), defaultPolicy };
}

export interface ReadBack<Entry> {
  readonly entries: Entry[];
  readonly notes: string[];
}

/** What every family of a kind reads back: one shape, since the entry slices of a kind are identical. */
export type WideSnapshot<Entry> = {
  value: UndeclaredPolicyList<Entry> | undefined;
  notes: string[];
};

export function snapshotOf<Wide extends EndpointDict, Entry>(
  meta: SectionMeta<UndeclaredPolicySection, Wide>,
  read: (ctx: SnapshotContext<Wide>) => Read<ReadBack<Entry>>,
): (ctx: SnapshotContext<Wide>) => Promise<Result<WideSnapshot<Entry>, SectionFailure>> {
  return async (ctx) =>
    (await read(ctx)).map(({ entries, notes }) => ({
      value: entries.length === 0 ? undefined : knobbedSnapshot(meta, entries),
      notes,
    }));
}
