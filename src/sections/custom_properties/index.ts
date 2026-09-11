/**
 * `custom_properties:` section - values of organization-defined custom properties, set per
 * repository through ONE bulk PATCH. Definitions are org-scoped, so only values are managed;
 * a personal account no-ops with a note, and `value: null` unsets (reverting to the org default).
 */

import { z } from "zod";
import type { EndpointDecl } from "../contract/endpoints.js";
import { parseLive } from "../contract/live.js";
import {
  defaultUndeclaredPolicy,
  loosen,
  type SectionModule,
  undeclaredDrift,
  undeclaredNote,
  undeclaredPolicy,
} from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import type { PlannedOp, SectionPlan } from "../contract/plan.js";
import { rejectDuplicates } from "../contract/requests.js";
import { knobbed } from "../shared/schema-helpers.js";
import { CustomPropertyConfig } from "./schema.js";

const permission: SectionPermission = { repo: ["custom_properties"] };

/** A value as GitHub stores and returns it: strings, string lists, or unset. */
type WireValue = string | string[] | null;

/**
 * A declared value in the form GitHub stores: booleans and numbers become their string form
 * (true_false values travel as "true"/"false"), lists are copied, null (unset) passes through.
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
 * Lists compare by SET MEMBERSHIP: a multi_select value is a set, so a reordered declaration is
 * not drift, and a live-side duplicate GitHub would collapse still converges instead of
 * re-writing forever (declared-side duplicates are rejected before any read).
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

/**
 * A repeated multi_select option is a typo the set comparison would hide forever; an empty list
 * is rejected because GitHub does not document whether [] stores or normalizes to unset, so it
 * could re-write on every apply (value: null is the documented unset).
 */
function rejectMalformedList(property: CustomPropertyConfig): void {
  if (!Array.isArray(property.value)) {
    return;
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

const ENDPOINTS = {
  // GET /orgs/{org} is public, so it needs no token permission. Its 404 is the
  // personal-account signal (no custom properties exist), and the only 404 the
  // section can meet: the values GET is Metadata-gated, which every token holds.
  org: {
    route: "GET /orgs/{org}",
    statuses: { 200: "the organization", 404: "not an organization (a personal account)" },
    permission: "none",
    primaryRead: { notFound: "absent" },
  },
  // Metadata (read) only, so it can never be permission-denied; only the PATCH
  // needs the Custom properties grant.
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
 * One live entry, parsed loudly at the boundary: both fields are REQUIRED on the wire, so an
 * entry without a string property_name (or a value outside string/string[]/null) is a contract
 * violation parseLive rejects, not something to guess around.
 */
const LiveProperty = z.looseObject({
  property_name: z.string(),
  value: z.union([z.string(), z.array(z.string()), z.null()]),
});

/** One property the bulk PATCH writes, with the line each mode renders for it. */
interface PendingUpdate {
  readonly property_name: string;
  readonly value: WireValue;
  readonly drift: string;
  readonly change: string;
}

export const customPropertiesSection = {
  key: "custom_properties",
  undeclaredDefault: "keep",
  permission,
  // Custom properties exist only under an organization owner; the org probe
  // in plan() implements the personal-account no-op this declares.
  ownerSensitivity: "org",
  endpoints: ENDPOINTS,
  shape: loosen(knobbed(CustomPropertyConfig)),
  // Closed surface: the bulk PATCH body is built from exactly property_name
  // and value, so an extra key has no destination and is always a typo.
  closedSurface: {
    known: { property_name: true, value: true },
    describe: (p) => p.property_name,
    consequence:
      "the key would silently never reach GitHub and the misdeclared property would keep its live value",
  },
  async plan(ctx, declared) {
    const { policy, entries: desired } = undeclaredPolicy(declared, defaultUndeclaredPolicy(this));
    // Exact-name matching: GitHub documents no case folding for property
    // names, so entries are duplicates only when they match verbatim.
    rejectDuplicates(
      this,
      desired,
      (p) => p.property_name,
      (p) => p.property_name,
    );
    for (const property of desired) {
      rejectMalformedList(property);
    }
    const plan: SectionPlan<PlannedOp<typeof ENDPOINTS>> = { ops: [], notes: [], drift: [] };
    const orgProbe = await ctx.read.org.probeAbsent({ params: { org: ctx.repo.owner } });
    if ("missing" in orgProbe) {
      plan.notes.push(
        `custom_properties: owner "${ctx.repo.owner}" is a personal account, and custom properties require an organization-owned repository; section skipped - remove the custom_properties section from the settings file to silence this note`,
      );
      return plan;
    }
    // Not paginated upstream: one GET carries every value.
    const live = parseLive(this, ENDPOINTS.list, z.array(LiveProperty), await ctx.read.list.call());
    const liveByName = new Map(live.map((p) => [p.property_name, p.value]));
    const declaredNames = new Set(desired.map((p) => p.property_name));

    // A live null and an absent live entry both mean "unset".
    const updates: PendingUpdate[] = [];
    for (const property of desired) {
      const name = property.property_name;
      const wanted = normalizeValue(property.value);
      const current = liveByName.get(name) ?? null;
      if (sameValue(wanted, current)) {
        continue;
      }
      const label = `custom_properties[${name}]`;
      updates.push(
        wanted === null
          ? {
              property_name: name,
              value: null,
              drift: `${label}: declared null but the live value is ${show(current)}; apply will unset it (reverting to the org default, if any)`,
              change: `unset custom property "${name}"`,
            }
          : {
              property_name: name,
              value: wanted,
              drift: `${label}: declared ${show(wanted)} != live ${show(current)}; apply will set the declared value`,
              change: `set custom property "${name}" to ${show(wanted)}`,
            },
      );
    }
    for (const property of live) {
      const name = property.property_name;
      if (declaredNames.has(name) || property.value === null) {
        continue;
      }
      if (policy === "keep") {
        plan.notes.push(
          undeclaredNote({
            subject: `custom property "${name}"`,
            state: "is set on the repo but not declared",
            action: "UNSET it",
          }),
        );
        continue;
      }
      updates.push({
        property_name: name,
        value: null,
        drift: undeclaredDrift(defaultUndeclaredPolicy(this), {
          label: `custom_properties[${name}]`,
          action: "unset it (reverting to the org default, if any)",
        }),
        change: `unset undeclared custom property "${name}"`,
      });
    }
    const [first, ...rest] = updates;
    if (first === undefined) {
      return plan;
    }
    plan.ops.push({
      role: "update",
      payload: {
        properties: updates.map(({ property_name, value }) => ({ property_name, value })),
      },
      describe: "updating custom property values",
      drift: [first.drift, ...rest.map((update) => update.drift)],
      change: () => [first.change, ...rest.map((update) => update.change)] as const,
    });
    return plan;
  },
} satisfies SectionModule<"custom_properties", typeof ENDPOINTS>;
