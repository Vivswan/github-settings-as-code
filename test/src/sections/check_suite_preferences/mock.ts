/**
 * The check_suite_preferences e2e mock fragment (aggregated in test/e2e/mock/sections.ts).
 */

import { restRepoSurface } from "../../../e2e/mock/state.js";
import { asObject, ok, type SectionRestHandlers } from "../../../e2e/mock/support.js";

export const checkSuitePreferencesMockHandlers: SectionRestHandlers<"check_suite_preferences"> = {
  "check_suite_preferences.update": ({ state, body }) => {
    // No GET exists, so the stored preferences are visible only through this PATCH's echo
    // ({preferences, repository} per the spec's check-suite-preference schema).
    Object.assign(state.check_suite_preferences, asObject(body));
    return ok({
      preferences: state.check_suite_preferences,
      repository: restRepoSurface(state.repo),
    });
  },
};
