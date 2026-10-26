/**
 * `teams:` section: team repository access. Organization repos only, so a personal account no-ops with a note. An
 * undeclared team keeps its access by default (a team is often granted by the org, for reasons outside one
 * repository's file); `_undeclared: delete` revokes the direct grants the file does not name. Bespoke, not on
 * listSection: the live list carries no role, so each team's access is a separate probe.
 */

import { ok, okAsync, type Result, safeTry } from "neverthrow";
import { z } from "zod";
import type { UndeclaredPolicy } from "../../types.js";
import {
  undeclaredDrift,
  undeclaredNote,
  undeclaredPolicy,
  valueDrift,
} from "../contract/drift.js";
import type { EndpointDecl } from "../contract/endpoints.js";
import type { SectionFailure } from "../contract/errors.js";
import { identifiedBy } from "../contract/keyed-list.js";
import { liveByIdentity, liveIdentity } from "../contract/live.js";
import {
  defaultUndeclaredPolicy,
  ORG_PROBE,
  type SectionMeta,
  type SectionModule,
} from "../contract/module.js";
import { sectionGrant } from "../contract/operations.js";
import type { SectionPermission } from "../contract/permissions.js";
import type { PlanContext, PlannedOp, Read, SectionPlan } from "../contract/plan.js";
import { DEFAULT_ROLE, readBackPermission, roleForPermission } from "../shared/roles.js";
import { knobbed, routed } from "../shared/schema-helpers.js";
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

type TeamsOp = PlannedOp<typeof ENDPOINTS>;

// Nullish because a server ignoring the repository media type answers a bare 204, which still means "the team has access".
const LiveTeamRepo = z.looseObject({ role_name: z.string().optional() }).nullish();

// The id tells two same-fold slugs apart; access_source appears only in a repository listing, and absent reads as direct.
const LiveTeam = z.looseObject({
  id: z.number().optional(),
  slug: z.string(),
  access_source: z.string().optional(),
});

type LiveTeam = z.infer<typeof LiveTeam>;

/** What the access probe answers for one team. */
type TeamAccess = { access: false } | { access: true; role: string | undefined };

/** The role a listed team reads back, or why the snapshot leaves the team out. */
type SnapshotRole = { role: string } | { leftOut: string };

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
function probeTeamRole(ctx: TeamsContext, slug: string): Read<TeamAccess> {
  return ctx.read.probe
    .probeAbsent(LiveTeamRepo, {
      params: { org: ctx.repo.owner, team_slug: slug },
      accept: "application/vnd.github.v3.repository+json",
      describe: `team "${slug}"`,
    })
    .map((probe) =>
      "missing" in probe
        ? { access: false as const }
        : { access: true as const, role: probe.data?.role_name },
    );
}

/** A team's slug is its lowercased name; the brand marks a name or slug already folded to the key every lookup reads. */
declare const teamSlugKey: unique symbol;

type TeamKey = string & { readonly [teamSlugKey]: true };

function teamKey(nameOrSlug: string): TeamKey {
  return nameOrSlug.toLowerCase() as TeamKey;
}

/**
 * The listed teams by slug under the duplicate-live guard (slugs fold case-insensitively, as the
 * declared entries do); plan() and snapshot() both index through it.
 */
function teamsBySlug(
  section: SectionMeta,
  live: readonly LiveTeam[],
): Result<Map<TeamKey, LiveTeam>, SectionFailure> {
  return liveByIdentity(
    section,
    "team",
    live,
    (team) => teamKey(team.slug),
    (team) => liveIdentity(team.slug, { team_id: team.id }),
  );
}

/** The drift line a declared team's probe earns, or undefined once its live role matches. */
function declaredTeamDrift(
  repo: string,
  team: TeamConfig,
  role: string,
  probe: TeamAccess,
): string | undefined {
  if (!probe.access) {
    return `teams[${team.name}]: no access to ${repo}; apply will grant "${role}"`;
  }

  const wantRole = roleForPermission(role);
  const liveRole = probe.role ?? "";
  if (liveRole === wantRole) {
    return undefined;
  }

  return valueDrift(`teams[${team.name}]`, JSON.stringify(wantRole), JSON.stringify(liveRole), {
    remedy: "apply will set the declared permission",
  });
}

/** A keep-note or the revocation for each live team the file does not name; access granted above the repository is beyond either. */
function undeclaredTeams(
  ctx: TeamsContext,
  section: SectionMeta<"teams">,
  live: ReadonlyMap<TeamKey, LiveTeam>,
  declaredSlugs: ReadonlySet<TeamKey>,
  policy: UndeclaredPolicy,
): { ops: TeamsOp[]; notes: string[] } {
  const ops: TeamsOp[] = [];
  const notes: string[] = [];
  for (const [slugKey, team] of live) {
    if (declaredSlugs.has(slugKey)) {
      continue;
    }

    const inherited = inheritedAccess(team);
    if (inherited !== undefined) {
      // Only a revocation would act on it, so only the policy that would revoke is told it cannot.
      if (policy === "delete") {
        notes.push(
          `teams[${team.slug}]: ${inheritedAccessReason(ctx.repo.slug, inherited)}, so "_undeclared: delete" cannot revoke it; left untouched`,
        );
      }
      continue;
    }

    if (policy === "keep") {
      notes.push(
        undeclaredNote({
          subject: `team "${team.slug}"`,
          state: "has access but is not declared",
          manage: "its access",
          action: "REVOKE its access",
        }),
      );
      continue;
    }

    ops.push({
      role: "revoke",
      params: { org: ctx.repo.owner, team_slug: team.slug },
      drift: [
        undeclaredDrift(defaultUndeclaredPolicy(section), {
          label: `teams[${team.slug}]`,
          action: "REVOKE its access",
          keep: "its access",
        }),
      ],
      change: `REVOKED undeclared team "${team.slug}"`,
    });
  }

  return { ops, notes };
}

/** Inherited access is never probed; a 404 or a roleless answer leaves the team out with the reason. */
function snapshotRole(ctx: TeamsContext, section: SectionMeta, team: LiveTeam): Read<SnapshotRole> {
  const inherited = inheritedAccess(team);
  if (inherited !== undefined) {
    return okAsync({
      leftOut: `${inheritedAccessReason(ctx.repo.slug, inherited)}, and declaring it would grant direct access`,
    });
  }

  return probeTeamRole(ctx, team.slug).map((probe): SnapshotRole => {
    if (!probe.access) {
      // No write follows to surface a denial, so the note names both readings of the 404.
      return {
        leftOut:
          `listed with access to ${ctx.repo.slug}, but the access probe answered 404, read here as no access. ` +
          "A fine-grained token missing the grant gets the same answer; if the team does have access, " +
          `${sectionGrant(section)}, then snapshot again`,
      };
    }
    if (probe.role === undefined) {
      return {
        leftOut: `has access to ${ctx.repo.slug}, but GitHub reported no role for it; add the entry with the intended permission`,
      };
    }
    return { role: probe.role };
  });
}

export const teamsSection = {
  ...identifiedBy("teams", "name", "team", { fold: teamKey }),
  undeclaredDefault: "keep",
  permission,
  // Teams exist only under an organization owner; the registry's owner gate (contract/owner.ts) probes the `org` role.
  ownerSensitivity: "org",
  endpoints: ENDPOINTS,
  shape: routed(knobbed(TeamConfig)),
  // The grant PUT accepts exactly one setting ("permission"), so an extra key is always a typo.
  closedSurface: {
    known: { name: true, permission: true },
    consequence: `a misspelled "permission" key would silently grant the default "${DEFAULT_ROLE}" role instead of the intended one`,
  },
  async plan(ctx, declared) {
    const section = this;
    return safeTry(async function* () {
      const { policy, entries: desired } = undeclaredPolicy(
        declared,
        defaultUndeclaredPolicy(section),
      );
      const plan: SectionPlan<TeamsOp> = { ops: [], notes: [], drift: [] };
      // The listing is read BEFORE the declared walk, so the undeclared teams are judged against the state the grants
      // below start from; a declared team's role still comes from the probe, which names a custom role.
      const live = yield* ctx.read.list
        .listAll(LiveTeam)
        .andThen((teams) => teamsBySlug(section, teams));
      const declaredSlugs = new Set(desired.map((team) => teamKey(team.name)));
      for (const team of desired) {
        const role = team.permission ?? DEFAULT_ROLE;
        const probe = yield* probeTeamRole(ctx, team.name);
        const drift = declaredTeamDrift(ctx.repo.slug, team, role, probe);
        if (drift === undefined) {
          continue;
        }
        plan.ops.push({
          role: "grant",
          params: { org: ctx.repo.owner, team_slug: team.name },
          payload: { permission: role },
          describe: `granting team "${team.name}" access`,
          drift: [drift],
          change: `granted team "${team.name}" ${role}`,
        });
      }

      const undeclared = undeclaredTeams(ctx, section, live, declaredSlugs, policy);
      plan.ops.push(...undeclared.ops);
      plan.notes.push(...undeclared.notes);
      return ok(plan);
    });
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
    const section = this;
    return safeTry(async function* () {
      const teams = yield* ctx.read.list
        .listAll(LiveTeam)
        .andThen((live) => teamsBySlug(section, live));
      const notes: string[] = [];
      const entries: TeamConfig[] = [];
      for (const team of teams.values()) {
        const label = `teams[${team.slug}]`;
        const probed = yield* snapshotRole(ctx, section, team);
        if ("leftOut" in probed) {
          notes.push(leftOutOfSnapshot(label, probed.leftOut));
          continue;
        }
        const permission = yield* readBackPermission(section, label, probed.role, notes);
        if (permission === undefined) {
          continue;
        }
        entries.push({ name: team.slug, permission });
      }
      return ok({
        value: entries.length === 0 ? undefined : knobbedSnapshot(section, entries),
        notes,
      });
    });
  },
} satisfies SectionModule<"teams", typeof ENDPOINTS>;
