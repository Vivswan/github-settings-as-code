/**
 * `autolinks:` section - autolinks cannot be edited, so a changed one is
 * deleted and recreated. Undeclared autolinks are DELETED by default; the
 * wrapped `undeclared: keep` form softens that to notes.
 */

import { z } from "zod";
import type { EndpointDecl } from "../contract/endpoints.js";
import { listSection } from "../shared/list-section.js";
import { AutolinkConfig } from "./schema.js";

/** The fields of a live autolink this section reads; extras ride along. */
const LiveAutolink = z.looseObject({ id: z.number(), key_prefix: z.string() });

const ENDPOINTS = {
  list: {
    route: "GET /repos/{owner}/{repo}/autolinks",
    statuses: { 200: "the autolink list" },
    primaryRead: { notFound: "denied" },
  },
  create: { route: "POST /repos/{owner}/{repo}/autolinks", statuses: { 201: "autolink created" } },
  remove: {
    route: "DELETE /repos/{owner}/{repo}/autolinks/{autolink_id}",
    statuses: { 204: "autolink deleted" },
  },
} as const satisfies Record<string, EndpointDecl>;

export const autolinksSection = listSection({
  key: "autolinks",
  permission: { repo: ["administration"] },
  undeclaredDefault: "delete",
  noun: "autolink",
  entry: AutolinkConfig,
  live: LiveAutolink,
  endpoints: ENDPOINTS,
  // GitHub returns every autolink in one response and ignores page params.
  listing: { unpaginated: true },
  identity: { field: "key_prefix" },
  address: (live) => ({ autolink_id: String(live.id) }),
  lens: {
    // An undeclared is_alphanumeric is GitHub's default (true) on the create and unmanaged after.
    toWrite: ({ key_prefix, url_template, is_alphanumeric, ...passthrough }) => ({
      key_prefix,
      url_template,
      ...(is_alphanumeric === undefined ? {} : { is_alphanumeric }),
      ...passthrough,
    }),
    fromLive: (live) => live,
    matchBy: {},
  },
  prose: { undeclaredAction: "DELETE it" },
});
