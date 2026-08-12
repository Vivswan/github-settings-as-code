/**
 * `custom_properties:` section - values of organization-defined custom
 * properties, set per repository. The property DEFINITIONS are
 * organization-scoped and out of scope; on a personal account the section
 * no-ops with a note (custom properties only exist on org-owned repos).
 * `value: null` unsets a property, reverting to the org default, if any.
 */

import {
  type CustomPropertyConfig,
  type MustBeNever,
  SettingsFile,
  type UndeclaredPolicyList,
} from "../../schema.js";
import {
  call,
  defaultUndeclaredPolicy,
  type EndpointDecl,
  emptyResult,
  loosen,
  probeAbsent,
  rejectDuplicates,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
  undeclaredPolicy,
} from "../contract.js";

const permission: SectionPermission = { repo: ["custom_properties"] };

const KNOWN_KEYS = ["property_name", "value"] as const;
/** Compile-time lockstep: a CustomPropertyConfig field missing from KNOWN_KEYS fails here. */
type _AllKeysKnown = MustBeNever<Exclude<keyof CustomPropertyConfig, (typeof KNOWN_KEYS)[number]>>;

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

/** One live entry, after the loud extraction below. */
interface LiveProperty {
  property_name: string;
  value: WireValue;
}

/**
 * Extract the live list loudly: both fields are REQUIRED on the wire, so an
 * entry without a string property_name (or with a value outside the
 * documented string/string[]/null space) is a contract violation, not
 * something to guess around.
 */
function extractLive(data: unknown): LiveProperty[] {
  if (!Array.isArray(data)) {
    throw new Error(
      `custom_properties: GET ${ENDPOINTS.list.route} returned a non-list body (got ${(JSON.stringify(data) ?? String(data)).slice(0, 200)}); check the "api-version" input against the GitHub REST docs for this endpoint`,
    );
  }
  return data.map((entry) => {
    const raw = entry as { property_name?: unknown; value?: unknown } | null;
    const name = raw?.property_name;
    const value = raw?.value;
    const valueOk =
      value === null ||
      typeof value === "string" ||
      (Array.isArray(value) && value.every((element) => typeof element === "string"));
    if (typeof name !== "string" || !valueOk) {
      throw new Error(
        `custom_properties: GET ${ENDPOINTS.list.route} returned an entry without a string property_name or with a value outside string/string[]/null (${JSON.stringify(entry)}); check the "api-version" input against the GitHub REST docs for this endpoint`,
      );
    }
    return { property_name: name, value: value as WireValue };
  });
}

export const customPropertiesSection: SectionModule<"custom_properties"> = {
  key: "custom_properties",
  undeclaredDefault: "keep",
  permission,
  endpoints: ENDPOINTS,
  shape: loosen(SettingsFile.shape.custom_properties),
  // Closed surface: the bulk PATCH body is built from exactly property_name
  // and value, so an extra key has no destination and is always a typo.
  closedSurface: {
    known: KNOWN_KEYS,
    describe: (p) => p.property_name,
    consequence:
      "the key would silently never reach GitHub and the misdeclared property would keep its live value",
  },
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const { policy, entries: desired } = undeclaredPolicy(
      desiredRaw as CustomPropertyConfig[] | UndeclaredPolicyList<CustomPropertyConfig>,
      defaultUndeclaredPolicy(this),
    );
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
      result.notes.push(
        `custom_properties: owner "${ctx.repo.owner}" is a personal account, and custom properties require an organization-owned repository; section skipped - remove the custom_properties section from the settings file to silence this note`,
      );
      return result;
    }
    // The values list endpoint is not paginated; a single GET returns every
    // property, and sending page params would not advance anything.
    const live = extractLive(await call(ctx, this, ENDPOINTS.list));
    const liveByName = new Map(live.map((p) => [p.property_name, p.value]));
    const declared = new Set<string>();

    // The divergent declared values, accumulated into ONE bulk PATCH; a live
    // value of null and an absent live entry both mean "unset".
    const updates: Array<{ property_name: string; value: WireValue }> = [];
    for (const property of desired) {
      declared.add(property.property_name);
      const wanted = normalizeValue(property.value);
      const current = liveByName.get(property.property_name) ?? null;
      if (sameValue(wanted, current)) {
        continue;
      }
      if (ctx.check) {
        if (wanted === null) {
          result.drift.push(
            `custom_properties[${property.property_name}]: declared null but the live value is ${show(current)}; apply will unset it (reverting to the org default, if any)`,
          );
        } else {
          result.drift.push(
            `custom_properties[${property.property_name}]: declared ${show(wanted)} != live ${show(current)}; apply will set the declared value`,
          );
        }
        continue;
      }
      updates.push({ property_name: property.property_name, value: wanted });
    }

    for (const property of live) {
      if (declared.has(property.property_name) || property.value === null) {
        continue;
      }
      if (policy === "keep") {
        result.notes.push(
          `custom property "${property.property_name}" is set on the repo but not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply UNSET it`,
        );
      } else if (ctx.check) {
        result.drift.push(
          `custom_properties[${property.property_name}]: undeclared - not in the settings file, so apply will unset it (reverting to the org default, if any); add it to the settings file to keep it`,
        );
      } else {
        updates.push({ property_name: property.property_name, value: null });
      }
    }

    // One bulk PATCH carries every divergent property; nothing diverging
    // means no write at all (compare-before-write). Change lines land only
    // after the write succeeded.
    if (!ctx.check && updates.length > 0) {
      await call(ctx, this, ENDPOINTS.update, {
        payload: { properties: updates },
        describe: "updating custom property values",
      });
      for (const update of updates) {
        if (!declared.has(update.property_name)) {
          result.changes.push(`unset undeclared custom property "${update.property_name}"`);
        } else if (update.value === null) {
          result.changes.push(`unset custom property "${update.property_name}"`);
        } else {
          result.changes.push(
            `set custom property "${update.property_name}" to ${show(update.value)}`,
          );
        }
      }
    }
    return result;
  },
};
