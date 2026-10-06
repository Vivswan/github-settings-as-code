/**
 * A section's declared value and its file-only checks, which engine/validate.ts runs inside document
 * validation, before any section writes.
 */

import { z } from "zod";
import { isPlainObject } from "../../plain-data.js";
import type { SectionKey, SettingsFile } from "../../schema.js";
import type { UndeclaredPolicyList } from "../../types.js";
import { rule } from "../shared/schema-helpers.js";
import type { PlainData } from "./plan.js";

/**
 * The entries of a list section's value in either form, by reference: the bare list, or the `{entries}` wrapper (the
 * knobbed `{_undeclared, entries}` and the plain-list `{_layering, entries}` alike). The one unwrap a planner over a
 * plain-list section performs; the knobbed ones read theirs through undeclaredPolicy(). A shape rule reads a wrapper
 * whose `entries` is raw or missing beside its own shape issue (../shared/raw-values.ts); it holds no entries.
 */
export function listEntries<E>(
  declared: readonly E[] | { readonly entries: readonly E[] },
): readonly E[] {
  if (Array.isArray(declared)) {
    return declared;
  }
  const entries: unknown = (declared as { readonly entries: readonly E[] }).entries;
  return Array.isArray(entries) ? (entries as readonly E[]) : [];
}

/**
 * A section's declared value as the schema types it. Only `undefined` (the absent-section marker) is excluded: a
 * nullable section (interaction_limits, pages) keeps its `null`. The validate and secretValues hooks take it, since
 * they run inside validation; plan() takes ValidatedInput, the same shape carrying validation's proof.
 */
export type SectionInput<K extends SectionKey> = Exclude<SettingsFile[K], undefined>;

declare const validatedInput: unique symbol;

/**
 * The brand's carrier, named so a module's declaration prints a planner's input by this name (a bundled declaration
 * cannot spell the unexported symbol). It holds the KEY the value was validated as, so a validated branches list is
 * not a labels input, whose checks it never met. An alias, not an interface: an interface has no implicit index
 * signature, so a branded mapping could no longer pass where a `Record<string, unknown>` is read.
 */
export type ValidatedBrand<K extends SectionKey = SectionKey> = { readonly [validatedInput]: K };

/**
 * The proof that validateSettingsDoc (engine/orchestrate.ts) ran section K's every file-only check over the value:
 * a brand that exists at the type level only (no runtime field), minted at that one site and read off the
 * ValidatedSettings document. Every plan() takes it, so a hand-built entry list cannot reach a planner and skip the
 * checks; the unbranded shape is read back by assignment (`const declared: SectionInput<K> = desired`). A `null`
 * value stays unbranded: it carries nothing a file-only check could judge, and no brand attaches to null.
 */
export type ValidatedInput<K extends SectionKey> = K extends SectionKey
  ? Validated<SectionInput<K>, K>
  : never;

type Validated<T, K extends SectionKey> = T extends null ? null : PlainTyped<T> & ValidatedBrand<K>;

/**
 * The declared shape as the brand's proof lets a planner read it. The checks behind the brand include the plainness
 * walk (engine/validate.ts), which found plain data at every leaf the schema left `unknown` (a catchall, a
 * passthrough record), so such a leaf reads as PlainData here. A request body assembled from declared values and
 * literals is then PlainData by type alone, with no second walk; a body carrying a part the types do not constrain
 * (a live `unknown` field copied back, a lens's wire) still proves itself through plainData() (./plan.ts).
 *
 * The leaf admits `undefined` too: a catchall's index signature must take what every optional named key beside it
 * can hold, or the bundled declaration, which spells the mapped type out, fails a strict consumer's compile.
 */
export type PlainTyped<T> = unknown extends T
  ? PlainData | undefined
  : T extends object
    ? { [P in keyof T]: PlainTyped<T[P]> }
    : T;

/**
 * A finding of a section's file-only checks (SectionModule.validate). `path` follows the section key the way a
 * zod issue's does (`[3].name`, `.entries[1].name`, "" for the whole value), so `labels[3].name: ...` reads alike
 * whichever check raised it.
 */
export interface DeclaredIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * The entries of a knobbed list in either declared form, with the path prefix they sit under, so a file-only
 * check's issue path matches the zod issue path for the same entry (`labels[1]` vs `labels.entries[1]`).
 */
export function declaredEntries<E>(declared: readonly E[] | UndeclaredPolicyList<E>): {
  readonly entries: readonly E[];
  readonly path: "" | ".entries";
} {
  return Array.isArray(declared)
    ? { entries: declared, path: "" }
    : { entries: (declared as UndeclaredPolicyList<E>).entries, path: ".entries" };
}

/**
 * Two entries resolving to one natural key would fight each other on every run. Every collision is reported, each
 * against the first entry under its key, so N duplicates cost one run to discover. `what` names the resource
 * ("label", `secret of the "prod" environment`); `at` is the offending item's path within the list (`[3].name`).
 */
export function duplicateIssues<T>(
  items: readonly T[],
  identity: {
    keyOf(item: T): string;
    describe(item: T): string;
    at(item: T, index: number): string;
  },
  what: string,
): DeclaredIssue[] {
  const seen = new Map<string, string>();
  const issues: DeclaredIssue[] = [];
  items.forEach((item, index) => {
    const key = identity.keyOf(item);
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, identity.describe(item));
      return;
    }
    issues.push({
      path: identity.at(item, index),
      message: `"${identity.describe(item)}" names the same ${what} as "${first}" declared earlier; keep exactly one entry per ${what}`,
    });
  });
  return issues;
}

/**
 * duplicateIssues over a list whose entries carry ONE identity field, in either declared form: the key is `fold`
 * of the field (the field itself when GitHub matches exactly), the description the field verbatim, and each issue
 * sits at `<wrapper path>[i].<field>`, so `labels[1].name` and `labels.entries[1].name` read alike.
 */
export function duplicateFieldIssues<F extends string, E extends Record<F, string>>(
  declared: readonly E[] | UndeclaredPolicyList<E>,
  identity: {
    readonly field: F;
    /** Folds the field to the key GitHub matches it by; omitted, GitHub matches exactly. */
    readonly fold?: (name: string) => string;
  },
  what: string,
): DeclaredIssue[] {
  const { entries, path } = declaredEntries(declared);
  const fold = identity.fold ?? ((name: string): string => name);
  return duplicateIssues(
    entries,
    {
      keyOf: (entry) => fold(entry[identity.field]),
      describe: (entry) => entry[identity.field],
      at: (_entry, index) => `${path}[${index}].${identity.field}`,
    },
    what,
  );
}

/**
 * `label` names the OWNING ENTRY (a secret name, a webhook url) so a validation error can point at it;
 * it is configuration the settings file already spells, never a value.
 */
export interface DeclaredSecretValue {
  readonly label: string;
  readonly value: string;
}

/**
 * The secret values of a list section's declared value in either form, one `extract` per entry. Every caller hands
 * it zod's output (engine/validate.ts after the shape parse, engine/secrets.ts the validated document), so the
 * entries are the section's own type and a malformed value is validation's to report, never this walk's.
 */
export function secretValuesOf<E>(
  declared: readonly E[] | { readonly entries: readonly E[] },
  extract: (entry: E) => readonly DeclaredSecretValue[],
): DeclaredSecretValue[] {
  return listEntries(declared).flatMap((entry) => [...extract(entry)]);
}

/**
 * zod's object schemas accept any non-array object, so a YAML-tagged scalar like !!timestamp (a Date)
 * would validate as an empty mapping and silently configure nothing.
 *
 *   scalars, arrays, null    -> pass through, so the piped shape reports its own error
 *   applied by               -> the sections whose whole value is one mapping (repository, the setups, interaction_limits)
 *   document-wide backstop   -> the raw non-plain walk in engine/validate.ts (validateSectionShapes)
 */
export function requirePlainMapping(shape: z.ZodType): z.ZodType {
  return z
    .unknown()
    .check(
      rule((value, ctx) => {
        const isMapping = value !== null && typeof value === "object" && !Array.isArray(value);
        if (isMapping && !isPlainObject(value)) {
          ctx.addIssue({
            code: "custom",
            message:
              "Invalid input: expected a plain mapping (a YAML-tagged value like !!timestamp parses to another type)",
          });
        }
      }),
    )
    .pipe(shape);
}

export type EntryOf<T> = T extends readonly (infer E)[]
  ? E
  : T extends { entries: readonly (infer E)[] }
    ? E
    : never;
