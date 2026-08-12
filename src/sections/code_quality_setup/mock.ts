/**
 * The code_quality_setup mock fragment the e2e route pipeline aggregates
 * (test/e2e/mock/sections.ts). Deliberately imports the test-tree seams
 * (support.ts, never routes.ts); the bundle entry is src/main.ts, so this
 * file never reaches lib/index.js.
 */

import { asObject, ok, type SectionRestHandlers } from "../../../test/e2e/mock/support.js";

export const codeQualitySetupMockHandlers: SectionRestHandlers<"code_quality_setup"> = {
  "code_quality_setup.get": ({ state }) => ok(state.code_quality),
  "code_quality_setup.update": ({ state, body }) => {
    // Mirrors code_scanning_default_setup.update: the in-progress 409 flag
    // (set via live_state.code_quality) is checked first so a scenario can
    // trigger it independently, then the deterministic 200-vs-202 rule - a
    // `languages` change starts an async configuration run.
    if (state.code_quality.configuration_run_in_progress === true) {
      return { status: 409, body: { message: "A configuration run is already in progress" } };
    }
    const payload = asObject(body);
    const changesLanguages =
      "languages" in payload &&
      JSON.stringify(payload.languages) !== JSON.stringify(state.code_quality.languages);
    Object.assign(state.code_quality, payload);
    if (changesLanguages) {
      const runId = state.nextId++;
      return {
        status: 202,
        body: {
          run_id: runId,
          run_url: `https://api.github.com/repos/${state.slug}/code-quality/setup/runs/${runId}`,
        },
      };
    }
    // Like code-scanning's, the spec's 200 response is an EMPTY object
    // (additionalProperties: false); state is still updated above.
    return ok({});
  },
};
