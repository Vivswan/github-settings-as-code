/**
 * `custom_properties:` section: values of organization-defined custom properties, set through ONE
 * bulk PATCH. Definitions are org-scoped, so only values are managed; a personal account no-ops
 * with a note, and `value: null` unsets (reverting to the org default). Bespoke, not on listSection:
 * every value rides one write, so there is no per-item create, update, or delete to declare.
 */

import { z } from "zod";
import type { EndpointDecl } from "../contract/endpoints.js";
import { liveByIdentity, liveIdentity } from "../contract/live.js";
import {
  defaultUndeclaredPolicy,
  loosen,
  ORG_PROBE,
  type SectionMeta,
  type SectionModule,
  undeclaredDrift,
  undeclaredNote,
  undeclaredPolicy,
  valueDrift,
} from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import type { PlannedOp, SectionPlan } from "../contract/plan.js";
import { rejectDuplicates } from "../contract/requests.js";
import { knobbed } from "../shared/schema-helpers.js";
import { knobbedSnapshot, projectOntoSchema } from "../shared/snapshot-helpers.js";
import { CustomPropertyConfig } from "./schema.js";

const permission: SectionPermission = { repo: ["custom_properties"] };

type WireValue = string | string[] | null;

/** GitHub stores true_false values as the strings "true"/"false" and numbers as their string form. */
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
 * Lists compare by SET MEMBERSHIP: a multi_select value is a set, so a reordered declaration is not
 * drift, and a live-side duplicate GitHub would collapse still converges instead of re-writing forever.
 */
function sameValue(a: WireValue, b: WireValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    const setA = new Set(a);
    const setB = new Set(b);
    return setA.size === setB.size && [...setA].every((element) => setB.has(element));
  }
  return a === b;
}

function show(value: WireValue): string {
  return value === null ? "unset" : JSON.stringify(value);
}

/**
 * A repeated option is a typo the set comparison would hide forever. An empty list is rejected
 * because GitHub does not document whether [] stores or normalizes to unset, so it could re-write
 * on every apply; value: null is the documented unset.
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
  // The only 404 the section can meet: the values GET is Metadata-gated, which every token holds.
  org: { ...ORG_PROBE, primaryRead: { notFound: "absent" } },
  // Metadata (read) only, so it can never be permission-denied; only the PATCH needs the grant.
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

const LiveProperty = z.looseObject({
  property_name: z.string(),
  value: z.union([z.string(), z.array(z.string()), z.null()]),
});

function propertiesByName(
  section: SectionMeta,
  live: readonly z.infer<typeof LiveProperty>[],
): Map<string, z.infer<typeof LiveProperty>> {
  return liveByIdentity(
    section,
    "custom property",
    live,
    (p) => p.property_name,
    (p) => liveIdentity(p.property_name),
  );
}

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
  // Custom properties exist only under an organization owner; the registry's owner gate (contract/owner.ts)
  // probes the `org` role and no-ops with a note on a personal account.
  ownerSensitivity: "org",
  endpoints: ENDPOINTS,
  shape: loosen(knobbed(CustomPropertyConfig)),
  // The bulk PATCH body is built from exactly property_name and value, so an extra key has no
  // destination and is always a typo.
  closedSurface: {
    known: { property_name: true, value: true },
    describe: (p) => p.property_name,
    consequence:
      "the key would silently never reach GitHub and the misdeclared property would keep its live value",
  },
  async plan(ctx, declared) {
    const { policy, entries: desired } = undeclaredPolicy(declared, defaultUndeclaredPolicy(this));
    // GitHub documents no case folding for property names, so entries are duplicates only when they match verbatim.
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
    // Not paginated upstream: one GET carries every value.
    const live = await ctx.read.list.call(z.array(LiveProperty));
    const liveByName = propertiesByName(this, live);
    const declaredNames = new Set(desired.map((p) => p.property_name));

    // A live null and an absent live entry both mean "unset".
    const updates: PendingUpdate[] = [];
    for (const property of desired) {
      const name = property.property_name;
      const wanted = normalizeValue(property.value);
      const current = liveByName.get(name)?.value ?? null;
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
              drift: valueDrift(label, show(wanted), show(current)),
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
  // An unset (null) live value is the org default, which no declaration needs to restate; an empty
  // list is read the same way (the planner refuses `[]`, whose storage GitHub leaves undocumented).
  // A list reads back as the SET the planner compares, so a live duplicate option is dropped.
  async snapshot(ctx) {
    const live = await ctx.read.list.call(z.array(LiveProperty));
    propertiesByName(this, live);
    const set = live.flatMap((property) => {
      if (property.value === null) {
        return [];
      }
      if (!Array.isArray(property.value)) {
        return [property];
      }
      const options = [...new Set(property.value)];
      return options.length === 0 ? [] : [{ ...property, value: options }];
    });
    if (set.length === 0) {
      return { value: undefined, notes: [] };
    }
    const entries = set.map((property) => projectOntoSchema(CustomPropertyConfig, property));
    return { value: knobbedSnapshot(this, entries), notes: [] };
  },
} satisfies SectionModule<"custom_properties", typeof ENDPOINTS>;
