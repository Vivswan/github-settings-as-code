/**
 * `milestones:` section: upsert by title. Undeclared milestones are kept by default, unlike Probot:
 * deleting a milestone detaches it from every issue carrying it.
 */

import { z } from "zod";
import type { EndpointDecl } from "../contract/endpoints.js";
import {
  exactName,
  type ListComparable,
  type ListWrite,
  listSection,
} from "../shared/list-section.js";
import { MilestoneConfig } from "./schema.js";

/**
 * GitHub keeps only the day of a due_on, read off the sent instant in US Pacific, and echoes it as that
 * day's Pacific midnight (07:00Z or 08:00Z): a UTC midnight lands on the previous day, and only a
 * Pacific-midnight timestamp reads back verbatim. Both lens sides spell the day as noon UTC, which
 * GitHub stores on the same day in either DST state, so the write is what a converged milestone reads back as.
 */
declare const milestoneDueOn: unique symbol;
type DueOnWire = string & { readonly [milestoneDueOn]: true };

/** `dueOn` is a day or an ISO 8601 UTC timestamp (the schema and LiveMilestone admit nothing else). */
export function dueOnWire(dueOn: string): DueOnWire {
  return `${dueOn.slice(0, 10)}T12:00:00Z` as DueOnWire;
}

type MilestoneWrite = ListWrite<"title"> & { readonly due_on?: DueOnWire };

type MilestoneComparable = ListComparable<"title"> & { readonly due_on: DueOnWire | null };

const LiveMilestone = z.looseObject({
  number: z.number(),
  title: z.string(),
  due_on: z.iso.datetime().nullable(),
});

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
    toWrite: ({ due_on, ...rest }): MilestoneWrite =>
      due_on === undefined ? rest : { ...rest, due_on: dueOnWire(due_on) },
    fromLive: (live): MilestoneComparable => ({
      ...live,
      due_on: live.due_on === null ? null : dueOnWire(live.due_on),
    }),
    matchBy: {},
  },
  replaces: false,
  prose: {
    undeclaredAction: DETACH_ACTION,
    undeclaredNote: {
      action: `${DETACH_ACTION} (closing is not enough; closed milestones are still listed)`,
    },
  },
});
