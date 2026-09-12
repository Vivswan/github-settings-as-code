/**
 * The workflows e2e mock fragment (registered in test/e2e/mock/sections.ts). It imports the
 * test-tree seams on purpose: the bundle entry is src/main.ts, so this file never reaches lib/index.js.
 */

import {
  noContent,
  ok,
  type SectionRestHandlers,
  slicePage,
} from "../../../test/e2e/mock/support.js";

export const workflowsMockHandlers: SectionRestHandlers<"workflows"> = {
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
