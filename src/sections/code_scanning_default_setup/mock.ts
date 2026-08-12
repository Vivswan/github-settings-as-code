/**
 * The code_scanning_default_setup mock fragment the e2e route pipeline
 * aggregates (test/e2e/mock/sections.ts). Deliberately imports the test-tree
 * seams (support.ts, never routes.ts); the bundle entry is src/main.ts, so
 * this file never reaches lib/index.js.
 */

import { ADMIN_SLUG } from "../../../test/e2e/constants.js";
import { asObject, type Handler, ok } from "../../../test/e2e/mock/support.js";

export const codeScanningDefaultSetupMockHandlers: Record<string, Handler> = {
  "code_scanning_default_setup.get": ({ state }) => ok(state.code_scanning),
  "code_scanning_default_setup.update": ({ state, body }) => {
    // A configuration validation run already in progress: the PATCH answers 409
    // (a declared status the section tolerates and gives its own advice for),
    // and no change is applied. Flag set via live_state.code_scanning. This is
    // checked before the language/200-vs-202 rule so it can be triggered
    // independently.
    if (state.code_scanning.configuration_run_in_progress === true) {
      return { status: 409, body: { message: "A configuration run is already in progress" } };
    }
    // The PATCH answers 200 (synchronous) or 202 (async run started). Rule,
    // deterministic: when the payload changes `languages`, GitHub kicks off an
    // async configuration run and answers 202 with a run_id; otherwise it
    // applies synchronously and answers 200. This mirrors the real endpoint's
    // behavior (language changes trigger a rebuild) without nondeterminism.
    const payload = asObject(body);
    const changesLanguages =
      "languages" in payload &&
      JSON.stringify(payload.languages) !== JSON.stringify(state.code_scanning.languages);
    Object.assign(state.code_scanning, payload);
    if (changesLanguages) {
      return {
        status: 202,
        body: {
          run_id: state.nextId++,
          run_url: `https://api.github.com/repos/${ADMIN_SLUG}/code-scanning/default-setup/runs/1`,
        },
      };
    }
    // The spec's 200 response is an EMPTY object (additionalProperties: false):
    // a synchronous apply returns no body content. The 202 path (below) carries
    // {run_id, run_url}. State is still updated above; only the wire body is {}.
    return ok({});
  },
};
