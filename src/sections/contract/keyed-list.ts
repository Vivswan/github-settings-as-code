/**
 * A list section's identity: the field its entries are told apart by, which engine/layers.ts folds
 * them under.
 */

import type { ListSection } from "../../schema.js";
import type { MustBeNever, UndeclaredPolicy, UndeclaredPolicyList } from "../../types.js";
import type { Layering } from "../shared/schema-helpers.js";
import {
  type DeclaredIssue,
  duplicateFieldIssues,
  type EntryOf,
  type SectionInput,
} from "./declared.js";

/**
 * engine/layers.ts pairs two entries when their key sets intersect, the planner's own duplicate test,
 * so a merged document is always one the planner accepts; the directive (replace, shallow, deep) is the
 * layer's to choose, never the module's.
 */
export interface KeyedListLayering {
  /**
   * Folded as the planner folds them (a label claims its name plus its pre-rename name); null when the
   * entry carries none, which the layer boundary refuses.
   */
  readonly keys: (entry: Readonly<Record<string, unknown>>) => readonly string[] | null;
  /** The entry field the keys come from, for refusal prose ("name", "type"). */
  readonly keyField: string;
  /** The field's kind in the same prose ("string" unless said otherwise; a reviewer's `id` is "numeric"). */
  readonly keyKind?: string;
  /**
   * Fields of a merged entry that are themselves keyed lists (rulesets' `rules`, an environment's `variables`). A
   * nested list arrives as a bare list or a nested `{_undeclared, entries}` wrapper and unions by its own key under
   * the directive its entry inherits; its wrapper takes no `_layering` (nestedKnobbed in ../shared/schema-helpers.ts).
   */
  readonly nested?: Readonly<Record<string, KeyedListLayering>>;
  /**
   * The dotted paths a `_remove: true` entry may carry beside the marker: the key field's own unless the key spans
   * several (a reviewer is its `type` and `id`). Any other path on a removal is refused at the layer boundary by name.
   */
  readonly removalPaths?: readonly string[];
  /**
   * A NESTED list's `_undeclared` default (an environment's variables), the last fallback engine/undeclared.ts resolves a
   * nested wrapper without a policy to; absent on a nested list that takes no knob (a ruleset's rules, reviewers).
   * test/sections/registry.test.ts pins it to the nested wrappers the schema declares.
   */
  readonly undeclaredDefault?: UndeclaredPolicy;
}

/** A list keyed by one string field of each entry, folded as the planner's duplicate check folds it. */
export function keyedBy(
  keyField: string,
  options: {
    readonly fold?: (name: string) => string;
    readonly nested?: Readonly<Record<string, KeyedListLayering>>;
    readonly undeclaredDefault?: UndeclaredPolicy;
  } = {},
): KeyedListLayering {
  const fold = options.fold ?? ((name: string) => name);
  return {
    keyField,
    keys: (entry) => {
      const value = entry[keyField];
      return typeof value === "string" ? [fold(value)] : null;
    },
    ...(options.nested === undefined ? {} : { nested: options.nested }),
    ...(options.undeclaredDefault === undefined
      ? {}
      : { undeclaredDefault: options.undeclaredDefault }),
  };
}

/** The string-valued fields of a list section's entry, the ones it can be identified by. */
type StringField<K extends ListSection> = {
  [F in keyof EntryOf<SectionInput<K>> & string]: EntryOf<SectionInput<K>>[F] extends string
    ? F
    : never;
}[keyof EntryOf<SectionInput<K>> & string];

/**
 * A bespoke list module's key, layering, and duplicate check from one declaration of its identity field and fold,
 * as listSection derives them from `identity`. Spread it into the module in place of `key`; a module with further
 * file-only checks declares a validate() after the spread that reads this one first.
 */
export function identifiedBy<K extends ListSection, F extends StringField<K>>(
  key: K,
  keyField: F,
  noun: string,
  options: {
    readonly fold?: (name: string) => string;
    readonly nested?: Readonly<Record<string, KeyedListLayering>>;
  } = {},
): {
  readonly key: K;
  readonly layering: KeyedListLayering;
  validate(declared: SectionInput<K>): DeclaredIssue[];
} {
  return {
    key,
    layering: keyedBy(keyField, options),
    validate: (declared) =>
      duplicateFieldIssues(
        // A list section's input is its entries in either declared form; the generic key cannot show the compiler.
        declared as unknown as
          | readonly Record<F, string>[]
          | UndeclaredPolicyList<Record<F, string>>,
        { field: keyField, fold: options.fold },
        noun,
      ),
  };
}

/** The wrapper type in ../../types.ts is zod-free and spells the directive's values itself; both pins fail when the two sets part. */
type _WrapperLayeringComplete = MustBeNever<
  Exclude<Layering, NonNullable<UndeclaredPolicyList<unknown>["_layering"]>>
>;
type _WrapperLayeringSound = MustBeNever<
  Exclude<NonNullable<UndeclaredPolicyList<unknown>["_layering"]>, Layering>
>;
