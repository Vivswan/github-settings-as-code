/**
 * This fragment imports test-tree seams on purpose: the bundle entry is src/main.ts, so it never
 * reaches lib/index.js. custom_pattern_version is real optimistic concurrency here, so a section that
 * reuses a version across writes fails a single-threaded e2e run instead of only failing against real GitHub.
 *
 * create or update               -> mints a fresh version
 * stale version on a write       -> 412
 * PATCH version: null            -> accepted (the key is required but nullable upstream)
 * DELETE entry without a version -> accepted (optional upstream)
 */

import {
  asObject,
  type Json,
  mintSecretScanningVersion,
  noContent,
  ok,
  SECRET_SCANNING_STALE_VERSION,
  SECRET_SCANNING_UPDATABLE_KEYS,
  type SectionRestHandlers,
  secretScanningPatternFromCreate,
  slicePage,
} from "../../../test/e2e/mock/support.js";

export const secretScanningCustomPatternsMockHandlers: SectionRestHandlers<"secret_scanning_custom_patterns"> =
  {
    "secret_scanning_custom_patterns.list": ({ state, query }) =>
      ok(slicePage(state.secret_scanning_patterns, query)),
    "secret_scanning_custom_patterns.create": ({ state, body }) => {
      const patterns = asObject(body).patterns;
      // An empty or missing patterns array is GitHub's documented 422. A MISSING one is also how a
      // body that never made it onto the wire looks, so this arm staying cold in the curated
      // scenarios proves the bulk POST body transmits.
      if (!Array.isArray(patterns) || patterns.length === 0) {
        return {
          status: 422,
          body: { message: "Validation failed: no patterns provided", validation_errors: {} },
        };
      }
      const created: Json[] = [];
      for (const [index, entry] of patterns.entries()) {
        const payload = asObject(entry);
        const name = String(payload.name ?? "");
        const duplicate =
          state.secret_scanning_patterns.some((p) => p.name === name) ||
          created.some((p) => p.name === name);
        if (duplicate) {
          // A duplicate name answers GitHub's per-index validation_errors map; nothing is created.
          return {
            status: 422,
            body: {
              message: "Validation failed for one or more patterns",
              validation_errors: {
                [String(index)]: {
                  errors: [{ code: "name", message: `A pattern named "${name}" already exists` }],
                },
              },
            },
          };
        }
        created.push(secretScanningPatternFromCreate(state, payload));
      }
      state.secret_scanning_patterns.push(...created);
      return { status: 201, body: { created_patterns: created } };
    },
    "secret_scanning_custom_patterns.update": ({ state, param, body }) => {
      const id = param("pattern_id");
      const pattern = state.secret_scanning_patterns.find((p) => String(p.id) === id);
      if (!pattern) {
        // Existence first, like GitHub: an unknown id 404s before the version is even compared.
        return { status: 404, body: { message: "Not Found" } };
      }
      const payload = asObject(body);
      // A null version skips the concurrency check (the key is required but nullable); a present
      // string must match the stored one.
      if (
        payload.custom_pattern_version !== null &&
        payload.custom_pattern_version !== pattern.custom_pattern_version
      ) {
        return SECRET_SCANNING_STALE_VERSION;
      }
      // The request schema's anyOf requires at least one updatable field alongside the version, so
      // a regression that stops sending fields fails e2e loudly with GitHub's 422.
      if (!SECRET_SCANNING_UPDATABLE_KEYS.some((key) => payload[key] !== undefined)) {
        return {
          status: 422,
          body: { message: "Validation failed: at least one updatable field must be provided" },
        };
      }
      for (const key of SECRET_SCANNING_UPDATABLE_KEYS) {
        if (payload[key] !== undefined) {
          pattern[key] = payload[key];
        }
      }
      pattern.custom_pattern_version = mintSecretScanningVersion(state);
      pattern.updated_at = "2026-07-02T00:00:00Z";
      return ok(pattern);
    },
    "secret_scanning_custom_patterns.remove": ({ state, body }) => {
      const payload = asObject(body);
      const entries = payload.patterns;
      if (!Array.isArray(entries) || entries.length === 0) {
        // The spec marks the body and its patterns list required; a missing list is also what a
        // DELETE whose body never transmitted looks like, so this arm is the loud tripwire for that.
        return { status: 400, body: { message: "Bad Request: no patterns provided" } };
      }
      const action = payload.post_delete_action;
      if (action !== undefined && action !== "delete_alerts" && action !== "resolve_alerts") {
        return {
          status: 400,
          body: { message: `Bad Request: unknown post_delete_action "${String(action)}"` },
        };
      }
      // Every entry is resolved and version-checked before ANY is deleted, so a stale version can
      // never half-delete the batch: GitHub documents the 412 for the operation, not per pattern.
      const targets: Json[] = [];
      for (const entry of entries) {
        const request = asObject(entry);
        const pattern = state.secret_scanning_patterns.find(
          (p) => String(p.id) === String(request.pattern_id),
        );
        if (!pattern) {
          return { status: 404, body: { message: "Not Found" } };
        }
        if (
          request.custom_pattern_version !== undefined &&
          request.custom_pattern_version !== pattern.custom_pattern_version
        ) {
          return SECRET_SCANNING_STALE_VERSION;
        }
        targets.push(pattern);
      }
      state.secret_scanning_patterns = state.secret_scanning_patterns.filter(
        (p) => !targets.includes(p),
      );
      return noContent();
    },
  };
