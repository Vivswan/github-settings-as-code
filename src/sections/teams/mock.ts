/**
 * The teams section's mock handler fragment (see test/e2e/mock/sections.ts
 * for the aggregation and the deliberate src -> test import direction).
 */

import { restRepoSurface, teamRepoFromPut } from "../../../test/e2e/mock/state.js";
import {
  asObject,
  type Handler,
  noContent,
  ok,
  orgProbeHandler,
} from "../../../test/e2e/mock/support.js";

export const teamsMockHandlers: Record<string, Handler> = {
  "teams.org": orgProbeHandler,
  "teams.probe": ({ state, param }) => {
    const slug = param("team_slug");
    const access = state.teams[slug];
    if (!access) {
      // The spec documents this 404 ("team does not have permission for the
      // repository") with NO response content, so the body is empty.
      return { status: 404, body: null };
    }
    // The repository media type makes this return the repo object with the
    // team's role_name folded in.
    return ok({ ...restRepoSurface(state.repo), role_name: access.role_name });
  },
  "teams.grant": ({ state, param, body }) => {
    const slug = param("team_slug");
    state.teams[slug] = teamRepoFromPut(asObject(body));
    return noContent();
  },
};
