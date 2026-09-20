/** `autolinks:` section. GitHub cannot edit an autolink, so a changed one is deleted and recreated. */

import { z } from "zod";
import type { EndpointDecl } from "../contract/endpoints.js";
import { exactName, listSection } from "../shared/list-section.js";
import { AutolinkConfig } from "./schema.js";

const LiveAutolink = z.looseObject({
  id: z.number(),
  key_prefix: z.string(),
  is_alphanumeric: z.boolean(),
});

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
  identity: { field: "key_prefix", fold: exactName },
  address: (live) => ({ autolink_id: String(live.id) }),
  lens: {
    // An undeclared is_alphanumeric stays off the create body (GitHub defaults it to true) and is never compared.
    toWrite: ({ key_prefix, url_template, is_alphanumeric, ...passthrough }) => ({
      key_prefix,
      url_template,
      ...(is_alphanumeric === undefined ? {} : { is_alphanumeric }),
      ...passthrough,
    }),
    fromLive: (live) => live,
    matchBy: {},
  },
  // A recreate re-sends the LIVE flag when the file leaves it undeclared (the write is spread last, so
  // a declared value wins): the create default is true, so a false flag would flip with no drift line.
  recreate: (live, write) => ({ is_alphanumeric: live.is_alphanumeric, ...write }),
  // GitHub refuses a prefix that begins, or is begun by, an existing one; the pair is named before
  // the first create instead of the second failing mid-apply.
  conflicts: {
    declared: (writes) =>
      writes.flatMap((write, index) =>
        writes.slice(index + 1).flatMap((other) => {
          const [shorter, longer] =
            write.key_prefix.length <= other.key_prefix.length ? [write, other] : [other, write];
          return longer.key_prefix.startsWith(shorter.key_prefix)
            ? [
                `the key_prefix "${shorter.key_prefix}" begins the key_prefix "${longer.key_prefix}", and GitHub rejects an autolink whose prefix begins or extends another, so the second create would fail - choose prefixes where neither begins the other`,
              ]
            : [];
        }),
      ),
  },
  replaces: false,
  prose: { undeclaredAction: "DELETE it" },
});
