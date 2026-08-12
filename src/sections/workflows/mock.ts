/**
 * The workflows section's e2e mock fragment, registered in
 * test/e2e/mock/sections.ts. Imports the test-tree seams (mock/support.ts)
 * on purpose - the bundle entry is src/main.ts, so this fragment never
 * reaches lib/index.js - and never routes.ts or sections.ts.
 */

import { type Handler, noContent, ok, slicePage } from "../../../test/e2e/mock/support.js";

export const workflowsMockHandlers: Record<string, Handler> = {
  "workflows.list": ({ state, query }) => {
    const page = slicePage(state.workflows, query);
    return ok({ total_count: state.workflows.length, workflows: page });
  },
  "workflows.enable": ({ state, param }) => {
    const id = param("workflow_id");
    const workflow = state.workflows.find((w) => String(w.id) === id);
    if (!workflow) {
      return { status: 404, body: { message: "Not Found" } };
    }
    workflow.state = "active";
    return noContent();
  },
  "workflows.disable": ({ state, param }) => {
    const id = param("workflow_id");
    const workflow = state.workflows.find((w) => String(w.id) === id);
    if (!workflow) {
      return { status: 404, body: { message: "Not Found" } };
    }
    workflow.state = "disabled_manually";
    return noContent();
  },
};
