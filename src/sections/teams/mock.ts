/**
 * The teams e2e mock fragment (aggregated in test/e2e/mock/sections.ts). It imports the test-tree
 * seams on purpose: the bundle entry is src/main.ts, so this file never reaches lib/index.js.
 */

import { restRepoSurface, teamRepoFromPut } from "../../../test/e2e/mock/state.js";
import {
  asObject,
  type Json,
  noContent,
  ok,
  orgProbeHandler,
  type SectionRestHandlers,
  slicePage,
} from "../../../test/e2e/mock/support.js";
import { permissionForRole } from "../shared/roles.js";

/** The base roles the listing's `permission` can spell; a custom role collapses to "push" there. */
const BASE_PERMISSIONS: ReadonlySet<string> = new Set([
  "pull",
  "triage",
  "push",
  "maintain",
  "admin",
]);

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
          permission !== undefined && BASE_PERMISSIONS.has(permission) ? permission : "push",
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

export const teamsMockHandlers: SectionRestHandlers<"teams"> = {
  "teams.org": orgProbeHandler,
  "teams.list": ({ state, query }) => ok(slicePage(repoTeams(state), query)),
  "teams.probe": ({ state, param }) => {
    const slug = param("team_slug");
    const access = state.teams[slug];
    if (!access) {
      // The spec documents this 404 with NO response content.
      return { status: 404, body: null };
    }
    // The repository media type makes this return the repo object with the team's role_name folded in.
    return ok({ ...restRepoSurface(state.repo), role_name: access.role_name });
  },
  "teams.grant": ({ state, param, body }) => {
    const slug = param("team_slug");
    state.teams[slug] = teamRepoFromPut(asObject(body));
    return noContent();
  },
};
