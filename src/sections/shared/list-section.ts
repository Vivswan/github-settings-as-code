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

/** The declared value of a list section, exactly as the settings document types it. */
type Declared<K extends ListSectionKey> = Exclude<SettingsFile[K], undefined>;

/** One declared entry of a list section, whichever form the value takes. */
type Entry<K extends ListSectionKey> = EntryOf<NonNullable<SettingsFile[K]>>;

/** The routes of a method whose only path params are owner and repo: the collection routes. */
type Paramless<R extends Route> = R extends Route
  ? [PathParams<R>] extends [never]
    ? R
    : never
  : never;

/** The role editing one live item in place. */
type UpdateDecl = EndpointDecl & {
  readonly route: Extract<Route, `PATCH ${string}` | `PUT ${string}`>;
};

/** The role deleting one live item. */
type RemoveDecl = EndpointDecl & { readonly route: Extract<Route, `DELETE ${string}`> };

/**
 * The roles: list and create address the collection, remove one item, and update - one item in place -
 * only when GitHub can edit the resource; without it a drifted item is deleted and recreated. The list is
 * the primary read in the "denied" posture. A type alias, so it keeps EndpointDict's index signature.
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

/** The role names the factory serves and derives handlers for. */
export type ListRoleName = "list" | "create" | "update" | "remove";

type UnionToIntersection<U> = (U extends unknown ? (member: U) => void : never) extends (
  member: infer I,
) => void
  ? I
  : never;

/** True for a union: only a single type is assignable to the intersection of its own members. */
type IsUnion<T> = [T] extends [UnionToIntersection<T>] ? false : true;

/**
 * Pins a dictionary to the factory's roles at the declaration: ONE literal dictionary (a union hides
 * its members' roles from keyof, so it is refused), no fifth role, and any `update` is a PATCH or PUT
 * (a DELETE would pass the immutable arm's structural match). An intersection: the index signature stays.
 */
type OnlyListRoles<Ends> = (IsUnion<Ends> extends true ? never : unknown) & {
  readonly [R in Exclude<keyof Ends, ListRoleName>]: never;
} & { readonly [R in keyof Ends & "update"]: UpdateDecl };

/** The update declaration of a dictionary, or undefined for a resource GitHub cannot edit. */
export function updateRole(endpoints: ListEndpoints): UpdateDecl | undefined {
  return "update" in endpoints ? endpoints.update : undefined;
}

/** The address params two item routes agree on; never when they spell different params. */
type SameParams<A extends string, B extends string> = [PathParams<A>] extends [PathParams<B>]
  ? [PathParams<B>] extends [PathParams<A>]
    ? Readonly<Record<PathParams<A>, string>>
    : never
  : never;

/**
 * The path params addressing one live item. One address serves update and remove, so when both
 * exist they must spell the SAME params; a dictionary whose item routes disagree collapses to never.
 */
type Address<Ends extends ListEndpoints> = Ends extends {
  readonly update: { readonly route: infer U extends string };
}
  ? SameParams<U, Ends["remove"]["route"]>
  : Readonly<Record<PathParams<Ends["remove"]["route"]>, string>>;

/**
 * An entry in wire terms: the JSON-plain body a create sends, carrying the
 * identity field as a string. Declared fields only - an omitted optional
 * stays OUT (never undefined), so it is neither written nor compared.
 */
type Write<F extends string> = { readonly [P in F]: string } & {
  readonly [key: string]: PlainData;
};

/** A live item in the same terms, each field normalized as GitHub stores it. */
type Comparable<F extends string> = { readonly [P in F]: string } & Readonly<
  Record<string, unknown>
>;

/** The wording knobs of the keep-note beyond its derived subject and action. */
type NoteWording = Pick<Parameters<typeof undeclaredNote>[0], "state" | "add" | "manage">;

/** The wording knobs of the delete drift beyond its derived label and action. */
type DriftWording = Pick<Parameters<typeof undeclaredDrift>[1], "state" | "add" | "keep">;

/** How the list read is issued; both facets also drive the derived mock's list handler. */
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
     * Names an entry also answers to (a label's pre-rename `name`), so a live
     * item under one is this entry's - renamed by the update - not undeclared.
     */
    readonly aliases?: (entry: Entry<K>) => readonly string[];
    /**
     * The update body's key for the name when GitHub renames through another
     * one (labels' `new_name`); omitted, the name travels under `field`.
     */
    readonly renameKey?: string;
  };
  /** The path params addressing one live item for update and remove; unrepresentable when the two routes disagree. */
  readonly address: [Address<Ends>] extends [never] ? never : (live: Live) => Address<Ends>;
  readonly lens: {
    /** The entry in wire terms: the create body, and what a converged live item reads back as. */
    readonly toWrite: (entry: Entry<K>) => Write<F>;
    /**
     * A live item in the same terms, each field normalized as GitHub stores it (a color lowercased
     * without "#", a null description as ""), the identity field verbatim, and every other live
     * field kept so declared passthrough keys compare against what the API echoed.
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
   * `declared` sees only the entries and runs BEFORE the read (a settings-file mistake costs no
   * request); `live` runs after it and before any write (a deploy key's material held by another key).
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
  readonly plan: (
    ctx: PlanContext<Ends>,
    desired: Declared<K>,
  ) => Promise<SectionPlan<PlannedOp<Ends>>>;
  /** The declaration, for the harness derivations (the mock's transformers, the fuzz witness). */
  readonly decl: ListSectionDecl<K, Ends, Live, F>;
}

/**
 * The declaration as the planner reads it, entries and live items erased to
 * objects; the planner only hands them back to the declaration's own functions.
 */
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

/** A declared value in the erased view: the entry list, plain or wrapped. */
type ErasedDeclared = readonly object[] | UndeclaredPolicyList<object>;

/**
 * What apply does about a drifted item, as the drift lines spell it: an update sets values in
 * place, a recreate names its remedy once on the generic line, so the field lines carry none.
 */
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

/** The identity field of a write or comparable: typed string by the declaration, checked once in the erased view. */
function nameOf(record: Readonly<Record<string, unknown>>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new Error(
      `BUG: the identity field "${field}" is not a string in ${JSON.stringify(record)}; the lens must carry it verbatim`,
    );
  }
  return value;
}

/** The check-mode line for a declared entry the listing does not carry. */
function missingLine(label: string): string {
  return `${label}: missing - declared in the settings file but not on the repo; apply will create it`;
}

/**
 * One entry-level delta as drift prose: the identity field diverging under an
 * equal key is a rename, another top-level scalar names both values, and
 * everything else is the shared delta rendering under the entry's label.
 */
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

/** The update body: the write with its identity under the rename key when GitHub renames through one. */
function updateBody(decl: ErasedDecl, write: Write<string>): PlainData {
  const { renameKey, field } = decl.identity;
  if (renameKey === undefined) {
    return plainData(write);
  }
  const { [field]: _name, ...rest } = write;
  return plainData({ [renameKey]: nameOf(write, field), ...rest });
}

/** The list read as the declaration issues it: the whole list at once, or every page. */
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
    const claims = [...new Set([fold(name), ...(identity.aliases?.(entry) ?? []).map(fold)])];
    return { write, name, claims };
  });
  // Every identity an entry claims must be its alone: two entries resolving
  // to one resource would fight each other on every run.
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
  // Every live item under a folded key: GitHub may hold two items one fold
  // apart (deploy keys repeat titles), which a single-slot map would hide.
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
      // The differing fields are named on the recreate; the generic line alone
      // would leave the reader guessing which field (or typo) forces the replace.
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

/** Every entry's designated secret values, labelled by the extractor the declaration supplied. */
function secretValuesOf(decl: ErasedDecl, declared: ErasedDeclared): DeclaredSecretValue[] {
  const extract = decl.secretValues;
  if (extract === undefined) {
    return [];
  }
  // The policy is irrelevant here; only the entries are read.
  return undeclaredPolicy(declared, "keep").entries.flatMap((entry) => [...extract(entry)]);
}

/**
 * Mint a list section from its declaration. The planner runs over the erased
 * view while the module surface stays typed over the literal dictionary and
 * declared value the registry pins; the casts are that one boundary.
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
