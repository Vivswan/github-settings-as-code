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
 */

import { z } from "zod";
import { subsetDiff } from "../engine/diff.js";
import type { InteractionLimitsConfig } from "../schema.js";
import {
  call,
  type EndpointDecl,
  emptyResult,
  grantFor,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
  tryCall,
} from "./contract.js";

const permission: SectionPermission = { repo: ["administration"] };

const ORG_OVERRIDE = "an organization- or user-level interaction limit overrides this repository's";

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
} as const satisfies Record<string, EndpointDecl>;

/** A GET body with no keys means "no limit is currently set". */
function noLiveLimit(live: Record<string, unknown>): boolean {
  return Object.keys(live).length === 0;
}

/** True when the live limit was set above the repository (org or user). */
function overriddenFromAbove(live: Record<string, unknown>): boolean {
  return live.origin !== undefined && String(live.origin).toLowerCase() !== "repository";
}

export const interactionLimitsSection: SectionModule<"interaction_limits"> = {
  key: "interaction_limits",
  undeclaredDefault: "untouched",
  permission,
  grant: grantFor(permission),
  endpoints: ENDPOINTS,
  // Loose on purpose: the PUT forwards the object verbatim, so future fields
  // ride along; only the natural key is checked. null = clear the limit.
  shape: z.looseObject({ limit: z.string() }).nullable(),
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const desired = desiredRaw as InteractionLimitsConfig | null;

    if (ctx.check) {
      const live = (await call(ctx, this, ENDPOINTS.get)) as Record<string, unknown>;
      // Declared != effective is drift REGARDLESS of who set the live limit;
      // when an org/user-level limit is the cause, the prose says apply
      // cannot fix it (the org is the place to), but check stays red rather
      // than reporting a repo that does not match its declaration as clean.
      const overridden = !noLiveLimit(live) && overriddenFromAbove(live);
      if (desired === null) {
        if (!noLiveLimit(live)) {
          result.drift.push(
            overridden
              ? `interaction_limits: declared null but a live "${String(live.limit)}" limit is set at the ${String(live.origin)} level; apply cannot remove it from the repository`
              : `interaction_limits: declared null but a live "${String(live.limit)}" limit is set; apply will remove it`,
          );
        }
        return result;
      }
      if (noLiveLimit(live)) {
        result.drift.push(
          `interaction_limits: no live limit (never set, or it expired); apply will (re-)arm the declared "${desired.limit}" limit`,
        );
      } else {
        // The live body carries limit/origin/expires_at but never the
        // declared expiry duration, so diffing expiry would be permanent
        // false drift; compare everything else.
        const { expiry: _expiry, ...comparable } = desired;
        result.drift.push(...subsetDiff(comparable, live, "interaction_limits"));
        if (overridden) {
          result.notes.push(
            `interaction_limits: ${ORG_OVERRIDE} (origin: ${String(live.origin)}); apply cannot change it from the repository`,
          );
        }
      }
      if (desired.expiry !== undefined) {
        result.notes.push(
          `interaction_limits.expiry: GitHub reports only the computed expires_at, so the declared duration cannot be verified; apply re-arms it on every run`,
        );
      }
      return result;
    }

    if (desired === null) {
      const outcome = await tryCall(ctx, this, ENDPOINTS.remove, {
        describe: "clearing the interaction limit",
      });
      if ("error" in outcome) {
        result.notes.push(
          `interaction_limits: ${ORG_OVERRIDE}, so the repository-level clear was not applied (${outcome.error.status})`,
        );
        return result;
      }
      result.changes.push("cleared the interaction limit");
      return result;
    }

    const outcome = await tryCall(ctx, this, ENDPOINTS.put, {
      payload: desired,
      describe: `arming the "${desired.limit}" interaction limit`,
    });
    if ("error" in outcome) {
      result.notes.push(
        `interaction_limits: ${ORG_OVERRIDE}, so the repository-level limit was not applied (${outcome.error.status})`,
      );
      return result;
    }
    result.changes.push(
      `armed the "${desired.limit}" interaction limit (expiry: ${desired.expiry ?? "one_day (GitHub default)"})`,
    );
    return result;
  },
};
