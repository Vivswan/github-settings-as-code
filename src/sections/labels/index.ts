import { z } from "zod";
import type { EndpointDecl } from "../contract/endpoints.js";
import { listSection } from "../shared/list-section.js";
import { LabelConfig } from "./schema.js";

/** Case-insensitive matching is the section's whole contract; the brand marks a name as already folded. */
declare const labelNameKey: unique symbol;
export type NameKey = string & { readonly [labelNameKey]: true };

export function nameKey(name: string): NameKey {
  return name.toLowerCase() as NameKey;
}

/**
 * GitHub stores colors without the leading '#', lowercase; a color compared or written unfolded
 * would drift forever against the stored form.
 */
declare const labelHexColor: unique symbol;
type HexColor = string & { readonly [labelHexColor]: true };

function normalizeColor(color: string): HexColor {
  return color.replace(/^#/, "").toLowerCase() as HexColor;
}

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
  layering: { combine: "replace" },
});
