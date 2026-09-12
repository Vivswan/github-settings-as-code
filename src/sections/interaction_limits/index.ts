/**
 * `interaction_limits:` section. The base limit self-expires and GitHub reads back only the computed
 * expires_at, never the duration, so a declared limit is re-armed on every apply.
 *
 * an organization- or user-level limit  -> overrides the repository's and answers 409 on writes, surfaced as a note
 * interaction_limits: null              -> clears the base limit only
 * pull_request_creation_cap             -> its own sub-endpoint; persistent state, PATCHed only on divergence; 405 where unavailable
 * pull_request_creation_bypass          -> its own sub-endpoint; the live login list is reconciled, removals before adds (100-user cap)
 */

import { z } from "zod";
import { phantomKeys, phantomNote, subsetDiff } from "../../engine/diff.js";
import type { EndpointDecl } from "../contract/endpoints.js";
import { parseLive } from "../contract/live.js";
import {
  loosen,
  requirePlainMapping,
  type SectionMeta,
  type SectionModule,
} from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import {
  hasDrift,
  type PlanContext,
  type PlannedOp,
  plainData,
  type SectionPlan,
} from "../contract/plan.js";
import { INTERACTION_LIMITS_ROUTED_KEYS, InteractionLimitsConfig } from "./schema.js";

const permission: SectionPermission = { repo: ["administration"] };

type DeclaredInteractionLimits = NonNullable<InteractionLimitsConfig>;

const ORG_OVERRIDE = "an organization- or user-level interaction limit overrides this repository's";

const CAP_UNAVAILABLE = "the pull request creation cap is not available on this repository";

// The bypass endpoints document no 405 (only the cap pair does), so on a repository without the
// cap feature their denial is ambiguous.
const BYPASS_DENIAL =
  "a 403 or 404 here can also mean the pull request creation cap is not available on this repository";

const ENDPOINTS = {
  get: {
    route: "GET /repos/{owner}/{repo}/interaction-limits",
    statuses: { 200: "the active interaction limit, or an empty object when none is set" },
    primaryRead: { notFound: "denied" },
  },
  put: {
    route: "PUT /repos/{owner}/{repo}/interaction-limits",
    statuses: { 200: "interaction limit set", 409: ORG_OVERRIDE },
    hints: {
      422: "the declared limit or expiry is not a value GitHub accepts; see the repository interactions documentation",
    },
    // The limit self-expires and its declared expiry cannot be read back, so the re-arm on every
    // apply IS the desired behavior.
    alwaysRewrite: true,
  },
  remove: {
    route: "DELETE /repos/{owner}/{repo}/interaction-limits",
    statuses: { 204: "interaction limit cleared", 409: ORG_OVERRIDE },
  },
  // GitHub gates the cap and bypass-list READS at write, so a read-only token is denied them.
  capGet: {
    route: "GET /repos/{owner}/{repo}/interaction-limits/pulls/creation-cap",
    statuses: { 200: "the pull request creation cap", 405: CAP_UNAVAILABLE },
    accessGrade: "write",
  },
  capPatch: {
    route: "PATCH /repos/{owner}/{repo}/interaction-limits/pulls/creation-cap",
    statuses: { 200: "pull request creation cap updated", 405: CAP_UNAVAILABLE },
    hints: {
      422: "enabled must be a boolean and max_open_pull_requests a whole number from 1 to 1000; see the pull request creation cap endpoint documentation",
    },
  },
  bypassList: {
    route: "GET /repos/{owner}/{repo}/interaction-limits/pulls/bypass-list",
    statuses: { 200: "the pull request creation cap bypass list" },
    denialHint: BYPASS_DENIAL,
    accessGrade: "write",
  },
  bypassAdd: {
    route: "PUT /repos/{owner}/{repo}/interaction-limits/pulls/bypass-list",
    statuses: { 204: "users added to the bypass list" },
    denialHint: BYPASS_DENIAL,
    hints: {
      422: "every users entry must be an existing GitHub login, and the bypass list holds at most 100 users; see the bypass-list endpoint documentation",
    },
  },
  bypassRemove: {
    route: "DELETE /repos/{owner}/{repo}/interaction-limits/pulls/bypass-list",
    statuses: { 204: "users removed from the bypass list" },
    denialHint: BYPASS_DENIAL,
    hints: {
      422: "every users entry must be an existing GitHub login; see the bypass-list endpoint documentation",
    },
  },
} as const satisfies Record<string, EndpointDecl>;

type InteractionLimitsContext = PlanContext<typeof ENDPOINTS>;
type InteractionLimitsPlan = SectionPlan<PlannedOp<typeof ENDPOINTS>>;

/**
 * An EMPTY plain object is GitHub's "no limit set"; anything else falls through to the limit parse,
 * which fails loudly instead of reading a malformed body as absence.
 */
function noLiveLimit(live: unknown): boolean {
  return (
    typeof live === "object" &&
    live !== null &&
    !Array.isArray(live) &&
    Object.keys(live).length === 0
  );
}

const LiveInteractionLimit = z.looseObject({
  limit: z.string(),
  origin: z.string().optional(),
});

type LiveLimitState =
  | { kind: "none" }
  | { kind: "repository"; limit: string; body: Record<string, unknown> }
  | { kind: "inherited"; limit: string; origin: string; body: Record<string, unknown> };

async function liveBaseLimit(
  ctx: InteractionLimitsContext,
  section: SectionMeta,
): Promise<LiveLimitState> {
  const body = await ctx.read.get.call();
  if (noLiveLimit(body)) {
    return { kind: "none" };
  }
  const parsed = parseLive(section, ENDPOINTS.get, LiveInteractionLimit, body);
  // An absent origin reads as the repository's own limit: only a non-repository origin changes what apply can do.
  return parsed.origin !== undefined && parsed.origin.toLowerCase() !== "repository"
    ? { kind: "inherited", limit: parsed.limit, origin: parsed.origin, body: parsed }
    : { kind: "repository", limit: parsed.limit, body: parsed };
}

/**
 * When `base` is present it carries `limit` as a non-optional string BY CONSTRUCTION: the shape's
 * superRefine rejected base keys without a limit upfront, so the prose sites read base.limit instead
 * of re-trusting an optional field.
 */
interface DeclaredLimits {
  base?: { limit: string } & Record<string, unknown>;
  cap: DeclaredInteractionLimits["pull_request_creation_cap"];
  bypass: DeclaredInteractionLimits["pull_request_creation_bypass"];
}

function splitDeclared(desired: DeclaredInteractionLimits): DeclaredLimits {
  const base = Object.fromEntries(
    Object.entries(desired as Record<string, unknown>).filter(
      ([key]) => !INTERACTION_LIMITS_ROUTED_KEYS.has(key),
    ),
  );
  const cap = desired.pull_request_creation_cap;
  const bypass = desired.pull_request_creation_bypass;
  if (Object.keys(base).length === 0) {
    return { cap, bypass };
  }
  const limit = base.limit;
  if (typeof limit !== "string") {
    // The shape's superRefine rejects base keys without a limit upfront, and the engine hands plan() that shape's output.
    throw new Error(
      `BUG: interaction_limits base key(s) [${Object.keys(base).join(", ")}] reached plan() without a limit; the shape rejects this pairing during document validation`,
    );
  }
  return { base: { ...base, limit }, cap, bypass };
}

/**
 * GitHub logins are case-insensitive. Removals go FIRST because the list holds at most 100 users,
 * so adding before removing could transiently overflow it and 422.
 */
function bypassDelta(
  declared: readonly string[],
  liveLogins: readonly string[],
): { add: string[]; remove: string[] } {
  const declaredKeys = new Set(declared.map((login) => login.toLowerCase()));
  const liveKeys = new Set(liveLogins.map((login) => login.toLowerCase()));
  return {
    add: declared.filter((login) => !liveKeys.has(login.toLowerCase())),
    remove: liveLogins.filter((login) => !declaredKeys.has(login.toLowerCase())),
  };
}

/**
 * A single GET, not listAll(): the endpoint documents no pagination parameters (the list holds at
 * most 100 users), so a page loop on a full 100-user list would re-request the same body forever.
 */
async function liveBypassLogins(
  ctx: InteractionLimitsContext,
  section: SectionMeta,
): Promise<string[]> {
  const live = parseLive(
    section,
    ENDPOINTS.bypassList,
    z.array(z.looseObject({ login: z.string() })),
    await ctx.read.bypassList.call(),
  );
  return live.map((user) => user.login);
}

export const interactionLimitsSection = {
  key: "interaction_limits",
  undeclaredDefault: "untouched",
  permission,
  endpoints: ENDPOINTS,
  shape: requirePlainMapping(loosen(InteractionLimitsConfig)),
  async plan(ctx, desired) {
    const plan: InteractionLimitsPlan = { ops: [], notes: [], drift: [] };

    if (desired === null) {
      // null clears the BASE limit only; the cap and bypass list are separate resources.
      const live = await liveBaseLimit(ctx, this);
      if (live.kind === "none") {
        return plan;
      }
      plan.ops.push({
        role: "remove",
        describe: "clearing the interaction limit",
        drift: [
          live.kind === "inherited"
            ? `interaction_limits: declared null but a live "${live.limit}" limit is set at the ${live.origin} level; ` +
              "apply cannot remove it from the repository"
            : `interaction_limits: declared null but a live "${live.limit}" limit is set; apply will remove it`,
        ],
        tolerate: {
          statuses: [409],
          outcome: (error) => ({
            note: `interaction_limits: ${ORG_OVERRIDE}, so the repository-level clear was not applied (${error.status})`,
          }),
        },
        change: "cleared the interaction limit",
      });
      return plan;
    }

    const { base, cap, bypass } = splitDeclared(desired);

    if (base !== undefined) {
      const live = await liveBaseLimit(ctx, this);
      // Declared != effective is drift REGARDLESS of who set the live limit: an inherited limit adds
      // the cannot-fix note, but check stays red rather than reporting a non-matching repository as clean.
      const drift: string[] = [];
      if (live.kind === "none") {
        drift.push(
          `interaction_limits: no live limit (never set, or it expired); apply will (re-)arm the declared "${base.limit}" limit`,
        );
      } else {
        // The live body carries limit/origin/expires_at but never the declared expiry duration, so
        // diffing expiry would be permanent false drift.
        const { expiry: _expiry, ...comparable } = base;
        drift.push(...subsetDiff(comparable, live.body, "interaction_limits"));
        if (live.kind === "inherited") {
          plan.notes.push(
            `interaction_limits: ${ORG_OVERRIDE} (origin: ${live.origin}); apply cannot change it from the repository`,
          );
        }
      }
      if (desired.expiry !== undefined) {
        plan.notes.push(
          `interaction_limits.expiry: GitHub reports only the computed expires_at, so the declared duration cannot be verified; apply re-arms it on every run`,
        );
      }
      // The PUT is alwaysRewrite: a matching live limit still re-arms (its expiry is ticking), so
      // the drift may legitimately be empty here.
      plan.ops.push({
        role: "put",
        payload: plainData(base),
        describe: `arming the "${base.limit}" interaction limit`,
        drift,
        tolerate: {
          statuses: [409],
          outcome: (error) => ({
            note: `interaction_limits: ${ORG_OVERRIDE}, so the repository-level limit was not applied (${error.status})`,
          }),
        },
        change: `armed the "${base.limit}" interaction limit (expiry: ${desired.expiry ?? "one_day (GitHub default)"})`,
      });
    }
    if (cap !== undefined) {
      const outcome = await ctx.read.capGet.tryCall({
        describe: "reading the pull request creation cap",
      });
      if ("error" in outcome) {
        // A tolerated 405: the declared cap cannot exist live and apply could not set it either,
        // so this is honest drift no operation fixes.
        plan.drift.push(
          `interaction_limits.pull_request_creation_cap: declared but ${CAP_UNAVAILABLE} (405); apply cannot set it`,
        );
      } else {
        // The cap object is loose passthrough and the PATCH is diff-gated, so a declared key GitHub
        // ignores would re-PATCH on every apply without converging.
        const phantom = phantomKeys(cap, outcome.data);
        if (phantom.length > 0) {
          plan.notes.push(
            phantomNote(
              "interaction_limits.pull_request_creation_cap",
              phantom,
              "creation cap",
              "this PATCH will re-run",
            ),
          );
        }
        // Unlike the self-expiring base limit there is nothing to re-arm, so the cap PATCHes only on divergence.
        const drift = subsetDiff(cap, outcome.data, "interaction_limits.pull_request_creation_cap");
        if (hasDrift(drift)) {
          plan.ops.push({
            role: "capPatch",
            payload: plainData(cap),
            describe: "setting the pull request creation cap",
            drift,
            tolerate: {
              statuses: [405],
              outcome: (error) => ({
                note: `interaction_limits.pull_request_creation_cap: ${CAP_UNAVAILABLE}, so the declared cap was not applied (${error.status})`,
              }),
            },
            change:
              `set the pull request creation cap (enabled: ${cap.enabled}` +
              `${cap.max_open_pull_requests !== undefined ? `, max_open_pull_requests: ${cap.max_open_pull_requests}` : ""})`,
          });
        }
      }
    }
    if (bypass !== undefined) {
      const liveLogins = await liveBypassLogins(ctx, this);
      const { add, remove } = bypassDelta(bypass, liveLogins);
      if (remove.length > 0) {
        plan.ops.push({
          role: "bypassRemove",
          payload: { users: remove },
          describe: "removing users from the pull request creation cap bypass list",
          drift: [
            `interaction_limits.pull_request_creation_bypass: live login(s) [${remove.join(", ")}] are not declared; apply will remove them`,
          ],
          change: `removed [${remove.join(", ")}] from the pull request creation cap bypass list`,
        });
      }
      if (add.length > 0) {
        plan.ops.push({
          role: "bypassAdd",
          payload: { users: add },
          describe: "adding users to the pull request creation cap bypass list",
          drift: [
            `interaction_limits.pull_request_creation_bypass: declared login(s) [${add.join(", ")}] are not on the live bypass list; apply will add them`,
          ],
          change: `added [${add.join(", ")}] to the pull request creation cap bypass list`,
        });
      }
    }
    return plan;
  },
} satisfies SectionModule<"interaction_limits", typeof ENDPOINTS>;
