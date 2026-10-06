/**
 * The list-section factory: upsert-by-natural-key plus keep-or-delete-undeclared as ONE declaration
 * (slice, roles, identity, address, lens, prose) from which plan(), snapshot(), the loose shape, the
 * mock's transformers, and the fuzz witness derive. Prose enters through the two undeclared hooks and
 * the reasons `concealed` and `foreign` return; a section needing more stays bespoke.
 */

import type { Result } from "neverthrow";
import type { SectionFailure } from "../../contract/errors.js";
import {
  type DeclaredSecretValue,
  type SectionSnapshot,
  secretValuesOf,
} from "../../contract/module.js";
import type { PlanContext, PlannedOp, SectionPlan } from "../../contract/plan.js";
import { knobbed, routed } from "../schema-helpers.js";
import type {
  Declared,
  ErasedDecl,
  ErasedDeclared,
  ListEndpoints,
  ListSectionDecl,
  ListSectionKey,
  ListSectionModule,
} from "./decl.js";
import { planList, validateList } from "./plan.js";
import { snapshotList } from "./snapshot.js";
import { identityClaims, pathOf, valueAt } from "./write.js";

/**
 * valueAt() walks the erased entry, so a declared secret field reads as `unknown`: absent on an entry that leaves
 * the optional field out, a string otherwise, like the identity beside it. The narrowing is that walk's, not a
 * second proof of the shape.
 */
function secretValuesFor(
  decl: ErasedDecl<string>,
  declared: ErasedDeclared,
): DeclaredSecretValue[] {
  const fields = decl.secrets ?? [];
  return secretValuesOf(declared, (entry) =>
    fields.flatMap((field) => {
      const value = valueAt(entry, pathOf(field));
      if (typeof value !== "string") {
        return [];
      }
      const name = valueAt(entry, pathOf(decl.identity.field));
      const label =
        typeof name === "string" && name !== ""
          ? `the ${decl.noun} "${name}" ${field}`
          : `a ${decl.noun} entry's ${field}`;
      return [{ label, value }];
    }),
  );
}

/**
 * The planner runs over the erased view while the module surface stays typed over the literal dictionary
 * and declared value the registry pins; the casts are that one boundary.
 */
export function listSection<
  K extends ListSectionKey,
  const Ends extends ListEndpoints,
  Live extends object,
  F extends string,
  Key extends string,
  M extends string = never,
>(decl: ListSectionDecl<K, Ends, Live, F, Key, M>): ListSectionModule<K, Ends, Live, F, Key, M> {
  const erased = decl as unknown as ErasedDecl<Key>;
  const section: ListSectionModule<K, Ends, Live, F, Key, M> = {
    key: decl.key,
    permission: decl.permission,
    undeclaredDefault: decl.undeclaredDefault,
    endpoints: decl.endpoints,
    shape: routed(knobbed(decl.entry)),
    ...(decl.secrets === undefined
      ? {}
      : {
          secretValues: (declared: Declared<K>) =>
            secretValuesFor(erased, declared as unknown as ErasedDeclared),
        }),
    layering: {
      keys: (entry) => identityClaims(erased.identity, entry),
      keyField: decl.identity.field,
      ...(decl.layering?.nested === undefined ? {} : { nested: decl.layering.nested }),
    },
    validate: (declared) => validateList(erased, declared as unknown as ErasedDeclared),
    plan: (ctx, desired) =>
      planList(
        erased,
        section,
        ctx as unknown as PlanContext<ListEndpoints>,
        desired as unknown as ErasedDeclared,
      ) as unknown as Promise<Result<SectionPlan<PlannedOp<Ends>>, SectionFailure>>,
    snapshot: (ctx) =>
      snapshotList(
        erased,
        section,
        ctx as unknown as PlanContext<ListEndpoints>,
      ) as unknown as Promise<Result<SectionSnapshot<K>, SectionFailure>>,
    decl,
  };
  return section;
}
