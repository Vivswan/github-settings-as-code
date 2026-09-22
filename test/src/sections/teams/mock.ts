/**
 * The teams e2e mock fragment (aggregated in test/e2e/mock/sections.ts).
 */

import { permissionForRole } from "../../../../src/sections/shared/roles.js";
import {
  GRANT_PERMISSIONS,
  grantablePermission,
  restRepoSurface,
  teamRepoFromPut,
} from "../../../e2e/mock/state.js";
import {
  asObject,
  type Json,
  noContent,
  ok,
  orgProbeHandler,
  PERMISSION_NOT_GRANTABLE,
  type SectionRestHandlers,
  slicePage,
} from "../../../e2e/mock/support.js";

/** The Accept media type the probe's role_name body is served under; the section sends it (probeTeamRole, index.ts). */
export const TEAM_REPOSITORY_MEDIA_TYPE = "application/vnd.github.v3.repository+json";

/**
 * The teams with access, in the team GET shape, one per non-null access entry. The listing's
 * `permission` speaks the PUT vocabulary and collapses a custom role to a base role, like GitHub;
 * the probe's role_name is where the section reads the role.
 */
function repoTeams(state: {
  teams: Record<string, { role_name: string } | null>;
  org: Json | null;
}): Json[] {
  const org = String(state.org?.login ?? "org");
  const orgId = Number(state.org?.id ?? 1);
  return Object.entries(state.teams).flatMap(([slug, access], index) => {
    if (access === null) {
      return [];
    }
    const id = 7000 + index;
    const permission = permissionForRole(access.role_name);
    return [
      {
        id,
        node_id: `T_kwDOAAAAAM${id}`,
        name: slug,
        slug,
        description: null,
        privacy: "closed",
        notification_setting: "notifications_enabled",
        permission:
          permission !== undefined && GRANT_PERMISSIONS.has(permission) ? permission : "push",
        url: `https://api.github.com/organizations/${orgId}/team/${id}`,
        html_url: `https://github.com/orgs/${org}/teams/${slug}`,
        members_url: `https://api.github.com/organizations/${orgId}/team/${id}/members{/member}`,
        repositories_url: `https://api.github.com/organizations/${orgId}/team/${id}/repos`,
        type: "organization",
        organization_id: orgId,
        access_source: "direct",
        parent: null,
      },
    ];
  });
}

/** GitHub stores a team slug lowercase and matches the path's spelling case-insensitively: "Core-Team" reaches "core-team". */
function slugKey(param: (name: string) => string): string {
  return param("team_slug").toLowerCase();
}

export const teamsMockHandlers: SectionRestHandlers<"teams"> = {
  "teams.org": orgProbeHandler,
  "teams.list": ({ state, query }) => ok(slicePage(repoTeams(state), query)),
  "teams.probe": ({ state, param, headers }) => {
    const access = state.teams[slugKey(param)];
    if (!access) {
      // The spec documents this 404 with NO response content.
      return { status: 404, body: null };
    }
    // GitHub, "Check team permissions for a repository" (docs.github.com/rest/teams/teams): the 200 body with the
    // repository and the team's role_name is the "Alternative response with repository permissions", served for the
    // application/vnd.github.v3.repository+json media type; the 204 is "the response when the repository media type
    // hasn't been provided in the Accept header". So a client that drops its Accept header reads no role here.
    if (!(headers.accept ?? "").includes(TEAM_REPOSITORY_MEDIA_TYPE)) {
      return noContent();
    }
    return ok({ ...restRepoSurface(state.repo), role_name: access.role_name });
  },
  "teams.grant": ({ state, param, body }) => {
    if (!grantablePermission(state.ownerKind, asObject(body))) {
      return PERMISSION_NOT_GRANTABLE;
    }
    state.teams[slugKey(param)] = teamRepoFromPut(asObject(body));
    return noContent();
  },
  "teams.revoke": ({ state, param }) => {
    state.teams[slugKey(param)] = null;
    return noContent();
  },
};
