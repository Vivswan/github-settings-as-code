/**
 * The teams e2e mock fragment (aggregated in test/e2e/mock/sections.ts). It imports the test-tree
 * seams on purpose: the bundle entry is src/main.ts, so this file never reaches lib/index.js.
 */

import { restRepoSurface, teamRepoFromPut } from "../../../test/e2e/mock/state.js";
import {
  asObject,
  noContent,
  ok,
  orgProbeHandler,
  type SectionRestHandlers,
} from "../../../test/e2e/mock/support.js";

export const teamsMockHandlers: SectionRestHandlers<"teams"> = {
  "teams.org": orgProbeHandler,
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
