/**
 * The shape of a section module: the declaration fields every section states, the handlers it
 * implements, and the freeze that seals the declarations at registration.
 */

import type { Result } from "neverthrow";
import type { z } from "zod";
import type { RepoRef } from "../../discovery/targets.js";
import type { GitHubClient } from "../../github/api.js";
import type {
  ListSection,
  SectionKey,
  SettingsFile,
  UndeclaredPolicySection,
} from "../../schema.js";
import type { DeepReadonly, MustBeNever, UndeclaredPolicy } from "../../types.js";
import type {
  DeclaredIssue,
  DeclaredSecretValue,
  EntryOf,
  SectionInput,
  ValidatedInput,
} from "./declared.js";
import type { EndpointDecl } from "./endpoints.js";
import type { SectionFailure } from "./errors.js";
import type { GraphqlOpDecl } from "./graphql.js";
import type { KeyedListLayering } from "./keyed-list.js";
import type { SectionPermission } from "./permissions.js";
import type { PlanContext, PlannedOp, SectionPlan, SnapshotContext } from "./plan.js";

// Staging for the importer sweep: it repoints every file importing from this module at the
// sibling that declares each name, then deletes this block.
export {
  type DeclaredIssue,
  type DeclaredSecretValue,
  declaredEntries,
  duplicateFieldIssues,
  duplicateIssues,
  type EntryOf,
  listEntries,
  type PlainTyped,
  requirePlainMapping,
  type SectionInput,
  secretValuesOf,
  type ValidatedBrand,
  type ValidatedInput,
} from "./declared.js";
export {
  cannotVerifyNote,
  missingDrift,
  undeclaredDrift,
  undeclaredNote,
  undeclaredPolicy,
  valueDrift,
} from "./drift.js";
export { identifiedBy, type KeyedListLayering, keyedBy } from "./keyed-list.js";
export {
  concealedAbsenceNote,
  type DenialPosture,
  denialPosture,
  endpointPermission,
  type FailingOp,
  gatedAbsentRead,
  planningReads,
  type ReadGating,
  readGating,
  type SectionOperation,
  sectionGrant,
  sectionOperations,
  snapshotUnsupportedNote,
  writeGatedReads,
  writeOnlyCheckNote,
} from "./operations.js";

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
 * What a section reads back as a settings document: its live state in the section's own declared
 * form, or `undefined` when nothing exists (the engine omits the key). `notes` carry what the value
 * cannot: a secret's unreadable value, a feature the repository lacks.
 */
export interface SectionSnapshot<K extends SectionKey = SectionKey> {
  readonly value: SettingsFile[K] | undefined;
  readonly notes: readonly string[];
}

/**
 * plan() only READS (through the port in PlanContext) and returns the operations that would converge the repository,
 * or the failure that ended it as a value; the engine renders them as drift in check mode and executes them in apply mode.
 *
 *   snapshot() required  -> the section declares a read (a GET or a GraphQL query); SnapshotFacet and ../registry.ts
 *                           flag a module without one
 *   snapshot() absent    -> a write-only section (no read at all), which snapshot reports unsupported (snapshotUnsupportedNote)
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

/** The parameter type admits only the knobbed sections, so asking for a non-enumerating section's default is a compile error, not a runtime BUG. */
export function defaultUndeclaredPolicy(
  section: SectionMeta<UndeclaredPolicySection>,
): UndeclaredPolicy {
  return section.undeclaredDefault;
}
