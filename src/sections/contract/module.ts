/** The section contract: handler context, section metadata, and the SectionModule shape. */

import { z } from "zod";
import type { RepoRef } from "../../discovery/targets.js";
import type { GithubClient } from "../../github/api.js";
import type {
  MustBeNever,
  SectionKey,
  SettingsFile,
  UndeclaredPolicy,
  UndeclaredPolicyList,
  UndeclaredPolicySection,
} from "../../schema.js";
import { type EndpointDecl, endpointKind, endpointMethod } from "./endpoints.js";
import type { GraphqlOpDecl } from "./graphql.js";
import { grantFor, type SectionPermission } from "./permissions.js";

/** The facets of a section context shared by both mode arms. */
interface SectionContextBase {
  api: GithubClient;
  /** The target repository, parsed once at the boundary (see RepoRef). */
  repo: RepoRef;
}

/**
 * The context a section handler runs under, discriminated on `check` so the
 * mode carries its own capabilities:
 * - `check: true` (check mode and the apply-mode preflight) is the
 *   read-only phase: references are validated for syntax only, the
 *   environment is never read, and `resolveSecret?: never` makes a resolver
 *   in this phase unrepresentable.
 * - `check: false` (apply) ALWAYS carries `resolveSecret`, which maps a
 *   whole-value `$NAME` secret reference to its plaintext: the engine
 *   resolves EVERY declared secret value up front (after the preflight
 *   barrier, before the first mutation of any section) and registers each
 *   plaintext with output masking before any handler runs, so a handler
 *   only ever looks up an already-resolved name. When the document declares
 *   no secret values the resolver still exists, closed over an empty map,
 *   and any lookup fails with the engine's BUG error - a call it can never
 *   legitimately receive.
 * Handlers narrow on `ctx.check`, so the apply branch gets the resolver
 * structurally instead of re-checking for it at runtime.
 */
export type SectionContext =
  | (SectionContextBase & { check: true; resolveSecret?: never })
  | (SectionContextBase & { check: false; resolveSecret: (reference: string) => string });

/** The apply-mode arm of SectionContext, for helpers only apply may call. */
export type ApplySectionContext = Extract<SectionContext, { check: false }>;

export interface SectionResult {
  /** Mutations performed (apply mode) or that WOULD be performed. */
  changes: string[];
  /** Drift lines (check mode). */
  drift: string[];
  /** Informational notes (unmanaged resources left alone, skips). */
  notes: string[];
}

/**
 * The identity every helper needs to classify an error: the section's key
 * and its fine-grained-PAT grant advice. Handlers pass `this`, so the
 * advice always travels with the section that owns it.
 */
export interface SectionMeta<K extends SectionKey = SectionKey> {
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
   * Every REST endpoint this section may call, keyed by role (list, create,
   * update, remove, probe, ...). Handlers build their paths by passing these
   * declarations to the request helpers; the mock server and USED_PATHS
   * derivation iterate Object.values(...).
   */
  readonly endpoints: Readonly<Record<string, EndpointDecl>>;
  /**
   * Every GraphQL operation this section may issue, keyed by role exactly
   * like `endpoints`. Handlers pass these declarations to the GraphQL
   * request helpers; the mock's dispatch table, the coverage tripwire, and
   * the fuzz oracle iterate allGraphqlOps(). Omitted by REST-only sections.
   */
  readonly graphql?: Readonly<Record<string, GraphqlOpDecl>>;
  /**
   * The DEFAULT policy for live resources this section does NOT declare, the
   * single source the README Sections table and COVERAGE derive their
   * deletion claims from. Which sections sit in each bucket is read off the
   * registry (./registry.ts), not restated here. For the sections that
   * enumerate sibling resources, the settings file can override the default
   * per run with the wrapped `{undeclared, entries}` form (see
   * undeclaredPolicy below):
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
export function endpointPermission(
  section: SectionMeta,
  op: FailingOp,
): SectionPermission | "none" {
  return op.permission ?? section.permission;
}

/**
 * One entry in the flattened REST + GraphQL view of sectionOperations():
 * `wire` says whether the request READS or WRITES on the wire (a GET or a
 * query vs a mutating method or a mutation), `grade` the access level GitHub
 * gates it at (endpointKind, so an accessGrade override write-gates a wire
 * read; a GraphQL operation's kind is both), and `permission` the effective
 * permission (endpointPermission).
 */
export interface SectionOperation {
  readonly wire: "read" | "write";
  readonly grade: "read" | "write";
  readonly permission: SectionPermission | "none";
}

/**
 * Every operation a section may issue - its REST endpoints and GraphQL
 * operations flattened into one list. Consumers deriving cross-cutting facts
 * from "everything this section can call" (overrideAdviceLevel below, the
 * fuzz oracle's no-read and write-gated section sets, the registry
 * mixed-grade guard, the README PAT-form and permissions-doc sweeps) walk
 * THIS view instead of section.endpoints alone, so a derivation can never
 * quietly ignore the GraphQL dictionary. The _OperationDictionariesFlattened
 * pin below keeps the flattening total: a new operation dictionary on
 * SectionMeta fails to compile until it is folded in here.
 */
export function sectionOperations(section: SectionMeta): SectionOperation[] {
  return [
    ...Object.values(section.endpoints).map((endpoint) => ({
      wire: endpointMethod(endpoint.route) === "GET" ? ("read" as const) : ("write" as const),
      grade: endpointKind(endpoint),
      permission: endpointPermission(section, endpoint),
    })),
    ...Object.values(section.graphql ?? {}).map((op) => ({
      wire: op.kind,
      grade: op.kind,
      permission: endpointPermission(section, op),
    })),
  ];
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
 * One settings section, self-contained: identity and grant advice
 * (SectionMeta), the loose shape validation accepts for its declared
 * value, and the handler. Modules register in ./registry.ts.
 */
export interface SectionModule<K extends SectionKey = SectionKey> extends SectionMeta<K> {
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
   * `known` may only name real entry keys from SettingsFile, and a
   * non-list section cannot declare a closedSurface at all (the property
   * collapses to never). EntryOf sees through the wrapped
   * `{undeclared, entries}` form, so a closed section that also takes the
   * policy knob (collaborators) keeps its closed-surface validation in both
   * forms.
   */
  closedSurface?: [EntryOf<NonNullable<SettingsFile[K]>>] extends [never]
    ? never
    : {
        /** Every entry key the section recognizes. */
        known: readonly (keyof EntryOf<NonNullable<SettingsFile[K]>> & string)[];
        /** The entry's natural key, to name it in the error. */
        describe: (entry: EntryOf<NonNullable<SettingsFile[K]>>) => string;
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
  secretValues?(declared: unknown): DeclaredSecretValue[];
  run(ctx: SectionContext, desired: unknown): Promise<SectionResult>;
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

/** The loose "any YAML mapping" shape for passthrough-heavy sections. */
export const anyRecord = z.record(z.string(), z.unknown());

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
 * The zod shape for a knobbed list section: the union of the plain entry
 * array and the strict `{undeclared, entries}` wrapper. Routed by container
 * type instead of z.union so a failing entry keeps its precise issue path
 * (`labels[2].name`, or `labels.entries[2].name` in the wrapped form) - a
 * plain union collapses every failure into one pathless "Invalid input".
 * The wrapper is strictObject because it is this action's own vocabulary
 * (nothing in it passes through to GitHub), so an unrecognized key can only
 * be a typo.
 */
export function undeclaredPolicyShape(list: z.ZodType): z.ZodType {
  const wrapper = z.strictObject({
    undeclared: z.enum(["keep", "delete"]).optional(),
    entries: list,
  });
  return z
    .custom<unknown>(() => true)
    .superRefine((value, ctx) => {
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
        return;
      }
      const parsed = shape.safeParse(value);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({ ...issue });
        }
      }
    });
}

export function emptyResult(): SectionResult {
  return { changes: [], drift: [], notes: [] };
}
