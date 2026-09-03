/**
 * `webhooks:` section - repository webhooks, at most ONE per config.url (a changed url is a NEW
 * hook; the old one turns undeclared and is kept by default). Hook urls are configuration and appear
 * in drift on purpose; the secret never does, and a declared one rides the config PATCH every run.
 */

import { z } from "zod";
import { deltas, renderDelta } from "../../engine/diff.js";
import type { UndeclaredPolicyList } from "../../types.js";
import type { EndpointDecl } from "../contract/endpoints.js";
import { parseLive } from "../contract/live.js";
import {
  type DeclaredSecretValue,
  defaultUndeclaredPolicy,
  loosen,
  type SectionModule,
  undeclaredDrift,
  undeclaredNote,
  undeclaredPolicy,
} from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import {
  type ExecTools,
  hasDrift,
  type PlainData,
  type PlannedOp,
  plainData,
  type SectionPlan,
} from "../contract/plan.js";
import { rejectDuplicates } from "../contract/requests.js";
import { knobbed } from "../shared/schema-helpers.js";
import { WebhookConfig } from "./schema.js";

/** The fields of a live hook this section reads; extras ride along. */
const LiveHook = z.looseObject({
  id: z.number(),
  name: z.string().optional(),
  active: z.boolean().optional(),
  events: z.array(z.string()).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});
type LiveHook = z.infer<typeof LiveHook>;

const permission: SectionPermission = { repo: ["webhooks"] };

const ENDPOINTS = {
  list: {
    route: "GET /repos/{owner}/{repo}/hooks",
    statuses: { 200: "the webhook list" },
    primaryRead: { notFound: "denied" },
  },
  create: {
    route: "POST /repos/{owner}/{repo}/hooks",
    statuses: { 201: "webhook created" },
  },
  update: {
    route: "PATCH /repos/{owner}/{repo}/hooks/{hook_id}",
    statuses: { 200: "webhook events/active updated" },
  },
  updateConfig: {
    route: "PATCH /repos/{owner}/{repo}/hooks/{hook_id}/config",
    statuses: { 200: "webhook config updated" },
  },
  remove: {
    route: "DELETE /repos/{owner}/{repo}/hooks/{hook_id}",
    statuses: { 204: "webhook deleted" },
  },
} as const satisfies Record<string, EndpointDecl>;

/**
 * GitHub stores insecure_ssl as the STRING "0" or "1" and echoes it back that way even when the
 * write sent a number, so both sides normalize to the string form for comparison.
 */
function normalizeInsecureSsl(value: unknown): unknown {
  return typeof value === "number" ? String(value) : value;
}

/** A config copy with insecure_ssl normalized and the secret REMOVED (never diffed). */
function comparableConfig(config: Record<string, unknown>): Record<string, unknown> {
  const { secret: _secret, ...rest } = config;
  if ("insecure_ssl" in rest) {
    rest.insecure_ssl = normalizeInsecureSsl(rest.insecure_ssl);
  }
  return rest;
}

/** Events compared as sets: GitHub does not define an order (topics precedent). */
function eventsMatch(declared: readonly string[], live: readonly string[]): boolean {
  const declaredSet = new Set(declared);
  const liveSet = new Set(live);
  return declaredSet.size === liveSet.size && [...declaredSet].every((event) => liveSet.has(event));
}

/**
 * The declared config with the secret reference swapped for its resolved plaintext, sealed at
 * execution time: the engine resolved every reference up front, so the lookup cannot miss.
 */
function resolvedConfig(exec: ExecTools, hook: WebhookConfig): PlainData {
  if (hook.config.secret === undefined) {
    return plainData({ ...hook.config });
  }
  return plainData({ ...hook.config, secret: exec.resolveSecret(hook.config.secret) });
}

/**
 * The declared value of every entry's config.secret, for the engine's
 * up-front resolution, each labelled with its hook's url (configuration
 * that appears in drift lines on purpose - never a secret). DEFENSIVE by
 * contract: a malformed container
 * (webhooks: null, a scalar, entries that are not mappings) returns []
 * instead of throwing, so the actionable error always comes from shape
 * validation, never a TypeError from here.
 */
function secretValues(declared: unknown): DeclaredSecretValue[] {
  const container = declared as WebhookConfig[] | UndeclaredPolicyList<WebhookConfig>;
  const isWrapper =
    typeof container === "object" &&
    container !== null &&
    !Array.isArray(container) &&
    Array.isArray((container as UndeclaredPolicyList<WebhookConfig>).entries);
  if (!Array.isArray(container) && !isWrapper) {
    return [];
  }
  const { entries } = undeclaredPolicy(container, "keep");
  return entries.flatMap((entry) => {
    const value = typeof entry === "object" && entry !== null ? entry.config?.secret : undefined;
    if (typeof value !== "string") {
      return [];
    }
    const url = entry.config?.url;
    const label =
      typeof url === "string" && url !== ""
        ? `the webhook "${url}" config.secret`
        : "a webhook entry's config.secret";
    return [{ label, value }];
  });
}

/** How an undeclared live hook is named in notes and drift (its url, or its id). */
function describeHook(hook: LiveHook): string {
  const url = hook.config?.url;
  return typeof url === "string" && url !== "" ? `"${url}"` : `id ${hook.id} (no config.url)`;
}

const CANNOT_VERIFY_SECRET =
  'GitHub never reveals a webhook secret (reads echo "********"), so the declared value cannot be verified; apply re-sends it on every run so rotations propagate';

export const webhooksSection = {
  key: "webhooks",
  undeclaredDefault: "keep",
  permission,
  endpoints: ENDPOINTS,
  // name is pinned to "web" upfront: it is the only value GitHub's hooks API
  // accepts today, and any other value could only be a typo or a legacy
  // service hook this section does not manage.
  shape: loosen(knobbed(WebhookConfig)),
  secretValues,
  async plan(ctx, declared) {
    const { policy, entries: desired } = undeclaredPolicy(declared, defaultUndeclaredPolicy(this));
    rejectDuplicates(
      this,
      desired,
      (hook) => hook.config.url,
      (hook) => hook.config.url,
    );
    const live = parseLive(this, ENDPOINTS.list, z.array(LiveHook), await ctx.read.list.listAll());
    const declaredUrls = new Set(desired.map((hook) => hook.config.url));

    // Every ambiguous url is collected before the one throw: each fix is
    // manual GitHub cleanup, so N ambiguities must cost one run to discover.
    const ambiguous: string[] = [];
    for (const hook of desired) {
      const matches = live.filter((candidate) => candidate.config?.url === hook.config.url);
      if (matches.length > 1) {
        // No silent collapse: updating one of N same-url hooks (or all of
        // them) is a guess either way, so the user resolves it by hand once.
        ambiguous.push(
          `"${hook.config.url}" matches ${matches.length} live hooks (ids ${matches
            .map((candidate) => candidate.id)
            .join(", ")})`,
        );
      }
    }
    if (ambiguous.length > 0) {
      throw new Error(
        `webhooks: ${ambiguous.length} declared url(s) each match more than one live hook, and this section manages at most one hook per config.url: ${ambiguous.join("; ")}. Delete the duplicates on GitHub so exactly one remains per url, then re-run`,
      );
    }

    const plan: SectionPlan<PlannedOp<typeof ENDPOINTS>> = { ops: [], notes: [], drift: [] };
    for (const hook of desired) {
      const url = hook.config.url;
      const existing = live.find((candidate) => candidate.config?.url === url);
      const { name: _name, config: _config, events, active, ...extraKeys } = hook;
      const secretNote = `webhooks["${url}"].config.secret: ${CANNOT_VERIFY_SECRET}`;
      const general = {
        ...(events === undefined ? {} : { events }),
        ...(active === undefined ? {} : { active }),
        ...extraKeys, // passthrough hook fields ride verbatim
      };
      if (existing === undefined) {
        const missing = `webhooks["${url}"]: missing - declared in the settings file but not on the repo; apply will create it`;
        plan.ops.push({
          role: "create",
          payload: (exec) =>
            plainData({ name: "web", config: resolvedConfig(exec, hook), ...general }),
          describe: `creating webhook "${url}"`,
          drift:
            hook.config.secret === undefined
              ? [missing]
              : { unverifiable: secretNote, lines: [missing] },
          change: `created webhook "${url}"`,
        });
        continue;
      }

      const configDrift = deltas(
        comparableConfig(hook.config),
        comparableConfig(existing.config ?? {}),
      ).map((delta) => renderDelta(`webhooks["${url}"].config`, delta));
      // Config drift - and a declared secret, unconditionally - go through the
      // config SUB-endpoint, which updates named fields only: the general PATCH
      // would replace the whole config and drop an undeclared live secret.
      const configOp = {
        role: "updateConfig",
        params: { hook_id: String(existing.id) },
        payload: (exec: ExecTools) => resolvedConfig(exec, hook),
        describe: `updating webhook "${url}" config`,
      } as const;
      if (hook.config.secret !== undefined) {
        plan.ops.push({
          ...configOp,
          drift: { unverifiable: secretNote, lines: configDrift },
          change: `updated webhook "${url}" config (the declared secret is re-sent every run)`,
        });
      } else if (hasDrift(configDrift)) {
        plan.ops.push({
          ...configOp,
          drift: configDrift,
          change: `updated webhook "${url}" config`,
        });
      }

      // events/active (and passthrough extras) go through the general PATCH
      // WITHOUT a config key, so the whole-config replacement never fires.
      const generalDrift = [
        ...(events !== undefined && !eventsMatch(events, existing.events ?? [])
          ? [
              `webhooks["${url}"].events: declared ${JSON.stringify(events)} != live ${JSON.stringify(existing.events ?? [])} (compared order-insensitively); apply will set the declared events`,
            ]
          : []),
        ...(active !== undefined && (existing.active ?? true) !== active
          ? [
              `webhooks["${url}"].active: declared ${JSON.stringify(active)} != live ${JSON.stringify(existing.active ?? true)}; apply will set the declared value`,
            ]
          : []),
        ...deltas(extraKeys, existing).map((delta) => renderDelta(`webhooks["${url}"]`, delta)),
      ];
      if (hasDrift(generalDrift)) {
        plan.ops.push({
          role: "update",
          params: { hook_id: String(existing.id) },
          payload: plainData(general),
          describe: `updating webhook "${url}"`,
          drift: generalDrift,
          change: `updated webhook "${url}"`,
        });
      }
    }

    // Undeclared hooks are kept by default: integrations own their hooks, and
    // deleting one silently would break a service nobody named in this file.
    for (const hook of live) {
      const url = hook.config?.url;
      if (typeof url === "string" && declaredUrls.has(url)) {
        continue;
      }
      if (policy === "delete") {
        plan.ops.push({
          role: "remove",
          params: { hook_id: String(hook.id) },
          describe: `deleting undeclared webhook ${describeHook(hook)}`,
          drift: [
            undeclaredDrift(defaultUndeclaredPolicy(this), {
              label: `webhooks[${describeHook(hook)}]`,
              action: "DELETE it",
            }),
          ],
          change: `DELETED undeclared webhook ${describeHook(hook)}`,
        });
        continue;
      }
      plan.notes.push(
        undeclaredNote({ subject: `webhook ${describeHook(hook)}`, action: "DELETE it" }),
      );
    }
    return plan;
  },
} satisfies SectionModule<"webhooks", typeof ENDPOINTS>;
