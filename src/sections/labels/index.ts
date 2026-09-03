/**
 * `labels:` section - Probot parity: upsert declared labels by
 * case-insensitive name (with `new_name` rename support) and DELETE
 * undeclared labels, loudly. The wrapped `undeclared: keep` form softens
 * the deletion to notes. A list section: everything but the lens and the
 * identity fold derives from the declaration (see ../shared/list-section.ts).
 */

import { z } from "zod";
import type { EndpointDecl } from "../contract/endpoints.js";
import { listSection } from "../shared/list-section.js";
import { LabelConfig } from "./schema.js";

/**
 * The case-insensitive matching key of a label name, branded so only
 * nameKey() can mint one: matching case-insensitively is this section's
 * whole contract, and the brand makes a map or set keyed by a raw (unfolded)
 * name a compile error instead of a silent case-sensitive lookup.
 */
declare const labelNameKey: unique symbol;
export type NameKey = string & { readonly [labelNameKey]: true };

/** Case-insensitive key for name-matched resources (labels). */
export function nameKey(name: string): NameKey {
  return name.toLowerCase() as NameKey;
}

/**
 * A label color in GitHub's stored form (no leading '#', lowercase),
 * branded so only normalizeColor() can mint one - a color compared or
 * written unfolded would drift forever against the stored form.
 */
declare const labelHexColor: unique symbol;
type HexColor = string & { readonly [labelHexColor]: true };

/** Label colors: GitHub stores them without the leading '#', lowercase. */
function normalizeColor(color: string): HexColor {
  return color.replace(/^#/, "").toLowerCase() as HexColor;
}

/** The fields of a live label this section reads; extra fields ride along. */
const LiveLabel = z.looseObject({
  name: z.string(),
  color: z.string(),
  description: z.string().nullable(),
});

const ENDPOINTS = {
  list: {
    route: "GET /repos/{owner}/{repo}/labels",
    statuses: { 200: "the label list" },
    primaryRead: { notFound: "denied" },
  },
  create: {
    route: "POST /repos/{owner}/{repo}/labels",
    statuses: { 201: "label created" },
  },
  update: {
    route: "PATCH /repos/{owner}/{repo}/labels/{name}",
    statuses: { 200: "label updated" },
  },
  remove: {
    route: "DELETE /repos/{owner}/{repo}/labels/{name}",
    statuses: { 204: "label deleted" },
  },
} as const satisfies Record<string, EndpointDecl>;

export const labelsSection = listSection({
  key: "labels",
  permission: { repo: ["issues"] },
  undeclaredDefault: "delete",
  noun: "label",
  entry: LabelConfig,
  live: LiveLabel,
  endpoints: ENDPOINTS,
  identity: {
    field: "name",
    fold: nameKey,
    // A renaming entry also owns the label at its current name.
    aliases: (label) => (label.new_name === undefined ? [] : [label.name]),
    renameKey: "new_name",
  },
  address: (live) => ({ name: live.name }),
  lens: {
    toWrite: ({ name, new_name, color, description, ...passthrough }) => ({
      name: new_name ?? name,
      ...(color === undefined ? {} : { color: normalizeColor(color) }),
      ...(description === undefined ? {} : { description }),
      ...passthrough,
    }),
    // GitHub returns null for an empty description, which the file spells "".
    fromLive: (live) => ({
      ...live,
      color: normalizeColor(live.color),
      description: live.description ?? "",
    }),
    matchBy: {},
  },
  prose: { undeclaredAction: "DELETE it" },
});
