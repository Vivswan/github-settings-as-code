/**
 * A type a section reaches through its declaration or the module it mints is exported from here: the
 * bundled declarations cannot name a private one, and the package-smoke job fails.
 */

import type { Result } from "neverthrow";
import type { z } from "zod";
import type { MatchKey } from "../../../engine/diff.js";
import type { SettingsFile, UndeclaredPolicySection } from "../../../schema.js";
import type { UndeclaredPolicy, UndeclaredPolicyList } from "../../../types.js";
import type {
  DeclaredIssue,
  DeclaredSecretValue,
  EntryOf,
  ValidatedInput,
} from "../../contract/declared.js";
import type { undeclaredDrift, undeclaredNote } from "../../contract/drift.js";
import type { EndpointDecl, PathParams, Route } from "../../contract/endpoints.js";
import type { SectionFailure } from "../../contract/errors.js";
import type { KeyedListLayering } from "../../contract/keyed-list.js";
import type { GraphqlDict, SectionSnapshot } from "../../contract/module.js";
import type { SectionPermission } from "../../contract/permissions.js";
import type {
  PlainData,
  PlanContext,
  PlannedOp,
  SectionPlan,
  SnapshotContext,
} from "../../contract/plan.js";

/** A list section enumerates its live resources, so it is exactly a section with an undeclared policy. */
export type ListSectionKey = UndeclaredPolicySection;

export type Declared<K extends ListSectionKey> = Exclude<SettingsFile[K], undefined>;

type Entry<K extends ListSectionKey> = EntryOf<NonNullable<SettingsFile[K]>>;

type Paramless<R extends Route> = R extends Route
  ? [PathParams<R>] extends [never]
    ? R
    : never
  : never;

export type UpdateDecl = EndpointDecl & {
  readonly route: Extract<Route, `PATCH ${string}` | `PUT ${string}`>;
};

type RemoveDecl = EndpointDecl & { readonly route: Extract<Route, `DELETE ${string}`> };

/** The full body of one item, for a list that carries only a summary; never the primary read. */
type GetDecl = EndpointDecl & {
  readonly route: Extract<Route, `GET ${string}`>;
  readonly primaryRead?: never;
};

/**
 * `update` exists only when GitHub can edit the resource; without it a drifted item is deleted and
 * recreated. `updateConfig` sets one nested mapping field by field where the general update would
 * replace it whole (a webhook's config); `get` reads an item's full body when the list carries only a
 * summary (a ruleset). A type alias, so it keeps EndpointDict's index signature.
 */
export type ListEndpoints = {
  readonly list: EndpointDecl & {
    readonly route: Paramless<Extract<Route, `GET ${string}`>>;
    readonly primaryRead: { readonly notFound: "denied" };
  };
  readonly create: EndpointDecl & { readonly route: Paramless<Extract<Route, `POST ${string}`>> };
} & (
  | { readonly remove: RemoveDecl }
  | { readonly update: UpdateDecl; readonly remove: RemoveDecl }
  | { readonly update: UpdateDecl; readonly remove: RemoveDecl; readonly updateConfig: UpdateDecl }
) &
  // biome-ignore lint/complexity/noBannedTypes: `{}` is the "no get role" arm; an optional key would admit undefined into the dictionary
  ({} | { readonly get: GetDecl });

/** The roles every list section declares, which the derived mock fragment serves. */
export type ListRoleName = "list" | "create" | "update" | "remove";

type UnionToIntersection<U> = (U extends unknown ? (member: U) => void : never) extends (
  member: infer I,
) => void
  ? I
  : never;

type IsUnion<T> = [T] extends [UnionToIntersection<T>] ? false : true;

/**
 * Pins a dictionary to the factory's roles at the declaration. An intersection, so the index signature stays.
 *
 *   a union of dictionaries          -> refused (a union hides its members' roles from keyof)
 *   a seventh role                   -> never
 *   `update` not PATCH or PUT        -> refused (a DELETE would pass the immutable arm's structural match)
 *   `updateConfig` without `update`  -> refused (the general update carries the fields outside the mapping)
 */
type OnlyListRoles<Ends> = (IsUnion<Ends> extends true ? never : unknown) &
  ("updateConfig" extends keyof Ends
    ? "update" extends keyof Ends
      ? unknown
      : never
    : unknown) & {
    readonly [R in Exclude<keyof Ends, ListRoleName | "get" | "updateConfig">]: never;
  } & { readonly [R in keyof Ends & "update"]: UpdateDecl } & {
    readonly [R in keyof Ends & "updateConfig"]: UpdateDecl;
  } & { readonly [R in keyof Ends & "get"]: GetDecl };

/**
 * The write fields a `secrets` declaration may name: a dotted path under `mapping` (the field the
 * `updateConfig` role writes), admitted only where both carriers (`create` and `updateConfig`) declare
 * `unverifiable: true`, since the value is re-sent on every run; an immutable resource admits none.
 */
type SecretPath<Ends, M extends string> = Ends extends {
  readonly create: { readonly unverifiable: true };
  readonly updateConfig: { readonly unverifiable: true };
}
  ? `${M}.${string}`
  : never;

export function updateRole(endpoints: ListEndpoints): UpdateDecl | undefined {
  return "update" in endpoints ? endpoints.update : undefined;
}

type RouteOf<Ends, R extends string> = Ends extends {
  readonly [P in R]: { readonly route: infer U extends string };
}
  ? U
  : never;

/** Every route addressing ONE live item; they all read the same params off `address`. */
type ItemRoutes<Ends> =
  | RouteOf<Ends, "remove">
  | RouteOf<Ends, "update">
  | RouteOf<Ends, "updateConfig">
  | RouteOf<Ends, "get">;

type SameParamsAs<R extends string, P extends string> = R extends string
  ? [PathParams<R>] extends [P]
    ? [P] extends [PathParams<R>]
      ? true
      : false
    : false
  : never;

/**
 * One address serves every item route, so they must spell the SAME params; a dictionary whose item
 * routes disagree collapses to never.
 */
type Address<Ends extends ListEndpoints> =
  false extends SameParamsAs<ItemRoutes<Ends>, PathParams<ItemRoutes<Ends>>>
    ? never
    : Readonly<Record<PathParams<ItemRoutes<Ends>>, string>>;

/**
 * The identity field's home in a write: a top-level key, or a dotted path into a nested mapping (a
 * webhook's config.url), each nested level keeping the write's own index signature for its siblings.
 */
type Carrier<F extends string, Siblings> = F extends `${infer Head}.${infer Rest}`
  ? { readonly [P in Head]: Carrier<Rest, Siblings> & Siblings }
  : { readonly [P in F]: string };

/**
 * Declared fields only: an omitted optional stays OUT (never undefined), so it is neither written nor compared.
 * A section narrows it to pin a folded field's brand on its lens (labels' HexColor).
 */
export type ListWrite<F extends string> = Carrier<F, { readonly [key: string]: PlainData }> & {
  readonly [key: string]: PlainData;
};

/** A live item in the same terms, each field normalized as GitHub stores it. */
export type ListComparable<F extends string> = Carrier<F, Readonly<Record<string, unknown>>> &
  Readonly<Record<string, unknown>>;

/** The fold of a section GitHub matches exactly: the key IS the name. */
export function exactName(name: string): string {
  return name;
}

/** The keep-note wording; `action` overrides `undeclaredAction` for the note alone (a milestone's closing hint). */
type NoteWording = Pick<Parameters<typeof undeclaredNote>[0], "state" | "add" | "manage"> &
  Partial<Pick<Parameters<typeof undeclaredNote>[0], "action">>;

type DriftWording = Pick<Parameters<typeof undeclaredDrift>[1], "state" | "add" | "keep">;

/** `unpaginated` also drives the derived mock's list handler (test/e2e/mock/list-fragment.ts). */
interface Listing {
  /** The query the list carries (milestones' state=all: the default listing omits closed items). */
  readonly query?: Readonly<Record<string, string>>;

  /** GitHub serves the whole list in one response and ignores page params (autolinks), so the page loop is skipped. */
  readonly unpaginated?: true;
}

/**
 * A declared field GitHub omits from a live item the token lacks access for (a ruleset's bypass_actors
 * under a read grant): plan() compares around it and notes it, snapshot() leaves the item out.
 */
interface ConcealedField {
  /** The write field GitHub withholds, as a dotted path. */
  readonly field: string;

  /** Why GitHub withholds it ("GitHub returns it only to a token with write access to the ruleset"). */
  readonly reason: string;

  /** The grant that lifts it, as an imperative clause ("grant Administration write"). */
  readonly remedy: string;
}

/**
 * ONE string literal: not `string`, not `never`, not a union, not a pattern (`Lowercase<string>`, a
 * template with a `${string}` or `${any}` hole). A mapped type over one literal has a required property,
 * so the empty object is not assignable to it; over anything else it has an index signature or nothing.
 */
type IsStringLiteral<M extends string> =
  IsUnion<M> extends true ? false : Record<never, never> extends { [P in M]: 0 } ? false : true;

/**
 * With an `updateConfig` role, the entry field holding the mapping that endpoint sets field by field;
 * `M` is its literal, so SecretPath can demand that every secret path sit under it. ONE literal: a
 * union, `string`, or a pattern would admit a path under a mapping the declaration does not have, and
 * the planner would route that secret through the general update, so it is refused. The type catches an
 * ACCIDENTAL dotted secret path outside the declared mapping; a declaration written to defeat it (a
 * mapping cast to a type the check does not see) is deliberate and out of its scope.
 */
type MappingFacet<K extends ListSectionKey, Ends, M extends string> = Ends extends {
  readonly updateConfig: EndpointDecl;
}
  ? { readonly mapping: IsStringLiteral<M> extends true ? M & keyof Entry<K> : never }
  : { readonly mapping?: never };

interface Identity<K extends ListSectionKey, F extends string, Key extends string> {
  /** The write field naming the resource, as the live item carries it ("name", "title", "config.url"). */
  readonly field: F;

  /** Folds a name to the key GitHub matches it by; `exactName` when GitHub matches exactly. */
  readonly fold: (name: string) => Key;

  /** Names an entry also answers to (a label's pre-rename `name`), so a live item under one is this entry's, renamed by the update, not undeclared. */
  readonly aliases?: (entry: Entry<K>) => readonly string[];
}

/**
 * The update body's key for the name when GitHub renames through another one (labels' `new_name`);
 * omitted, the name travels under `field`. Only a top-level identity field renames.
 *
 *   entry declares a value under it  -> it is renaming: that value is the name it writes (the lens puts it under `field`)
 *   the entry's `field`              -> its current name
 */
type RenameFacet<F extends string> = F extends `${string}.${string}`
  ? { readonly renameKey?: never }
  : { readonly renameKey?: string };

/**
 * `Key` is the fold's output: the planner keys every live-versus-declared lookup by it, so an unfolded
 * name cannot be looked up, and a section's brand (labels' NameKey) survives to `decl`. `M` infers from
 * `mapping` alone (NoInfer on `secrets`), so a stray secret path is the error, never a re-inferred mapping.
 */
export type ListSectionDecl<
  K extends ListSectionKey,
  Ends extends ListEndpoints,
  Live extends object,
  F extends string,
  Key extends string,
  M extends string = never,
> = ListSectionDeclFields<K, Ends, Live, F, Key, M> & MappingFacet<K, Ends, M>;

/**
 * The declaration a list section hands listSection(). The lens puts the entry and the live item in one vocabulary,
 * so `fromLive` reads a live item in toWrite's terms:
 *
 *   identity field          -> verbatim
 *   other declared fields   -> normalized as GitHub stores them (a color lowercased without "#", a null description as "")
 *   every other live field  -> kept, so declared passthrough keys compare against what the API echoed
 *
 * `conflicts` are the clashes the identities cannot show, each naming the fix; any finding fails the section:
 *
 *   declared  -> sees only the writes and runs inside document validation, before ANY section writes
 *                (a settings-file mistake costs no request); `[i]` indexes the writes as the entries
 *   live      -> runs after the read and before any write (a deploy key's material held by another key)
 */
interface ListSectionDeclFields<
  K extends ListSectionKey,
  Ends extends ListEndpoints,
  Live extends object,
  F extends string,
  Key extends string,
  M extends string,
> {
  /** As SectionMeta.key. */
  readonly key: K;

  /** As SectionMeta.permission. */
  readonly permission: SectionPermission;

  /** As SectionMeta.undeclaredDefault: "delete" or "keep", since a list section enumerates its live resources. */
  readonly undeclaredDefault: UndeclaredPolicy;

  /** The output noun for change lines and notes ("label"). */
  readonly noun: string;

  /** The entry config slice (src/sections/<key>/schema.ts); the loose shape derives from it. */
  readonly entry: z.ZodType<Entry<K>>;

  /** The fields of a live item the section reads (a list item, and the `get` body when the role exists); extras ride along. */
  readonly live: z.ZodType<Live>;

  /** The roles the factory derives its handlers from, pinned to exactly those by OnlyListRoles. */
  readonly endpoints: Ends & OnlyListRoles<Ends>;

  /** How the list is read: a query on every page, or one unpaginated GET. */
  readonly listing?: Listing;

  /** The field entries and live items are matched by, with its fold and aliases. */
  readonly identity: Identity<K, F, Key> & RenameFacet<F>;

  /** The path params addressing one live item for every item role; unrepresentable when the routes disagree. */
  readonly address: [Address<Ends>] extends [never] ? never : (live: Live) => Address<Ends>;

  /** The entry and the live item in one vocabulary, and the body the request spells. */
  readonly lens: {
    /** The entry as a converged live item reads back, and the request body itself unless `wire` renders it. */
    readonly toWrite: (entry: Entry<K>) => ListWrite<F>;

    /** A live item in toWrite's terms (the rows above); a live item the section cannot compare (a ruleset repeating a rule type) is the failure that ends the plan or snapshot. */
    readonly fromLive: (live: Live) => Result<ListComparable<F>, SectionFailure>;

    /** The body as the request spells it when that differs from the compared form (a milestone's due day as noon UTC): every body the planner sends, nothing the comparison or the snapshot reads. */
    readonly wire?: (write: ListWrite<F>) => ListWrite<F>;

    /** Per entry field holding a list, the item key to pair by (see DeltaOptions.matchBy); `{}` when none does. */
    readonly matchBy: Readonly<Partial<Record<keyof Entry<K> & string, MatchKey>>>;
  };

  /** Whether the update replaces the live item whole (a ruleset's PUT), so a non-empty live value the entry omits is drift and apply refuses the write; required, so a replace-style section cannot inherit the PATCH comparison by leaving it out. */
  readonly replaces: boolean;

  /** The body recreating a drifted item of a resource GitHub cannot edit (no update role), when the write alone would drop a live field the file leaves undeclared (a deploy key's read_only). */
  readonly recreate?: "update" extends keyof Ends
    ? never
    : (live: Live, write: ListWrite<F>) => ListWrite<F>;

  /** File-only checks beyond identity uniqueness (a deploy key's material must parse), one issue per finding at its path (`[2].key`); the engine runs them inside document validation, so toWrite may treat such an entry as a BUG. */
  readonly validate?: (entries: readonly Entry<K>[]) => readonly DeclaredIssue[];

  /** Conflicts the identities cannot show (the rows above); any finding fails the section. */
  readonly conflicts?: {
    readonly declared?: (writes: readonly ListWrite<F>[]) => readonly DeclaredIssue[];
    readonly live?: (
      writes: readonly ListWrite<F>[],
      live: readonly ListComparable<F>[],
    ) => readonly string[];
  };

  /** Why a live item is outside what the section manages (an inherited ruleset, a legacy service hook), or null for the section's own; plan() neither matches nor removes it, snapshot() leaves it out with the reason. */
  readonly foreign?: (live: Live) => { readonly name: string; readonly reason: string } | null;

  /** Read off the full body (the `get` role's when it exists); see ConcealedField. */
  readonly concealed?: (live: Live) => readonly ConcealedField[];

  /** Dotted write paths holding a `$NAME` reference GitHub never echoes back (a webhook's config.secret): left out of the comparison, resolved at execution, re-sent every run under an unverifiable facet, and read back as a per-item reference. */
  readonly secrets?: readonly SecretPath<Ends, NoInfer<M>>[];

  /** The undeclared wording: what apply does, and the optional rewordings of the keep-note and the delete drift. */
  readonly prose: {
    /** What apply does to an undeclared live resource, as the note and drift spell it ("DELETE it"). */
    readonly undeclaredAction: string;

    /** Rewords the keep-note (see NoteWording). */
    readonly undeclaredNote?: NoteWording;

    /** Rewords the delete drift line (see DriftWording). */
    readonly undeclaredDrift?: DriftWording;
  };

  /** The nested keyed lists alone: the pairing derives from `identity`, the claims the planner's duplicate check reads, so the merge and the planner cannot disagree about which entries are one. */
  readonly layering?: Pick<KeyedListLayering, "nested">;
}

/** The module listSection() mints: SectionModule<K, Ends> at the registry, plus `decl`, the declaration the harness derives from (the mock's transformers, the fuzz witness). */
export interface ListSectionModule<
  K extends ListSectionKey,
  Ends extends ListEndpoints,
  Live extends object,
  F extends string,
  Key extends string,
  M extends string = never,
> {
  readonly key: K;
  readonly permission: SectionPermission;
  readonly undeclaredDefault: UndeclaredPolicy;
  readonly endpoints: Ends;
  readonly shape: z.ZodType;
  readonly secretValues?: (declared: Declared<K>) => DeclaredSecretValue[];
  readonly layering: KeyedListLayering;
  readonly validate: (declared: Declared<K>) => readonly DeclaredIssue[];
  readonly plan: (
    ctx: PlanContext<Ends, GraphqlDict, K>,
    desired: ValidatedInput<K>,
  ) => Promise<Result<SectionPlan<PlannedOp<Ends>>, SectionFailure>>;
  readonly snapshot: (
    ctx: SnapshotContext<Ends, GraphqlDict, K>,
  ) => Promise<Result<SectionSnapshot<K>, SectionFailure>>;
  readonly decl: ListSectionDecl<K, Ends, Live, F, Key, M>;
}

/**
 * Entries and live items erased to objects; the planner only hands them back to the declaration's own
 * functions. The fold's key type stays: it is what the planner's lookups are keyed by.
 */
export interface ErasedDecl<Key extends string> {
  readonly key: ListSectionKey;
  readonly noun: string;
  readonly entry: z.ZodType<object>;
  readonly live: z.ZodType<object>;
  readonly endpoints: ListEndpoints;
  readonly listing?: Listing;
  readonly identity: {
    readonly field: string;
    readonly fold: (name: string) => Key;
    readonly aliases?: (entry: object) => readonly string[];
    readonly renameKey?: string;
  };
  readonly address: (live: object) => Readonly<Record<string, string>>;
  readonly lens: {
    readonly toWrite: (entry: object) => ListWrite<string>;
    readonly fromLive: (live: object) => Result<ListComparable<string>, SectionFailure>;
    readonly wire?: (write: ListWrite<string>) => ListWrite<string>;
    readonly matchBy: Readonly<Record<string, MatchKey>>;
  };
  readonly replaces: boolean;
  readonly mapping?: string;
  readonly recreate?: (live: object, write: ListWrite<string>) => ListWrite<string>;
  readonly validate?: (entries: readonly object[]) => readonly DeclaredIssue[];
  readonly conflicts?: {
    readonly declared?: (writes: readonly ListWrite<string>[]) => readonly DeclaredIssue[];
    readonly live?: (
      writes: readonly ListWrite<string>[],
      live: readonly ListComparable<string>[],
    ) => readonly string[];
  };
  readonly foreign?: (live: object) => { readonly name: string; readonly reason: string } | null;
  readonly concealed?: (live: object) => readonly ConcealedField[];
  readonly secrets?: readonly string[];
  readonly prose: ListSectionDeclFields<
    ListSectionKey,
    ListEndpoints,
    object,
    string,
    Key,
    string
  >["prose"];
}

export type ErasedDeclared = readonly object[] | UndeclaredPolicyList<object>;
