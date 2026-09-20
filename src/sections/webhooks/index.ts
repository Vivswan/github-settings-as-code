/**
 * `webhooks:` section: web hooks, at most ONE per config.url (a changed url is a NEW hook; the old
 * one turns undeclared). Hook urls are configuration and appear in drift on purpose; the secret never
 * does, and a declared one is re-sent on every run. A legacy service hook (name other than "web") or
 * a hook without a config.url is outside what this section manages.
 */

import { z } from "zod";
import type { EndpointDecl } from "../contract/endpoints.js";
import {
  exactName,
  type ListComparable,
  type ListWrite,
  listSection,
} from "../shared/list-section.js";
import { WebhookConfig } from "./schema.js";

const LiveHook = z.looseObject({
  id: z.number(),
  name: z.string().optional(),
  active: z.boolean().optional(),
  events: z.array(z.string()).optional(),
  config: z.looseObject({ url: z.string().optional(), secret: z.string().optional() }).optional(),
});
type LiveHook = z.infer<typeof LiveHook>;

const ENDPOINTS = {
  list: {
    route: "GET /repos/{owner}/{repo}/hooks",
    statuses: { 200: "the webhook list" },
    primaryRead: { notFound: "denied" },
  },
  create: {
    route: "POST /repos/{owner}/{repo}/hooks",
    statuses: { 201: "webhook created" },
    unverifiable: true,
  },
  update: {
    route: "PATCH /repos/{owner}/{repo}/hooks/{hook_id}",
    statuses: { 200: "webhook events/active updated" },
  },
  // Updates named config fields only: the general PATCH would replace the whole config and drop an undeclared live secret.
  updateConfig: {
    route: "PATCH /repos/{owner}/{repo}/hooks/{hook_id}/config",
    statuses: { 200: "webhook config updated" },
    unverifiable: true,
  },
  remove: {
    route: "DELETE /repos/{owner}/{repo}/hooks/{hook_id}",
    statuses: { 204: "webhook deleted" },
  },
} as const satisfies Record<string, EndpointDecl>;

/**
 * GitHub stores insecure_ssl as the STRING "0" or "1" and echoes it back that way even when the
 * write sent a number, so both lens sides spell the string form.
 */
function normalizeInsecureSsl(value: unknown): unknown {
  return typeof value === "number" ? String(value) : value;
}

function normalizedConfig<C extends Record<string, unknown>>(config: C): C {
  return "insecure_ssl" in config
    ? { ...config, insecure_ssl: normalizeInsecureSsl(config.insecure_ssl) }
    : config;
}

function urlOf(hook: LiveHook): string | undefined {
  const url = hook.config?.url;
  return typeof url === "string" && url !== "" ? url : undefined;
}

export const webhooksSection = listSection({
  key: "webhooks",
  permission: { repo: ["webhooks"] },
  undeclaredDefault: "keep",
  noun: "webhook",
  entry: WebhookConfig,
  live: LiveHook,
  endpoints: ENDPOINTS,
  identity: { field: "config.url", fold: exactName },
  address: (live) => ({ hook_id: String(live.id) }),
  mapping: "config",
  secrets: ["config.secret"],
  lens: {
    // `name` never rides a write: "web" is the one value the slice admits and GitHub's default on
    // create, and the update endpoint takes no name. The config's catchall is unknown passthrough;
    // the factory proves the body plain at the payload.
    toWrite: ({ name: _name, ...hook }) =>
      ({
        ...hook,
        config: normalizedConfig(hook.config),
      }) as ListWrite<"config.url">,
    // GitHub defaults a new hook to active with the push event, so an omitted field reads as that default.
    fromLive: (live): ListComparable<"config.url"> => {
      const url = urlOf(live);
      if (url === undefined) {
        throw new Error(
          `BUG: webhooks: hook ${live.id} has no config.url, which \`foreign\` filters before the lens`,
        );
      }
      return {
        ...live,
        config: normalizedConfig({ ...live.config, url }),
        events: live.events ?? [],
        active: live.active ?? true,
      };
    },
    matchBy: {},
  },
  replaces: false,
  foreign: (live) => {
    const url = urlOf(live);
    if (url === undefined) {
      return {
        name: `id ${live.id} (no config.url)`,
        reason: "the hook has no config.url, the natural key this section manages by",
      };
    }
    if (live.name !== undefined && live.name !== "web") {
      return {
        name: url,
        reason: `a "${live.name}" service hook is not a web hook this section manages`,
      };
    }
    return null;
  },
  // Undeclared hooks are kept by default: integrations own their hooks, and deleting one silently
  // would break a service nobody named in this file.
  prose: { undeclaredAction: "DELETE it" },
});
