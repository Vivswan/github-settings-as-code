import type { Result } from "neverthrow";
import { z } from "zod";
import type { RepoRef } from "../../discovery/targets.js";
import type { GitHubClient } from "../../github/api.js";
import type {
  ListSection,
  SectionKey,
  SettingsFile,
  UndeclaredPolicySection,
} from "../../schema.js";
import type {
  DeepReadonly,
  MustBeNever,
  UndeclaredPolicy,
  UndeclaredPolicyList,
} from "../../types.js";
import type { Layering, UNDECLARED_POLICIES } from "../shared/schema-helpers.js";
import {
  type EndpointDecl,
  endpointKind,
  endpointMethod,
  endpointPath,
  type GatedReadDecl,
  type Route,
} from "./endpoints.js";
import type { SectionFailure } from "./errors.js";
import type { GraphqlOpDecl } from "./graphql.js";
import { grantFor, type SectionPermission } from "./permissions.js";
import type { PlanContext, PlannedOp, SectionPlan, SnapshotContext } from "./plan.js";

interface SectionContextBase {
  api: GitHubClient;
  /** The target repository, parsed once at the boundary (see RepoRef). */
  repo: RepoRef;
}

/**
 * The read-only phases (check mode, the preflight probe, every plan-time read) run under `check: true`;
 * apply's resolver has every declared secret resolved up front by the engine (ExecTools in ./plan.ts).
 */
export type SectionContext =
  | (SectionContextBase & { check: true; resolveSecret?: never })
  | (SectionContextBase & { check: false; resolveSecret: (reference: string) => string });

export type EndpointDict = Readonly<Record<string, EndpointDecl>>;

export type GraphqlDict = Readonly<Record<string, GraphqlOpDecl>>;

/**
 * GET /orgs/{org} is public, so no token permission; its 404 is the personal-account signal. A section whose
 * other reads can never be denied marks it the primary read (`primaryRead: { notFound: "absent" }`).
 */
export const ORG_PROBE = {
  route: "GET /orgs/{org}",
  statuses: { 200: "the organization", 404: "not an organization (a personal account)" },
  permission: "none",
} as const satisfies EndpointDecl;

/**
 * `E` and `G` must be the module's LITERAL (`as const`) dictionaries: ../registry.ts derives the
 * `${key}.${role}` unions from them, and the e2e mock's handler tables are typed by those unions.
 */
export interface SectionMeta<
  K extends SectionKey = SectionKey,
  E extends EndpointDict = EndpointDict,
  G extends GraphqlDict = GraphqlDict,
> {
  readonly key: K;
  /** Drives the grant prose (sectionGrant), the e2e mock's permission gate, and the fuzz oracle. */
  readonly permission: SectionPermission;
  /** Appended to the derived grant advice when a denial can mean more than a missing grant (an ambiguous 403). */
  readonly grantCaveat?: string;
  /**
   * "org": the resources exist only under an ORGANIZATION owner. The registry wraps the module's plan() and
   * snapshot() in the owner gate (./owner.ts), which probes the `org` role (ORG_PROBE, 404 tolerated) and
   * no-ops with a note on a personal account, so no section body spells the probe; the registry's lockstep
   * type admits the flag only beside that role. The single source of owner-kind modeling: the fuzz oracle's
   * personal-account fold reads it, and test/sections/registry.test.ts pins it to the probe endpoint.
   */
  readonly ownerSensitivity?: "org";
  /** Every REST endpoint the section may call, by role; the e2e mock's routes and USED_PATHS derive from it. */
  readonly endpoints: E;
  /**
   * Every GraphQL operation the section may issue, by role; the e2e mock, the coverage tripwire, and the
   * fuzz generators iterate allGraphqlOps().
   */
  readonly graphql?: G;
  /**
   * The generated Sections table's Undeclared-default column derives from it, and test/sections/docs-registry.test.ts
   * fails a coverage note that contradicts it; the wrapped `{_undeclared, entries}` form overrides it per run.
   *
   *   "delete"     -> lists live resources and DELETES undeclared ones; `_undeclared: keep` softens to notes
   *   "keep"       -> lists live resources and KEEPS undeclared ones as notes; `_undeclared: delete` hardens
   *   "untouched"  -> takes no `_undeclared` knob; the section applies no undeclared policy
   *
   * The conditional type pins the pairing: a section in UNDECLARED_POLICY_SECTIONS says "delete" or "keep", one outside it "untouched".
   */
  readonly undeclaredDefault: K extends UndeclaredPolicySection ? UndeclaredPolicy : "untouched";
  /**
   * Read by engine/layers.ts for the layered merge. Optional on the interface for the sections that take no
   * list; ../registry.ts requires it of every list section, so a list module omitting it fails to compile.
   */
  readonly layering?: K extends ListSection ? KeyedListLayering : never;
}

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
   * A NESTED list's `_undeclared` default (an environment's variables), the last fallback engine/layers.ts resolves a
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

/** The policy type in ../../types.ts is zod-free and spells the values itself; both pins fail when the two sets part. */
type _PolicyComplete = MustBeNever<Exclude<(typeof UNDECLARED_POLICIES)[number], UndeclaredPolicy>>;
type _PolicySound = MustBeNever<Exclude<UndeclaredPolicy, (typeof UNDECLARED_POLICIES)[number]>>;

/** The wrapper type in ../../types.ts is zod-free and spells the directive's values itself; both pins fail when the two sets part. */
type _WrapperLayeringComplete = MustBeNever<
  Exclude<Layering, NonNullable<UndeclaredPolicyList<unknown>["_layering"]>>
>;
type _WrapperLayeringSound = MustBeNever<
  Exclude<NonNullable<UndeclaredPolicyList<unknown>["_layering"]>, Layering>
>;

/** Used verbatim in permission errors; the Sections table on docs/reference/sections.md mirrors it in its PAT permission column. */
export function sectionGrant(section: Pick<SectionMeta, "permission" | "grantCaveat">): string {
  return grantFor(section.permission, section.grantCaveat);
}

/** A union, not a structural facet, so `{}` cannot satisfy it; failureFor and endpointPermission classify both kinds through it. */
export type FailingOp = EndpointDecl | GraphqlOpDecl;

/** The one place the override-vs-section precedence lives; the e2e mock's permission gate resolves through it too. "none" means public. */
export function endpointPermission(section: SectionMeta, op: GatedReadDecl): SectionPermission;
export function endpointPermission(section: SectionMeta, op: FailingOp): SectionPermission | "none";
export function endpointPermission(
  section: SectionMeta,
  op: FailingOp,
): SectionPermission | "none" {
  return op.permission ?? section.permission;
}

/**
 * `wire` is what the request does; `grade` is what GitHub gates it at, so an accessGrade override
 * write-gates a wire read (a GraphQL operation's kind is both). `phase` matters for reads (writes always carry "plan" and run at apply):
 *
 *   read, phase "plan"       -> available to plan(), so check mode and preflight may meet it
 *   read, phase "execution"  -> issued by a thunk, apply only (see EndpointDecl.phase)
 */
export interface SectionOperation {
  readonly role: string;
  readonly wire: "read" | "write";
  readonly grade: "read" | "write";
  readonly permission: SectionPermission | "none";
  readonly phase: "plan" | "execution";
}

/**
 * REST and GraphQL flattened, so a derivation over "everything this section can call" cannot skip the
 * GraphQL dictionary; _OperationDictionariesFlattened pins the flattening total.
 */
export function sectionOperations(section: SectionMeta): SectionOperation[] {
  return [
    ...Object.entries(section.endpoints).map(([role, endpoint]) => ({
      role,
      wire: endpointMethod(endpoint.route) === "GET" ? ("read" as const) : ("write" as const),
      grade: endpointKind(endpoint),
      permission: endpointPermission(section, endpoint),
      phase: endpoint.phase ?? ("plan" as const),
    })),
    ...Object.entries(section.graphql ?? {}).map(([role, op]) => ({
      role,
      wire: op.kind,
      grade: op.kind,
      permission: endpointPermission(section, op),
      phase: op.phase ?? ("plan" as const),
    })),
  ];
}

/** Execution-phase reads are excluded: only a thunk reaches them, so neither check mode nor preflight meets them. */
export function planningReads(section: SectionMeta): SectionOperation[] {
  return sectionOperations(section).filter((op) => op.wire === "read" && op.phase === "plan");
}

/**
 * How GitHub gates a section's planning reads under a read-only grant. Read by the fuzz oracle and the docs.
 *
 *   "plain"        -> every read succeeds (also a section with no reads)
 *   "write-gated"  -> denied at the first read
 *   "mixed"        -> reads until the handler reaches a gated one
 */
export type ReadGating = "plain" | "write-gated" | "mixed";

export function readGating(section: SectionMeta): ReadGating {
  const reads = planningReads(section);
  const gated = reads.filter((op) => op.grade === "write").length;
  if (gated === 0) {
    return "plain";
  }
  return gated === reads.length ? "write-gated" : "mixed";
}

export interface WriteGatedRead {
  readonly route: Route;
  readonly permission: SectionPermission;
}

/** GraphQL reads are never here: a GraphQL read is gated at read (its kind IS the gate), so the REST dictionary is complete. */
export function writeGatedReads(section: SectionMeta): WriteGatedRead[] {
  return Object.values(section.endpoints)
    .filter((endpoint): endpoint is GatedReadDecl => endpoint.accessGrade === "write")
    .map((endpoint) => ({
      route: endpoint.route,
      permission: endpointPermission(section, endpoint),
    }));
}

/** What a fine-grained 404 on a section's primary read means (see EndpointDecl.primaryRead). */
export type DenialPosture = NonNullable<EndpointDecl["primaryRead"]>["notFound"];

/**
 * A section with no planning read classifies nothing before its first write, so it is "absent".
 * Read by the fuzz oracle and the e2e mock.
 */
export function denialPosture(section: SectionMeta): DenialPosture {
  const primaries = Object.values(section.endpoints).flatMap((endpoint) =>
    endpoint.primaryRead === undefined ? [] : [endpoint],
  );
  if (primaries.length > 1) {
    throw new Error(
      `BUG: ${section.key} declares primaryRead on ${primaries.length} endpoints; at most one read carries the 404 posture`,
    );
  }
  const primary = primaries[0];
  if (primary !== undefined && primary.phase === "execution") {
    throw new Error(
      `BUG: ${section.key} declares primaryRead on the execution-phase read ${primary.route}; plan() never issues it, so no denied first read can be classified from it`,
    );
  }
  const posture = primary?.primaryRead?.notFound;
  if (posture !== undefined) {
    return posture;
  }
  if (planningReads(section).length > 0) {
    throw new Error(
      `BUG: ${section.key} reads but declares no primaryRead posture, so a denied first read cannot be classified`,
    );
  }
  return "absent";
}

/**
 * The primary read whose 404 a section reads as "absent" while a fine-grained token missing the
 * grant is answered with the same 404. Null when the read is public (a 404 there has one reading)
 * or the section classifies a 404 as a denial already.
 */
export function gatedAbsentRead(section: SectionMeta): EndpointDecl | null {
  const primary = Object.values(section.endpoints).find(
    (endpoint) => endpoint.primaryRead?.notFound === "absent",
  );
  return primary === undefined || endpointPermission(section, primary) === "none" ? null : primary;
}

/**
 * The note a snapshot carries when such a read DID answer 404 and the section read nothing:
 * unlike plan(), no write follows to surface a denial, so the note names both readings.
 */
export function concealedAbsenceNote(section: SectionMeta, read: EndpointDecl): string {
  return (
    `${section.key}: GitHub answered GET ${endpointPath(read.route)} with 404, read here as ` +
    "nothing to snapshot. A fine-grained token missing the grant gets the same answer; if the " +
    `repository does have this resource, ${sectionGrant(section)}, then snapshot again`
  );
}

type FlattenedOperationDictionaries = "endpoints" | "graphql";

type OperationDictionaryKeys = {
  [K in keyof SectionMeta]-?: NonNullable<SectionMeta[K]> extends Readonly<
    Record<string, FailingOp>
  >
    ? K
    : never;
}[keyof SectionMeta];

/**
 * A new operation dictionary on SectionMeta fails here until sectionOperations flattens it.
 * The structural match sees only `Readonly<Record<string, ...>>` properties: a dictionary declared as a
 * named interface would evade it, so keep the record form on any future one.
 */
type _OperationDictionariesFlattened = MustBeNever<
  Exclude<OperationDictionaryKeys, FlattenedOperationDictionaries>
>;

/**
 * Derived from the section's operation list rather than restated per section: a planning read added
 * later would make the cannot-verify claim false, so the helper throws instead of letting the prose drift
 * (an execution-phase read, which check mode never issues, does not count).
 */
export function writeOnlyCheckNote(
  section: SectionMeta,
  opts: { resource: string; reasserts: string },
): string {
  if (planningReads(section).length > 0) {
    throw new Error(
      `BUG: ${section.key} declares a read operation, so it is not write-only and the cannot-verify note would be false; diff against the read instead`,
    );
  }
  return cannotVerifyNote(section.key, {
    why: `GitHub exposes no read endpoint for ${opts.resource}`,
    what: "them",
    reasserts: `re-asserts ${opts.reasserts}`,
  });
}

/**
 * The ONE wording for a declared value check mode cannot compare (a secret GitHub never echoes, a
 * toggle with no read endpoint, a duration GitHub reports only as its computed expiry): why, what
 * stays unverified, and what apply does about it on every run.
 */
export function cannotVerifyNote(
  label: string,
  opts: {
    /** Why GitHub cannot show the value ("GitHub never reveals a webhook secret"). */
    why: string;
    /** What stays unverified ("the declared value", "them"). */
    what: string;
    /** Apply's every-run verb phrase ("re-sends it", "re-asserts the declared preferences"). */
    reasserts: string;
  },
): string {
  return `${label}: ${opts.why}, so check mode cannot verify ${opts.what}; apply ${opts.reasserts} on every run`;
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

type Validated<T, K extends SectionKey> = T extends null ? null : T & ValidatedBrand<K>;

interface SectionModuleBase<
  K extends SectionKey = SectionKey,
  E extends EndpointDict = EndpointDict,
  G extends GraphqlDict = GraphqlDict,
> extends SectionMeta<K, E, G> {
  /**
   * Declared fields are checked and unknown fields pass through, so validation does not fight
   * passthrough-first forward compatibility. STRICT nested sub-shapes are sanctioned only where the
   * endpoint offers no passthrough destination (actions.cache, the environment secrets and
   * deployment_protection_rules entries), where an extra key can only be a typo.
   */
  shape: z.ZodType;
  /**
   * Declared only by CLOSED sections, whose API calls never forward extra entry keys (collaborators, teams,
   * workflows), so an unrecognized key would apply "successfully" and never converge; open passthrough
   * sections must NOT declare it, since their extra keys reach GitHub.
   *
   *   `known` mapped over EVERY entry key          -> a new schema field forces a decision here; a phantom key is an excess property
   *   EntryOf sees through the wrapped form        -> a closed section that also takes the knob (collaborators) stays closed in both forms
   *   validateSectionShapes (engine/validate.ts)   -> rejects before any section writes
   */
  closedSurface?: [EntryOf<NonNullable<SettingsFile[K]>>] extends [never]
    ? never
    : {
        /** Key order is the order the error prose lists them in. */
        known: {
          readonly [P in Extract<keyof EntryOf<NonNullable<SettingsFile[K]>>, string>]: true;
        };
        /** What the unrecognized key would silently do, as message prose. */
        consequence: string;
      };
  /**
   * Declared only by sections with designated secret fields (every webhooks entry's config.secret); the
   * values are returned raw, and nothing here reads the environment.
   *
   *   check mode and preflight   -> the engine validates each as a whole-value `$NAME` reference
   *   apply                      -> the engine resolves and masks them all up front, so ctx.resolveSecret never misses
   */
  secretValues?(declared: SectionInput<K>): DeclaredSecretValue[];
}

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
 * Every check that reads the declared value and nothing else (no API, no environment): a duplicated identity, a
 * malformed key material, a list GitHub would fold. engine/validate.ts runs it inside document validation, in both
 * modes, before the preflight barrier and the first write, and joins the findings to the settings-malformed-sections
 * problem; the same check thrown from plan() would fire after earlier sections wrote (the preflight probe reports
 * only denials). Required on a list section, since every entry list has an identity to keep unique; a mapping
 * section may declare none. The erased view (SectionModule<SectionKey>) keeps it optional so every module erases.
 */
type ValidateFacet<K extends SectionKey> =
  IsUnion<K> extends true
    ? { validate?(declared: SectionInput<K>): readonly DeclaredIssue[] }
    : [EntryOf<NonNullable<SettingsFile[K]>>] extends [never]
      ? { validate?(declared: SectionInput<K>): readonly DeclaredIssue[] }
      : { validate(declared: SectionInput<K>): readonly DeclaredIssue[] };

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;

type IsUnion<T> = [T] extends [UnionToIntersection<T>] ? false : true;

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
 * What a section reads back as a settings document: its live state in the section's own declared
 * form, or `undefined` when nothing exists (the engine omits the key). `notes` carry what the value
 * cannot: a secret's unreadable value, a feature the repository lacks.
 */
export interface SectionSnapshot<K extends SectionKey = SectionKey> {
  readonly value: SettingsFile[K] | undefined;
  readonly notes: readonly string[];
}

/**
 * plan() only READS (through the port in PlanContext) and returns the operations that would converge the
 * repository, or the failure that ended it as a value (a denied read, a live state it cannot reconcile); the
 * engine renders the operations as drift in check mode and executes them in apply mode.
 * Modules register in ../registry.ts.
 *
 *   snapshot() required  -> the section declares a read (a GET or a GraphQL query), so the live state it
 *                           compares against can be read back; SnapshotFacet flags a module annotated over its
 *                           literal dictionaries without one, and ../registry.ts flags every registrant without one
 *   snapshot() absent    -> only a write-only section (no read at all), which snapshot reports unsupported
 *                           (snapshotUnsupportedNote)
 */
export type SectionModule<
  K extends SectionKey = SectionKey,
  E extends EndpointDict = EndpointDict,
  G extends GraphqlDict = GraphqlDict,
> = SectionModuleBase<K, E, G> &
  SnapshotFacet<K, E, G> &
  ValidateFacet<K> & {
    plan(
      ctx: PlanContext<E, G, K>,
      desired: ValidatedInput<K>,
    ): Promise<Result<SectionPlan<PlannedOp<E, G>>, SectionFailure>>;
    /** Pinned so a non-literal object carrying a run() handler is not assignable either. */
    run?: never;
  };

/** Whether a LITERAL dictionary pair declares any read; the erased pair (the engine's view) keeps snapshot optional. */
export type DeclaresRead<E extends EndpointDict, G extends GraphqlDict> = string extends keyof E
  ? false
  : [
        | { [R in keyof E]: E[R]["route"] extends `GET ${string}` ? true : never }[keyof E]
        | { [R in keyof G]: G[R] extends { readonly kind: "read" } ? true : never }[keyof G],
      ] extends [never]
    ? false
    : true;

type SnapshotFacet<K extends SectionKey, E extends EndpointDict, G extends GraphqlDict> =
  DeclaresRead<E, G> extends true
    ? {
        snapshot(
          ctx: SnapshotContext<E, G, K>,
        ): Promise<Result<SectionSnapshot<K>, SectionFailure>>;
      }
    : {
        snapshot?(
          ctx: SnapshotContext<E, G, K>,
        ): Promise<Result<SectionSnapshot<K>, SectionFailure>>;
      };

/**
 * Freezes in place through every nested object and array; functions are left as they are (nothing
 * reads their properties). The registry views freeze the tagged copies they build with it.
 */
export function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value === "object" && value !== null) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value as DeepReadonly<T>;
}

/** Every SectionMeta field plus closedSurface (its `known` map gates validation); the pin below fails on a module field sorted into neither list. */
const DECLARATION_FIELDS = [
  "key",
  "permission",
  "grantCaveat",
  "ownerSensitivity",
  "endpoints",
  "graphql",
  "undeclaredDefault",
  "layering",
  "closedSurface",
] as const satisfies readonly (keyof SectionModule)[];

/** `shape` stays as zod built it; the rest are handlers. */
type HandlerField = "shape" | "plan" | "snapshot" | "secretValues" | "validate" | "run";

type _EveryModuleFieldSorted = MustBeNever<
  Exclude<keyof SectionModule, (typeof DECLARATION_FIELDS)[number] | HandlerField>
>;

/**
 * Called once per module as ../registry.ts registers it, so a route, status, hint, permission, GraphQL
 * outcome, or closed-surface key cannot move after that in the action, the CLI, or the library alike; the
 * readonly types stop only compiled assignments. The module object itself is frozen shallowly.
 */
export function freezeDeclarations<M extends SectionModule>(module: M): M {
  for (const field of DECLARATION_FIELDS) {
    deepFreeze(module[field]);
  }
  return Object.freeze(module);
}

/**
 * The one reason a registered section has no snapshot(): it reads nothing, so there is nothing to read back
 * (SectionModule makes snapshot() required otherwise). Write-only is derived from the operations, as
 * writeOnlyCheckNote does, so the two notes cannot disagree.
 */
export function snapshotUnsupportedNote(section: SectionMeta): string {
  if (planningReads(section).length > 0) {
    throw new Error(
      `BUG: ${section.key} declares a read operation but no snapshot(); a section that reads must read back, so declare snapshot() on the module`,
    );
  }
  return `${section.key}: GitHub exposes no read endpoint for this section, so there is nothing to snapshot; apply re-asserts the declared value on every run`;
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
 * The secret values of a list section's declared value, one `extract` per entry. DEFENSIVE by contract:
 * secretValues runs before shape validation, so a malformed container or entry contributes nothing
 * rather than throwing, and the actionable error always comes from validation.
 */
export function secretValuesOf(
  declared: unknown,
  extract: (entry: Readonly<Record<string, unknown>>) => readonly DeclaredSecretValue[],
): DeclaredSecretValue[] {
  const isWrapper =
    typeof declared === "object" &&
    declared !== null &&
    !Array.isArray(declared) &&
    Array.isArray((declared as { entries?: unknown }).entries);
  if (!Array.isArray(declared) && !isWrapper) {
    return [];
  }
  // "keep" is a placeholder: only the entries are read.
  const { entries } = undeclaredPolicy(
    declared as readonly unknown[] | UndeclaredPolicyList<unknown>,
    "keep",
  );
  return entries.flatMap((entry) =>
    typeof entry === "object" && entry !== null && !Array.isArray(entry)
      ? [...extract(entry as Readonly<Record<string, unknown>>)]
      : [],
  );
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
    .superRefine((value, ctx) => {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) {
          ctx.addIssue({
            code: "custom",
            message:
              "Invalid input: expected a plain mapping (a YAML-tagged value like !!timestamp parses to another type)",
          });
        }
      }
    })
    .pipe(shape);
}

/** The zod internals a schema walk reads, one view for every walk in the tree. */
export interface ZodDef {
  type: string;
  shape?: Record<string, z.ZodType>;
  catchall?: z.ZodType;
  element?: z.ZodType;
  innerType?: z.ZodType;
  options?: readonly z.ZodType[];
  valueType?: z.ZodType;
  checks?: readonly unknown[];
}

export function defOf(schema: z.ZodType): ZodDef {
  return (schema as unknown as { _zod: { def: ZodDef } })._zod.def;
}

/** Every clone's own checks are rewired to report beside a failed nested value (reportingBesideFailures). */
function cloneWith(schema: z.ZodType, patch: Partial<ZodDef>): z.ZodType {
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
  const checks = (def.checks as readonly z.core.$ZodCheck[] | undefined)?.map(
    reportingBesideFailures,
  );
  return z.util.clone(
    schema as unknown as Parameters<typeof z.util.clone>[0],
    { ...def, ...patch, checks } as never,
  ) as unknown as z.ZodType;
}

/** The rewire for a check attached AFTER loosen(): a section composing a rule onto its loosened shape. */
export function checksReportingBesideFailures(schema: z.ZodType): z.ZodType {
  return cloneWith(schema, {});
}

const REPORTS_BESIDE_FAILURES = new WeakSet<z.core.$ZodCheck>();

let swallowedThrowObserver: ((error: unknown) => void) | null = null;

/** Test seam for the swallowed throws below (test/sections/raw-sibling.test.ts); production leaves it null. */
export function observeSwallowedThrows(observer: ((error: unknown) => void) | null): void {
  swallowedThrowObserver = observer;
}

/** The paths of the issues that abort a parse (a wrong type, a refused option); a rule's own finding and an unrecognized key do not. */
function failedPaths(issues: readonly z.core.$ZodRawIssue[]): PropertyKey[][] {
  return issues.flatMap((issue) => (issue.continue === true ? [] : [issue.path ?? []]));
}

function isUnder(path: readonly PropertyKey[], failed: readonly PropertyKey[]): boolean {
  return failed.length <= path.length && failed.every((step, index) => step === path[index]);
}

/**
 * zod skips a node's own checks once a nested value failed; rewired, a check runs unless the node itself was refused
 * (a pathless failure). The contract for a rule, which then meets the raw value at a failed property: a finding under
 * a failed path is dropped (the shape's issue stands there), a throw ends the rule with its findings so far, and a
 * rule branching on a sibling's type guards that read itself, and a rule reading a property or the truth of a
 * sibling asks for the type first (an empty string's length is zero, a number is truthy). With no failure a throw
 * propagates.
 */
function reportingBesideFailures(check: z.core.$ZodCheck): z.core.$ZodCheck {
  if (REPORTS_BESIDE_FAILURES.has(check)) {
    return check;
  }
  const { when, ...def } = check._zod.def;
  const inner = check._zod.check;
  const clone: z.core.$ZodCheck = {
    _zod: {
      def: {
        ...def,
        when: (payload) =>
          (when?.(payload) ?? true) && !failedPaths(payload.issues).some((p) => p.length === 0),
      },
      onattach: check._zod.onattach,
      check: (payload) => {
        const failed = failedPaths(payload.issues);
        if (failed.length === 0) {
          return inner(payload);
        }
        const before = payload.issues.length;
        try {
          inner(payload);
        } catch (error) {
          // The rule tripped on a raw value whose own shape issue is already listed.
          swallowedThrowObserver?.(error);
        }
        const findings = payload.issues.splice(before);
        payload.issues.push(
          ...findings.filter((f) => !failed.some((path) => isUnder(f.path ?? [], path))),
        );
      },
    },
  };
  REPORTS_BESIDE_FAILURES.add(clone);
  return clone;
}

/**
 * Every plain (strip) object becomes a passthrough looseObject, so unknown keys ride through to GitHub
 * and superRefine checks reading undeclared keys can see them. Preserved as authored:
 *
 *   strictObject             -> stays strict
 *   refine/superRefine       -> survives (clones carry the checks); one on the knobbed union itself throws instead
 *   a leaf's own checks      -> rewired like a rule (a min or max length runs, in zod, on any value with a length,
 *                               so it would judge a raw list beside the leaf's own type issue)
 *   knobbed-section union    -> rewrapped as a container-routed check, so a failing entry keeps its issue path
 *                               (`labels[2].name`) instead of a plain union's pathless "Invalid input"
 *   unrecognized CONTAINER   -> throws, rather than ship a shape that silently skipped loosening
 */
export function loosen(schema: z.ZodType): z.ZodType {
  const def = defOf(schema);
  switch (def.type) {
    case "object": {
      const shape = def.shape ?? {};
      const loosened = Object.fromEntries(
        Object.entries(shape).map(([key, value]) => [key, loosen(value)]),
      );
      // z.never stays never (strict stays strict); an absent catchall means strip, which becomes passthrough.
      const catchall = def.catchall === undefined ? z.unknown() : loosen(def.catchall);
      return cloneWith(schema, { shape: loosened, catchall });
    }
    case "array":
      return cloneWith(schema, { element: loosen(def.element as z.ZodType) });
    case "record":
      return cloneWith(schema, { valueType: loosen(def.valueType as z.ZodType) });
    case "optional":
    case "nullable":
    case "default":
      return cloneWith(schema, { innerType: loosen(def.innerType as z.ZodType) });
    case "union": {
      const options = def.options ?? [];
      const knob = detectKnobUnion(options);
      if (knob !== null) {
        if ((def.checks?.length ?? 0) > 0) {
          throw new Error(
            "BUG: loosen(): a knobbed-section union carries its own refinements, which the routed rewrap would silently drop - attach them to the entry array or the wrapper",
          );
        }
        return routedListShape(loosen(knob.list), loosen(knob.wrapper));
      }
      return cloneWith(schema, { options: options.map(loosen) });
    }
    default:
      if (!LOOSEN_LEAF_TYPES.has(def.type)) {
        throw new Error(
          `BUG: loosen(): unhandled schema type "${def.type}" - teach loosen() its runtime derivation before authoring it in src/schema.ts`,
        );
      }
      return (def.checks?.length ?? 0) > 0 ? cloneWith(schema, {}) : schema;
  }
}

const LOOSEN_LEAF_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "boolean",
  "enum",
  "literal",
  "unknown",
  "never",
  "null",
]);

/** The knobbed() and layeredList() unions (../shared/schema-helpers.ts): the entry array beside a strict wrapper with `entries`; engine/canonical.ts walks them by this detector too. */
export function detectKnobUnion(
  options: readonly z.ZodType[],
): { list: z.ZodType; wrapper: z.ZodType } | null {
  if (options.length !== 2) {
    return null;
  }
  const list = options.find((option) => defOf(option).type === "array");
  const wrapper = options.find((option) => {
    const def = defOf(option);
    return (
      def.type === "object" &&
      def.catchall !== undefined &&
      defOf(def.catchall).type === "never" &&
      def.shape?.entries !== undefined
    );
  });
  return list !== undefined && wrapper !== undefined ? { list, wrapper } : null;
}

/** A transform, not a union, so a failing entry keeps its precise issue path and the output is the routed shape's parsed data. */
function routedListShape(list: z.ZodType, wrapper: z.ZodType): z.ZodType {
  // The wrapper's own words for what rides beside `entries`: the policy on a knobbed section, the directive alone on a plain list.
  const beside =
    defOf(wrapper).shape?._undeclared === undefined
      ? 'an optional "_layering" directive'
      : 'an optional "_undeclared" policy';
  return z
    .custom<unknown>(() => true)
    .transform((value, ctx) => {
      const shape = Array.isArray(value)
        ? list
        : typeof value === "object" && value !== null
          ? wrapper
          : null;
      if (shape === null) {
        ctx.addIssue({
          code: "custom",
          message: `Invalid input: expected a list of entries, or a mapping with "entries" (and ${beside}), but this section parsed as ${value === null ? "null" : typeof value}`,
          // A null list has no empty state of its own: engine/validate.ts names the fix from this instead of the type prose.
          ...(value === null ? { params: { legal: "a list of entries ([] for none)" } } : {}),
        });
        return z.NEVER;
      }
      const parsed = shape.safeParse(value);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({ ...issue });
        }
        // The raw value, not z.NEVER: a rule the section composed onto the routed shape runs beside the failed
        // entry (reportingBesideFailures) and must meet the entries, raw where they failed. The parse fails regardless.
        return value;
      }
      return parsed.data;
    });
}

export type EntryOf<T> = T extends readonly (infer E)[]
  ? E
  : T extends { entries: readonly (infer E)[] }
    ? E
    : never;

/**
 * A validated document arrives with every knobbed list in wrapper form and its policy explicit
 * (resolveUndeclaredPolicies in engine/layers.ts runs at the fold and in the validator), so at run time the
 * wrapper's `_undeclared` is what a planner reads. `defaultPolicy` is REQUIRED all the same: it is the list's
 * own default, which the drift prose names and which a plan() called on a raw declaration (a test) falls back
 * to, and a nested list cannot derive it from its section's undeclaredDefault. Entries are returned by reference.
 */
export function undeclaredPolicy<E>(
  declared: readonly E[] | UndeclaredPolicyList<E>,
  defaultPolicy: UndeclaredPolicy,
): { policy: UndeclaredPolicy; entries: readonly E[] } {
  if (Array.isArray(declared)) {
    return { policy: defaultPolicy, entries: declared };
  }
  const wrapped = declared as UndeclaredPolicyList<E>;
  return { policy: wrapped._undeclared ?? defaultPolicy, entries: wrapped.entries };
}

/** The parameter type admits only the knobbed sections, so asking for a non-enumerating section's default is a compile error, not a runtime BUG. */
export function defaultUndeclaredPolicy(
  section: SectionMeta<UndeclaredPolicySection>,
): UndeclaredPolicy {
  return section.undeclaredDefault;
}

/**
 * Only the WORDS live here, so the keep-note cannot drift between sections; which branch runs stays in
 * each section's own control flow on purpose.
 */
export function undeclaredNote(opts: {
  /** The subject naming the live resource: `label "stale"`, `autolink JIRA-`. */
  subject: string;
  /** How the resource presents; the common case is the default. */
  state?: string;
  /** The pronoun for "add ... to the settings file" ("it" unless plural). */
  add?: string;
  /** What adding it would manage ("it", or "their access" for people). */
  manage?: string;
  /** What `_undeclared: delete` would make apply do, with any consequence. */
  action: string;
}): string {
  const state = opts.state ?? "exists on the repo but is not declared";
  const add = opts.add ?? "it";
  const manage = opts.manage ?? "it";
  return `${opts.subject} ${state} in the settings file; kept under "_undeclared: keep" - add ${add} to the settings file to manage ${manage}, or set "_undeclared: delete" to have apply ${opts.action}`;
}

/**
 * The drift line for a field whose live value differs, operands always in this order: declared first,
 * live second. Both arrive rendered (JSON.stringify, or a section's own spelling such as "unset").
 */
export function valueDrift(
  label: string,
  declared: string,
  live: string,
  opts: {
    /** Qualifies the live value, in parentheses: a raw state behind the compared one, why order counts. */
    qualifier?: string;
    /** The apply clause; null when a generic line beside it already names the remedy (a recreate's field lines). */
    remedy?: string | null;
  } = {},
): string {
  const qualifier = opts.qualifier === undefined ? "" : ` (${opts.qualifier})`;
  const remedy =
    opts.remedy === null ? "" : `; ${opts.remedy ?? "apply will set the declared value"}`;
  return `${label}: declared ${declared} != live ${live}${qualifier}${remedy}`;
}

/**
 * The knob clause derives from the list's DEFAULT policy so it can never contradict the section: under a
 * keep default this branch is reachable only because the file set `_undeclared: delete`, so the line says
 * so. Pass the same default the policy was unwrapped with.
 */
export function undeclaredDrift(
  listDefault: UndeclaredPolicy,
  opts: {
    /** The drift-line prefix with the natural key: `labels[stale]`. */
    label: string;
    /** What apply will do, with any consequence worth naming. */
    action: string;
    /** When "not in the settings file" understates it (a PENDING INVITATION rather than a collaborator); the knob clause follows it. */
    state?: string;
    /** The pronoun for "add ... to the settings file" ("it" unless plural). */
    add?: string;
    /** What adding it would keep ("it", or "their access" for people). */
    keep?: string;
  },
): string {
  const knob = listDefault === "keep" ? ' and "_undeclared: delete" is set' : "";
  const state = opts.state ?? "not in the settings file";
  const add = opts.add ?? "it";
  const keep = opts.keep ?? "it";
  return `${opts.label}: undeclared - ${state}${knob}, so apply will ${opts.action}; add ${add} to the settings file to keep ${keep}`;
}

/**
 * The drift line for a declared resource the live side lacks. `where` completes "but not ..." when "on the
 * repo" understates it ("on the environment", "enabled on the environment"); `action` when apply does more
 * than create it.
 */
export function missingDrift(
  label: string,
  opts: { where?: string; action?: string } = {},
): string {
  return `${label}: missing - declared in the settings file but not ${opts.where ?? "on the repo"}; apply will ${opts.action ?? "create it"}`;
}
