/**
 * `custom_properties:` section - values of organization-defined custom
 * properties, set per repository. The property DEFINITIONS are
 * organization-scoped and out of scope; on a personal account the section
 * no-ops with a note (custom properties only exist on org-owned repos).
 * `value: null` unsets a property, reverting to the org default, if any.
 */

import { z } from "zod";
import { type CustomPropertyConfig, SettingsFile } from "../../schema.js";
import {
  beginRun,
  call,
  defaultUndeclaredPolicy,
  type EndpointDecl,
  loosen,
  parseLive,
  probeAbsent,
  rejectDuplicates,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
  undeclaredDrift,
  undeclaredNote,
  undeclaredPolicy,
} from "../contract.js";

const permission: SectionPermission = { repo: ["custom_properties"] };

/** A value as GitHub stores and returns it: strings, string lists, or unset. */
type WireValue = string | string[] | null;

/**
 * Normalize a declared value to the form GitHub stores: booleans and numbers
 * become their string form (GitHub transports true_false values as the
 * strings "true"/"false"), string lists are copied as-is (validation already
 * pins their elements to strings), and null (unset) passes through.
 * Exported for direct testing.
 */
export function normalizeValue(value: CustomPropertyConfig["value"]): WireValue {
  if (value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    return [...value];
  }
  return typeof value === "string" ? value : String(value);
}

/**
 * Whether two normalized values agree. Lists compare by SET MEMBERSHIP,
 * order-insensitively (the webhooks eventsMatch precedent): a multi_select
 * value is a set, so a reordered declaration must not read as drift, and a
 * live-side duplicate GitHub would collapse must still converge instead of
 * re-writing forever. Declared-side duplicates are rejected upfront in
 * run(), so a declaration can never lean on the collapse.
 */
function sameValue(a: WireValue, b: WireValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    const setA = new Set(a);
    const setB = new Set(b);
    return setA.size === setB.size && [...setA].every((element) => setB.has(element));
  }
  return a === b;
}

/** Render a normalized value for drift lines ("unset" for null). */
function show(value: WireValue): string {
  return value === null ? "unset" : JSON.stringify(value);
}

const ENDPOINTS = {
  // GET /orgs/{org} is a public endpoint, so it needs no token permission.
  org: {
    route: "GET /orgs/{org}",
    statuses: { 200: "the organization", 404: "not an organization (a personal account)" },
    permission: "none",
  },
  // The values READ is gated by Metadata (read) only, which every
  // fine-grained token holds implicitly, so it can never be
  // permission-denied; only the PATCH needs the Custom properties grant.
  list: {
    route: "GET /repos/{owner}/{repo}/properties/values",
    statuses: { 200: "the custom property values" },
    permission: "none",
  },
  update: {
    route: "PATCH /repos/{owner}/{repo}/properties/values",
    statuses: { 204: "custom property values updated" },
    denialHint:
      "a 403 here can also mean the organization restricts a declared property's values to organization actors (values_editable_by: org_actors), which no repository-scoped token can satisfy",
    hints: {
      422: "each declared property must be DEFINED at the organization level first, and its value must fit the definition; see the organization's custom properties settings",
    },
  },
} as const satisfies Record<string, EndpointDecl>;

/**
 * One live entry, parsed loudly at the boundary: both fields are REQUIRED on
 * the wire, so an entry without a string property_name (or with a value
 * outside the documented string/string[]/null space) is a contract
 * violation parseLive rejects, not something to guess around.
 */
const LiveProperty = z.looseObject({
  property_name: z.string(),
  value: z.union([z.string(), z.array(z.string()), z.null()]),
});

export const customPropertiesSection = {
  key: "custom_properties",
  undeclaredDefault: "keep",
  permission,
  // Custom properties exist only under an organization owner; the org probe
  // below implements the personal-account no-op this declares.
  ownerSensitivity: "org",
  endpoints: ENDPOINTS,
  shape: loosen(SettingsFile.shape.custom_properties),
  // Closed surface: the bulk PATCH body is built from exactly property_name
  // and value, so an extra key has no destination and is always a typo.
  closedSurface: {
    known: { property_name: true, value: true },
    describe: (p) => p.property_name,
    consequence:
      "the key would silently never reach GitHub and the misdeclared property would keep its live value",
  },
  async run(ctx, declared): Promise<SectionResult> {
    const run = beginRun(ctx);
    const { policy, entries: desired } = undeclaredPolicy(declared, defaultUndeclaredPolicy(this));
    // Exact-name matching: GitHub does not document case folding for custom
    // property names, so two declarations are duplicates only when they match
    // verbatim - the same names the live list reports.
    rejectDuplicates(
      this,
      desired,
      (p) => p.property_name,
      (p) => p.property_name,
    );
    // A duplicate ELEMENT inside a multi_select list is a user mistake, not
    // something to quietly collapse: the set comparison below would treat
    // ["soc2", "soc2"] and ["soc2"] as equal, hiding the typo forever. An
    // EMPTY list is rejected for a different reason: GitHub does not
    // document whether [] stores as an empty set or normalizes to unset, so
    // it could re-write on every apply; value: null is the documented unset.
    for (const property of desired) {
      if (!Array.isArray(property.value)) {
        continue;
      }
      if (property.value.length === 0) {
        throw new Error(
          `custom_properties: the "${property.property_name}" entry declares an empty list; declare value: null to unset the property instead`,
        );
      }
      const seen = new Set<string>();
      for (const element of property.value) {
        if (seen.has(element)) {
          throw new Error(
            `custom_properties: the "${property.property_name}" entry lists the value ${JSON.stringify(element)} more than once; a multi_select value is a set, so keep each option exactly once`,
          );
        }
        seen.add(element);
      }
    }
    // Custom properties only exist on organization repos; on a personal
    // account the values endpoints 404. Probe once and no-op with a note
    // instead of failing; 403/5xx still flow through the permission policy
    // via probeAbsent.
    const orgProbe = await probeAbsent(ctx, this, ENDPOINTS.org, {
      params: { org: ctx.repo.owner },
    });
    if ("missing" in orgProbe) {
      run.result.notes.push(
        `custom_properties: owner "${ctx.repo.owner}" is a personal account, and custom properties require an organization-owned repository; section skipped - remove the custom_properties section from the settings file to silence this note`,
      );
      return run.result;
    }
    // The values list endpoint is not paginated; a single GET returns every
    // property, and sending page params would not advance anything.
    const live = parseLive(
      this,
      ENDPOINTS.list,
      z.array(LiveProperty),
      await call(ctx, this, ENDPOINTS.list),
    );
    const liveByName = new Map(live.map((p) => [p.property_name, p.value]));
    const declaredKeys = new Set<string>();

    // The divergent values, accumulated into ONE bulk PATCH; a live value of
    // null and an absent live entry both mean "unset". Each entry carries
    // its provenance from the branch that CREATED it - a declared value, or
    // an undeclared live value the delete policy unsets - so the change
    // lines below read the tag instead of re-deriving the split from set
    // membership.
    type PendingUpdate =
      | { kind: "declared"; property_name: string; value: WireValue }
      | { kind: "undeclared-unset"; property_name: string };
    const updates: PendingUpdate[] = [];
    for (const property of desired) {
      declaredKeys.add(property.property_name);
      const wanted = normalizeValue(property.value);
      const current = liveByName.get(property.property_name) ?? null;
      if (sameValue(wanted, current)) {
        continue;
      }
      if (run.check) {
        if (wanted === null) {
          run.result.drift.push(
            `custom_properties[${property.property_name}]: declared null but the live value is ${show(current)}; apply will unset it (reverting to the org default, if any)`,
          );
        } else {
          run.result.drift.push(
            `custom_properties[${property.property_name}]: declared ${show(wanted)} != live ${show(current)}; apply will set the declared value`,
          );
        }
        continue;
      }
      updates.push({ kind: "declared", property_name: property.property_name, value: wanted });
    }

    for (const property of live) {
      if (declaredKeys.has(property.property_name) || property.value === null) {
        continue;
      }
      if (policy === "keep") {
        run.result.notes.push(
          undeclaredNote({
            subject: `custom property "${property.property_name}"`,
            state: "is set on the repo but not declared",
            action: "UNSET it",
          }),
        );
      } else if (run.check) {
        run.result.drift.push(
          undeclaredDrift(defaultUndeclaredPolicy(this), {
            label: `custom_properties[${property.property_name}]`,
            action: "unset it (reverting to the org default, if any)",
          }),
        );
      } else {
        updates.push({ kind: "undeclared-unset", property_name: property.property_name });
      }
    }

    // One bulk PATCH carries every divergent property; nothing diverging
    // means no write at all (compare-before-write). Change lines land only
    // after the write succeeded.
    if (!run.check && updates.length > 0) {
      await call(ctx, this, ENDPOINTS.update, {
        payload: {
          // An undeclared-unset entry writes null - the documented unset.
          properties: updates.map((update) => ({
            property_name: update.property_name,
            value: update.kind === "declared" ? update.value : null,
          })),
        },
        describe: "updating custom property values",
      });
      for (const update of updates) {
        if (update.kind === "undeclared-unset") {
          run.result.changes.push(`unset undeclared custom property "${update.property_name}"`);
        } else if (update.value === null) {
          run.result.changes.push(`unset custom property "${update.property_name}"`);
        } else {
          run.result.changes.push(
            `set custom property "${update.property_name}" to ${show(update.value)}`,
          );
        }
      }
    }
    return run.result;
  },
} satisfies SectionModule<"custom_properties">;
