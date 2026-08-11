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
import { phantomKeys, phantomNote, subsetDiff } from "../engine/diff.js";
import type { InteractionLimitsConfig } from "../schema.js";
import {
  call,
  type EndpointDecl,
  emptyResult,
  expand,
  type SectionContext,
  type SectionMeta,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
  tryCall,
} from "./contract.js";

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

/** The keys with their own sub-endpoints, stripped from the base PUT payload. */
const ROUTED_KEYS = new Set<string>(["pull_request_creation_cap", "pull_request_creation_bypass"]);

/** A GET body with no keys means "no limit is currently set". */
function noLiveLimit(live: Record<string, unknown>): boolean {
  return Object.keys(live).length === 0;
}

/** True when the live limit was set above the repository (org or user). */
function overriddenFromAbove(live: Record<string, unknown>): boolean {
  return live.origin !== undefined && String(live.origin).toLowerCase() !== "repository";
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
 * The live bypass-list logins. A single GET, not listAll(): the endpoint
 * documents no pagination parameters (the list holds at most 100 users), so
 * a page loop would re-request the same full body forever on a
 * page-ignoring endpoint.
 */
async function liveBypassLogins(ctx: SectionContext, section: SectionMeta): Promise<string[]> {
  const live = await call(ctx, section, ENDPOINTS.bypassList);
  if (!Array.isArray(live)) {
    throw new Error(
      `${section.key}: GET ${expand(ENDPOINTS.bypassList, ctx)} was expected to return a list of users but returned ${(JSON.stringify(live) ?? String(live)).slice(0, 200)}. Check the "api-version" input against the GitHub REST docs for this endpoint`,
    );
  }
  return live.map((user) => String((user as Record<string, unknown>).login));
}

export const interactionLimitsSection: SectionModule<"interaction_limits"> = {
  key: "interaction_limits",
  undeclaredDefault: "untouched",
  permission,
  endpoints: ENDPOINTS,
  // Loose on purpose: the base PUT forwards the object verbatim minus the
  // two routed keys, so future fields ride along; only the natural keys are
  // checked. null = clear the base limit (the routed resources untouched).
  shape: z
    .looseObject({
      limit: z.string().optional(),
      // The cap object IS the PATCH body, loose so future fields ride it;
      // the flag is typed so a YAML-quoted "true" fails upfront in document
      // validation, before any section writes (the branches precedent).
      pull_request_creation_cap: z
        .looseObject({
          enabled: z.boolean({
            error:
              'enabled must be an unquoted true or false (YAML parses "no"/"off"/"yes" as strings, not booleans), so the cap direction is unambiguous',
          }),
          max_open_pull_requests: z.number().optional(),
        })
        .optional(),
      pull_request_creation_bypass: z.array(z.string()).optional(),
    })
    .superRefine((declared, refineCtx) => {
      // Rejected here, in the shape, so upfront document validation fails
      // the run in BOTH modes before ANY section writes (the actions
      // precedent). Base keys are read off the parsed record because the
      // object is loose passthrough.
      const record = declared as Record<string, unknown>;
      const baseKeys = Object.keys(record).filter((key) => !ROUTED_KEYS.has(key));
      if (
        baseKeys.length === 0 &&
        record.pull_request_creation_cap === undefined &&
        record.pull_request_creation_bypass === undefined
      ) {
        refineCtx.addIssue({
          code: "custom",
          message:
            "declare at least one of limit, pull_request_creation_cap, or pull_request_creation_bypass (or declare interaction_limits: null to clear the base limit)",
        });
      }
      if (baseKeys.length > 0 && record.limit === undefined) {
        // Base keys ride the base PUT, whose body GitHub rejects without a
        // limit - and a run that never issues the PUT would silently drop
        // them; reject the contradiction upfront instead.
        refineCtx.addIssue({
          code: "custom",
          path: ["limit"],
          message: `key(s) [${baseKeys.join(", ")}] ride the base interaction-limits PUT, which requires a limit; declare limit alongside them, or remove them`,
        });
      }
      const bypass = record.pull_request_creation_bypass;
      if (!Array.isArray(bypass)) {
        return;
      }
      if (bypass.length > 100) {
        // 100 is what makes single-request reconciliation valid (the writes
        // take at most 100 users per request), not just value validation:
        // GitHub also caps the list itself at 100.
        refineCtx.addIssue({
          code: "custom",
          path: ["pull_request_creation_bypass"],
          message: `GitHub caps the bypass list at 100 users, but ${bypass.length} logins are declared; trim the list`,
        });
      }
      // Logins are case-insensitive on GitHub, so two spellings of one login
      // would fight each other on every run instead of converging.
      const seen = new Map<string, string>();
      for (const login of bypass as string[]) {
        const key = login.toLowerCase();
        const first = seen.get(key);
        if (first === undefined) {
          seen.set(key, login);
        } else {
          refineCtx.addIssue({
            code: "custom",
            path: ["pull_request_creation_bypass"],
            message: `"${first}" and "${login}" name the same login (logins are case-insensitive); keep exactly one`,
          });
        }
      }
    })
    .nullable(),
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const desired = desiredRaw as InteractionLimitsConfig | null;

    if (desired === null) {
      // null clears the BASE limit only; the cap and bypass list are
      // separate resources a clear must not touch.
      if (ctx.check) {
        const live = (await call(ctx, this, ENDPOINTS.get)) as Record<string, unknown>;
        if (!noLiveLimit(live)) {
          result.drift.push(
            overriddenFromAbove(live)
              ? `interaction_limits: declared null but a live "${String(live.limit)}" limit is set at the ${String(live.origin)} level; apply cannot remove it from the repository`
              : `interaction_limits: declared null but a live "${String(live.limit)}" limit is set; apply will remove it`,
          );
        }
        return result;
      }
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

    const cap = desired.pull_request_creation_cap;
    const bypass = desired.pull_request_creation_bypass;
    const base = Object.fromEntries(
      Object.entries(desired as Record<string, unknown>).filter(([key]) => !ROUTED_KEYS.has(key)),
    );
    const baseDeclared = Object.keys(base).length > 0;

    if (ctx.check) {
      if (baseDeclared) {
        const live = (await call(ctx, this, ENDPOINTS.get)) as Record<string, unknown>;
        // Declared != effective is drift REGARDLESS of who set the live limit;
        // when an org/user-level limit is the cause, the prose says apply
        // cannot fix it (the org is the place to), but check stays red rather
        // than reporting a repo that does not match its declaration as clean.
        if (noLiveLimit(live)) {
          result.drift.push(
            `interaction_limits: no live limit (never set, or it expired); apply will (re-)arm the declared "${desired.limit}" limit`,
          );
        } else {
          // The live body carries limit/origin/expires_at but never the
          // declared expiry duration, so diffing expiry would be permanent
          // false drift; compare everything else.
          const { expiry: _expiry, ...comparable } = base;
          result.drift.push(...subsetDiff(comparable, live, "interaction_limits"));
          if (overriddenFromAbove(live)) {
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
      }
      if (cap !== undefined) {
        const outcome = await tryCall(ctx, this, ENDPOINTS.capGet, {
          describe: "reading the pull request creation cap",
        });
        if ("error" in outcome) {
          // A tolerated 405: the declared cap cannot exist live, and apply
          // could not set it either - honest drift, not silence.
          result.drift.push(
            `interaction_limits.pull_request_creation_cap: declared but ${CAP_UNAVAILABLE} (405); apply cannot set it`,
          );
        } else {
          result.drift.push(
            ...subsetDiff(cap, outcome.data, "interaction_limits.pull_request_creation_cap"),
          );
        }
      }
      if (bypass !== undefined) {
        const liveLogins = await liveBypassLogins(ctx, this);
        const { add, remove } = bypassDelta(bypass, liveLogins);
        if (remove.length > 0) {
          result.drift.push(
            `interaction_limits.pull_request_creation_bypass: live login(s) [${remove.join(", ")}] are not declared; apply will remove them`,
          );
        }
        if (add.length > 0) {
          result.drift.push(
            `interaction_limits.pull_request_creation_bypass: declared login(s) [${add.join(", ")}] are not on the live bypass list; apply will add them`,
          );
        }
      }
      return result;
    }

    if (baseDeclared) {
      const outcome = await tryCall(ctx, this, ENDPOINTS.put, {
        payload: base,
        describe: `arming the "${desired.limit}" interaction limit`,
      });
      if ("error" in outcome) {
        result.notes.push(
          `interaction_limits: ${ORG_OVERRIDE}, so the repository-level limit was not applied (${outcome.error.status})`,
        );
      } else {
        result.changes.push(
          `armed the "${desired.limit}" interaction limit (expiry: ${desired.expiry ?? "one_day (GitHub default)"})`,
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
        result.notes.push(
          `interaction_limits.pull_request_creation_cap: ${CAP_UNAVAILABLE}, so the declared cap was not applied (${outcome.error.status})`,
        );
      } else {
        // The cap object is loose passthrough and the PATCH is diff-gated, so
        // a declared key GitHub ignores would re-PATCH on every apply without
        // converging; say so (the labels/milestones phantom-key idiom).
        const phantom = phantomKeys(cap as Record<string, unknown>, outcome.data);
        if (phantom.length > 0) {
          result.notes.push(
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
            result.notes.push(
              `interaction_limits.pull_request_creation_cap: ${CAP_UNAVAILABLE}, so the declared cap was not applied (${patched.error.status})`,
            );
          } else {
            result.changes.push(
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
        result.changes.push(
          `removed [${remove.join(", ")}] from the pull request creation cap bypass list`,
        );
      }
      if (add.length > 0) {
        await call(ctx, this, ENDPOINTS.bypassAdd, {
          payload: { users: add },
          describe: "adding users to the pull request creation cap bypass list",
        });
        result.changes.push(
          `added [${add.join(", ")}] to the pull request creation cap bypass list`,
        );
      }
    }
    return result;
  },
};
