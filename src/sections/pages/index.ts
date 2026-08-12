/**
 * `pages:` section - create/update the GitHub Pages site; `pages: null`
 * declares Pages OFF (mirroring branches' `protection: null`).
 */

import { subsetDiff } from "../../engine/diff.js";
import { SettingsFile } from "../../schema.js";
import {
  beginRun,
  call,
  type EndpointDecl,
  loosen,
  probeAbsent,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
} from "../contract.js";

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

export const pagesSection = {
  key: "pages",
  undeclaredDefault: "untouched",
  permission,
  endpoints: ENDPOINTS,
  // The handler dereferences source.path before the API sees it, so the
  // shape must catch source: null or a source without a branch.
  shape: loosen(SettingsFile.shape.pages),
  async run(ctx, desired): Promise<SectionResult> {
    const run = beginRun(ctx);
    const probe = await probeAbsent(ctx, this, ENDPOINTS.get);
    const exists = !("missing" in probe);
    const liveSite = "data" in probe ? probe.data : undefined;

    // pages: null declares Pages OFF, mirroring branches' protection: null.
    if (desired === null) {
      if (!exists) {
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
    // The update PUT requires path alongside branch when source is sent;
    // the create POST defaults it, so default it everywhere.
    const payload: Record<string, unknown> = { ...desired };
    if (desired.source !== undefined && desired.source.path === undefined) {
      payload.source = { ...desired.source, path: "/" };
    }

    if (run.check) {
      if (!exists) {
        run.result.drift.push(
          "pages: declared in the settings file but GitHub Pages is not enabled on the repo; apply will enable it",
        );
      } else {
        run.result.drift.push(...subsetDiff(payload, liveSite, "pages"));
      }
      return run.result;
    }

    if (exists) {
      await call(ctx, this, ENDPOINTS.update, { payload });
      run.result.changes.push("updated GitHub Pages configuration");
      return run.result;
    }
    // The create endpoint accepts only build_type/source; cname and the
    // rest are update-only, so create first, then PUT the remainder.
    const create: Record<string, unknown> = {};
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
