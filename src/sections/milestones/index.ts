/**
 * `milestones:` section: upsert by title. Undeclared milestones are kept by default, unlike Probot:
 * deleting a milestone detaches it from every issue carrying it.
 */

import { z } from "zod";
import type { EndpointDecl } from "../contract/endpoints.js";
import { exactName, listSection } from "../shared/list-section.js";
import { MilestoneConfig } from "./schema.js";

const LiveMilestone = z.looseObject({ number: z.number(), title: z.string() });

const ENDPOINTS = {
  list: {
    route: "GET /repos/{owner}/{repo}/milestones",
    statuses: { 200: "the milestone list" },
    primaryRead: { notFound: "denied" },
  },
  create: {
    route: "POST /repos/{owner}/{repo}/milestones",
    statuses: { 201: "milestone created" },
  },
  update: {
    route: "PATCH /repos/{owner}/{repo}/milestones/{milestone_number}",
    statuses: { 200: "milestone updated" },
  },
  remove: {
    route: "DELETE /repos/{owner}/{repo}/milestones/{milestone_number}",
    statuses: { 204: "milestone deleted" },
  },
} as const satisfies Record<string, EndpointDecl>;

/** Deleting a milestone detaches it from its issues; every undeclared-delete line says so. */
const DETACH_ACTION = "DELETE it, detaching it from every issue that carries it";

export const milestonesSection = listSection({
  key: "milestones",
  permission: { repo: ["issues"] },
  undeclaredDefault: "keep",
  noun: "milestone",
  entry: MilestoneConfig,
  live: LiveMilestone,
  endpoints: ENDPOINTS,
  // The default listing omits closed milestones, so a declared closed one would read as missing.
  listing: { query: { state: "all" } },
  identity: { field: "title", fold: exactName },
  address: (live) => ({ milestone_number: String(live.number) }),
  lens: {
    toWrite: (milestone) => ({ ...milestone }),
    fromLive: (live) => live,
    matchBy: {},
  },
  prose: {
    undeclaredAction: DETACH_ACTION,
    undeclaredNote: {
      action: `${DETACH_ACTION} (closing is not enough; closed milestones are still listed)`,
    },
  },
});
