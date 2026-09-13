/**
 * The list-section factory: upsert-by-natural-key plus keep-or-delete-undeclared as ONE declaration
 * (slice, roles, identity, address, lens, prose) from which plan(), snapshot(), the loose shape, the
 * mock's transformers, and the fuzz witness derive. Prose enters through the two undeclared hooks and
 * the reasons `concealed` and `foreign` return; a section needing more stays bespoke.
 */

import { z } from "zod";
import { type Delta, deltas, phantomNote, renderDelta } from "../../engine/diff.js";
import { snapshotSecretReference } from "../../engine/secrets.js";
import type { SettingsFile, UndeclaredPolicySection } from "../../schema.js";
import type { UndeclaredPolicy, UndeclaredPolicyList } from "../../types.js";
import type { EndpointDecl, PathParams, Route } from "../contract/endpoints.js";
import { liveByIdentity, liveIdentity, plural } from "../contract/live.js";
import {
  cannotVerifyNote,
  type DeclaredSecretValue,
  defaultUndeclaredPolicy,
  type EntryOf,
  type GraphqlDict,
  type KeyedListLayering,
  loosen,
  missingDrift,
  type SectionMeta,
  type SectionSnapshot,
  secretValuesOf,
  undeclaredDrift,
  undeclaredNote,
  undeclaredPolicy,
  valueDrift,
} from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import {
  type ExecTools,
  hasDrift,
  type PlainData,
  type PlanContext,
  type PlannedOp,
  plainData,
  type SectionPlan,
  type SnapshotContext,
  type Unverifiable,
} from "../contract/plan.js";
import { rejectDuplicates } from "../contract/requests.js";
import { knobbed } from "./schema-helpers.js";
import {
  knobbedSnapshot,
  leftOutOfSnapshot,
  projectOntoSchema,
  unreadableSecretNote,
} from "./snapshot-helpers.js";

/** A list section enumerates its live resources, so it is exactly a section with an undeclared policy. */
export type ListSectionKey = UndeclaredPolicySection;

type Declared<K extends ListSectionKey> = Exclude<SettingsFile[K], undefined>;

type Entry<K extends ListSectionKey> = EntryOf<NonNullable<SettingsFile[K]>>;

type Paramless<R extends Route> = R extends Route
  ? [PathParams<R>] extends [never]
    ? R
    : never
  : never;

type UpdateDecl = EndpointDecl & {
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
  /**
   * Names an entry also answers to (a label's pre-rename `name`), so a live item under one is this
   * entry's, renamed by the update, not undeclared.
   */
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
 * name cannot be looked up, and a section's brand (labels' NameKey) survives to `decl`.
 */
export type ListSectionDecl<
  K extends ListSectionKey,
  Ends extends ListEndpoints,
  Live extends object,
  F extends string,
  Key extends string,
  M extends string = never,
> = ListSectionDeclFields<K, Ends, Live, F, Key, M> & MappingFacet<K, Ends, M>;

interface ListSectionDeclFields<
  K extends ListSectionKey,
  Ends extends ListEndpoints,
  Live extends object,
  F extends string,
  Key extends string,
  M extends string,
> {
  readonly key: K;
  readonly permission: SectionPermission;
  readonly undeclaredDefault: UndeclaredPolicy;
  /** The output noun for change lines and notes ("label"). */
  readonly noun: string;
  /** The entry config slice (src/sections/<key>/schema.ts); the loose shape derives from it. */
  readonly entry: z.ZodType<Entry<K>>;
  /** The fields of a live item the section reads (a list item, and the `get` body when the role exists); extras ride along. */
  readonly live: z.ZodType<Live>;
  readonly endpoints: Ends & OnlyListRoles<Ends>;
  readonly listing?: Listing;
  readonly identity: Identity<K, F, Key> & RenameFacet<F>;
  /** The path params addressing one live item for every item role; unrepresentable when the routes disagree. */
  readonly address: [Address<Ends>] extends [never] ? never : (live: Live) => Address<Ends>;
  readonly lens: {
    /** The entry in wire terms: the create body, and what a converged live item reads back as. */
    readonly toWrite: (entry: Entry<K>) => ListWrite<F>;
    /**
     * A live item in the same terms as toWrite, so the two compare field by field.
     *
     *   identity field          -> verbatim
     *   other declared fields   -> normalized as GitHub stores them (a color lowercased without "#", a null description as "")
     *   every other live field  -> kept, so declared passthrough keys compare against what the API echoed
     */
    readonly fromLive: (live: Live) => ListComparable<F>;
    /** Per entry field holding a list, the item key to pair by (see DeltaOptions.matchBy); `{}` when none does. */
    readonly matchBy: Readonly<Partial<Record<keyof Entry<K> & string, string>>>;
  };
  /**
   * The body recreating a drifted item of a resource GitHub cannot edit (no update role), when the
   * write alone would drop a live field the file leaves undeclared (a deploy key's read_only).
   */
  readonly recreate?: "update" extends keyof Ends
    ? never
    : (live: Live, write: ListWrite<F>) => ListWrite<F>;
  /**
   * Conflicts the identities cannot show, one line each naming the fix; any line fails the section.
   *
   *   `declared`  -> sees only the entries and runs BEFORE the read (a settings-file mistake costs no request)
   *   `live`      -> runs after the read and before any write (a deploy key's material held by another key)
   */
  readonly conflicts?: {
    readonly declared?: (writes: readonly ListWrite<F>[]) => readonly string[];
    readonly live?: (
      writes: readonly ListWrite<F>[],
      live: readonly ListComparable<F>[],
    ) => readonly string[];
  };
  /**
   * The reason a live item is outside what the section manages (an inherited ruleset, a legacy
   * service hook), or null when it is the section's own: plan() neither matches nor removes it,
   * snapshot() leaves it out under `name` with the reason.
   */
  readonly foreign?: (live: Live) => { readonly name: string; readonly reason: string } | null;
  /** Read off the full body (the `get` role's when it exists); see ConcealedField. */
  readonly concealed?: (live: Live) => readonly ConcealedField[];
  /**
   * Write fields (dotted paths) holding a `$NAME` reference to a value GitHub never echoes back (a
   * webhook's config.secret): left out of the comparison, resolved when the write executes, re-sent
   * on every run under an unverifiable facet, and read back by a snapshot as a per-item reference.
   * SecretPath admits a path only under `mapping`, and only where its carriers declare the facet; `mapping`
   * alone infers `M`, so a stray path is the error, never a re-inferred mapping.
   */
  readonly secrets?: readonly SecretPath<Ends, NoInfer<M>>[];
  readonly prose: {
    /** What apply does to an undeclared live resource, as the note and drift spell it ("DELETE it"). */
    readonly undeclaredAction: string;
    readonly undeclaredNote?: NoteWording;
    readonly undeclaredDrift?: DriftWording;
  };
  /**
   * Omitted, the list always replaces. The pairing itself is derived from `identity`, the very claims the
   * planner's duplicate check reads, so the merge and the planner cannot disagree about which entries are one.
   */
  readonly layering?: Pick<KeyedListLayering, "combine" | "nested">;
}

/** The module listSection() mints: SectionModule<K, Ends> at the registry, plus its declaration. */
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
  readonly layering?: KeyedListLayering;
  readonly plan: (
    ctx: PlanContext<Ends, GraphqlDict, K>,
    desired: Declared<K>,
  ) => Promise<SectionPlan<PlannedOp<Ends>>>;
  readonly snapshot: (ctx: SnapshotContext<Ends, GraphqlDict, K>) => Promise<SectionSnapshot<K>>;
  /** The declaration, for the harness derivations (the mock's transformers, the fuzz witness). */
  readonly decl: ListSectionDecl<K, Ends, Live, F, Key, M>;
}

/**
 * Entries and live items erased to objects; the planner only hands them back to the declaration's own
 * functions. The fold's key type stays: it is what the planner's lookups are keyed by.
 */
interface ErasedDecl<Key extends string> {
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
    readonly fromLive: (live: object) => ListComparable<string>;
    readonly matchBy: Readonly<Record<string, string>>;
  };
  readonly mapping?: string;
  readonly recreate?: (live: object, write: ListWrite<string>) => ListWrite<string>;
  readonly conflicts?: {
    readonly declared?: (writes: readonly ListWrite<string>[]) => readonly string[];
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

type ErasedDeclared = readonly object[] | UndeclaredPolicyList<object>;

/** A write or comparable seen as plain fields. */
type Fields = Readonly<Record<string, unknown>>;

/** A recreate names its remedy once on the generic line, so its field lines carry none. */
interface Remedies {
  readonly value: string | null;
  readonly rename: string;
  readonly phantom: string;
}

const UPDATE_REMEDIES: Remedies = {
  value: "apply will set the declared value",
  rename: "apply will rename it",
  phantom: "this update will re-run",
};

const RECREATE_REMEDIES: Remedies = {
  value: null,
  rename: "apply will delete and recreate it",
  phantom: "this delete-and-recreate will repeat",
};

// --- Dotted paths into a write ----------------------------------------------

function pathOf(field: string): string[] {
  return field.split(".");
}

function valueAt(record: unknown, path: readonly string[]): unknown {
  let node: unknown = record;
  for (const step of path) {
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, step)) {
      return undefined;
    }
    node = (node as Fields)[step];
  }
  return node;
}

/** A copy with the value at `path` replaced (present) or removed (undefined); a missing parent is left alone. */
function withValueAt<T extends Fields>(record: T, path: readonly string[], value: unknown): T {
  const [step, ...rest] = path;
  if (step === undefined || !Object.hasOwn(record, step)) {
    return record;
  }
  if (rest.length === 0) {
    const { [step]: _replaced, ...others } = record;
    return (value === undefined ? others : { ...others, [step]: value }) as T;
  }
  const child = record[step];
  if (typeof child !== "object" || child === null || Array.isArray(child)) {
    return record;
  }
  return { ...record, [step]: withValueAt(child as Fields, rest, value) };
}

function withoutPaths<T extends Fields>(record: T, paths: readonly string[]): T {
  return paths.reduce((out, field) => withValueAt(out, pathOf(field), undefined), record);
}

// --- Identity ---------------------------------------------------------------

/**
 * The ONE derivation behind the planner's duplicate check and the layered merge's pairing. Total over raw
 * records because the merge reads layers before validation: null when a claimed name is not a string,
 * which the merge refuses and a validated entry never is.
 */
function identityClaims<Key extends string>(
  identity: ErasedDecl<Key>["identity"],
  entry: Fields,
): readonly Key[] | null {
  const { field, renameKey, fold } = identity;
  const written = renameKey === undefined ? undefined : entry[renameKey];
  const names = [written ?? valueAt(entry, pathOf(field)), ...(identity.aliases?.(entry) ?? [])];
  if (!names.every((name): name is string => typeof name === "string")) {
    return null;
  }
  return [...new Set(names.map(fold))];
}

/** The erased view lost the declaration's string typing, so the check happens once here. */
function nameOf(record: Fields, field: string): string {
  const value = valueAt(record, pathOf(field));
  if (typeof value !== "string") {
    throw new Error(
      `BUG: the identity field "${field}" is not a string in ${JSON.stringify(record)}; the lens must carry it verbatim`,
    );
  }
  return value;
}

// --- Secret fields ----------------------------------------------------------

/** The secret paths of `decl` a write declares (holds a string at). */
function declaredSecrets(decl: ErasedDecl<string>, write: Fields): string[] {
  return (decl.secrets ?? []).filter((field) => typeof valueAt(write, pathOf(field)) === "string");
}

/** The write with every declared secret reference resolved, for the request body. */
function resolvedWrite(exec: ExecTools, write: Fields, fields: readonly string[]): PlainData {
  const resolved = fields.reduce(
    (out: Fields, field) =>
      withValueAt(out, pathOf(field), exec.resolveSecret(String(valueAt(out, pathOf(field))))),
    write as Fields,
  );
  return plainData(resolved);
}

function leafOf(field: string): string {
  const path = pathOf(field);
  return path[path.length - 1] ?? field;
}

/** The unverifiable facet an op re-sending secret fields carries, one clause per field. */
function secretFacet(decl: ErasedDecl<string>, label: string, fields: readonly string[]): string {
  return fields
    .map((field) =>
      cannotVerifyNote(`${label}.${field}`, {
        why: `GitHub never reveals a ${decl.noun} ${leafOf(field)}`,
        what: "the declared value",
        reasserts: "re-sends it",
      }),
    )
    .join("; ");
}

function facetOr(facet: string | null, lines: readonly string[]): Unverifiable | readonly string[] {
  return facet === null ? lines : { unverifiable: facet, lines };
}

// --- Rendering --------------------------------------------------------------

function renderEntryDelta(
  sectionKey: string,
  field: string,
  names: { readonly want: string; readonly live: string },
  delta: Delta,
  remedies: Remedies,
): string {
  const label = `${sectionKey}[${names.want}]`;
  const path = pathOf(field);
  if (
    delta.kind === "mismatch" &&
    delta.path.length === path.length &&
    delta.path.every((step, index) => step === path[index])
  ) {
    return `${sectionKey}[${names.live}]: should be named "${names.want}" per the settings file; ${remedies.rename}`;
  }
  if (
    delta.kind === "mismatch" &&
    delta.path.length > 0 &&
    delta.path.every((step) => typeof step === "string") &&
    (typeof delta.desired !== "object" || delta.desired === null)
  ) {
    return valueDrift(
      `${label}.${delta.path.join(".")}`,
      JSON.stringify(delta.desired),
      JSON.stringify(delta.live),
      { remedy: remedies.value },
    );
  }
  return renderDelta(label, delta);
}

function updateBody(decl: ErasedDecl<string>, write: Fields): Fields {
  const { renameKey, field } = decl.identity;
  if (renameKey === undefined) {
    return write;
  }
  const { [field]: _name, ...rest } = write;
  return { [renameKey]: nameOf(write, field), ...rest };
}

// --- Reads ------------------------------------------------------------------

async function readList(
  decl: ErasedDecl<string>,
  ctx: PlanContext<ListEndpoints>,
): Promise<object[]> {
  const query = decl.listing?.query;
  return decl.listing?.unpaginated === true
    ? ctx.read.list.call(z.array(decl.live), { query })
    : ctx.read.list.listAll(decl.live, { query });
}

interface LiveItems {
  readonly managed: object[];
  readonly foreign: { readonly name: string; readonly reason: string }[];
}

/** The parsed list split by `foreign`, in live order on both sides. */
async function readLive(
  decl: ErasedDecl<string>,
  ctx: PlanContext<ListEndpoints>,
): Promise<LiveItems> {
  const live = await readList(decl, ctx);
  const out: LiveItems = { managed: [], foreign: [] };
  for (const item of live) {
    const foreign = decl.foreign?.(item) ?? null;
    if (foreign === null) {
      out.managed.push(item);
    } else {
      out.foreign.push(foreign);
    }
  }
  return out;
}

/** The read port of the optional `get` role; the erased dictionary cannot type it, so the shape is spelled here. */
interface ItemReadPort {
  call<T>(schema: z.ZodType<T>, opts: { params: Readonly<Record<string, string>> }): Promise<T>;
}

/** The item's full body when the dictionary declares a `get`, the list item otherwise. */
async function readItem(
  decl: ErasedDecl<string>,
  ctx: PlanContext<ListEndpoints>,
  item: object,
): Promise<object> {
  if (!("get" in decl.endpoints)) {
    return item;
  }
  const port = (ctx.read as unknown as { readonly get: ItemReadPort }).get;
  return port.call(decl.live, { params: decl.address(item) });
}

// --- Plan -------------------------------------------------------------------

/** A live item with the comparison it takes part in, less what neither side can show. */
interface Comparison {
  readonly write: Fields;
  readonly live: Fields;
  readonly notes: string[];
}

function comparison(
  decl: ErasedDecl<string>,
  label: string,
  write: ListWrite<string>,
  body: object,
  comparable: ListComparable<string>,
): Comparison {
  const notes: string[] = [];
  const hidden = (decl.concealed?.(body) ?? []).filter(
    (field) => valueAt(write, pathOf(field.field)) !== undefined,
  );
  for (const { field, reason, remedy } of hidden) {
    notes.push(
      `${label}: ${field} is not visible to this token (${reason}), so drift on it cannot be judged here; ${remedy} to check it`,
    );
  }
  const dropped = [...(decl.secrets ?? []), ...hidden.map((field) => field.field)];
  return {
    write: withoutPaths(write as Fields, dropped),
    live: withoutPaths(comparable as Fields, dropped),
    notes,
  };
}

async function planList<Key extends string>(
  decl: ErasedDecl<Key>,
  section: SectionMeta<ListSectionKey>,
  ctx: PlanContext<ListEndpoints>,
  declared: ErasedDeclared,
): Promise<SectionPlan> {
  const { key, noun, identity, lens, prose, endpoints, mapping } = decl;
  const { fold } = identity;
  const update = updateRole(endpoints);
  const remedies = update === undefined ? RECREATE_REMEDIES : UPDATE_REMEDIES;
  const defaultPolicy = defaultUndeclaredPolicy(section);
  const { policy, entries } = undeclaredPolicy(declared, defaultPolicy);

  const writes = entries.map((entry) => {
    const write = lens.toWrite(entry);
    const name = nameOf(write, identity.field);
    const claims = identityClaims(identity, entry as Fields);
    if (claims === null) {
      throw new Error(
        `BUG: the validated ${noun} entry ${JSON.stringify(entry)} claims a non-string name; the slice must type the identity fields as strings`,
      );
    }
    return { write, name, claims };
  });
  // Every identity an entry claims must be its alone: two entries resolving to one resource would fight on every run.
  rejectDuplicates(
    section,
    writes.flatMap((w) => w.claims.map((claim) => ({ claim, name: w.name }))),
    (c) => c.claim,
    (c) => c.name,
  );

  const declaredConflicts = decl.conflicts?.declared?.(writes.map((w) => w.write)) ?? [];
  if (declaredConflicts.length > 0) {
    throw new Error(
      `${key}: the settings file declares conflicting ${plural(noun)}: ${declaredConflicts.join("; ")}. Fix the settings file, then re-run`,
    );
  }

  const live = await readLive(decl, ctx);
  const liveItems = live.managed.map((item) => {
    const comparable = lens.fromLive(item);
    const name = nameOf(comparable, identity.field);
    return { item, comparable, name, key: fold(name) };
  });
  // The guard runs before the section's own live conflicts: a duplicated live pair makes every other judgment a guess.
  const liveByKey = liveByIdentity(
    section,
    noun,
    liveItems,
    (item) => item.key,
    (item) => liveIdentity(item.name, decl.address(item.item)),
  );
  const liveConflicts =
    decl.conflicts?.live?.(
      writes.map((w) => w.write),
      liveItems.map((l) => l.comparable),
    ) ?? [];
  if (liveConflicts.length > 0) {
    throw new Error(
      `${key}: the settings file conflicts with the live ${plural(noun)}: ${liveConflicts.join("; ")}. Resolve each conflict on GitHub, then re-run`,
    );
  }
  const claimed = new Set<Key>(writes.flatMap((w) => w.claims));

  const plan: SectionPlan = { ops: [], notes: [], drift: [] };
  for (const { write, name, claims } of writes) {
    const matches = claims.flatMap((claim) => {
      const match = liveByKey.get(claim);
      return match === undefined ? [] : [match];
    });
    if (matches.length > 1) {
      throw new Error(
        `${key}: the entry "${name}" matches ${matches.length} separate live ${plural(noun)} (${matches.map((m) => `"${m.name}"`).join(", ")}), so it cannot converge; delete all but one of them on GitHub, or declare each as its own entry`,
      );
    }
    const existing = matches[0];
    const label = `${key}[${name}]`;
    const secrets = declaredSecrets(decl, write);
    if (existing === undefined) {
      plan.ops.push({
        role: "create",
        payload:
          secrets.length === 0
            ? plainData(write)
            : (exec: ExecTools) => resolvedWrite(exec, write, secrets),
        describe: `creating ${noun} "${name}"`,
        drift: facetOr(secrets.length === 0 ? null : secretFacet(decl, label, secrets), [
          missingDrift(label),
        ]),
        change: `created ${noun} "${name}"`,
      });
      continue;
    }
    const body = await readItem(decl, ctx, existing.item);
    const compared = comparison(decl, label, write, body, lens.fromLive(body));
    plan.notes.push(...compared.notes);
    const found = deltas(compared.write, compared.live, { matchBy: lens.matchBy });
    const render = (delta: Delta): string =>
      renderEntryDelta(key, identity.field, { want: name, live: existing.name }, delta, remedies);
    const phantom = found.flatMap((delta) =>
      delta.kind === "phantom" && delta.path.length === 1 && typeof delta.path[0] === "string"
        ? [delta.path[0]]
        : [],
    );
    if (phantom.length > 0) {
      plan.notes.push(phantomNote(label, phantom, noun, remedies.phantom));
    }
    if (update === undefined) {
      const drift = found.map(render);
      if (!hasDrift(drift)) {
        continue;
      }
      // The differing fields ride on the recreate; the generic line alone would leave the reader guessing which field forces the replace.
      plan.ops.push(
        {
          role: "remove",
          params: decl.address(existing.item),
          describe: `deleting ${noun} "${name}" before recreating it`,
          drift: [
            `${label}: live settings differ from the settings file, and ${plural(noun)} cannot be edited; apply will delete and recreate it`,
          ],
          change: `deleted ${noun} "${name}" to recreate it with the declared settings`,
        },
        {
          role: "create",
          payload: plainData(decl.recreate?.(existing.item, write) ?? write),
          describe: `recreating ${noun} "${name}"`,
          drift,
          change: `recreated ${noun} "${name}"`,
        },
      );
      continue;
    }
    const params = decl.address(existing.item);
    // The mapping's deltas go through updateConfig, which sets named fields only; the general update never carries the mapping.
    const inMapping = (field: string): boolean =>
      mapping !== undefined && pathOf(field)[0] === mapping;
    const mappingDrift = found
      .filter((delta) => mapping !== undefined && delta.path[0] === mapping)
      .map(render);
    const mappingSecrets = secrets.filter(inMapping);
    if (mapping !== undefined && (hasDrift(mappingDrift) || mappingSecrets.length > 0)) {
      const config = write[mapping] as ListWrite<string>;
      plan.ops.push({
        role: "updateConfig",
        params,
        payload:
          mappingSecrets.length === 0
            ? plainData(config)
            : (exec: ExecTools) =>
                resolvedWrite(
                  exec,
                  config,
                  mappingSecrets.map((field) => pathOf(field).slice(1).join(".")),
                ),
        describe: `updating ${noun} "${name}" ${mapping}`,
        drift: facetOr(
          mappingSecrets.length === 0 ? null : secretFacet(decl, label, mappingSecrets),
          mappingDrift,
        ),
        change:
          mappingSecrets.length === 0
            ? `updated ${noun} "${name}" ${mapping}`
            : `updated ${noun} "${name}" ${mapping} (the declared ${mappingSecrets.map(leafOf).join(" and ")} is re-sent every run)`,
      });
    }
    const generalDrift = found
      .filter((delta) => mapping === undefined || delta.path[0] !== mapping)
      .map(render);
    const generalSecrets = secrets.filter((field) => !inMapping(field));
    if (!hasDrift(generalDrift) && generalSecrets.length === 0) {
      continue;
    }
    const general =
      mapping === undefined ? (write as Fields) : withoutPaths(write as Fields, [mapping]);
    plan.ops.push({
      role: "update",
      params,
      payload:
        generalSecrets.length === 0
          ? plainData(updateBody(decl, general))
          : (exec: ExecTools) =>
              resolvedWrite(exec, updateBody(decl, general) as ListWrite<string>, generalSecrets),
      describe: `updating ${noun} "${name}"`,
      drift: facetOr(
        generalSecrets.length === 0 ? null : secretFacet(decl, label, generalSecrets),
        generalDrift,
      ),
      change: `updated ${noun} "${name}"`,
    });
  }

  for (const { item, name, key: liveKey } of liveItems) {
    if (claimed.has(liveKey)) {
      continue;
    }
    if (policy === "keep") {
      plan.notes.push(
        undeclaredNote({
          subject: `${noun} "${name}"`,
          action: prose.undeclaredAction,
          ...prose.undeclaredNote,
        }),
      );
      continue;
    }
    plan.ops.push({
      role: "remove",
      params: decl.address(item),
      describe: `deleting undeclared ${noun} "${name}"`,
      drift: [
        undeclaredDrift(defaultPolicy, {
          label: `${key}[${name}]`,
          action: prose.undeclaredAction,
          ...prose.undeclaredDrift,
        }),
      ],
      change: `DELETED undeclared ${noun} "${name}"`,
    });
  }
  return plan;
}

// --- Snapshot ---------------------------------------------------------------

/**
 * Items are normalized as GitHub stores them before the projection onto the entry slice, so the
 * read-back compares equal to the declaration that produced it. An item a concealed field hides from
 * the token is left out (an entry without the field would clear it on the next update), and a secret
 * field reads back as a `$NAME` reference keyed by the item's address, so a reordering never rebinds it.
 */
async function snapshotList(
  decl: ErasedDecl<string>,
  section: SectionMeta<ListSectionKey>,
  ctx: PlanContext<ListEndpoints>,
): Promise<{ value: UndeclaredPolicyList<object> | undefined; notes: string[] }> {
  const { key, noun, identity, lens } = decl;
  const live = await readLive(decl, ctx);
  const notes = live.foreign.map(({ name, reason }) =>
    leftOutOfSnapshot(`${key}[${name}]`, reason),
  );
  if (live.managed.length === 0) {
    return { value: undefined, notes };
  }
  const items = live.managed.map((item) => {
    const name = nameOf(lens.fromLive(item), identity.field);
    return { item, name, key: identity.fold(name) };
  });
  liveByIdentity(
    section,
    noun,
    items,
    (item) => item.key,
    (item) => liveIdentity(item.name, decl.address(item.item)),
  );
  const entries: object[] = [];
  for (const { item, name } of items) {
    const label = `${key}[${name}]`;
    const body = await readItem(decl, ctx, item);
    const hidden = decl.concealed?.(body) ?? [];
    if (hidden.length > 0) {
      for (const { field, reason, remedy } of hidden) {
        notes.push(
          leftOutOfSnapshot(
            label,
            `${field} is not visible to this token (${reason}), and an entry without it would clear it on the next update; ${remedy} to read it back`,
          ),
        );
      }
      continue;
    }
    let entry = projectOntoSchema(decl.entry, lens.fromLive(body)) as Fields;
    for (const field of declaredSecrets(decl, entry)) {
      const id = Object.values(decl.address(item)).join("_");
      const { variable, reference } = snapshotSecretReference(noun, id);
      notes.push(
        unreadableSecretNote(`${label}.${field}`, `the ${noun} ${leafOf(field)}`, variable),
      );
      entry = withValueAt(entry, pathOf(field), reference);
    }
    entries.push(entry);
  }
  return { value: knobbedSnapshot(section, entries), notes };
}

// --- Module -----------------------------------------------------------------

function secretValuesFor(decl: ErasedDecl<string>, declared: unknown): DeclaredSecretValue[] {
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
    shape: loosen(knobbed(decl.entry)),
    ...(decl.secrets === undefined
      ? {}
      : { secretValues: (declared: Declared<K>) => secretValuesFor(erased, declared) }),
    ...(decl.layering === undefined
      ? {}
      : {
          layering: {
            keys: (entry) => identityClaims(erased.identity, entry),
            keyField: decl.identity.field,
            combine: decl.layering.combine,
            ...(decl.layering.nested === undefined ? {} : { nested: decl.layering.nested }),
          },
        }),
    plan: (ctx, desired) =>
      planList(
        erased,
        section,
        ctx as unknown as PlanContext<ListEndpoints>,
        desired as unknown as ErasedDeclared,
      ) as unknown as Promise<SectionPlan<PlannedOp<Ends>>>,
    snapshot: (ctx) =>
      snapshotList(
        erased,
        section,
        ctx as unknown as PlanContext<ListEndpoints>,
      ) as unknown as Promise<SectionSnapshot<K>>,
    decl,
  };
  return section;
}
