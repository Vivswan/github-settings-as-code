/**
 * The scaffolding the repo-scoped secret families (./repo-secrets.ts) and variable families (./repo-variables.ts)
 * share: what a section supplies, the undeclared-policy unwrap, and the knobbed snapshot wrap. What a value IS
 * (sealed and write-only, or readable and compared) stays in the family file: it decides the routes, the plan
 * scope, and the read-back, so those are written once per kind, not once per section. The wide plan a family file
 * writes and the lockstep proving it is each family's own plan are the contract's (../../contract/plan.ts).
 */

import type { Result } from "neverthrow";
import type { SectionKey, UndeclaredPolicySection } from "../../../schema.js";
import type { UndeclaredPolicy, UndeclaredPolicyList } from "../../../types.js";
import type { SectionFailure } from "../../contract/errors.js";
import {
  defaultUndeclaredPolicy,
  type EndpointDict,
  type SectionMeta,
  undeclaredPolicy,
} from "../../contract/module.js";
import type { PatResource } from "../../contract/permissions.js";
import type { Read, SnapshotContext } from "../../contract/plan.js";
import { knobbedSnapshot } from "../snapshot-helpers.js";

export interface KeyedValuesFamily<K extends SectionKey> {
  readonly key: K;
  /** The fine-grained-PAT Repository permission gating the family. */
  readonly resource: PatResource;
  /** The output noun for notes and change lines ("Actions secret", "Copilot agents variable"). */
  readonly noun: string;
}

export type Declared<Entry> = Entry[] | UndeclaredPolicyList<Entry>;

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
