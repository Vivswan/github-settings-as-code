/**
 * The list-section factory: upsert-by-natural-key plus keep-or-delete-undeclared as ONE declaration
 * (slice, roles, identity, address, lens, prose) from which plan(), the loose shape, the mock's
 * transformers, and the fuzz witness derive. Two prose hooks only: a section needing more stays bespoke.
 */

import { z } from "zod";
import { type Delta, deltas, phantomNote, renderDelta } from "../../engine/diff.js";
import type { SettingsFile, UndeclaredPolicySection } from "../../schema.js";
import type { UndeclaredPolicy, UndeclaredPolicyList } from "../../types.js";
import type { EndpointDecl, PathParams, Route } from "../contract/endpoints.js";
import { parseLive } from "../contract/live.js";
import {
  type DeclaredSecretValue,
  defaultUndeclaredPolicy,
  type EntryOf,
  type KeyedListLayering,
  loosen,
  type SectionMeta,
  undeclaredDrift,
  undeclaredNote,
  undeclaredPolicy,
} from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import {
  hasDrift,
  type PlainData,
  type PlanContext,
  type PlannedOp,
  plainData,
  type SectionPlan,
} from "../contract/plan.js";
import { rejectDuplicates } from "../contract/requests.js";
import { knobbed } from "./schema-helpers.js";

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

/**
 * `update` exists only when GitHub can edit the resource; without it a drifted item is deleted and
 * recreated. A type alias, so it keeps EndpointDict's index signature.
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
);

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
 *   a union of dictionaries    -> refused (a union hides its members' roles from keyof)
 *   a fifth role               -> never
 *   `update` not PATCH or PUT  -> refused (a DELETE would pass the immutable arm's structural match)
 */
type OnlyListRoles<Ends> = (IsUnion<Ends> extends true ? never : unknown) & {
  readonly [R in Exclude<keyof Ends, ListRoleName>]: never;
} & { readonly [R in keyof Ends & "update"]: UpdateDecl };

export function updateRole(endpoints: ListEndpoints): UpdateDecl | undefined {
  return "update" in endpoints ? endpoints.update : undefined;
}

type SameParams<A extends string, B extends string> = [PathParams<A>] extends [PathParams<B>]
  ? [PathParams<B>] extends [PathParams<A>]
    ? Readonly<Record<PathParams<A>, string>>
    : never
  : never;

/**
 * One address serves update and remove, so when both exist they must spell the SAME params; a dictionary
 * whose item routes disagree collapses to never.
 */
type Address<Ends extends ListEndpoints> = Ends extends {
  readonly update: { readonly route: infer U extends string };
}
  ? SameParams<U, Ends["remove"]["route"]>
  : Readonly<Record<PathParams<Ends["remove"]["route"]>, string>>;

/** Declared fields only: an omitted optional stays OUT (never undefined), so it is neither written nor compared. */
type Write<F extends string> = { readonly [P in F]: string } & {
  readonly [key: string]: PlainData;
};

/** A live item in the same terms, each field normalized as GitHub stores it. */
type Comparable<F extends string> = { readonly [P in F]: string } & Readonly<
  Record<string, unknown>
>;

type NoteWording = Pick<Parameters<typeof undeclaredNote>[0], "state" | "add" | "manage">;

type DriftWording = Pick<Parameters<typeof undeclaredDrift>[1], "state" | "add" | "keep">;

/** `unpaginated` also drives the derived mock's list handler (test/e2e/mock/list-fragment.ts). */
interface Listing {
  /** The query the list carries (milestones' state=all: the default listing omits closed items). */
  readonly query?: Readonly<Record<string, string>>;
  /** GitHub serves the whole list in one response and ignores page params (autolinks), so the page loop is skipped. */
  readonly unpaginated?: true;
}

export interface ListSectionDecl<
  K extends ListSectionKey,
  Ends extends ListEndpoints,
  Live extends object,
  F extends string,
> {
  readonly key: K;
  readonly permission: SectionPermission;
  readonly undeclaredDefault: UndeclaredPolicy;
  /** The output noun for change lines and notes ("label"). */
  readonly noun: string;
  /** The entry config slice (src/sections/<key>/schema.ts); the loose shape derives from it. */
  readonly entry: z.ZodType<Entry<K>>;
  /** The fields of a live list item the section reads; extras ride along for the comparison. */
  readonly live: z.ZodType<Live>;
  readonly endpoints: Ends & OnlyListRoles<Ends>;
  readonly listing?: Listing;
  readonly identity: {
    /** The write field naming the resource, as the live item carries it ("name", "title"). */
    readonly field: F;
    /** Folds a name to its matching key; omitted when GitHub matches exactly. */
    readonly fold?: (name: string) => string;
    /**
     * Names an entry also answers to (a label's pre-rename `name`), so a live item under one is this
     * entry's, renamed by the update, not undeclared.
     */
    readonly aliases?: (entry: Entry<K>) => readonly string[];
    /**
     * The update body's key for the name when GitHub renames through another one (labels' `new_name`);
     * omitted, the name travels under `field`.
     *
     *   entry declares a value under it  -> it is renaming: that value is the name it writes (the lens puts it under `field`)
     *   the entry's `field`              -> its current name
     */
    readonly renameKey?: string;
  };
  /** The path params addressing one live item for update and remove; unrepresentable when the two routes disagree. */
  readonly address: [Address<Ends>] extends [never] ? never : (live: Live) => Address<Ends>;
  readonly lens: {
    /** The entry in wire terms: the create body, and what a converged live item reads back as. */
    readonly toWrite: (entry: Entry<K>) => Write<F>;
    /**
     * A live item in the same terms as toWrite, so the two compare field by field.
     *
     *   identity field          -> verbatim
     *   other declared fields   -> normalized as GitHub stores them (a color lowercased without "#", a null description as "")
     *   every other live field  -> kept, so declared passthrough keys compare against what the API echoed
     */
    readonly fromLive: (live: Live) => Comparable<F>;
    /** Per entry field holding a list, the item key to pair by (see DeltaOptions.matchBy); `{}` when none does. */
    readonly matchBy: Readonly<Partial<Record<keyof Entry<K> & string, string>>>;
  };
  /**
   * The body recreating a drifted item of a resource GitHub cannot edit (no update role), when the
   * write alone would drop a live field the file leaves undeclared (a deploy key's read_only).
   */
  readonly recreate?: "update" extends keyof Ends
    ? never
    : (live: Live, write: Write<F>) => Write<F>;
  /**
   * Conflicts the identities cannot show, one line each naming the fix; any line fails the section.
   *
   *   `declared`  -> sees only the entries and runs BEFORE the read (a settings-file mistake costs no request)
   *   `live`      -> runs after the read and before any write (a deploy key's material held by another key)
   */
  readonly conflicts?: {
    readonly declared?: (writes: readonly Write<F>[]) => readonly string[];
    readonly live?: (
      writes: readonly Write<F>[],
      live: readonly Comparable<F>[],
    ) => readonly string[];
  };
  readonly prose: {
    /** What apply does to an undeclared live resource, as the note and drift spell it ("DELETE it"). */
    readonly undeclaredAction: string;
    readonly undeclaredNote?: NoteWording;
    readonly undeclaredDrift?: DriftWording;
  };
  /** The designated secret-field values of one entry, for the engine's up-front resolution. */
  readonly secretValues?: (entry: Entry<K>) => readonly DeclaredSecretValue[];
  /**
   * Omitted, the list always replaces. The pairing itself is derived from `identity`, the very claims the
   * planner's duplicate check reads, so the merge and the planner cannot disagree about which entries are one.
   */
  readonly layering?: Pick<KeyedListLayering, "combine">;
}

/** The module listSection() mints: SectionModule<K, Ends> at the registry, plus its declaration. */
export interface ListSectionModule<
  K extends ListSectionKey,
  Ends extends ListEndpoints,
  Live extends object,
  F extends string,
> {
  readonly key: K;
  readonly permission: SectionPermission;
  readonly undeclaredDefault: UndeclaredPolicy;
  readonly endpoints: Ends;
  readonly shape: z.ZodType;
  readonly secretValues?: (declared: Declared<K>) => DeclaredSecretValue[];
  readonly layering?: KeyedListLayering;
  readonly plan: (
    ctx: PlanContext<Ends>,
    desired: Declared<K>,
  ) => Promise<SectionPlan<PlannedOp<Ends>>>;
  /** The declaration, for the harness derivations (the mock's transformers, the fuzz witness). */
  readonly decl: ListSectionDecl<K, Ends, Live, F>;
}

/** Entries and live items erased to objects; the planner only hands them back to the declaration's own functions. */
interface ErasedDecl {
  readonly key: ListSectionKey;
  readonly noun: string;
  readonly live: z.ZodType<object>;
  readonly endpoints: ListEndpoints;
  readonly listing?: Listing;
  readonly identity: {
    readonly field: string;
    readonly fold?: (name: string) => string;
    readonly aliases?: (entry: object) => readonly string[];
    readonly renameKey?: string;
  };
  readonly address: (live: object) => Readonly<Record<string, string>>;
  readonly lens: {
    readonly toWrite: (entry: object) => Write<string>;
    readonly fromLive: (live: object) => Comparable<string>;
    readonly matchBy: Readonly<Record<string, string>>;
  };
  readonly recreate?: (live: object, write: Write<string>) => Write<string>;
  readonly conflicts?: {
    readonly declared?: (writes: readonly Write<string>[]) => readonly string[];
    readonly live?: (
      writes: readonly Write<string>[],
      live: readonly Comparable<string>[],
    ) => readonly string[];
  };
  readonly prose: ListSectionDecl<ListSectionKey, ListEndpoints, object, string>["prose"];
  readonly secretValues?: (entry: object) => readonly DeclaredSecretValue[];
}

type ErasedDeclared = readonly object[] | UndeclaredPolicyList<object>;

/** A recreate names its remedy once on the generic line, so its field lines carry none. */
interface Remedies {
  readonly value: string;
  readonly rename: string;
  readonly phantom: string;
}

const UPDATE_REMEDIES: Remedies = {
  value: "; apply will set the declared value",
  rename: "apply will rename it",
  phantom: "this update will re-run",
};

const RECREATE_REMEDIES: Remedies = {
  value: "",
  rename: "apply will delete and recreate it",
  phantom: "this delete-and-recreate will repeat",
};

/**
 * The ONE derivation behind the planner's duplicate check and the layered merge's pairing. Total over raw
 * records because the merge reads layers before validation: null when a claimed name is not a string,
 * which the merge refuses and a validated entry never is.
 */
function identityClaims(
  identity: ErasedDecl["identity"],
  entry: Readonly<Record<string, unknown>>,
): readonly string[] | null {
  const { field, renameKey, fold = (name: string) => name } = identity;
  const written = renameKey === undefined ? undefined : entry[renameKey];
  const names = [written ?? entry[field], ...(identity.aliases?.(entry) ?? [])];
  if (!names.every((name): name is string => typeof name === "string")) {
    return null;
  }
  return [...new Set(names.map(fold))];
}

/** The erased view lost the declaration's string typing, so the check happens once here. */
function nameOf(record: Readonly<Record<string, unknown>>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new Error(
      `BUG: the identity field "${field}" is not a string in ${JSON.stringify(record)}; the lens must carry it verbatim`,
    );
  }
  return value;
}

function missingLine(label: string): string {
  return `${label}: missing - declared in the settings file but not on the repo; apply will create it`;
}

function renderEntryDelta(
  sectionKey: string,
  field: string,
  names: { readonly want: string; readonly live: string },
  delta: Delta,
  remedies: Remedies,
): string {
  const label = `${sectionKey}[${names.want}]`;
  const [step, ...rest] = delta.path;
  if (delta.kind === "mismatch" && rest.length === 0 && typeof step === "string") {
    if (step === field) {
      return `${sectionKey}[${names.live}]: should be named "${names.want}" per the settings file; ${remedies.rename}`;
    }
    if (typeof delta.desired !== "object" || delta.desired === null) {
      return `${label}.${step}: declared ${JSON.stringify(delta.desired)} != live ${JSON.stringify(delta.live)}${remedies.value}`;
    }
  }
  return renderDelta(label, delta);
}

function updateBody(decl: ErasedDecl, write: Write<string>): PlainData {
  const { renameKey, field } = decl.identity;
  if (renameKey === undefined) {
    return plainData(write);
  }
  const { [field]: _name, ...rest } = write;
  return plainData({ [renameKey]: nameOf(write, field), ...rest });
}

async function readList(decl: ErasedDecl, ctx: PlanContext<ListEndpoints>): Promise<unknown> {
  const query = decl.listing?.query;
  return decl.listing?.unpaginated === true
    ? ctx.read.list.call({ query })
    : ctx.read.list.listAll({ query });
}

async function planList(
  decl: ErasedDecl,
  section: SectionMeta<ListSectionKey>,
  ctx: PlanContext<ListEndpoints>,
  declared: ErasedDeclared,
): Promise<SectionPlan> {
  const { key, noun, identity, lens, prose, endpoints } = decl;
  const fold = identity.fold ?? ((name: string) => name);
  const update = updateRole(endpoints);
  const remedies = update === undefined ? RECREATE_REMEDIES : UPDATE_REMEDIES;
  const defaultPolicy = defaultUndeclaredPolicy(section);
  const { policy, entries } = undeclaredPolicy(declared, defaultPolicy);

  const writes = entries.map((entry) => {
    const write = lens.toWrite(entry);
    const name = nameOf(write, identity.field);
    const claims = identityClaims(identity, entry as Readonly<Record<string, unknown>>);
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
      `${key}: the settings file declares conflicting ${noun}s: ${declaredConflicts.join("; ")}. Fix the settings file, then re-run`,
    );
  }

  const live = parseLive(section, endpoints.list, z.array(decl.live), await readList(decl, ctx));
  const liveItems = live.map((item) => {
    const comparable = lens.fromLive(item);
    const name = nameOf(comparable, identity.field);
    return { item, comparable, name, key: fold(name) };
  });
  const liveConflicts =
    decl.conflicts?.live?.(
      writes.map((w) => w.write),
      liveItems.map((l) => l.comparable),
    ) ?? [];
  if (liveConflicts.length > 0) {
    throw new Error(
      `${key}: the settings file conflicts with the live ${noun}s: ${liveConflicts.join("; ")}. Resolve each conflict on GitHub, then re-run`,
    );
  }
  // GitHub may hold two items one fold apart (deploy keys repeat titles), which a single-slot map would hide.
  const liveByKey = new Map<string, (typeof liveItems)[number][]>();
  for (const item of liveItems) {
    liveByKey.set(item.key, [...(liveByKey.get(item.key) ?? []), item]);
  }
  const claimed = new Set(writes.flatMap((w) => w.claims));

  const plan: SectionPlan = { ops: [], notes: [], drift: [] };
  for (const { write, name, claims } of writes) {
    const matches = [...new Set(claims.flatMap((claim) => liveByKey.get(claim) ?? []))];
    if (matches.length > 1) {
      throw new Error(
        `${key}: the entry "${name}" matches ${matches.length} separate live ${noun}s (${matches.map((m) => `"${m.name}"`).join(", ")}), so it cannot converge; delete all but one of them on GitHub, or declare each as its own entry`,
      );
    }
    const existing = matches[0];
    const label = `${key}[${name}]`;
    if (existing === undefined) {
      plan.ops.push({
        role: "create",
        payload: plainData(write),
        describe: `creating ${noun} "${name}"`,
        drift: [missingLine(label)],
        change: `created ${noun} "${name}"`,
      });
      continue;
    }
    const found = deltas(write, existing.comparable, { matchBy: lens.matchBy });
    const drift = found.map((delta) =>
      renderEntryDelta(key, identity.field, { want: name, live: existing.name }, delta, remedies),
    );
    if (!hasDrift(drift)) {
      continue;
    }
    const phantom = found.flatMap((delta) =>
      delta.kind === "phantom" && delta.path.length === 1 && typeof delta.path[0] === "string"
        ? [delta.path[0]]
        : [],
    );
    if (phantom.length > 0) {
      plan.notes.push(phantomNote(label, phantom, noun, remedies.phantom));
    }
    if (update === undefined) {
      // The differing fields ride on the recreate; the generic line alone would leave the reader guessing which field forces the replace.
      plan.ops.push(
        {
          role: "remove",
          params: decl.address(existing.item),
          describe: `deleting ${noun} "${name}" before recreating it`,
          drift: [
            `${label}: live settings differ from the settings file, and ${noun}s cannot be edited; apply will delete and recreate it`,
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
    plan.ops.push({
      role: "update",
      params: decl.address(existing.item),
      payload: updateBody(decl, write),
      describe: `updating ${noun} "${name}"`,
      drift,
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

function secretValuesOf(decl: ErasedDecl, declared: ErasedDeclared): DeclaredSecretValue[] {
  const extract = decl.secretValues;
  if (extract === undefined) {
    return [];
  }
  // "keep" is a placeholder: only the entries are read.
  return undeclaredPolicy(declared, "keep").entries.flatMap((entry) => [...extract(entry)]);
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
>(decl: ListSectionDecl<K, Ends, Live, F>): ListSectionModule<K, Ends, Live, F> {
  const erased = decl as unknown as ErasedDecl;
  const section: ListSectionModule<K, Ends, Live, F> = {
    key: decl.key,
    permission: decl.permission,
    undeclaredDefault: decl.undeclaredDefault,
    endpoints: decl.endpoints,
    shape: loosen(knobbed(decl.entry)),
    ...(decl.secretValues === undefined
      ? {}
      : {
          secretValues: (declared: Declared<K>) =>
            secretValuesOf(erased, declared as unknown as ErasedDeclared),
        }),
    ...(decl.layering === undefined
      ? {}
      : {
          layering: {
            keys: (entry) => identityClaims(erased.identity, entry),
            keyField: decl.identity.field,
            combine: decl.layering.combine,
          },
        }),
    plan: (ctx, desired) =>
      planList(
        erased,
        section,
        ctx as unknown as PlanContext<ListEndpoints>,
        desired as unknown as ErasedDeclared,
      ) as unknown as Promise<SectionPlan<PlannedOp<Ends>>>,
    decl,
  };
  return section;
}
