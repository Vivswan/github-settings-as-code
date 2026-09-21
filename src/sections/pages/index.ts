import { z } from "zod";
import { phantomKeys, phantomNote, subsetDiff } from "../../engine/diff.js";
import type { EndpointDecl } from "../contract/endpoints.js";
import { loosen, type SectionModule, type SectionSnapshot } from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import { hasDrift, type PlannedOp, plainData, type SectionPlan } from "../contract/plan.js";
import { projectOntoSchema } from "../shared/snapshot-helpers.js";
import { PAGES_SITE_SHAPE, PagesConfig } from "./schema.js";

const permission: SectionPermission = { repo: ["pages"] };

const ENDPOINTS = {
  get: {
    route: "GET /repos/{owner}/{repo}/pages",
    statuses: { 200: "the Pages site", 404: "Pages is not enabled on the repository" },
    primaryRead: { notFound: "absent" },
  },
  create: { route: "POST /repos/{owner}/{repo}/pages", statuses: { 201: "Pages enabled" } },
  update: {
    route: "PUT /repos/{owner}/{repo}/pages",
    statuses: { 204: "Pages configuration updated" },
  },
  remove: { route: "DELETE /repos/{owner}/{repo}/pages", statuses: { 204: "Pages disabled" } },
} as const satisfies Record<string, EndpointDecl>;

type PagesSite = NonNullable<PagesConfig>;

/**
 * `path` is REQUIRED on the wire (the update PUT rejects a source without it) where the config
 * leaves it optional; wireSource() is the only mint, so no payload can carry a pathless source.
 */
type PagesSourceWire = Omit<NonNullable<PagesSite["source"]>, "path"> & { path: string };

/** The update PUT requires path alongside branch and the create POST defaults it, so it is defaulted everywhere. */
function wireSource(source: NonNullable<PagesSite["source"]>): PagesSourceWire {
  return { ...source, path: source.path ?? "/" };
}

type PagesWirePayload = Omit<PagesSite, "source"> & { source?: PagesSourceWire };

/**
 * GitHub documents every field but build_type and source as update-only, so enabling a site is
 * create-then-update. A Pick over the wire payload, so a renamed config field breaks this split at
 * compile time instead of silently rerouting through the wrong endpoint.
 */
type PagesCreateBody = Pick<PagesWirePayload, "build_type" | "source">;

/**
 * The site body must be a mapping: PagesConfig accepts null (the declared "Pages off"), so a null 200
 * would otherwise read back as a declaration that DISABLES the site.
 */
const LiveSite = z.looseObject({});

/**
 * A note, not a parse error: nothing in the file tells an Enterprise Cloud organization from github.com,
 * where GitHub reports `public: true` and drops the field from the update. Only that signature (live
 * true, declared false) earns it: a live non-public site proves the host supports visibility, so the
 * PUT can make it public and the drift is ordinary.
 */
const PUBLIC_VISIBILITY_NOTE =
  "pages.public: site visibility is settable only for organizations on GitHub Enterprise Cloud; " +
  "elsewhere GitHub reports public: true and ignores the field on the update, so this drift never " +
  "converges. Remove pages.public unless the repository belongs to an Enterprise Cloud organization";

export const pagesSection = {
  key: "pages",
  undeclaredDefault: "untouched",
  permission,
  endpoints: ENDPOINTS,
  // The handler dereferences source.path before the API sees it, so the shape must catch
  // source: null or a source without a branch.
  shape: loosen(PagesConfig),
  async plan(ctx, desired) {
    const plan: SectionPlan<PlannedOp<typeof ENDPOINTS>> = { ops: [], notes: [], drift: [] };
    return ctx.read.get.probeAbsent(LiveSite).map((probe) => {
      if (desired === null) {
        if ("missing" in probe) {
          // A 404 is ambiguous: no Pages site, or a fine-grained token without the Pages permission.
          // The non-null path stays loud either way (the POST would fail); this no-op path must say so.
          plan.notes.push(
            "pages: declared null and GitHub reports no Pages site, so there is nothing to disable. A fine-grained token missing the Pages permission gets the same answer; if this repo does have a Pages site, grant the token Pages read and write",
          );
          return plan;
        }
        plan.ops.push({
          role: "remove",
          drift: [
            "pages: enabled live but the settings file declares pages: null; apply will disable GitHub Pages",
          ],
          change: "disabled GitHub Pages",
        });
        return plan;
      }
      if (Object.keys(desired).length === 0) {
        plan.notes.push(
          "pages: declared as an empty mapping, which configures nothing (the update endpoint rejects an empty body). Declare at least one field, use pages: null to disable the site, or remove the section",
        );
        return plan;
      }
      // The source is split off so the no-source form never carries a source key at all: an own
      // `source: undefined` would count as a remainder below.
      const { source, ...restConfig } = desired;
      const payload: PagesWirePayload =
        source === undefined ? restConfig : { ...restConfig, source: wireSource(source) };

      if (!("missing" in probe)) {
        // The site mapping passes unknown keys through, so a key the GET never echoes would re-PUT on
        // every apply without converging; the note names it beside the drift it causes. A site key the
        // GET omits (https_enforced on a site created without it) is drift the PUT resolves, so only a
        // key outside the site shape is noted.
        const phantom = phantomKeys(payload, probe.data).filter(
          (name) => !Object.hasOwn(PAGES_SITE_SHAPE, name),
        );
        if (phantom.length > 0) {
          plan.notes.push(phantomNote("pages", phantom, "Pages site", "this PUT will re-run"));
        }
        const drift = subsetDiff(payload, probe.data, "pages");
        if (hasDrift(drift)) {
          plan.ops.push({
            role: "update",
            payload: plainData(payload),
            drift,
            change: "updated GitHub Pages configuration",
          });
          if (payload.public === false && probe.data.public === true) {
            plan.notes.push(PUBLIC_VISIBILITY_NOTE);
          }
        }
        return plan;
      }
      const create: PagesCreateBody = {};
      if (payload.build_type !== undefined) {
        create.build_type = payload.build_type;
      }
      if (payload.source !== undefined) {
        create.source = payload.source;
      }
      plan.ops.push({
        role: "create",
        payload: plainData(create),
        drift: [
          "pages: declared in the settings file but GitHub Pages is not enabled on the repo; apply will enable it",
        ],
        change: "enabled GitHub Pages",
      });
      const rest = Object.keys(payload).filter((k) => !Object.hasOwn(create, k));
      if (rest.length > 0) {
        plan.ops.push({
          role: "update",
          payload: plainData(payload),
          drift: [
            `pages: the create call takes only build_type and source, so apply will then set the remaining configuration (${rest.join(", ")})`,
          ],
          change: "applied remaining Pages configuration",
        });
      }
      return plan;
    });
  },
  // No site is nothing to declare (not `pages: null`, which would DISABLE Pages on apply); the
  // engine notes the 404's other reading (a token without the Pages grant).
  async snapshot(ctx) {
    return ctx.read.get
      .probeAbsent(LiveSite)
      .map(
        (probe): SectionSnapshot<"pages"> =>
          "missing" in probe
            ? { value: undefined, notes: [] }
            : { value: projectOntoSchema(PagesConfig, probe.data), notes: [] },
      );
  },
} satisfies SectionModule<"pages", typeof ENDPOINTS>;
