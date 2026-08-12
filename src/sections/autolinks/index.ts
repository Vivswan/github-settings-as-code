/**
 * `autolinks:` section - autolinks cannot be edited, so a changed one is
 * deleted and recreated. Undeclared autolinks are DELETED by default; the
 * wrapped `undeclared: keep` form softens that to notes.
 */

import { z } from "zod";
import { phantomKeys, phantomNote, subsetDiff } from "../../engine/diff.js";
import type { EndpointDecl } from "../contract/endpoints.js";
import { parseLive } from "../contract/live.js";
import {
  beginRun,
  defaultUndeclaredPolicy,
  loosen,
  type SectionModule,
  type SectionResult,
  undeclaredDrift,
  undeclaredNote,
  undeclaredPolicy,
} from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import { call, rejectDuplicates } from "../contract/requests.js";
import { knobbed } from "../shared/schema-helpers.js";
import { AutolinkConfig } from "./schema.js";

/** The fields of a live autolink this section reads; extras ride along. */
const LiveAutolink = z.looseObject({ id: z.number(), key_prefix: z.string() });

const permission: SectionPermission = { repo: ["administration"] };

const ENDPOINTS = {
  list: { route: "GET /repos/{owner}/{repo}/autolinks", statuses: { 200: "the autolink list" } },
  create: { route: "POST /repos/{owner}/{repo}/autolinks", statuses: { 201: "autolink created" } },
  remove: {
    route: "DELETE /repos/{owner}/{repo}/autolinks/{autolink_id}",
    statuses: { 204: "autolink deleted" },
  },
} as const satisfies Record<string, EndpointDecl>;

export const autolinksSection = {
  key: "autolinks",
  undeclaredDefault: "delete",
  permission,
  endpoints: ENDPOINTS,
  shape: loosen(knobbed(AutolinkConfig)),
  async run(ctx, declared): Promise<SectionResult> {
    const run = beginRun(ctx);
    const { policy, entries: desired } = undeclaredPolicy(declared, defaultUndeclaredPolicy(this));
    rejectDuplicates(
      this,
      desired,
      (a) => a.key_prefix,
      (a) => a.key_prefix,
    );
    // The autolinks list endpoint is not paginated; a single GET returns
    // everything, and sending page params would not advance anything.
    const live = parseLive(
      this,
      ENDPOINTS.list,
      z.array(LiveAutolink),
      await call(ctx, this, ENDPOINTS.list),
    );
    const liveByPrefix = new Map(live.map((a) => [a.key_prefix, a]));
    const declaredKeys = new Set<string>();

    for (const autolink of desired) {
      declaredKeys.add(autolink.key_prefix);
      const existing = liveByPrefix.get(autolink.key_prefix);
      const { key_prefix: _kp, ...declaredFields } = autolink;
      const matches =
        existing !== undefined && subsetDiff(declaredFields, existing, "autolink").length === 0;
      if (matches) {
        continue;
      }
      if (run.check) {
        if (existing) {
          run.result.drift.push(
            `autolinks[${autolink.key_prefix}]: live settings differ from the settings file, and autolinks cannot be edited; apply will delete and recreate it`,
          );
          // Name the differing fields; the generic line alone left the reader
          // guessing which key (or typo) forces the replace.
          run.result.drift.push(
            ...subsetDiff(declaredFields, existing, `autolinks[${autolink.key_prefix}]`),
          );
        } else {
          run.result.drift.push(
            `autolinks[${autolink.key_prefix}]: missing - declared in the settings file but not on the repo; apply will create it`,
          );
        }
        continue;
      }
      if (existing) {
        const phantom = phantomKeys(declaredFields, existing);
        if (phantom.length > 0) {
          run.result.notes.push(
            phantomNote(
              `autolinks[${autolink.key_prefix}]`,
              phantom,
              "autolink",
              "this delete-and-recreate will repeat",
            ),
          );
        }
        // Autolinks have no update endpoint; replace.
        await call(ctx, this, ENDPOINTS.remove, { params: { autolink_id: String(existing.id) } });
      }
      await call(ctx, this, ENDPOINTS.create, {
        payload: {
          is_alphanumeric: true,
          ...autolink, // declared keys (including future ones) pass through
        },
      });
      run.result.changes.push(
        `${existing ? "replaced" : "created"} autolink ${autolink.key_prefix}`,
      );
    }

    for (const autolink of live) {
      if (declaredKeys.has(autolink.key_prefix)) {
        continue;
      }
      if (policy === "keep") {
        run.result.notes.push(
          undeclaredNote({ subject: `autolink ${autolink.key_prefix}`, action: "DELETE it" }),
        );
      } else if (run.check) {
        run.result.drift.push(
          undeclaredDrift(defaultUndeclaredPolicy(this), {
            label: `autolinks[${autolink.key_prefix}]`,
            action: "DELETE it",
          }),
        );
      } else {
        await call(ctx, this, ENDPOINTS.remove, { params: { autolink_id: String(autolink.id) } });
        run.result.changes.push(`DELETED undeclared autolink ${autolink.key_prefix}`);
      }
    }
    return run.result;
  },
} satisfies SectionModule<"autolinks">;
