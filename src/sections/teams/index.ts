/**
 * `teams:` section - team repository access, organization repos only; on a personal account the
 * section no-ops with a note. Each declared team is probed and granted only when its access diverges.
 */

import { z } from "zod";
import type { EndpointDecl } from "../contract/endpoints.js";
import { parseLive } from "../contract/live.js";
import { loosen, type SectionModule } from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import type { PlannedOp, SectionPlan } from "../contract/plan.js";
import { rejectDuplicates } from "../contract/requests.js";
import { DEFAULT_ROLE, roleForPermission } from "../shared/roles.js";
import { TeamsConfig } from "./schema.js";

const permission: SectionPermission = { repo: ["administration"], org: "members" };

const ENDPOINTS = {
  // GET /orgs/{org} is public, so it needs no token permission; its 404 is the personal-account no-op.
  org: {
    route: "GET /orgs/{org}",
    statuses: { 200: "the organization", 404: "not an organization (a personal account)" },
    permission: "none",
    primaryRead: { notFound: "absent" },
  },
  probe: {
    route: "GET /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}",
    statuses: { 200: "the team's access to the repository", 404: "the team has no access" },
  },
  grant: {
    route: "PUT /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}",
    statuses: { 204: "team access granted" },
  },
} as const satisfies Record<string, EndpointDecl>;

/**
 * The probe body under the repository media type: the repo object, of which this section reads
 * role_name (optional, so a body without one reads as no role). Nullish, because a server
 * ignoring the media type answers a bare 204, which still means "the team has access".
 */
const LiveTeamRepo = z.looseObject({ role_name: z.string().optional() }).nullish();

export const teamsSection = {
  key: "teams",
  undeclaredDefault: "untouched",
  permission,
  // Teams exist only under an organization owner; the org probe below
  // implements the personal-account no-op this declares.
  ownerSensitivity: "org",
  endpoints: ENDPOINTS,
  shape: loosen(TeamsConfig),
  // Closed surface: the grant PUT accepts exactly one setting ("permission"), so an extra key is
  // always a typo - and a misspelled "permission" would silently grant the default role and report clean.
  closedSurface: {
    known: { name: true, permission: true },
    describe: (t) => t.name,
    consequence: `a misspelled "permission" key would silently grant the default "${DEFAULT_ROLE}" role instead of the intended one`,
  },
  async plan(ctx, desired) {
    rejectDuplicates(
      this,
      desired,
      (t) => t.name.toLowerCase(),
      (t) => t.name,
    );
    const plan: SectionPlan<PlannedOp<typeof ENDPOINTS>> = { ops: [], notes: [], drift: [] };
    // Teams only exist on organization repos; on a personal account the org endpoints 404, so probe
    // once and no-op with a note instead of failing (403/5xx still classify through probeAbsent).
    const orgProbe = await ctx.read.org.probeAbsent({ params: { org: ctx.repo.owner } });
    if ("missing" in orgProbe) {
      plan.notes.push(
        `teams: owner "${ctx.repo.owner}" is a personal account, not an organization, so team access does not apply; section skipped - remove the teams section from the settings file to silence this note`,
      );
      return plan;
    }
    for (const team of desired) {
      const role = team.permission ?? DEFAULT_ROLE;
      const params = { org: ctx.repo.owner, team_slug: team.name };
      // The repository media type makes this endpoint return the repo object (with role_name) instead of 204.
      const probe = await ctx.read.probe.probeAbsent({
        params,
        accept: "application/vnd.github.v3.repository+json",
      });
      const wantRole = roleForPermission(role);
      let drift: string;
      if ("missing" in probe) {
        drift = `teams[${team.name}]: no access to ${ctx.repo.slug}; apply will grant "${role}"`;
      } else {
        const live = parseLive(
          this,
          ENDPOINTS.probe,
          LiveTeamRepo,
          probe.data,
          `team "${team.name}"`,
        );
        const liveRole = live?.role_name ?? "";
        if (liveRole === wantRole) {
          continue;
        }
        drift = `teams[${team.name}]: live role "${liveRole}" != declared "${wantRole}"; apply will set the declared permission`;
      }
      plan.ops.push({
        role: "grant",
        params,
        payload: { permission: role },
        describe: `granting team "${team.name}" access`,
        drift: [drift],
        change: `granted team "${team.name}" ${role}`,
      });
    }
    return plan;
  },
} satisfies SectionModule<"teams", typeof ENDPOINTS>;
