/**
 * `pages:` section - create/update the GitHub Pages site; `pages: null`
 * declares Pages OFF (mirroring branches' `protection: null`).
 */

import { subsetDiff } from "../../engine/diff.js";
import type { EndpointDecl } from "../contract/endpoints.js";
import { beginRun, loosen, type SectionModule, type SectionResult } from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import { call, probeAbsent } from "../contract/requests.js";
import { type PagesConfig, PagesSlice } from "./schema.js";

const permission: SectionPermission = { repo: ["pages"] };

const ENDPOINTS = {
  get: {
    route: "GET /repos/{owner}/{repo}/pages",
    statuses: { 200: "the Pages site", 404: "Pages is not enabled on the repository" },
  },
  create: { route: "POST /repos/{owner}/{repo}/pages", statuses: { 201: "Pages enabled" } },
  update: {
    route: "PUT /repos/{owner}/{repo}/pages",
    statuses: { 204: "Pages configuration updated" },
  },
  remove: { route: "DELETE /repos/{owner}/{repo}/pages", statuses: { 204: "Pages disabled" } },
} as const satisfies Record<string, EndpointDecl>;

/**
 * A Pages source as the API takes it: `path` is REQUIRED on the wire (the
 * update PUT rejects a source without it), where the config leaves it
 * optional. wireSource() is the only mint, so a payload can never carry a
 * pathless source.
 */
type PagesSourceWire = Omit<NonNullable<PagesConfig["source"]>, "path"> & { path: string };

/**
 * Normalize a declared source to the wire form. The update PUT requires
 * path alongside branch when source is sent; the create POST defaults it,
 * so default it everywhere.
 */
function wireSource(source: NonNullable<PagesConfig["source"]>): PagesSourceWire {
  return { ...source, path: source.path ?? "/" };
}

/** The declared config with its source already in the wire form. */
type PagesWirePayload = Omit<PagesConfig, "source"> & { source?: PagesSourceWire };

/**
 * The subset of the payload the create POST accepts; GitHub documents every
 * other field (cname, https_enforced, public) as update-only, so enabling a
 * site is create-then-update. A Pick over the wire payload, so a renamed
 * config field breaks this split at compile time instead of silently
 * rerouting through the wrong endpoint.
 */
type PagesCreateBody = Pick<PagesWirePayload, "build_type" | "source">;

export const pagesSection = {
  key: "pages",
  undeclaredDefault: "untouched",
  permission,
  endpoints: ENDPOINTS,
  // The handler dereferences source.path before the API sees it, so the
  // shape must catch source: null or a source without a branch.
  shape: loosen(PagesSlice),
  async run(ctx, desired): Promise<SectionResult> {
    const run = beginRun(ctx);
    // The probe stays the discriminated union probeAbsent returns; narrowing
    // happens at each use, so "site exists but no body" (or the reverse) is
    // not representable, unlike an exists-boolean beside an optional body.
    const probe = await probeAbsent(ctx, this, ENDPOINTS.get);

    // pages: null declares Pages OFF, mirroring branches' protection: null.
    if (desired === null) {
      if ("missing" in probe) {
        // A 404 here is ambiguous: no Pages site, or a fine-grained token
        // without the Pages permission (which also answers 404). The
        // non-null path stays loud either way (the POST would fail); this
        // no-op path must say so instead of silently succeeding.
        run.result.notes.push(
          "pages: declared null and GitHub reports no Pages site, so there is nothing to disable. A fine-grained token missing the Pages permission gets the same answer; if this repo does have a Pages site, grant the token Pages read and write",
        );
        return run.result;
      }
      if (run.check) {
        run.result.drift.push(
          "pages: enabled live but the settings file declares pages: null; apply will disable GitHub Pages",
        );
        return run.result;
      }
      await call(ctx, this, ENDPOINTS.remove);
      run.result.changes.push("disabled GitHub Pages");
      return run.result;
    }
    if (Object.keys(desired).length === 0) {
      run.result.notes.push(
        "pages: declared as an empty mapping, which configures nothing (the update endpoint rejects an empty body). Declare at least one field, use pages: null to disable the site, or remove the section",
      );
      return run.result;
    }
    // Split the source off so the no-source form never carries a source key
    // at all (an own `source: undefined` would count as a remainder below).
    const { source, ...restConfig } = desired;
    const payload: PagesWirePayload =
      source === undefined ? restConfig : { ...restConfig, source: wireSource(source) };

    if (run.check) {
      if ("missing" in probe) {
        run.result.drift.push(
          "pages: declared in the settings file but GitHub Pages is not enabled on the repo; apply will enable it",
        );
      } else {
        run.result.drift.push(...subsetDiff(payload, probe.data, "pages"));
      }
      return run.result;
    }

    if (!("missing" in probe)) {
      await call(ctx, this, ENDPOINTS.update, { payload });
      run.result.changes.push("updated GitHub Pages configuration");
      return run.result;
    }
    const create: PagesCreateBody = {};
    if (payload.build_type !== undefined) {
      create.build_type = payload.build_type;
    }
    if (payload.source !== undefined) {
      create.source = payload.source;
    }
    await call(ctx, this, ENDPOINTS.create, { payload: create });
    run.result.changes.push("enabled GitHub Pages");
    const rest = Object.keys(payload).filter((k) => !(k in create));
    if (rest.length > 0) {
      await call(ctx, this, ENDPOINTS.update, { payload });
      run.result.changes.push("applied remaining Pages configuration");
    }
    return run.result;
  },
} satisfies SectionModule<"pages">;
