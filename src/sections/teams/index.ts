/** `teams:` section: team repository access. Organization repos only, so a personal account no-ops with a note. */

import { z } from "zod";
import type { EndpointDecl } from "../contract/endpoints.js";
import { parseLive } from "../contract/live.js";
import { loosen, type SectionMeta, type SectionModule, sectionGrant } from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import type { PlanContext, PlannedOp, SectionPlan } from "../contract/plan.js";
import { rejectDuplicates } from "../contract/requests.js";
import { DEFAULT_ROLE, permissionForRole, roleForPermission } from "../shared/roles.js";
import { type TeamConfig, TeamsConfig } from "./schema.js";

const permission: SectionPermission = { repo: ["administration"], org: "members" };

const ENDPOINTS = {
  // GET /orgs/{org} is public, so no token permission; its 404 is the personal-account no-op.
  org: {
    route: "GET /orgs/{org}",
    statuses: { 200: "the organization", 404: "not an organization (a personal account)" },
    permission: "none",
    primaryRead: { notFound: "absent" },
  },
  list: {
    route: "GET /repos/{owner}/{repo}/teams",
    statuses: { 200: "the teams with access to the repository" },
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

type TeamsContext = PlanContext<typeof ENDPOINTS>;

// The repo object under the repository media type, of which only role_name is read. Nullish,
// because a server ignoring the media type answers a bare 204, which still means "the team has access".
const LiveTeamRepo = z.looseObject({ role_name: z.string().optional() }).nullish();

/**
 * A listed team: the slug the probe and the grant address, and how its access was granted
 * (present only in a repository listing; absent reads as direct).
 */
const LiveTeam = z.looseObject({ slug: z.string(), access_source: z.string().optional() });

/** The probe plan() and snapshot() share, under the media type LiveTeamRepo describes. */
async function probeTeamRole(
  ctx: TeamsContext,
  section: SectionMeta,
  slug: string,
): Promise<{ access: false } | { access: true; role: string | undefined }> {
  const probe = await ctx.read.probe.probeAbsent({
    params: { org: ctx.repo.owner, team_slug: slug },
    accept: "application/vnd.github.v3.repository+json",
  });
  if ("missing" in probe) {
    return { access: false };
  }
  const live = parseLive(section, ENDPOINTS.probe, LiveTeamRepo, probe.data, `team "${slug}"`);
  return { access: true, role: live?.role_name };
}

function personalAccountNote(owner: string): string {
  return `teams: owner "${owner}" is a personal account, not an organization, so team access does not apply`;
}

export const teamsSection = {
  key: "teams",
  undeclaredDefault: "untouched",
  permission,
  // Teams exist only under an organization owner; the org probe below implements the no-op this declares.
  ownerSensitivity: "org",
  endpoints: ENDPOINTS,
  shape: loosen(TeamsConfig),
  // The grant PUT accepts exactly one setting ("permission"), so an extra key is always a typo.
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
    // On a personal account the org endpoints 404; 403/5xx still classify through probeAbsent.
    const orgProbe = await ctx.read.org.probeAbsent({ params: { org: ctx.repo.owner } });
    if ("missing" in orgProbe) {
      plan.notes.push(
        `${personalAccountNote(ctx.repo.owner)}; section skipped - remove the teams section from the settings file to silence this note`,
      );
      return plan;
    }
    for (const team of desired) {
      const role = team.permission ?? DEFAULT_ROLE;
      const params = { org: ctx.repo.owner, team_slug: team.name };
      const probe = await probeTeamRole(ctx, this, team.name);
      const wantRole = roleForPermission(role);
      let drift: string;
      if (!probe.access) {
        drift = `teams[${team.name}]: no access to ${ctx.repo.slug}; apply will grant "${role}"`;
      } else {
        const liveRole = probe.role ?? "";
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
  /**
   * The role comes from the probe, not the listing's `permission`:
   * the listing reports a custom role as its base role, role_name names it.
   * Omitted with a note, each a no-op since the section never removes an undeclared team:
   * non-direct access (declaring it would grant direct access), a probe 404 (no access, or a
   * concealed denial), an unreadable role, a role no declaration plans as.
   */
  async snapshot(ctx) {
    const orgProbe = await ctx.read.org.probeAbsent({ params: { org: ctx.repo.owner } });
    if ("missing" in orgProbe) {
      return { value: undefined, notes: [personalAccountNote(ctx.repo.owner)] };
    }
    const teams = parseLive(this, ENDPOINTS.list, z.array(LiveTeam), await ctx.read.list.listAll());
    const notes: string[] = [];
    const entries: TeamConfig[] = [];
    for (const team of teams) {
      const label = `teams[${team.slug}]`;
      if (team.access_source !== undefined && team.access_source !== "direct") {
        notes.push(
          `${label}: access to ${ctx.repo.slug} is granted at the ${team.access_source} level, not on the repository; not declared, since declaring it would grant direct access`,
        );
        continue;
      }
      const probe = await probeTeamRole(ctx, this, team.slug);
      if (!probe.access) {
        // No write follows to surface a denial, so the note names both readings of the 404.
        notes.push(
          `${label}: listed with access to ${ctx.repo.slug}, but the access probe answered 404, ` +
            "read here as no access; not declared. A fine-grained token missing the grant gets the " +
            `same answer; if the team does have access, ${sectionGrant(this)}, then snapshot again`,
        );
        continue;
      }
      if (probe.role === undefined) {
        notes.push(
          `${label}: has access to ${ctx.repo.slug}, but GitHub reported no role for it; not declared - add the entry with the intended permission`,
        );
        continue;
      }
      const permission = permissionForRole(probe.role);
      if (permission === undefined) {
        notes.push(
          `${label}: the live role "${probe.role}" has no declaration that plans as itself ("${probe.role}" in a settings file means the "${roleForPermission(probe.role)}" role); not declared`,
        );
        continue;
      }
      entries.push({ name: team.slug, permission });
    }
    return { value: entries.length === 0 ? undefined : entries, notes };
  },
} satisfies SectionModule<"teams", typeof ENDPOINTS>;
