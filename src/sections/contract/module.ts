/** The section contract: handler context, section metadata, and the SectionModule shape. */

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

/** The facets of a section context shared by both mode arms. */
interface SectionContextBase {
  api: GithubClient;
  /** The target repository, parsed once at the boundary (see RepoRef). */
  repo: RepoRef;
}

/**
 * The context the request helpers run under, discriminated on `check`: the read-only phases (check
 * mode, the preflight probe, every plan-time read) carry no resolver, and apply ALWAYS carries the
 * one the engine built after resolving every declared secret value up front (see ExecTools).
 */
export type SectionContext =
  | (SectionContextBase & { check: true; resolveSecret?: never })
  | (SectionContextBase & { check: false; resolveSecret: (reference: string) => string });

/** A section's REST endpoint dictionary: role -> declaration. */
export type EndpointDict = Readonly<Record<string, EndpointDecl>>;

/** A section's GraphQL operation dictionary: role -> declaration. */
export type GraphqlDict = Readonly<Record<string, GraphqlOpDecl>>;

/**
 * The identity every helper needs to classify an error: the section's key
 * and its fine-grained-PAT grant advice. Handlers pass `this`, so the
 * advice always travels with the section that owns it. `E` and `G` carry
 * the section's LITERAL endpoint and GraphQL dictionaries (each module
 * declares them `as const`), so the `${key}.${role}` key unions the
 * registry derives - and everything downstream of them: the e2e mock's
 * handler tables, its dispatch, USED_PATHS - are exact types, not strings.
 */
export interface SectionMeta<
  K extends SectionKey = SectionKey,
  E extends EndpointDict = EndpointDict,
  G extends GraphqlDict = GraphqlDict,
> {
  readonly key: K;
  /**
   * The machine-readable permission this section requires, from which its
   * grant prose is derived via sectionGrant.
   */
  readonly permission: SectionPermission;
  /**
   * Extra prose sectionGrant appends to the derived grant advice, for a
   * section whose denials need more than the permission grant (an ambiguous
   * 403, a per-key permission override). Omit it when the derived grant
   * says everything.
   */
  readonly grantCaveat?: string;
  /**
   * Owner-kind sensitivity. "org" marks a section whose resources exist
   * only under an ORGANIZATION owner: its handler probes the owner (the
   * bare GET /orgs/{org} endpoint, 404 tolerated) and NO-OPS with a note on
   * a personal account, so check reports clean and apply reports applied
   * there. Omitted (the default), the section works under any repository
   * owner. The single source for owner-kind modeling outside the handler:
   * the fuzz oracle's personal-account fold derives its section set from
   * this, and the registry unit test pins the declaration to the org-probe
   * endpoint that implements it - so a new org-only section declares it
   * here and the consumers follow.
   */
  readonly ownerSensitivity?: "org";
  /**
   * Every REST endpoint this section may call, keyed by role (list, create,
   * update, remove, probe, ...). Handlers build their paths by passing these
   * declarations to the request helpers; the mock server and USED_PATHS
   * derivation iterate Object.values(...).
   */
  readonly endpoints: E;
  /**
   * Every GraphQL operation this section may issue, keyed by role exactly
   * like `endpoints`. Handlers pass these declarations to the GraphQL
   * request helpers; the mock's dispatch table, the coverage tripwire, and
   * the fuzz oracle iterate allGraphqlOps(). Omitted by REST-only sections.
   */
  readonly graphql?: G;
  /**
   * The section's undeclared-entry policy; the generated README and COVERAGE tables and the docs
   * registry's contradiction tests derive their deletion claims from it. Which sections sit in each
   * bucket is read off ./registry.ts; the wrapped `{undeclared, entries}` form overrides it per run:
   * - "delete": the section lists live resources and DELETES undeclared ones
   *   by default; `undeclared: keep` softens that to notes.
   * - "keep": the section lists live resources but KEEPS undeclared ones by
   *   default, surfacing each as a note; `undeclared: delete` hardens that
   *   to deletion.
   * - "untouched": the section never enumerates sibling resources, so an
   *   undeclared one is simply never seen and no policy applies.
   *
   * The conditional type makes the pairing unrepresentable to get wrong: a
   * section in UNDECLARED_POLICY_SECTIONS must say "delete" or "keep",
   * and one outside it must say "untouched" - so defaultUndeclaredPolicy
   * can never be reached for a section the merge does not normalize.
   */
  readonly undeclaredDefault: K extends UndeclaredPolicySection ? UndeclaredPolicy : "untouched";
}

/**
 * A section's fine-grained-PAT grant advice, used verbatim in permission
 * errors: the prose grantFor derives from the section's permission, plus its
 * caveat when one is declared. The README's "Sections" table mirrors these
 * in its PAT permission column.
 */
export function sectionGrant(section: Pick<SectionMeta, "permission" | "grantCaveat">): string {
  return grantFor(section.permission, section.grantCaveat);
}

/**
 * The declaration behind a failing request, as error classification reads
 * it: a REST endpoint or a GraphQL operation. An honest union rather than a
 * structural facet - `{}` must not satisfy it - and the GraphqlOpDecl arm's
 * `hints?: never` makes a hint on a GraphQL operation (which has no HTTP
 * status for it to key on) a compile error. throwFor and endpointPermission
 * take this, so both kinds classify through one code path.
 */
export type FailingOp = EndpointDecl | GraphqlOpDecl;

/**
 * The permission this endpoint or GraphQL operation actually requires: its
 * own override when one is declared, otherwise the section's permission.
 * "none" means public. The single place downstream consumers (e.g. the e2e
 * mock's permission gate) resolve the effective permission, so section vs
 * per-operation precedence lives in one spot.
 */
export function endpointPermission(section: SectionMeta, op: GatedReadDecl): SectionPermission;
export function endpointPermission(section: SectionMeta, op: FailingOp): SectionPermission | "none";
export function endpointPermission(
  section: SectionMeta,
  op: FailingOp,
): SectionPermission | "none" {
  return op.permission ?? section.permission;
}

/**
 * One entry in the flattened REST + GraphQL view of sectionOperations():
 * `role` is the operation's key in its declaring dictionary (its identity
 * within the section), `wire` says whether the request READS or WRITES on
 * the wire (a GET or a query vs a mutating method or a mutation), `grade`
 * the access level GitHub gates it at (endpointKind, so an accessGrade
 * override write-gates a wire read; a GraphQL operation's kind is both),
 * and `permission` the effective permission (endpointPermission).
 */
export interface SectionOperation {
  readonly role: string;
  readonly wire: "read" | "write";
  readonly grade: "read" | "write";
  readonly permission: SectionPermission | "none";
}

/**
 * Every operation a section may issue, REST and GraphQL flattened, so a derivation
 * over "everything this section can call" cannot ignore the GraphQL dictionary.
 * _OperationDictionariesFlattened below keeps the flattening total.
 */
export function sectionOperations(section: SectionMeta): SectionOperation[] {
  return [
    ...Object.entries(section.endpoints).map(([role, endpoint]) => ({
      role,
      wire: endpointMethod(endpoint.route) === "GET" ? ("read" as const) : ("write" as const),
      grade: endpointKind(endpoint),
      permission: endpointPermission(section, endpoint),
    })),
    ...Object.entries(section.graphql ?? {}).map(([role, op]) => ({
      role,
      wire: op.kind,
      grade: op.kind,
      permission: endpointPermission(section, op),
    })),
  ];
}

/**
 * How GitHub gates a section's reads under a read-only grant: "plain" reads all
 * (also no reads at all), "write-gated" is denied at the first read, "mixed" reads
 * until the handler reaches a gated one. Read by the fuzz oracle and the docs.
 */
export type ReadGating = "plain" | "write-gated" | "mixed";

export function readGating(section: SectionMeta): ReadGating {
  const reads = sectionOperations(section).filter((op) => op.wire === "read").length;
  const gated = writeGatedReads(section).length;
  if (gated === 0) {
    return "plain";
  }
  return gated === reads ? "write-gated" : "mixed";
}

/** One read GitHub gates at write: its route and effective permission. */
export interface WriteGatedRead {
  readonly route: Route;
  readonly permission: SectionPermission;
}

/**
 * The section's GatedReadDecl entries, in declaration order. A GraphQL read is
 * always gated at read (its kind IS the gate), so the REST dictionary is complete.
 */
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
 * The section's 404 posture, off its primaryRead declaration: a section with no read at all
 * classifies nothing before its first write, so it is "absent"; a reading section that declares
 * no posture (or several) is a BUG, never a guess. Read by the fuzz oracle and the e2e mock.
 */
export function denialPosture(section: SectionMeta): DenialPosture {
  const primaries = Object.values(section.endpoints).flatMap((endpoint) =>
    endpoint.primaryRead === undefined ? [] : [endpoint.primaryRead.notFound],
  );
  if (primaries.length > 1) {
    throw new Error(
      `BUG: ${section.key} declares primaryRead on ${primaries.length} endpoints; at most one read carries the 404 posture`,
    );
  }
  const posture = primaries[0];
  if (posture !== undefined) {
    return posture;
  }
  if (sectionOperations(section).some((op) => op.wire === "read")) {
    throw new Error(
      `BUG: ${section.key} reads but declares no primaryRead posture, so a denied first read cannot be classified`,
    );
  }
  return "absent";
}

/** The SectionMeta properties sectionOperations flattens. */
type FlattenedOperationDictionaries = "endpoints" | "graphql";

/** Every SectionMeta property holding a dictionary of operation declarations. */
type OperationDictionaryKeys = {
  [K in keyof SectionMeta]-?: NonNullable<SectionMeta[K]> extends Readonly<
    Record<string, FailingOp>
  >
    ? K
    : never;
}[keyof SectionMeta];

/**
 * The compile-time pin behind sectionOperations' completeness claim: a new
 * operation dictionary added to SectionMeta lands in OperationDictionaryKeys
 * structurally and fails here until sectionOperations (and the list above)
 * flatten it - the _UnlistedSection idiom from schema.ts. The structural
 * match sees `Readonly<Record<string, ...>>` properties (the form both
 * dictionaries use today); a dictionary declared as a named interface would
 * evade it, so keep the record form on any future operation dictionary.
 */
type _OperationDictionariesFlattened = MustBeNever<
  Exclude<OperationDictionaryKeys, FlattenedOperationDictionaries>
>;

/**
 * The check-mode note of a WRITE-ONLY section: one that declares no read
 * operation at all, so check mode can verify nothing (and issues no request)
 * while apply re-asserts the declared state on every run. Derived from the
 * section's own operation list rather than restated per section: a read
 * endpoint added later makes the note's claim false, so the helper throws
 * the BUG loudly instead of letting the prose and the declarations drift
 * apart. `resource` names what cannot be read back ("check suite
 * preferences"); `reasserts` names what apply rewrites ("the declared
 * preferences").
 */
export function writeOnlyCheckNote(
  section: SectionMeta,
  opts: { resource: string; reasserts: string },
): string {
  if (sectionOperations(section).some((op) => op.wire === "read")) {
    throw new Error(
      `BUG: ${section.key} declares a read operation, so it is not write-only and the cannot-verify note would be false; diff against the read instead`,
    );
  }
  return `${section.key}: GitHub exposes no read endpoint for ${opts.resource}, so check mode cannot verify them; apply re-asserts ${opts.reasserts} on every run`;
}

/**
 * The declared value a section receives once its key is present: the
 * section's slice of the validated settings document. The document was
 * parsed once at the boundary (validateSettingsDoc runs every section's
 * shape before any handler sees the value), so plan() and secretValues()
 * carry the proof in their parameter type instead of re-asserting it with
 * a per-section cast. Only `undefined` (the absent-section marker the
 * engine filters) is excluded; a nullable section (interaction_limits)
 * keeps its `null`.
 */
type SectionInput<K extends SectionKey> = Exclude<SettingsFile[K], undefined>;

/**
 * One settings section, self-contained: identity and grant advice (SectionMeta), the loose shape
 * validation accepts for its declared value, and the plan() handler (SectionModule). Modules
 * register in ./registry.ts.
 */
interface SectionModuleBase<
  K extends SectionKey = SectionKey,
  E extends EndpointDict = EndpointDict,
  G extends GraphqlDict = GraphqlDict,
> extends SectionMeta<K, E, G> {
  /**
   * Loose zod shape for the declared value: only the natural keys the
   * handler needs are checked, and unknown fields pass through untouched,
   * so validation does not fight the passthrough-first forward-compatibility
   * tenet. The sanctioned exceptions are STRICT nested sub-shapes for
   * values whose endpoint offers no passthrough destination (actions.cache,
   * where each key is the entire body of its own endpoint, and the
   * environment secrets and deployment_protection_rules entries, whose
   * write bodies are built from the named fields alone), where an extra
   * key can only be a typo.
   */
  shape: z.ZodType;
  /**
   * Declared only on CLOSED sections - those whose API calls never forward
   * extra entry keys (collaborators, teams, workflows), where an
   * unrecognized key is always a typo that would otherwise apply
   * "successfully" and never converge. Consumed by validateSectionShapes,
   * so the rejection happens during upfront document validation, BEFORE any
   * section has written anything. Open passthrough sections must NOT
   * declare this: their extra keys genuinely reach GitHub, and future API
   * fields have to keep working. The conditional type enforces both edges:
   * `known` is a mapped record over EVERY entry key from SettingsFile, so a
   * config field the declaration omits fails to compile (a new schema field
   * forces a decision here) and a key the entry type does not carry is an
   * excess property - no per-section lockstep pin needed. A non-list
   * section cannot declare a closedSurface at all (the property collapses
   * to never). EntryOf sees through the wrapped `{undeclared, entries}`
   * form, so a closed section that also takes the policy knob
   * (collaborators) keeps its closed-surface validation in both forms.
   */
  closedSurface?: [EntryOf<NonNullable<SettingsFile[K]>>] extends [never]
    ? never
    : {
        /**
         * Every entry key the section recognizes, one required `true` per
         * key of the entry type - the exhaustiveness lives in this shape.
         * Key order is the order error prose lists them in.
         */
        known: {
          readonly [P in Extract<keyof EntryOf<NonNullable<SettingsFile[K]>>, string>]: true;
        };
        /**
         * The entry's natural key, to name it in the error. Method syntax
         * on purpose: a function-typed property is contravariant in its
         * parameter, which would stop a module's exact per-section type
         * from erasing to SectionModule<SectionKey> in the registry.
         */
        describe(entry: EntryOf<NonNullable<SettingsFile[K]>>): string;
        /** What the unrecognized key would silently do, as message prose. */
        consequence: string;
      };
  /**
   * The declared values of this section's DESIGNATED SECRET FIELDS (e.g.
   * every webhooks entry's config.secret), extracted from the raw declared
   * value, each labelled with its owning entry (see DeclaredSecretValue).
   * Declared only by sections that carry secret fields. The engine
   * collects these before any section runs: it validates each value as a
   * whole-value `$NAME` reference (syntax only in check mode and preflight)
   * and, in apply mode, resolves them all up front - masking every
   * plaintext - so ctx.resolveSecret never misses. Values are returned raw;
   * nothing here reads the environment.
   */
  secretValues?(declared: SectionInput<K>): DeclaredSecretValue[];
}

/**
 * The section contract: plan() only READS (through the typed port in PlanContext) and returns the
 * operations that would converge the repository; the engine renders them as drift in check mode and
 * executes them in apply mode. `E` as the literal ENDPOINTS types the read port and the planned roles.
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
 * One designated secret-field value as a section declares it: the raw value
 * (a `$NAME` reference when well-formed) plus a label naming the OWNING
 * ENTRY - a secret name, an environment-plus-secret pair, a webhook url -
 * so a validation error can point at the offending entry among many. The
 * label is configuration the settings file already spells, never a value.
 */
export interface DeclaredSecretValue {
  readonly label: string;
  readonly value: string;
}

/**
 * Reject non-plain mappings before an object shape sees them: zod's object
 * schemas accept any non-array object, so a YAML-tagged scalar like
 * !!timestamp (which parses to a Date) would otherwise validate as an empty
 * mapping and silently configure nothing. Scalars, arrays, and null pass
 * through so the piped shape reports its own, more precise error for them.
 * Applied by the sections whose value is one mapping with no required
 * keys (repository, the code-scanning setups, interaction_limits) -
 * everywhere else a required natural key already fails the impostor.
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

/** The zod internals loosen() reads: the def discriminator and its children. */
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

/** Clone a schema with a patched def, keeping its checks (refinements). */
function cloneWith(schema: z.ZodType, patch: Partial<LoosenDef>): z.ZodType {
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
  return z.util.clone(
    schema as unknown as Parameters<typeof z.util.clone>[0],
    { ...def, ...patch } as never,
  ) as unknown as z.ZodType;
}

/**
 * The tolerant runtime derivative of an authored schema from src/schema.ts:
 * every plain (strip) object becomes a passthrough looseObject, so unknown
 * keys ride through to GitHub instead of being dropped and superRefine
 * checks that read undeclared keys can see them. Deliberately preserved as
 * authored:
 * - strictObject stays strict (the {undeclared, entries} wrapper and the
 *   nested shapes whose endpoints offer no passthrough destination);
 * - every refine/superRefine survives (clones carry the checks), so the
 *   runtime-only invariants keep firing;
 * - a knobbed-section union (entry array | strict wrapper) is rewrapped as
 *   a container-routed check, so a failing entry keeps its precise issue
 *   path (`labels[2].name`, or `labels.entries[2].name` in the wrapped
 *   form) instead of a plain union's pathless "Invalid input".
 * Leaf types (strings, enums, numbers, literals, records) pass through
 * untouched; an unrecognized CONTAINER type fails loudly rather than ship a
 * shape that silently skipped loosening.
 */
export function loosen(schema: z.ZodType): z.ZodType {
  const def = defOf(schema);
  switch (def.type) {
    case "object": {
      const shape = def.shape ?? {};
      const loosened = Object.fromEntries(
        Object.entries(shape).map(([key, value]) => [key, loosen(value)]),
      );
      // The catchall is loosened like any other child (z.never stays never,
      // so strict objects stay strict; an absent catchall means strip, which
      // becomes passthrough).
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
          // The rewrap replaces the union with a container-routed custom
          // check, which cannot carry the union's own refinements; attach
          // the invariant to the entry array or the wrapper instead.
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

/** The schema types loosen() passes through untouched (no children to derive). */
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

/**
 * Recognize a knobbed-section union: exactly the entry array plus the strict
 * {undeclared, entries} wrapper (see knobbed() in src/sections/shared/schema-helpers.ts).
 */
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

/**
 * A knobbed list section's runtime shape: the entry array or the strict
 * wrapper, routed by container type so a failing entry keeps its precise
 * issue path, as a transform so the output is the routed shape's parsed data.
 */
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
          message: `Invalid input: expected a list of entries, or a mapping with "entries" (and an optional "undeclared" policy), but this section parsed as ${value === null ? "null" : typeof value}`,
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

/**
 * The entry type of a list section's declared value, whichever form it
 * takes: a plain entry array, or the wrapped `{undeclared, entries}` form.
 * Distributes over the union, so a knobbed section (whose SettingsFile type
 * is that union) resolves to its one entry type; a non-list section
 * resolves to never.
 */
export type EntryOf<T> = T extends readonly (infer E)[]
  ? E
  : T extends { entries: readonly (infer E)[] }
    ? E
    : never;

/**
 * Unwrap a list section's declared value into its policy and entries. The
 * plain array form takes `defaultPolicy`; the wrapped form's explicit
 * `undeclared` wins, and an omitted one falls back to the same default. The
 * default is a REQUIRED parameter on purpose: a nested list in a future
 * feature cannot derive its default from its section's undeclaredDefault,
 * so the call site always says which default applies. Entries are returned
 * by reference, not cloned.
 */
export function undeclaredPolicy<E>(
  declared: readonly E[] | UndeclaredPolicyList<E>,
  defaultPolicy: UndeclaredPolicy,
): { policy: UndeclaredPolicy; entries: readonly E[] } {
  if (Array.isArray(declared)) {
    return { policy: defaultPolicy, entries: declared };
  }
  const wrapped = declared as UndeclaredPolicyList<E>;
  return { policy: wrapped.undeclared ?? defaultPolicy, entries: wrapped.entries };
}

/**
 * The section-level default for undeclaredPolicy, read off the section's own
 * undeclaredDefault declaration so the two can never disagree. The parameter
 * type restricts callers to the knobbed sections, where the conditional
 * undeclaredDefault type already excludes "untouched" - asking for a
 * non-enumerating section's default is a compile error, not a runtime BUG.
 */
export function defaultUndeclaredPolicy(
  section: SectionMeta<UndeclaredPolicySection>,
): UndeclaredPolicy {
  return section.undeclaredDefault;
}

/**
 * The keep-note for one live resource the settings file does not declare,
 * reported when the governing policy is "keep". Only the WORDS live here -
 * which branch runs stays in each section's own control flow on purpose -
 * so the sweep prose cannot drift between sections. `action` is what the
 * opposite knob would make apply do ("DELETE it", "REMOVE them", "CANCEL
 * the invitation"), including any consequence worth naming.
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
  /** What `undeclared: delete` would make apply do, with any consequence. */
  action: string;
}): string {
  const state = opts.state ?? "exists on the repo but is not declared";
  const add = opts.add ?? "it";
  const manage = opts.manage ?? "it";
  return `${opts.subject} ${state} in the settings file; kept under "undeclared: keep" - add ${add} to the settings file to manage ${manage}, or set "undeclared: delete" to have apply ${opts.action}`;
}

/**
 * The check-mode drift line for one live resource the settings file does not
 * declare, reported when the governing policy is "delete" - the
 * undeclaredNote sibling. The middle clause derives from the list's DEFAULT
 * policy, so it can never contradict the section again: under a keep
 * default this branch is only reachable because the file set
 * `undeclared: delete`, so the line says so; under a delete default the
 * deletion is the list's own posture and no knob was needed. Callers pass
 * the same default they unwrapped the policy with (the section's
 * undeclaredDefault via defaultUndeclaredPolicy, or a nested list's own
 * fixed default).
 */
export function undeclaredDrift(
  listDefault: UndeclaredPolicy,
  opts: {
    /** The drift-line prefix with the natural key: `labels[stale]`. */
    label: string;
    /** What apply will do, with any consequence worth naming. */
    action: string;
    /**
     * How the undeclared resource presents, when the plain "not in the
     * settings file" understates it (a PENDING INVITATION rather than an
     * existing collaborator). The knob clause is appended after it.
     */
    state?: string;
    /** The pronoun for "add ... to the settings file" ("it" unless plural). */
    add?: string;
    /** What adding it would keep ("it", or "their access" for people). */
    keep?: string;
  },
): string {
  const knob = listDefault === "keep" ? ' and "undeclared: delete" is set' : "";
  const state = opts.state ?? "not in the settings file";
  const add = opts.add ?? "it";
  const keep = opts.keep ?? "it";
  return `${opts.label}: undeclared - ${state}${knob}, so apply will ${opts.action}; add ${add} to the settings file to keep ${keep}`;
}
