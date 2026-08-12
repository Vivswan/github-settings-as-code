/**
 * The check_suite_preferences mock fragment the e2e route pipeline aggregates
 * (test/e2e/mock/sections.ts). Deliberately imports the test-tree seams
 * (support.ts and state.ts, never routes.ts); the bundle entry is
 * src/main.ts, so this file never reaches lib/index.js.
 */

import { restRepoSurface } from "../../../test/e2e/mock/state.js";
import { asObject, type Handler, ok } from "../../../test/e2e/mock/support.js";

export const checkSuitePreferencesMockHandlers: Record<string, Handler> = {
  "check_suite_preferences.update": ({ state, body }) => {
    // The one write-only endpoint: no GET exists, so the stored preferences
    // are visible only through this PATCH's echo ({preferences, repository}
    // per the spec's check-suite-preference schema).
    Object.assign(state.check_suite_preferences, asObject(body));
    return ok({
      preferences: state.check_suite_preferences,
      repository: restRepoSurface(state.repo),
    });
  },
};
