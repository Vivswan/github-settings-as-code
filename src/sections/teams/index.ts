/**
 * `teams:` section - team repository access, organization repos only; on a
 * personal account the section no-ops with a note.
 */

import {
  beginRun,
  call,
  type EndpointDecl,
  loosen,
  probeAbsent,
  rejectDuplicates,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
} from "../contract.js";
import { DEFAULT_ROLE, roleForPermission } from "../roles.js";
import { TeamsSlice } from "./schema.js";

const permission: SectionPermission = { repo: ["administration"], org: "members" };

const ENDPOINTS = {
  // GET /orgs/{org} is a public endpoint, so it needs no token permission.
  org: {
    route: "GET /orgs/{org}",
    statuses: { 200: "the organization", 404: "not an organization (a personal account)" },
    permission: "none",
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

export const teamsSection = {
  key: "teams",
  undeclaredDefault: "untouched",
  permission,
  // Teams exist only under an organization owner; the org probe below
  // implements the personal-account no-op this declares.
  ownerSensitivity: "org",
  endpoints: ENDPOINTS,
  shape: loosen(TeamsSlice),
  // Closed surface: the grant PUT accepts exactly one setting ("permission"),
  // so an extra key is always a typo - and a misspelled "permission" would
  // silently grant the default role and report clean.
  closedSurface: {
    known: { name: true, permission: true },
    describe: (t) => t.name,
    consequence: `a misspelled "permission" key would silently grant the default "${DEFAULT_ROLE}" role instead of the intended one`,
  },
  async run(ctx, desired): Promise<SectionResult> {
    const run = beginRun(ctx);
    rejectDuplicates(
      this,
      desired,
      (t) => t.name.toLowerCase(),
      (t) => t.name,
    );
    // Teams only exist on organization repos; on a personal account the org
    // endpoints 404. Probe once and no-op with a note instead of failing;
    // 403/5xx still flow through the permission policy via probeAbsent.
    const orgProbe = await probeAbsent(ctx, this, ENDPOINTS.org, {
      params: { org: ctx.repo.owner },
    });
    if ("missing" in orgProbe) {
      run.result.notes.push(
        `teams: owner "${ctx.repo.owner}" is a personal account, not an organization, so team access does not apply; section skipped - remove the teams section from the settings file to silence this note`,
      );
      return run.result;
    }
    for (const team of desired) {
      const role = team.permission ?? DEFAULT_ROLE;
      if (!run.check) {
        await call(ctx, this, ENDPOINTS.grant, {
          params: { org: ctx.repo.owner, team_slug: team.name },
          payload: { permission: role },
          describe: `granting team "${team.name}" access`,
        });
        run.result.changes.push(`granted team "${team.name}" ${role}`);
        continue;
      }
      // The repository media type makes this endpoint return the repo
      // object (with role_name) instead of 204.
      const probe = await probeAbsent(ctx, this, ENDPOINTS.probe, {
        params: { org: ctx.repo.owner, team_slug: team.name },
        accept: "application/vnd.github.v3.repository+json",
      });
      if ("missing" in probe) {
        run.result.drift.push(
          `teams[${team.name}]: no access to ${ctx.repo.slug}; apply will grant "${role}"`,
        );
        continue;
      }
      const wantRole = roleForPermission(role);
      const liveRole = (probe.data as { role_name?: string } | null)?.role_name ?? "";
      if (liveRole !== wantRole) {
        run.result.drift.push(
          `teams[${team.name}]: live role "${liveRole}" != declared "${wantRole}"; apply will set the declared permission`,
        );
      }
    }
    return run.result;
  },
} satisfies SectionModule<"teams">;
