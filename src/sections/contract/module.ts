import { z } from "zod";
import type { RepoRef } from "../../discovery/targets.js";
import type { GithubClient } from "../../github/api.js";
import type { SectionKey, SettingsFile, UndeclaredPolicySection } from "../../schema.js";
import type { MustBeNever, UndeclaredPolicy, UndeclaredPolicyList } from "../../types.js";
import {
  type EndpointDecl,
  endpointKind,
  endpointMethod,
  type GatedReadDecl,
  type Route,
} from "./endpoints.js";
import type { GraphqlOpDecl } from "./graphql.js";
import { grantFor, type SectionPermission } from "./permissions.js";
import type { PlanContext, PlannedOp, SectionPlan } from "./plan.js";

interface SectionContextBase {
  api: GithubClient;
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
   * "org": the resources exist only under an ORGANIZATION owner, so the handler probes GET /orgs/{org}
   * (404 tolerated) and no-ops with a note on a personal account. The single source of owner-kind modeling:
   * the fuzz oracle's personal-account fold reads it, and test/sections/registry.test.ts pins it to the probe endpoint.
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
   * fails a COVERAGE Notes cell that contradicts it; the wrapped `{_undeclared, entries}` form overrides it per run.
   *
   *   "delete"     -> lists live resources and DELETES undeclared ones; `_undeclared: keep` softens to notes
   *   "keep"       -> lists live resources and KEEPS undeclared ones as notes; `_undeclared: delete` hardens
   *   "untouched"  -> takes no `_undeclared` knob; the section applies no undeclared policy
   *
   * The conditional type pins the pairing: a section in UNDECLARED_POLICY_SECTIONS says "delete" or "keep", one outside it "untouched".
   */
  readonly undeclaredDefault: K extends UndeclaredPolicySection ? UndeclaredPolicy : "untouched";
  /** Read by engine/layers.ts for the layered merge; a knobbed section that declares none always replaces. */
  readonly layering?: K extends UndeclaredPolicySection ? KeyedListLayering : never;
}

/**
 * engine/layers.ts pairs two entries when their key sets intersect, the planner's own duplicate test,
 * so a merged document is always one the planner accepts.
 */
export interface KeyedListLayering {
  /**
   * Folded as the planner folds them (a label claims its name plus its pre-rename name); null when the
   * entry carries none, which the layer boundary refuses.
   */
  readonly keys: (entry: Readonly<Record<string, unknown>>) => readonly string[] | null;
  /** The entry field the keys come from, for refusal prose ("name", "type"). */
  readonly keyField: string;
  /** A matched pair: "replace" (higher wins wholesale) or "merge" (key by key, nested keyed lists below). */
  readonly combine: "replace" | "merge";
  /** Fields of a merged entry that are themselves keyed lists (rulesets' `rules`). */
  readonly nested?: Readonly<Record<string, KeyedListLayering>>;
}

/** Used verbatim in permission errors; the Sections table on docs/reference/sections.md mirrors it in its PAT permission column. */
export function sectionGrant(section: Pick<SectionMeta, "permission" | "grantCaveat">): string {
  return grantFor(section.permission, section.grantCaveat);
}

/** A union, not a structural facet, so `{}` cannot satisfy it; throwFor and endpointPermission classify both kinds through it. */
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
  return `${section.key}: GitHub exposes no read endpoint for ${opts.resource}, so check mode cannot verify them; apply re-asserts ${opts.reasserts} on every run`;
}

/**
 * validateSettingsDoc (engine/orchestrate.ts) has run every section's shape before a handler sees this,
 * so plan() carries the proof in its parameter type instead of a per-section cast. Only `undefined` (the
 * absent-section marker) is excluded: a nullable section (interaction_limits) keeps its `null`.
 */
type SectionInput<K extends SectionKey> = Exclude<SettingsFile[K], undefined>;

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
        /**
         * Method syntax on purpose: a function-typed property is contravariant in its parameter, which
         * would stop the module's exact type from erasing to SectionModule<SectionKey> in ../registry.ts.
         */
        describe(entry: EntryOf<NonNullable<SettingsFile[K]>>): string;
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
 * plan() only READS (through the port in PlanContext) and returns the operations that would converge the
 * repository; the engine renders them as drift in check mode and executes them in apply mode.
 * Modules register in ../registry.ts.
 */
export interface SectionModule<
  K extends SectionKey = SectionKey,
  E extends EndpointDict = EndpointDict,
  G extends GraphqlDict = GraphqlDict,
> extends SectionModuleBase<K, E, G> {
  plan(ctx: PlanContext<E, G>, desired: SectionInput<K>): Promise<SectionPlan<PlannedOp<E, G>>>;
  /** Pinned so a non-literal object carrying a run() handler is not assignable either. */
  run?: never;
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
 * zod's object schemas accept any non-array object, so a YAML-tagged scalar like !!timestamp (a Date)
 * would validate as an empty mapping and silently configure nothing.
 *
 *   scalars, arrays, null    -> pass through, so the piped shape reports its own error
 *   applied by               -> the sections whose whole value is one mapping (repository, the setups, interaction_limits)
 *   document-wide backstop   -> findNonPlain in engine/validate.ts
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

interface LoosenDef {
  type: string;
  shape?: Record<string, z.ZodType>;
  catchall?: z.ZodType;
  element?: z.ZodType;
  innerType?: z.ZodType;
  options?: readonly z.ZodType[];
  valueType?: z.ZodType;
  checks?: readonly unknown[];
}

function defOf(schema: z.ZodType): LoosenDef {
  return (schema as unknown as { _zod: { def: LoosenDef } })._zod.def;
}

function cloneWith(schema: z.ZodType, patch: Partial<LoosenDef>): z.ZodType {
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
  return z.util.clone(
    schema as unknown as Parameters<typeof z.util.clone>[0],
    { ...def, ...patch } as never,
  ) as unknown as z.ZodType;
}

/**
 * Every plain (strip) object becomes a passthrough looseObject, so unknown keys ride through to GitHub
 * and superRefine checks reading undeclared keys can see them. Preserved as authored:
 *
 *   strictObject             -> stays strict
 *   refine/superRefine       -> survives (clones carry the checks); one on the knobbed union itself throws instead
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
      return cloneWith(schema, { innerType: loosen(def.innerType as z.ZodType) });
    case "union": {
      const options = def.options ?? [];
      const knob = detectKnobUnion(options);
      if (knob !== null) {
        if ((def.checks?.length ?? 0) > 0) {
          throw new Error(
            "loosen(): a knobbed-section union carries its own refinements, which the routed rewrap would silently drop - attach them to the entry array or the wrapper",
          );
        }
        return routedListShape(loosen(knob.list), loosen(knob.wrapper));
      }
      return cloneWith(schema, { options: options.map(loosen) });
    }
    default:
      if (!LOOSEN_LEAF_TYPES.has(def.type)) {
        throw new Error(
          `loosen(): unhandled schema type "${def.type}" - teach loosen() its runtime derivation before authoring it in src/schema.ts`,
        );
      }
      return schema;
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

/** The entry array plus the strict {_undeclared, entries} wrapper (knobbed() in ../shared/schema-helpers.ts). */
function detectKnobUnion(
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
          message: `Invalid input: expected a list of entries, or a mapping with "entries" (and an optional "_undeclared" policy), but this section parsed as ${value === null ? "null" : typeof value}`,
        });
        return z.NEVER;
      }
      const parsed = shape.safeParse(value);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({ ...issue });
        }
        return z.NEVER;
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
 * `defaultPolicy` is REQUIRED on purpose: a nested list cannot derive its default from its section's
 * undeclaredDefault, so the call site always says which applies. Entries are returned by reference.
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
