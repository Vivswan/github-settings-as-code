/**
 * What a section can call, derived from its operation dictionaries so no section restates it; the fuzz
 * oracle, the e2e mock, and the docs read these same derivations.
 */

import type { MustBeNever } from "../../types.js";
import { cannotVerifyNote } from "./drift.js";
import {
  type EndpointDecl,
  endpointKind,
  endpointMethod,
  endpointPath,
  type GatedReadDecl,
  type Route,
} from "./endpoints.js";
import type { GraphqlOpDecl } from "./graphql.js";
import type { SectionMeta } from "./module.js";
import { grantFor, type SectionPermission } from "./permissions.js";

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
