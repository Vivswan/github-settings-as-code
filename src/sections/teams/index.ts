/**
 * `teams:` section: team repository access. Organization repos only, so a personal account no-ops with a note. An
 * undeclared team keeps its access by default (a team is often granted by the org, for reasons outside one
 * repository's file); `_undeclared: delete` revokes the direct grants the file does not name. Bespoke, not on
 * listSection: the live list carries no role, so each team's access is a separate probe.
 */

import { z } from "zod";
import type { EndpointDecl } from "../contract/endpoints.js";
import { liveByIdentity, liveIdentity } from "../contract/live.js";
import {
  defaultUndeclaredPolicy,
  loosen,
  ORG_PROBE,
  type SectionMeta,
  type SectionModule,
  sectionGrant,
  undeclaredDrift,
  undeclaredNote,
  undeclaredPolicy,
  valueDrift,
} from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import type { PlanContext, PlannedOp, SectionPlan } from "../contract/plan.js";
import { rejectDuplicates } from "../contract/requests.js";
import { DEFAULT_ROLE, readBackPermission, roleForPermission } from "../shared/roles.js";
import { knobbed } from "../shared/schema-helpers.js";
import { knobbedSnapshot, leftOutOfSnapshot } from "../shared/snapshot-helpers.js";
import { TeamConfig } from "./schema.js";

const permission: SectionPermission = { repo: ["administration"], org: "members" };

const ENDPOINTS = {
  org: ORG_PROBE,
  // GitHub gates the repository's team list at repository Administration (read) alone: the first read a fine-grained
  // token can be denied, on a repository the org probe just proved exists, so its 404 is a denial.
  list: {
    route: "GET /repos/{owner}/{repo}/teams",
    statuses: { 200: "the teams with access to the repository" },
    permission: { repo: ["administration"] },
    primaryRead: { notFound: "denied" },
  },
  probe: {
    route: "GET /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}",
    statuses: { 200: "the team's access to the repository", 404: "the team has no access" },
  },
  grant: {
    route: "PUT /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}",
    statuses: { 204: "team access granted" },
  },
  revoke: {
    route: "DELETE /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}",
    statuses: { 204: "team access revoked" },
  },
} as const satisfies Record<string, EndpointDecl>;

type TeamsContext = PlanContext<typeof ENDPOINTS>;

// The repo object under the repository media type, of which only role_name is read. Nullish,
// because a server ignoring the media type answers a bare 204, which still means "the team has access".
const LiveTeamRepo = z.looseObject({ role_name: z.string().optional() }).nullish();

/**
 * A listed team: the slug the probe and the grant address, its id (which tells two same-fold slugs
 * apart), and how its access was granted (present only in a repository listing; absent reads as direct).
 */
const LiveTeam = z.looseObject({
  id: z.number().optional(),
  slug: z.string(),
  access_source: z.string().optional(),
});
type LiveTeam = z.infer<typeof LiveTeam>;

/** Access granted above the repository (the organization, the enterprise), which no repository call revokes. */
function inheritedAccess(team: LiveTeam): string | undefined {
  return team.access_source !== undefined && team.access_source !== "direct"
    ? team.access_source
    : undefined;
}

/** Why plan() and snapshot() leave such access alone; each says what it does about it. */
function inheritedAccessReason(repo: string, source: string): string {
  return `access to ${repo} is granted at the ${source} level, not on the repository`;
}

/** The probe plan() and snapshot() share, under the media type LiveTeamRepo describes. */
async function probeTeamRole(
  ctx: TeamsContext,
  slug: string,
): Promise<{ access: false } | { access: true; role: string | undefined }> {
  const probe = await ctx.read.probe.probeAbsent(LiveTeamRepo, {
    params: { org: ctx.repo.owner, team_slug: slug },
    accept: "application/vnd.github.v3.repository+json",
    describe: `team "${slug}"`,
  });
  if ("missing" in probe) {
    return { access: false };
  }
  return { access: true, role: probe.data?.role_name };
}

/**
 * The listed teams by slug under the duplicate-live guard (slugs fold case-insensitively, as the
 * declared entries do); plan() and snapshot() both index through it.
 */
function teamsBySlug(section: SectionMeta, live: readonly LiveTeam[]): Map<string, LiveTeam> {
  return liveByIdentity(
    section,
    "team",
    live,
    (team) => team.slug.toLowerCase(),
    (team) => liveIdentity(team.slug, { team_id: team.id }),
  );
}

export const teamsSection = {
  key: "teams",
  undeclaredDefault: "keep",
  permission,
  // Teams exist only under an organization owner; the registry's owner gate (contract/owner.ts) probes the `org` role.
  ownerSensitivity: "org",
  endpoints: ENDPOINTS,
  shape: loosen(knobbed(TeamConfig)),
  // The grant PUT accepts exactly one setting ("permission"), so an extra key is always a typo.
  closedSurface: {
    known: { name: true, permission: true },
    describe: (t) => t.name,
    consequence: `a misspelled "permission" key would silently grant the default "${DEFAULT_ROLE}" role instead of the intended one`,
  },
  async plan(ctx, declared) {
    const { policy, entries: desired } = undeclaredPolicy(declared, defaultUndeclaredPolicy(this));
    rejectDuplicates(
      this,
      desired,
      (t) => t.name.toLowerCase(),
      (t) => t.name,
    );
    const plan: SectionPlan<PlannedOp<typeof ENDPOINTS>> = { ops: [], notes: [], drift: [] };
    // The listing is read BEFORE the declared walk, so the undeclared teams are judged against the state the grants
    // below start from; a declared team's role still comes from the probe, which names a custom role.
    const live = teamsBySlug(this, await ctx.read.list.listAll(LiveTeam));
    const declaredSlugs = new Set(desired.map((team) => team.name.toLowerCase()));
    for (const team of desired) {
      const role = team.permission ?? DEFAULT_ROLE;
      const params = { org: ctx.repo.owner, team_slug: team.name };
      const probe = await probeTeamRole(ctx, team.name);
      const wantRole = roleForPermission(role);
      let drift: string;
      if (!probe.access) {
        drift = `teams[${team.name}]: no access to ${ctx.repo.slug}; apply will grant "${role}"`;
      } else {
        const liveRole = probe.role ?? "";
        if (liveRole === wantRole) {
          continue;
        }
        drift = valueDrift(
          `teams[${team.name}]`,
          JSON.stringify(wantRole),
          JSON.stringify(liveRole),
          { remedy: "apply will set the declared permission" },
        );
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

    for (const [slugKey, team] of live) {
      if (declaredSlugs.has(slugKey)) {
        continue;
      }
      const inherited = inheritedAccess(team);
      if (inherited !== undefined) {
        // Only a revocation would act on it, so only the policy that would revoke is told it cannot.
        if (policy === "delete") {
          plan.notes.push(
            `teams[${team.slug}]: ${inheritedAccessReason(ctx.repo.slug, inherited)}, so "_undeclared: delete" cannot revoke it; left untouched`,
          );
        }
        continue;
      }
      if (policy === "keep") {
        plan.notes.push(
          undeclaredNote({
            subject: `team "${team.slug}"`,
            state: "has access but is not declared",
            manage: "its access",
            action: "REVOKE its access",
          }),
        );
        continue;
      }
      plan.ops.push({
        role: "revoke",
        params: { org: ctx.repo.owner, team_slug: team.slug },
        drift: [
          undeclaredDrift(defaultUndeclaredPolicy(this), {
            label: `teams[${team.slug}]`,
            action: "REVOKE its access",
            keep: "its access",
          }),
        ],
        change: `REVOKED undeclared team "${team.slug}"`,
      });
    }
    return plan;
  },
  /**
   * The role comes from the probe, not the listing's `permission`:
   * the listing reports a custom role as its base role, role_name names it.
   * Omitted with a note, each a no-op under the keep default: non-direct access (declaring it
   * would grant direct access; plan() never revokes it either), a probe 404 (no access, or a
   * concealed denial), an unreadable role, a role no declaration plans as (a direct team plan()
   * still revokes under `_undeclared: delete`, so the note names what the file would have to declare).
   */
  async snapshot(ctx) {
    const teams = teamsBySlug(this, await ctx.read.list.listAll(LiveTeam));
    const notes: string[] = [];
    const entries: TeamConfig[] = [];
    for (const team of teams.values()) {
      const label = `teams[${team.slug}]`;
      const inherited = inheritedAccess(team);
      if (inherited !== undefined) {
        notes.push(
          leftOutOfSnapshot(
            label,
            `${inheritedAccessReason(ctx.repo.slug, inherited)}, and declaring it would grant direct access`,
          ),
        );
        continue;
      }
      const probe = await probeTeamRole(ctx, team.slug);
      if (!probe.access) {
        // No write follows to surface a denial, so the note names both readings of the 404.
        notes.push(
          leftOutOfSnapshot(
            label,
            `listed with access to ${ctx.repo.slug}, but the access probe answered 404, read here as no access. ` +
              "A fine-grained token missing the grant gets the same answer; if the team does have access, " +
              `${sectionGrant(this)}, then snapshot again`,
          ),
        );
        continue;
      }
      if (probe.role === undefined) {
        notes.push(
          leftOutOfSnapshot(
            label,
            `has access to ${ctx.repo.slug}, but GitHub reported no role for it; add the entry with the intended permission`,
          ),
        );
        continue;
      }
      const permission = readBackPermission(this, label, probe.role, notes);
      if (permission === undefined) {
        continue;
      }
      entries.push({ name: team.slug, permission });
    }
    return { value: entries.length === 0 ? undefined : knobbedSnapshot(this, entries), notes };
  },
} satisfies SectionModule<"teams", typeof ENDPOINTS>;
