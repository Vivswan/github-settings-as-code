/**
 * `webhooks:` section - repository webhooks, managed AT MOST ONE per
 * config.url (the natural key). Undeclared hooks are KEPT by default and
 * surfaced as notes, because integrations create their own hooks; the
 * wrapped `undeclared: delete` form hardens that to deletion. A changed
 * config.url is a NEW identity: apply creates a new hook and the old one
 * becomes undeclared (kept and noted, or deleted under the knob) - it is
 * never treated as an update.
 *
 * Hook URLs are configuration, not credentials: they appear in drift lines
 * and notes on purpose. The SECRET never does. A declared config.secret must
 * be a whole-value `$NAME` reference (src/action/secret-refs.ts) that the
 * engine resolves and masks before this handler runs; GitHub echoes a live
 * secret back as "********", so the secret is excluded from the diff (check
 * mode notes it cannot verify) and the declared value rides the config PATCH
 * on EVERY apply run so rotations propagate. Config-field drift goes through
 * the PATCH .../config sub-endpoint, which updates the named fields WITHOUT
 * the general PATCH's replace-the-whole-config semantics - the general PATCH
 * would remove an undeclared live secret, so this section sends it only for
 * events/active drift, never with a config key.
 */

import { subsetDiff } from "../../engine/diff.js";
import { SettingsFile, type UndeclaredPolicyList, type WebhookConfig } from "../../schema.js";
import {
  type ApplySectionContext,
  call,
  type DeclaredSecretValue,
  defaultUndeclaredPolicy,
  type EndpointDecl,
  emptyResult,
  listAll,
  loosen,
  rejectDuplicates,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
  undeclaredPolicy,
} from "../contract.js";

interface LiveHook {
  id: number;
  name?: string;
  active?: boolean;
  events?: string[];
  config?: Record<string, unknown>;
}

const permission: SectionPermission = { repo: ["webhooks"] };

const ENDPOINTS = {
  list: { route: "GET /repos/{owner}/{repo}/hooks", statuses: { 200: "the webhook list" } },
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
 * GitHub stores insecure_ssl as the STRING "0" or "1" and echoes it back
 * that way even when the write sent a number, so both sides normalize to the
 * string form for comparison. Other values pass through as-is (GitHub is the
 * authority on what it accepts).
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
 * The declared config with the secret reference swapped for its resolved
 * plaintext. Takes the APPLY arm of SectionContext (call sites sit in
 * apply-narrowed branches), whose resolver exists by construction: the
 * engine resolved every reference up front and masked the plaintexts, so
 * the lookup cannot miss.
 */
function resolvedConfig(ctx: ApplySectionContext, hook: WebhookConfig): Record<string, unknown> {
  if (hook.config.secret === undefined) {
    return { ...hook.config };
  }
  return { ...hook.config, secret: ctx.resolveSecret(hook.config.secret) };
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
  shape: loosen(SettingsFile.shape.webhooks),
  secretValues,
  async run(ctx, declared): Promise<SectionResult> {
    const result = emptyResult();
    const { policy, entries: desired } = undeclaredPolicy(declared, defaultUndeclaredPolicy(this));
    rejectDuplicates(
      this,
      desired,
      (hook) => hook.config.url,
      (hook) => hook.config.url,
    );
    const live = (await listAll(ctx, this, ENDPOINTS.list)) as LiveHook[];
    const declaredUrls = new Set(desired.map((hook) => hook.config.url));

    // Ambiguity is rejected BEFORE any write: a hard error mid-loop would
    // leave earlier declared hooks already written (the rejectDuplicates
    // precedent - reject first, mutate after). Every ambiguous url is
    // collected before the one throw: each fix is manual GitHub cleanup, so
    // N ambiguities must cost one run to discover, not N.
    const ambiguous: string[] = [];
    for (const hook of desired) {
      const matches = live.filter((candidate) => candidate.config?.url === hook.config.url);
      if (matches.length > 1) {
        // No silent collapse: updating one of N same-url hooks (or all of
        // them) is a guess either way, so the user resolves the duplication
        // by hand once and the section converges from then on.
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

    for (const hook of desired) {
      const url = hook.config.url;
      const matches = live.filter((candidate) => candidate.config?.url === url);
      const existing = matches[0];
      const secretDeclared = hook.config.secret !== undefined;
      if (!existing) {
        if (ctx.check) {
          result.drift.push(
            `webhooks["${url}"]: missing - declared in the settings file but not on the repo; apply will create it`,
          );
          if (secretDeclared) {
            result.notes.push(`webhooks["${url}"].config.secret: ${CANNOT_VERIFY_SECRET}`);
          }
        } else {
          const { name: _name, config: _config, events, active, ...extraKeys } = hook;
          await call(ctx, this, ENDPOINTS.create, {
            payload: {
              name: "web",
              config: resolvedConfig(ctx, hook),
              ...(events === undefined ? {} : { events }),
              ...(active === undefined ? {} : { active }),
              ...extraKeys, // future hook fields pass through verbatim
            },
            describe: `creating webhook "${url}"`,
          });
          result.changes.push(`created webhook "${url}"`);
        }
        continue;
      }

      const { name: _name, config: _config, events, active, ...extraKeys } = hook;
      const configDrift = subsetDiff(
        comparableConfig(hook.config),
        comparableConfig(existing.config ?? {}),
        `webhooks["${url}"].config`,
      );
      const eventsDrift = events !== undefined && !eventsMatch(events, existing.events ?? []);
      const activeDrift = active !== undefined && (existing.active ?? true) !== active;
      const extraDrift = subsetDiff(extraKeys, existing, `webhooks["${url}"]`);

      if (ctx.check) {
        result.drift.push(...configDrift);
        if (eventsDrift) {
          result.drift.push(
            `webhooks["${url}"].events: declared ${JSON.stringify(events)} != live ${JSON.stringify(existing.events ?? [])} (compared order-insensitively); apply will set the declared events`,
          );
        }
        if (activeDrift) {
          result.drift.push(
            `webhooks["${url}"].active: declared ${JSON.stringify(active)} != live ${JSON.stringify(existing.active ?? true)}; apply will set the declared value`,
          );
        }
        result.drift.push(...extraDrift);
        if (secretDeclared) {
          result.notes.push(`webhooks["${url}"].config.secret: ${CANNOT_VERIFY_SECRET}`);
        }
        continue;
      }

      // Config drift - and a declared secret, unconditionally - go through
      // the config SUB-endpoint: it updates the named fields without the
      // general PATCH's whole-config replacement, so a live secret this file
      // does not declare is never removed. The declared secret rides every
      // run because GitHub cannot report whether it already matches.
      if (secretDeclared || configDrift.length > 0) {
        await call(ctx, this, ENDPOINTS.updateConfig, {
          params: { hook_id: String(existing.id) },
          payload: resolvedConfig(ctx, hook),
          describe: `updating webhook "${url}" config`,
        });
        result.changes.push(
          secretDeclared
            ? `updated webhook "${url}" config (the declared secret is re-sent every run)`
            : `updated webhook "${url}" config`,
        );
      }
      // events/active (and passthrough extras) go through the general PATCH
      // WITHOUT a config key, so the whole-config replacement never fires.
      if (eventsDrift || activeDrift || extraDrift.length > 0) {
        await call(ctx, this, ENDPOINTS.update, {
          params: { hook_id: String(existing.id) },
          payload: {
            ...(events === undefined ? {} : { events }),
            ...(active === undefined ? {} : { active }),
            ...extraKeys, // future hook fields pass through verbatim
          },
          describe: `updating webhook "${url}"`,
        });
        result.changes.push(`updated webhook "${url}"`);
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
        if (ctx.check) {
          result.drift.push(
            `webhooks[${describeHook(hook)}]: undeclared - not in the settings file and "undeclared: delete" is set, so apply will DELETE it; add it to the settings file to keep it`,
          );
        } else {
          await call(ctx, this, ENDPOINTS.remove, {
            params: { hook_id: String(hook.id) },
            describe: `deleting undeclared webhook ${describeHook(hook)}`,
          });
          result.changes.push(`DELETED undeclared webhook ${describeHook(hook)}`);
        }
        continue;
      }
      result.notes.push(
        `webhook ${describeHook(hook)} exists on the repo but is not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply DELETE it`,
      );
    }
    return result;
  },
} satisfies SectionModule<"webhooks">;
