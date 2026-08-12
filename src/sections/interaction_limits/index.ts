/**
 * `interaction_limits:` section - a repo-level restriction on who may
 * comment, open issues, or create pull requests. The resource self-expires
 * (GitHub's expiry tops out at six_months), so a declared limit is re-armed
 * on every apply run, and check mode reports drift once it lapses; the
 * declared expiry itself is write-only (GitHub reads back the computed
 * expires_at, never the duration). `interaction_limits: null` clears a live
 * repo-level limit. An organization- or user-level limit overrides the
 * repository's and answers 409 on writes, which surfaces as a note rather
 * than a failure - the org is the place to change it.
 *
 * Two keys route to their own .../interaction-limits/pulls sub-endpoints
 * instead of the base PUT (the required_signatures precedent):
 * pull_request_creation_cap is persistent desired state with no self-expiry,
 * so check diffs it exactly and apply PATCHes only on divergence (no
 * re-arm); pull_request_creation_bypass reconciles the live login list,
 * DELETEing the undeclared logins and then PUTting the missing ones (the
 * list holds at most 100 users, so removals go first).
 * Repositories where the cap is unavailable answer 405 on the cap
 * endpoints: apply surfaces that as a note (the 409 pattern), check mode as
 * drift. `interaction_limits: null` clears the base limit only and never
 * touches the cap or bypass list.
 */

import { z } from "zod";
import { phantomKeys, phantomNote, subsetDiff } from "../../engine/diff.js";
import {
  INTERACTION_LIMITS_ROUTED_KEYS,
  type InteractionLimitsConfig,
  SettingsFile,
} from "../../schema.js";
import {
  beginRun,
  call,
  type EndpointDecl,
  loosen,
  parseLive,
  requirePlainMapping,
  type SectionContext,
  type SectionMeta,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
  tryCall,
} from "../contract.js";

const permission: SectionPermission = { repo: ["administration"] };

const ORG_OVERRIDE = "an organization- or user-level interaction limit overrides this repository's";

const CAP_UNAVAILABLE = "the pull request creation cap is not available on this repository";

// The bypass endpoints document no 405 (only the cap pair does), so on a
// repository without the cap feature their denial is ambiguous.
const BYPASS_DENIAL =
  "a 403 or 404 here can also mean the pull request creation cap is not available on this repository";

const ENDPOINTS = {
  get: {
    route: "GET /repos/{owner}/{repo}/interaction-limits",
    statuses: { 200: "the active interaction limit, or an empty object when none is set" },
  },
  put: {
    route: "PUT /repos/{owner}/{repo}/interaction-limits",
    statuses: { 200: "interaction limit set", 409: ORG_OVERRIDE },
    hints: {
      422: "the declared limit or expiry is not a value GitHub accepts; see the repository interactions documentation",
    },
  },
  remove: {
    route: "DELETE /repos/{owner}/{repo}/interaction-limits",
    statuses: { 204: "interaction limit cleared", 409: ORG_OVERRIDE },
  },
  capGet: {
    route: "GET /repos/{owner}/{repo}/interaction-limits/pulls/creation-cap",
    statuses: { 200: "the pull request creation cap", 405: CAP_UNAVAILABLE },
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

/** A GET body with no keys means "no limit is currently set". */
function noLiveLimit(live: Record<string, unknown>): boolean {
  return Object.keys(live ?? {}).length === 0;
}

/** The fields a NON-EMPTY live limit body must carry; extras ride along. */
const LiveInteractionLimit = z.looseObject({
  limit: z.string(),
  origin: z.string().optional(),
});

/**
 * The live base limit as the prose branches on it: no limit at all, a
 * repository-level limit apply can manage, or a limit inherited from the
 * organization or user level that apply cannot touch. `body` carries the
 * raw GET object for subsetDiff. One parse at the boundary, so "origin says
 * inherited but no limit to name" is unrepresentable downstream - every arm
 * that has a limit carries it as a proven string.
 */
type LiveLimitState =
  | { kind: "none" }
  | { kind: "repository"; limit: string; body: Record<string, unknown> }
  | { kind: "inherited"; limit: string; origin: string; body: Record<string, unknown> };

async function liveBaseLimit(ctx: SectionContext, section: SectionMeta): Promise<LiveLimitState> {
  const body = (await call(ctx, section, ENDPOINTS.get)) as Record<string, unknown>;
  if (noLiveLimit(body)) {
    return { kind: "none" };
  }
  const parsed = parseLive(section, ENDPOINTS.get, LiveInteractionLimit, body);
  // An absent origin reads as the repository's own limit (the GET documents
  // origin, but only a non-repository origin changes what apply can do).
  return parsed.origin !== undefined && parsed.origin.toLowerCase() !== "repository"
    ? { kind: "inherited", limit: parsed.limit, origin: parsed.origin, body }
    : { kind: "repository", limit: parsed.limit, body };
}

/**
 * The declared value split ONCE into its three destinations: the base PUT
 * body, the creation-cap object, and the bypass login list. When `base` is
 * present it carries `limit` as a non-optional string BY CONSTRUCTION - the
 * shape's superRefine rejected base keys without a limit during upfront
 * document validation - so the prose sites read base.limit instead of
 * re-trusting an optional field, and the impossible state throws as the BUG
 * it would be.
 */
interface DeclaredLimits {
  base?: { limit: string } & Record<string, unknown>;
  cap: InteractionLimitsConfig["pull_request_creation_cap"];
  bypass: InteractionLimitsConfig["pull_request_creation_bypass"];
}

function splitDeclared(desired: InteractionLimitsConfig): DeclaredLimits {
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
    throw new Error(
      "BUG: interaction_limits base keys reached the handler without a limit; the shape's superRefine rejects that document upfront",
    );
  }
  return { base: { ...base, limit }, cap, bypass };
}

/**
 * The bypass-list reconciliation, from a case-insensitive login compare
 * (GitHub logins are case-insensitive): the live logins the file does not
 * declare are DELETEd, the declared logins missing live are PUT - never a
 * wholesale replace. Removals go FIRST: the list holds at most 100 users,
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
 * The live bypass-list logins, parsed at the boundary (a user without a
 * string login has no identity to reconcile by). A single GET, not
 * listAll(): the endpoint
 * documents no pagination parameters (the list holds at most 100 users), so
 * a page loop would re-request the same full body forever on a
 * page-ignoring endpoint.
 */
async function liveBypassLogins(ctx: SectionContext, section: SectionMeta): Promise<string[]> {
  const live = parseLive(
    section,
    ENDPOINTS.bypassList,
    z.array(z.looseObject({ login: z.string() })),
    await call(ctx, section, ENDPOINTS.bypassList),
  );
  return live.map((user) => user.login);
}

export const interactionLimitsSection = {
  key: "interaction_limits",
  undeclaredDefault: "untouched",
  permission,
  endpoints: ENDPOINTS,
  shape: requirePlainMapping(loosen(SettingsFile.shape.interaction_limits)),
  async run(ctx, desired): Promise<SectionResult> {
    const run = beginRun(ctx);

    if (desired === null) {
      // null clears the BASE limit only; the cap and bypass list are
      // separate resources a clear must not touch.
      if (run.check) {
        const live = await liveBaseLimit(ctx, this);
        if (live.kind !== "none") {
          run.result.drift.push(
            live.kind === "inherited"
              ? `interaction_limits: declared null but a live "${live.limit}" limit is set at the ${live.origin} level; apply cannot remove it from the repository`
              : `interaction_limits: declared null but a live "${live.limit}" limit is set; apply will remove it`,
          );
        }
        return run.result;
      }
      const outcome = await tryCall(ctx, this, ENDPOINTS.remove, {
        describe: "clearing the interaction limit",
      });
      if ("error" in outcome) {
        run.result.notes.push(
          `interaction_limits: ${ORG_OVERRIDE}, so the repository-level clear was not applied (${outcome.error.status})`,
        );
        return run.result;
      }
      run.result.changes.push("cleared the interaction limit");
      return run.result;
    }

    const { base, cap, bypass } = splitDeclared(desired);

    if (run.check) {
      if (base !== undefined) {
        const live = await liveBaseLimit(ctx, this);
        // Declared != effective is drift REGARDLESS of who set the live limit;
        // when an org/user-level limit is the cause, the prose says apply
        // cannot fix it (the org is the place to), but check stays red rather
        // than reporting a repo that does not match its declaration as clean.
        if (live.kind === "none") {
          run.result.drift.push(
            `interaction_limits: no live limit (never set, or it expired); apply will (re-)arm the declared "${base.limit}" limit`,
          );
        } else {
          // The live body carries limit/origin/expires_at but never the
          // declared expiry duration, so diffing expiry would be permanent
          // false drift; compare everything else.
          const { expiry: _expiry, ...comparable } = base;
          run.result.drift.push(...subsetDiff(comparable, live.body, "interaction_limits"));
          if (live.kind === "inherited") {
            run.result.notes.push(
              `interaction_limits: ${ORG_OVERRIDE} (origin: ${live.origin}); apply cannot change it from the repository`,
            );
          }
        }
        if (desired.expiry !== undefined) {
          run.result.notes.push(
            `interaction_limits.expiry: GitHub reports only the computed expires_at, so the declared duration cannot be verified; apply re-arms it on every run`,
          );
        }
      }
      if (cap !== undefined) {
        const outcome = await tryCall(ctx, this, ENDPOINTS.capGet, {
          describe: "reading the pull request creation cap",
        });
        if ("error" in outcome) {
          // A tolerated 405: the declared cap cannot exist live, and apply
          // could not set it either - honest drift, not silence.
          run.result.drift.push(
            `interaction_limits.pull_request_creation_cap: declared but ${CAP_UNAVAILABLE} (405); apply cannot set it`,
          );
        } else {
          run.result.drift.push(
            ...subsetDiff(cap, outcome.data, "interaction_limits.pull_request_creation_cap"),
          );
        }
      }
      if (bypass !== undefined) {
        const liveLogins = await liveBypassLogins(ctx, this);
        const { add, remove } = bypassDelta(bypass, liveLogins);
        if (remove.length > 0) {
          run.result.drift.push(
            `interaction_limits.pull_request_creation_bypass: live login(s) [${remove.join(", ")}] are not declared; apply will remove them`,
          );
        }
        if (add.length > 0) {
          run.result.drift.push(
            `interaction_limits.pull_request_creation_bypass: declared login(s) [${add.join(", ")}] are not on the live bypass list; apply will add them`,
          );
        }
      }
      return run.result;
    }

    if (base !== undefined) {
      const outcome = await tryCall(ctx, this, ENDPOINTS.put, {
        payload: base,
        describe: `arming the "${base.limit}" interaction limit`,
      });
      if ("error" in outcome) {
        run.result.notes.push(
          `interaction_limits: ${ORG_OVERRIDE}, so the repository-level limit was not applied (${outcome.error.status})`,
        );
      } else {
        run.result.changes.push(
          `armed the "${base.limit}" interaction limit (expiry: ${desired.expiry ?? "one_day (GitHub default)"})`,
        );
      }
    }
    if (cap !== undefined) {
      // Unlike the self-expiring base limit there is nothing to re-arm, so
      // the cap is compare-before-write: PATCH only on divergence.
      const outcome = await tryCall(ctx, this, ENDPOINTS.capGet, {
        describe: "reading the pull request creation cap",
      });
      if ("error" in outcome) {
        run.result.notes.push(
          `interaction_limits.pull_request_creation_cap: ${CAP_UNAVAILABLE}, so the declared cap was not applied (${outcome.error.status})`,
        );
      } else {
        // The cap object is loose passthrough and the PATCH is diff-gated, so
        // a declared key GitHub ignores would re-PATCH on every apply without
        // converging; say so (the labels/milestones phantom-key idiom).
        const phantom = phantomKeys(cap as Record<string, unknown>, outcome.data);
        if (phantom.length > 0) {
          run.result.notes.push(
            phantomNote(
              "interaction_limits.pull_request_creation_cap",
              phantom,
              "creation cap",
              "this PATCH will re-run",
            ),
          );
        }
        if (
          subsetDiff(cap, outcome.data, "interaction_limits.pull_request_creation_cap").length > 0
        ) {
          const patched = await tryCall(ctx, this, ENDPOINTS.capPatch, {
            payload: cap,
            describe: "setting the pull request creation cap",
          });
          if ("error" in patched) {
            run.result.notes.push(
              `interaction_limits.pull_request_creation_cap: ${CAP_UNAVAILABLE}, so the declared cap was not applied (${patched.error.status})`,
            );
          } else {
            run.result.changes.push(
              `set the pull request creation cap (enabled: ${cap.enabled}${cap.max_open_pull_requests !== undefined ? `, max_open_pull_requests: ${cap.max_open_pull_requests}` : ""})`,
            );
          }
        }
      }
    }
    if (bypass !== undefined) {
      const liveLogins = await liveBypassLogins(ctx, this);
      const { add, remove } = bypassDelta(bypass, liveLogins);
      if (remove.length > 0) {
        await call(ctx, this, ENDPOINTS.bypassRemove, {
          payload: { users: remove },
          describe: "removing users from the pull request creation cap bypass list",
        });
        run.result.changes.push(
          `removed [${remove.join(", ")}] from the pull request creation cap bypass list`,
        );
      }
      if (add.length > 0) {
        await call(ctx, this, ENDPOINTS.bypassAdd, {
          payload: { users: add },
          describe: "adding users to the pull request creation cap bypass list",
        });
        run.result.changes.push(
          `added [${add.join(", ")}] to the pull request creation cap bypass list`,
        );
      }
    }
    return run.result;
  },
} satisfies SectionModule<"interaction_limits">;
